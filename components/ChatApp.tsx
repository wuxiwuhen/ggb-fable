'use client';

// 主应用编排组件(替代 app.js 的 send/agent loop/streaming/trace/recipe/session 全流程)
// 三大流程:
//   1) 发送 → Agent 工具循环 → 流式渲染 → 画布更新 → 工具轨迹 → 会话持久化 → 重建脚本
//   2) 图片上传 → OCR → 回填输入框(两步解耦, 用户校对后再发)
//   3) 模式切换(trial 后端代理+限额 / byok 前端直连)

import { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import Link from 'next/link';
import { useAuth } from '@/lib/auth';
import { useConfigStore } from '@/lib/config-store';
import { Logger } from '@/lib/logger';
import { CommandSearch, type EmbedFunction } from '@/lib/command-search';
import { AgentEngine, type AgentBackend } from '@/lib/agent';
import { makeTrialBackend, makeByokBackend } from '@/lib/agent-backend';
import { makeTrialEmbed, makeByokEmbed } from '@/lib/embed';
import { chatTrial, visionTrial, visionByok, type TrialContext } from '@/lib/llm';
import { Vision } from '@/lib/vision';
import { Condenser } from '@/lib/condenser';
import { useGeogebra } from '@/hooks/useGeogebra';
import MessageContent from './MessageContent';
import TracePanel, { type TraceItem, type ExecLine } from './TracePanel';
import CommandBar from './CommandBar';
import { useSessionStore } from '@/lib/session-store';
import { rebuildChatMessages, rebuildTrace, rebuildHistory, extractReplayCommands, rebuildExecLines, type ApiMessage } from '@/lib/conversation';
import SessionSidebar from './SessionSidebar';

interface Msg {
  id: number;
  role: 'user' | 'assistant' | 'system';
  content: string;
  streaming?: boolean;
}

const EXAMPLES = [
  { label: '三角形内角和', prompt: '画一个三角形 ABC, 标注三个内角, 并测量内角和' },
  { label: '二次函数', prompt: '画抛物线 y = x^2 - 4x + 3, 标出顶点、与 x 轴交点' },
  { label: '动态圆', prompt: '用一个滑块 a 控制圆的半径, 展示圆随半径变化' },
  { label: '三角函数', prompt: '画单位圆和角 θ 的终边, 展示 sin/cos 的几何意义' },
];

let msgId = 0;

// 工具名 → 用户友好的进度文案(发送后到首条有效文本之间, 据当前正在执行的工具显示进度)
const TOOL_STATUS: Record<string, string> = {
  get_canvas_context: '正在读取画布',
  search_command: '正在检索命令',
  execute_command: '正在构造图形',
  verify_geometry: '正在验证几何关系',
  inspect_render: '正在检查渲染效果',
  reset_canvas: '正在清空画布',
};

function ThinkingIndicator({ trace }: { trace: TraceItem[] }) {
  const last = trace[trace.length - 1];
  const busy = !!(last && last.result == null && TOOL_STATUS[last.name]);
  return (
    <div className="thinking">
      <span className="thinking-dots"><i /><i /><i /></span>
      <span>{(busy && last && TOOL_STATUS[last.name]) || '正在思考'}…</span>
    </div>
  );
}

export default function ChatApp() {
  const { user, isAdmin, adminLoading, signOut } = useAuth();
  const config = useConfigStore();
  const { sessions, currentSessionId, setSessions, setCurrent, upsert, patchCurrent } = useSessionStore();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [sessionsLoading, setSessionsLoading] = useState(true);

  // ── 引擎实例(单例) ──
  const loggerRef = useRef<Logger>(new Logger());
  const { containerRef, ggb: ggbRef, ready: ggbReady, error: ggbError } = useGeogebra(loggerRef.current);

  const csRef = useRef<CommandSearch | null>(null);
  const agentRef = useRef<AgentEngine | null>(null);

  // embed 随 mode 动态切换(一个 CommandSearch 实例, 内部缓存复用)
  const embedFn = useMemo<EmbedFunction>(() => async (texts) => {
    const st = useConfigStore.getState();
    if (st.mode === 'trial') return makeTrialEmbed()(texts);
    return (makeByokEmbed(st.getActiveByok()) || (async () => null))(texts);
  }, []);

  // 初始化 command search + agent(ggb 就绪后)
  useEffect(() => {
    if (!ggbReady || !ggbRef.current) return;
    if (!csRef.current) {
      const cs = new CommandSearch(embedFn);
      cs.init();
      csRef.current = cs;
    }
    if (!agentRef.current) {
      agentRef.current = new AgentEngine({ ggb: ggbRef.current, commandSearch: csRef.current, logger: loggerRef.current });
    }
  }, [ggbReady, embedFn, ggbRef]);

  // ── UI 状态 ──
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [trace, setTrace] = useState<TraceItem[]>([]);
  const [execLines, setExecLines] = useState<ExecLine[]>([]);
  const [commandLog, setCommandLog] = useState<Array<{ cmd: string; ok: boolean; labels: string; error: string; ephemeral?: boolean }>>([]);
  const [recipe, setRecipe] = useState<string[] | null>(null);
  const [recipeLoading, setRecipeLoading] = useState(false);
  const [usage, setUsage] = useState<{ used: number; limit: number; remaining: number } | null>(null);
  const [error, setError] = useState('');
  const [ocrLoading, setOcrLoading] = useState(false);
  const [imgPreview, setImgPreview] = useState<string | null>(null);

  const [history, setHistory] = useState<any[]>([]);     // Agent 上下文(截断 8 条)
  const trialTokenRef = useRef<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  // 流式 token 缓冲 + rAF 批量 flush(避免每个 token 一次 setState)
  const streamBuf = useRef<{ id: number; text: string } | null>(null);
  const rafRef = useRef<number | null>(null);
  const flushStream = useCallback(() => {
    rafRef.current = null;
    const buf = streamBuf.current;
    if (!buf) return;
    setMessages((prev) => prev.map((m) => (m.id === buf.id ? { ...m, content: buf.text } : m)));
  }, []);
  const scheduleFlush = useCallback(() => {
    if (rafRef.current == null) rafRef.current = requestAnimationFrame(flushStream);
  }, [flushStream]);

  // trial context(getter 实时读 ref, setToken 写 ref)
  const trialCtx = useMemo<TrialContext>(() => ({
    get token() { return trialTokenRef.current; },
    setToken: (t) => { trialTokenRef.current = t; },
  }), []);

  // ── 会话管理(云端) ──

  // 新建空会话: create → 清空 state + 画布 → 设为当前
  const newSession = useCallback(async () => {
    // 已有会话且当前是空画布+无消息 → 无需重复新建
    if (currentSessionId && messages.length === 0 && !(ggbRef.current?.getCommandLog() || []).length) return;
    abortRef.current?.abort();
    setError('');
    const res = await fetch('/api/sessions', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'create', mode: config.mode, model: config.mode === 'trial' ? 'deepseek' : config.getActiveByok()?.model_name }),
    });
    const data = await res.json();
    const id: string = data.id;
    setMessages([]); setTrace([]); setExecLines([]); setCommandLog([]); setRecipe(null); setHistory([]);
    await ggbRef.current?.clearAll();
    const now = new Date().toISOString();
    upsert({ id, title: null, mode: config.mode, model: null, created_at: now, updated_at: now });
    setCurrent(id);
    loggerRef.current.setSession(id);          // 修复: logger 绑定 sessionId
    setSidebarOpen(false);
    return id;
  }, [config, setSessions, setCurrent, upsert]);

  // 清空工作区(不建新会话): 保留当前 sessionId, 只清画布+聊天, 侧边栏不变
  const clearWorkspace = useCallback(async () => {
    if (!currentSessionId) return;
    if (messages.length === 0 && !(ggbRef.current?.getCommandLog() || []).length) return;
    abortRef.current?.abort();
    setError('');
    setMessages([]);
    setTrace([]);
    setExecLines([]);
    setCommandLog([]);
    setRecipe(null);
    setHistory([]);
    await ggbRef.current?.clearAll();
  }, [currentSessionId, messages]);

  // 切换会话: 加载 → 重建 chat/trace/history → 重放画布 → 设为当前
  const switchSession = useCallback(async (id: string) => {
    if (id === currentSessionId) return;
    abortRef.current?.abort();
    setError('');
    try {
      const res = await fetch(`/api/sessions?id=${id}`, { cache: 'no-store' });
      if (!res.ok) return;
      const { session, messages }: { session: any; messages: ApiMessage[] } = await res.json();
      // 重建运行态
      const chatMsgs = rebuildChatMessages(messages);
      setMessages(chatMsgs.map((m, i) => ({ id: ++msgId, role: m.role, content: m.content })));
      setTrace(rebuildTrace(messages).map((t) => ({ id: ++msgId, ...t })));
      setHistory(rebuildHistory(messages));
      setExecLines(rebuildExecLines(messages));
      // 恢复画布: recipe 优先, 没有则回退重放 execute_command 命令
      await ggbRef.current?.clearAll();
      const recipe: string[] | null = session?.recipe ? (Array.isArray(session.recipe) ? session.recipe : null) : null;
      const cmds = recipe && recipe.length ? recipe : extractReplayCommands(messages);
      setRecipe(recipe && recipe.length ? recipe : null);
      if (cmds.length) {
        try { await ggbRef.current?.execBatch(cmds.join('\n')); } catch (e) { console.warn('画布重放失败:', e); }
      }
      setCommandLog(ggbRef.current?.getCommandLog() || []);
      setCurrent(id);
      loggerRef.current.setSession(id);
    } catch (e) {
      setError('切换会话失败: ' + (e as any).message);
    }
    setSidebarOpen(false);
  }, [currentSessionId, setCurrent]);

  // 首次进入: 加载会话列表, 无则建空会话; 绑定 logger sessionId
  useEffect(() => {
    if (!ggbReady) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/sessions', { cache: 'no-store' });
        const data = await res.json();
        const list: any[] = data.sessions || [];
        if (cancelled) { setSessionsLoading(false); return; }
        setSessions(list);
        setSessionsLoading(false);
      } catch (e) {
        console.warn('加载会话失败:', e);
        setSessionsLoading(false);
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ggbReady]);

  // ── 额度(仅 trial 模式) ──
  const fetchUsage = useCallback(async () => {
    try {
      const resp = await fetch('/api/usage');
      if (resp.ok) setUsage(await resp.json());
    } catch (e) { /* 静默 */ }
  }, []);
  useEffect(() => { if (config.mode === 'trial') fetchUsage(); }, [config.mode, fetchUsage]);

  // 构建 backend
  const buildBackend = useCallback((): AgentBackend => {
    if (config.mode === 'trial') return makeTrialBackend(trialCtx);
    const profile = config.getActiveByok();
    if (!profile) throw new Error('BYOK 未配置, 请到设置页填写');
    return makeByokBackend(profile, config.vision);
  }, [config, trialCtx]);

  // ── 发送 ──
  const send = useCallback(async () => {
    const text = input.trim();
    if (!text || sending) return;
    if (sessionsLoading) return;
    if (!useSessionStore.getState().currentSessionId) await newSession();  // 惰性创建
    if (!ggbRef.current || !agentRef.current) { setError('画布未就绪'); return; }

    // 校验
    if (config.mode === 'trial') {
      if (!isAdmin && usage && usage.remaining <= 0) {
        setError('试用次数已用完, 可切换到"自带 Key"模式继续使用');
        return;
      }
    } else {
      if (!config.isByokValid()) { setError('请先在设置页配置 BYOK 模型'); return; }
    }

    setError('');
    setTrace([]);
    setExecLines([]);
    trialTokenRef.current = null;   // 新意图, 首次扣 1 次

    // user 消息
    const userMsg: Msg = { id: ++msgId, role: 'user', content: text };
    const assistantMsg: Msg = { id: ++msgId, role: 'assistant', content: '', streaming: true };
    setMessages((prev) => [...prev, userMsg, assistantMsg]);
    setInput('');
    setSending(true);
    // 首条消息后, 后台生成会话标题(当前会话无标题时)
    const sid = useSessionStore.getState().currentSessionId;
    if (sid && !useSessionStore.getState().sessions.find((s) => s.id === sid)?.title) {
      generateTitle(text, sid);
    }
    loggerRef.current.userTurn(text);

    streamBuf.current = { id: assistantMsg.id, text: '' };
    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const backend = buildBackend();
      const result = await agentRef.current.run({
        userInput: text,
        history,
        config: { max_tool_rounds: config.maxToolRounds },
        backend,
        signal: controller.signal,
        hooks: {
          onToken: (delta) => {
            if (streamBuf.current) { streamBuf.current.text += delta; scheduleFlush(); }
          },
          onToolStart: (name, args) => {
            setTrace((prev) => [...prev, { id: ++msgId, name, args, result: null }]);
          },
          onToolEnd: (name, args, res) => {
            setTrace((prev) => prev.map((t, i) => (i === prev.length - 1 ? { ...t, result: res } : t)));
          },
          onExec: (cmd, r) => {
            setExecLines((prev) => [...prev, { cmd, result: r }]);
            setCommandLog(ggbRef.current?.getCommandLog() || []);
          },
        },
      });

      // 完成: 更新 assistant 消息
      if (rafRef.current != null) { cancelAnimationFrame(rafRef.current); rafRef.current = null; }
      flushStream();
      setMessages((prev) => prev.map((m) => (m.id === assistantMsg.id ? { ...m, content: result.finalText, streaming: false } : m)));

      // history 累积(截断 8 条, 只存文本)
      const newHistory = [...history, { role: 'user', content: text }, { role: 'assistant', content: result.finalText }].slice(-8);
      setHistory(newHistory);

      // 刷新额度
      if (config.mode === 'trial') fetchUsage();
      loggerRef.current.flush();

      // 后台生成重建脚本
      if (!result.stopped) generateRecipe(backend);
    } catch (e: any) {
      if (e.message === 'TRIAL_EXHAUSTED') {
        setError('试用次数已用完, 可切换到"自带 Key"模式继续使用');
        fetchUsage();
      } else if (e.message === '已中止') {
        // 用户主动停止, 保留已生成内容
      } else {
        setError(e.message || String(e));
      }
      setMessages((prev) => prev.map((m) => (m.id === assistantMsg.id ? { ...m, streaming: false, content: m.content || '（出错）' } : m)));
    } finally {
      setSending(false);
      streamBuf.current = null;
    }
  }, [input, sending, config, usage, history, buildBackend, scheduleFlush, flushStream, fetchUsage, ggbRef]);

  // 重建脚本(后台, 复用 trial token 免重复扣)
  const generateRecipe = useCallback(async (backend: AgentBackend) => {
    const log = ggbRef.current?.getCommandLog() || [];
    if (!log.length) return;
    setRecipeLoading(true);
    try {
      const res = await Condenser.run(log, (p) => backend.chat(p));
      const cmds = res.commands.length ? res.commands : null;
      setRecipe(cmds);
      // 持久化 recipe 到当前会话(供切换重放)
      const sid = useSessionStore.getState().currentSessionId;
      if (cmds && sid) {
        fetch('/api/sessions', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'update', id: sid, recipe: cmds }),
        }).catch(() => {});
      }
    } catch (e) { /* 静默 */ } finally { setRecipeLoading(false); }
  }, [ggbRef]);

  // 手动保存编辑后的重建脚本: 写 state + 持久化到当前会话(供切换/刷新重放)
  const saveRecipe = useCallback(async (lines: string[]) => {
    setRecipe(lines.length ? lines : null);
    const sid = useSessionStore.getState().currentSessionId;
    if (!sid) return;
    try {
      await fetch('/api/sessions', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'update', id: sid, recipe: lines }),
      });
    } catch (e) {
      console.warn('保存重建脚本失败:', e);
    }
  }, []);

  // 后台生成标题并更新会话(trial 走 /api/trial/title 不扣次数; byok 用用户 key)
  const generateTitle = useCallback(async (text: string, sessionId: string) => {
    try {
      let title = '';
      if (config.mode === 'trial') {
        const res = await fetch('/api/trial/title', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text }),
        });
        if (res.ok) title = (await res.json()).title || '';
      } else {
        const prof = config.getActiveByok();
        if (prof) {
          const { chatByok } = await import('@/lib/llm');
          const msg = await chatByok({
            messages: [
              { role: 'system', content: '给下面这段数学问题生成一个不超过15字的中文标题, 只输出标题文本。' },
              { role: 'user', content: text.slice(0, 500) },
            ],
            config: { api_key: prof.api_key, base_url: prof.base_url, model_name: prof.model_name },
          });
          title = (msg.content || '').trim().slice(0, 15);
        }
      }
      if (title) {
        await fetch('/api/sessions', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'update', id: sessionId, title }),
        });
        patchCurrent({ title });
      }
    } catch (e) { /* 标题失败不阻塞 */ }
  }, [config, patchCurrent]);

  const stop = useCallback(() => { abortRef.current?.abort(); }, []);

  const replay = useCallback(async (lines: string[]) => {
    if (!ggbRef.current) return;
    await ggbRef.current.clearAll();
    await ggbRef.current.execBatch(lines.join('\n'));
    setCommandLog(ggbRef.current.getCommandLog());
  }, [ggbRef]);

  // ── 图片 OCR ──
  const handleImage = useCallback(async (file: File) => {
    if (config.mode === 'trial') {
      // 直接走后端视觉代理
    } else if (!config.isVisionValid()) {
      setError('BYOK 模式未配置视觉模型, 请到设置页填写');
      return;
    }
    setError('');
    setOcrLoading(true);
    try {
      const dataUrl = await Vision.compress(file);
      setImgPreview(dataUrl);
      const text = await Vision.recognize({
        image: dataUrl,
        visionFn: config.mode === 'trial'
          ? (img, prompt, sig) => visionTrial({ image: img, prompt, trialCtx, signal: sig })
          : (img, prompt, sig) => visionByok(config.vision as any, { image: img, prompt, signal: sig }),
      });
      setInput(text);
      setImgPreview(null);
    } catch (e: any) {
      setError('图片识别失败: ' + (e.message || e));
    } finally {
      setOcrLoading(false);
    }
  }, [config, trialCtx]);

  const remaining = config.mode === 'trial' ? (usage?.remaining ?? null) : null;
  const canSend = config.mode === 'trial' ? (isAdmin || remaining === null || remaining > 0) : config.isByokValid();

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <Link href="/" className="brand-link">
            <span className="logo">📐</span>
            <span className="title">GGB Fable</span>
          </Link>
          <button className="btn ghost" title="对话列表" onClick={() => setSidebarOpen(true)}>☰</button>
          <button className="btn ghost" title="清空工作区" onClick={clearWorkspace}>+</button>
        </div>
        <div className="top-actions">
          {/* 模式切换 */}
          <div className="mode-switch">
            <button className={config.mode === 'trial' ? 'active' : ''} onClick={() => config.setMode('trial')}>免费试用</button>
            <button className={config.mode === 'byok' ? 'active' : ''} onClick={() => config.setMode('byok')}>自带 Key</button>
          </div>
          {config.mode === 'trial' && usage && !adminLoading && !isAdmin && (
            <span className={`usage-badge ${remaining === 0 ? 'exhausted' : ''}`} title="剩余试用次数">
              剩余 {remaining}/{usage.limit}
            </span>
          )}
          {config.mode === 'trial' && !adminLoading && isAdmin && (
            <span className="usage-badge" title="管理员不限次数">管理员 ∞</span>
          )}
          {!adminLoading && isAdmin && <Link className="btn ghost" href="/admin">🛠 管理</Link>}
          <Link className="btn ghost" href="/settings">⚙ 设置</Link>
          <button className="btn ghost" onClick={() => exportPng(ggbRef.current)}>⬇ PNG</button>
          <button className="btn ghost" onClick={() => signOut()}>退出</button>
        </div>
      </header>

      <SessionSidebar open={sidebarOpen} onClose={() => setSidebarOpen(false)} onNew={clearWorkspace} onSwitch={switchSession} />
      <main className="layout">
        <section className="pane chat-pane">
          <CommandBar
            commandLog={commandLog}
            recipe={recipe}
            onGenerateRecipe={async () => { if (agentRef.current) generateRecipe(buildBackend()); }}
            onReplay={replay}
            onSaveRecipe={saveRecipe}
            recipeLoading={recipeLoading}
          />

          <div className="messages">
            {messages.length === 0 && (
              <div className="welcome">
                <h2>用自然语言画数学图形</h2>
                <p>{user?.email ? `${user.email}，` : ''}描述你想画的图形，AI 会构造可拖动、可探究的动态画布。</p>
                <div className="examples">
                  {EXAMPLES.map((ex) => (
                    <button key={ex.label} className="chip" onClick={() => setInput(ex.prompt)}>{ex.label}</button>
                  ))}
                </div>
              </div>
            )}
            {messages.map((m) => (
              <div key={m.id} className={`msg ${m.role}`}>
                {m.role === 'system' ? (
                  <div className="msg-content">{m.content}</div>
                ) : m.role === 'assistant' && m.streaming && !m.content ? (
                  <ThinkingIndicator trace={trace} />
                ) : (
                  <MessageContent content={m.content || ''} />
                )}
              </div>
            ))}
          </div>

          <div className="composer">
            {error && <div className="error-banner">{error}</div>}
            <div className="input-box">
              {(imgPreview || ocrLoading) && (
                <div className="media-row">
                  {imgPreview && <img src={imgPreview} className="img-preview" alt="预览" />}
                  {ocrLoading && <span className="ocr-status"><span className="spinner" />识别图片中…</span>}
                </div>
              )}
              <textarea
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') send(); }}
                placeholder="描述你想画的数学图形，例如：画一个圆心在原点、半径为 3 的圆…"
                rows={3}
              />
              <div className="toolbar">
                <button className="icon-btn" title="上传数学题图片（OCR 识别）" aria-label="上传图片"
                  onClick={() => document.getElementById('image-file-input')?.click()} disabled={ocrLoading}>
                  <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="3" y="3" width="18" height="18" rx="3" />
                    <circle cx="8.5" cy="8.5" r="1.6" />
                    <path d="M21 15l-5-5L5 21" />
                  </svg>
                </button>
                <div className="toolbar-spacer" />
                {!sending ? (
                  <button className="send-btn" onClick={send} disabled={!canSend || !input.trim()} title="发送" aria-label="发送">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M12 19V6M6 12l6-6 6 6" />
                    </svg>
                  </button>
                ) : (
                  <button className="send-btn stop" onClick={stop} title="停止" aria-label="停止">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                      <rect x="5" y="5" width="14" height="14" rx="2.5" />
                    </svg>
                  </button>
                )}
              </div>
            </div>
            <input id="image-file-input" type="file" accept="image/*" hidden
              onChange={(e) => { const f = e.target.files?.[0]; if (f) handleImage(f); e.target.value = ''; }} />
            <div className="status">
              {config.mode === 'byok' && !config.isByokValid() ? '⚠ 未配置 BYOK 模型，请到设置页填写' : '就绪 · Cmd/Ctrl+Enter 发送'}
            </div>
          </div>
        </section>

        <section className="pane canvas-pane">
          <div className="canvas-wrap" ref={containerRef as any}>
            <div id="ggb-container" />
            {!ggbReady && <div className="canvas-loading">{ggbError || '正在加载 GeoGebra 画布…'}</div>}
          </div>
          {!adminLoading && isAdmin && <TracePanel trace={trace} execLines={execLines} />}
        </section>
      </main>
    </div>
  );
}

function exportPng(ggb: any) {
  if (!ggb) return;
  const base64 = ggb.getPNGBase64(2, false, 200);
  if (!base64) return;
  const a = document.createElement('a');
  a.href = base64.startsWith('data:') ? base64 : `data:image/png;base64,${base64}`;
  a.download = `ggb-fable-${Date.now()}.png`;
  a.click();
}
