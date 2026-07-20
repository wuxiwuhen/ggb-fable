// 日志收集器(从 js/logger.js 迁移)
// 原版写本地 log/ 目录(经 serve.js); 新版缓冲后 flush 到 /api/sessions → Supabase
// 用途: 会话云端持久化(替代 log/jsonl) + 收集交互数据帮助项目迭代
//
// 设计: 可实例化, 每个会话一个 Logger, 绑定 sessionId + mode + user。
// 缓冲事件, 定时批量 POST; flush 失败静默降级(不阻塞 UI), 事件留在缓冲下次再试。

// 把一批事件按 ev.sessionId 分组。跳过无 sessionId 的(如 setSession('') 后的 ggb_exec——无会话态不入库)。
// 事件在 push 时已 stamp sessionId, flush/flushNow 据此分组各自 append, 保证归属正确。
function groupBySession(batch: any[]): Map<string, any[]> {
  const groups = new Map<string, any[]>();
  for (const ev of batch) {
    if (!ev.sessionId) continue;
    const arr = groups.get(ev.sessionId);
    if (arr) arr.push(ev);
    else groups.set(ev.sessionId, [ev]);
  }
  return groups;
}

export class Logger {
  private sessionId = '';
  private buffer: any[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly MAX_BUFFER = 3000;
  private enabled = true;

  // 同步设置当前会话(不落库)。仅作标记: 初始绑定 / clearWorkspace 后置 '' 表示"无会话"。
  // 切换会话请用 switchTo(先 flush 再切)——旧的 setSession→flushNow(sendBeacon) 路径已废弃
  // (sendBeacon 不保证送达、失败不回填, 是消息丢失的根因)。
  setSession(sessionId: string, _meta: Record<string, any> = {}) {
    this.sessionId = sessionId;
  }

  // 可靠切换会话: 先用 fetch 把当前 buffer 按 sessionId 分组落库, 再切到新会话。
  // 调用方(newSession/switchSession)在持久化画布后 await 本方法, 与 persistCanvasXml 对称,
  // 保证离开会话的消息可靠入库(不依赖 sendBeacon)。
  async switchTo(newId: string) {
    await this.flush();
    this.sessionId = newId;
  }

  // 同步 flush(不等待网络): 仅 beforeunload 兜底用。按 sessionId 分组 sendBeacon, 入队失败回填。
  flushNow(): void {
    if (!this.buffer.length) return;
    const batch = this.buffer.splice(0, this.buffer.length);
    for (const [sid, events] of groupBySession(batch)) {
      try {
        const ok = navigator.sendBeacon('/api/sessions', new Blob(
          [JSON.stringify({ action: 'append', sessionId: sid, events })],
          { type: 'application/json' },
        ));
        if (!ok) this.buffer = [...events, ...this.buffer];   // 入队失败回填, 下次 flush 重试
      } catch {
        this.buffer = [...events, ...this.buffer];
      }
    }
  }

  setEnabled(v: boolean) { this.enabled = v; }

  private mask(key: string): string {
    if (!key || typeof key !== 'string') return '';
    if (key.length <= 8) return '***';
    return key.slice(0, 3) + '***' + key.slice(-4);
  }

  private push(type: string, payload: Record<string, any> = {}) {
    if (!this.enabled) return;
    this.buffer.push({ ts: Date.now(), sessionId: this.sessionId, type, ...payload });
    if (this.buffer.length > this.MAX_BUFFER) this.buffer.splice(0, this.buffer.length - this.MAX_BUFFER);
    this.scheduleFlush();
  }

  private scheduleFlush() {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => { this.flush(); }, 400);
  }

  async flush() {
    this.flushTimer = null;
    if (!this.buffer.length) return;
    const batch = this.buffer.splice(0, this.buffer.length);
    // 事件在 push 时已 stamp 各自的 sessionId, 这里按会话分组各自 append。
    // 不再用"统一发到当前 sessionId + alien filter 丢弃"——后者与失败回填组合会形成黑洞:
    // flush 失败回填的事件(带旧 sid)在 sessionId 切换后会被 alien filter 永久丢弃。
    // 分组发送让每条事件始终归属它产生时的会话, abort 后迟到的 straggler 也不会丢/污染。
    const groups = groupBySession(batch);
    if (!groups.size) return;
    await Promise.all([...groups.entries()].map(async ([sid, events]) => {
      try {
        const resp = await fetch('/api/sessions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'append', sessionId: sid, events }),
          keepalive: true,
        });
        if (!resp.ok) this.buffer = [...events, ...this.buffer];   // 失败组回填(带原 sid, 下次仍分组正确)
      } catch {
        this.buffer = [...events, ...this.buffer];
      }
    }));
  }

  // ── 事件 API(与原版方法名一致, ggb.ts/agent.ts 依赖) ──
  startSession(meta: Record<string, any>) {
    this.sessionId = meta.sessionId || this.sessionId;
    this.push('session_start', {
      summary: `model=${meta.model_name || '?'} mode=${meta.mode || '?'}`,
      model: meta.model_name,
      mode: meta.mode,
      api_key_masked: this.mask(meta.api_key),
      temperature: meta.temperature,
      max_tool_rounds: meta.max_tool_rounds,
    });
  }

  userTurn(text: string) {
    this.push('user_input', { summary: text.slice(0, 60), text });
  }

  llmRequest(meta: Record<string, any>) {
    this.push('llm_request', {
      summary: `model=${meta.model} msgs=${meta.messages ? meta.messages.length : 0}`,
      callIndex: meta.callIndex,
      model: meta.model,
      toolNames: meta.toolNames,
      // messages 含完整上下文, 排查模型行为的关键; 但体积大, 仅在显式开启时记录完整
      messages: meta.messages,
    });
  }

  llmResponse(meta: Record<string, any>) {
    const tc = meta.tool_calls || [];
    this.push('llm_response', {
      summary: `calls=${tc.length} text=${(meta.content || '').length}字`,
      callIndex: meta.callIndex,
      content: meta.content || '',
      tool_calls: tc,
    });
  }

  toolCall(meta: Record<string, any>) {
    this.push('tool_call', {
      summary: `${meta.name} (${meta.durationMs}ms) ${meta.result && meta.result.error ? '✗' : '✓'}`,
      round: meta.round,
      name: meta.name,
      args: meta.args,
      result: meta.result,
      durationMs: meta.durationMs,
    });
  }

  ggbExec(meta: Record<string, any>) {
    this.push('ggb_exec', {
      summary: `${meta.command} ${meta.ok ? '✓ ' + (meta.labels || '') : '✗'}`,
      command: meta.command,
      ok: meta.ok,
      labels: meta.labels,
      error: meta.error,
      durationMs: meta.durationMs,
    });
  }

  errorEvent(where: string, err: any) {
    this.push('error', {
      summary: `${where}: ${String(err && err.message || err).slice(0, 80)}`,
      where,
      message: String(err && err.message || err),
    });
  }

  turnEnd(meta: Record<string, any>) {
    this.push('turn_end', {
      summary: `tools=${meta.toolCount} stopped=${!!meta.stopped}`,
      finalText: meta.finalText,
      toolCount: meta.toolCount,
      stopped: !!meta.stopped,
    });
  }
}
