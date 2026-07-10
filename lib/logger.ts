// 日志收集器(从 js/logger.js 迁移)
// 原版写本地 log/ 目录(经 serve.js); 新版缓冲后 flush 到 /api/sessions → Supabase
// 用途: 会话云端持久化(替代 log/jsonl) + 收集交互数据帮助项目迭代
//
// 设计: 可实例化, 每个会话一个 Logger, 绑定 sessionId + mode + user。
// 缓冲事件, 定时批量 POST; flush 失败静默降级(不阻塞 UI), 事件留在缓冲下次再试。

export class Logger {
  private sessionId = '';
  private buffer: any[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly MAX_BUFFER = 3000;
  private enabled = true;

  setSession(sessionId: string, _meta: Record<string, any> = {}) {
    this.sessionId = sessionId;
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
    try {
      const resp = await fetch('/api/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'append', sessionId: this.sessionId, events: batch }),
        keepalive: true,
      });
      if (!resp.ok) {
        // 失败: 放回缓冲下次再试(尾部, 保序)
        this.buffer = [...batch, ...this.buffer];
      }
    } catch (e) {
      this.buffer = [...batch, ...this.buffer];
    }
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
