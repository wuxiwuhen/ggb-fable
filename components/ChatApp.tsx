'use client';

// 主应用编排组件(替代 app.js 的 send/agent loop/streaming/trace/session 全流程)
// 三大流程:
//   1) 发送 → Agent 工具循环 → 流式渲染 → 画布更新 → 工具轨迹 → 会话持久化
//   2) 图片上传 → OCR → 回填输入框(两步解耦, 用户校对后再发)
//   3) 模式切换(trial 后端代理+限额 / byok 前端直连)

import { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import Link from 'next/link';
import { useAuth } from '@/lib/auth';
import { useConfigStore } from '@/lib/config-store';
import { Logger } from '@/lib/logger';
import { CommandSearch, type EmbedFunction, makeEmbeddingModelKey, TRIAL_MODEL_KEY } from '@/lib/command-search';
import { AgentEngine, type AgentBackend } from '@/lib/agent';
import { makeTrialBackend, makeByokBackend } from '@/lib/agent-backend';
import { makeTrialEmbed, makeByokEmbed } from '@/lib/embed';
import { chatTrial, visionTrial, visionByok, type TrialContext } from '@/lib/llm';
import { Vision } from '@/lib/vision';
import { useGeogebra } from '@/hooks/useGeogebra';
import { exportPng, startRecording, stopRecording, recordingFormat } from '@/lib/export-media';
import MessageContent from './MessageContent';
import TracePanel, { type TraceItem, type ExecLine } from './TracePanel';
import CommandBar from './CommandBar';
import { useSessionStore, getLastSessionId } from '@/lib/session-store';
import { rebuildChatMessages, rebuildTrace, rebuildHistory, extractReplayCommands, rebuildExecLines, type ApiMessage } from '@/lib/conversation';
import SessionSidebar from './SessionSidebar';
import OnboardingTour from './OnboardingTour';
import { useOnboarding } from '@/hooks/useOnboarding';
import { buildTourSteps, type TourCtx } from '@/lib/onboarding-steps';

interface Msg {
  id: number;
  role: 'user' | 'assistant' | 'system';
  content: string;
  streaming?: boolean;
  image?: string;   // user 附图(data URL), 仅当轮显示, 不持久化(重载后以识别文本回显)
  ocr?: { state: 'loading' | 'done' | 'error'; text?: string; error?: string; expanded?: boolean };
}

const EXAMPLES = [
  { label: '三角形内角和', prompt: '画一个三角形 ABC, 标注三个内角, 并测量内角和' },
  { label: '二次函数', prompt: '画抛物线 y = x^2 - 4x + 3, 标出顶点、与 x 轴交点' },
  { label: '动态圆', prompt: '用一个滑块 a 控制圆的半径, 展示圆随半径变化' },
  { label: '三角函数', prompt: '画单位圆和角 θ 的终边, 展示 sin/cos 的几何意义' },
];

let msgId = 0;

// 工具名 → 阶段名词(输出气泡首字文本前, 把工具调用映射成可见的过程阶段)
const PHASE_LABEL: Record<string, string> = {
  get_canvas_context: '读取画布',
  search_command: '检索命令',
  execute_command: '构造图形',
  verify_geometry: '几何验证',
  inspect_render: '视觉核验',
  reset_canvas: '清空画布',
};

// 输出气泡"首字文本前"的过程面板: 图片识别阶段 + 各工具阶段(✓完成 / ⟳进行中), 全空则"正在思考…"
function AssistantProgress({ msg, trace }: { msg: Msg; trace: TraceItem[] }) {
  const phases = trace.filter((t) => PHASE_LABEL[t.name]);
  const ocrLoading = msg.ocr?.state === 'loading';
  const showThinking = !ocrLoading && phases.length === 0;
  return (
    <div className="assistant-progress">
      {ocrLoading && (
        <div className="phase-item active"><span className="spinner" /><span>图片识别中…</span></div>
      )}
      {phases.map((t, i) => {
        const active = t.result == null;
        return (
          <div key={i} className={`phase-item ${active ? 'active' : 'done'}`}>
            {active ? <span className="spinner" /> : <span className="phase-check">✓</span>}
            <span>{PHASE_LABEL[t.name]}{active ? '…' : ''}</span>
          </div>
        );
      })}
      {showThinking && (
        <div className="phase-item active"><span className="spinner" /><span>正在思考…</span></div>
      )}
    </div>
  );
}

export default function ChatApp() {
  const { user, isAdmin, adminLoading, signOut } = useAuth();
  const config = useConfigStore();
  const { sessions, currentSessionId, setSessions, setCurrent, upsert, patchCurrent } = useSessionStore();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const { active, setActive, autoStartIfDue, start, markSeen } = useOnboarding();
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
    const embCfg = st.getEmbeddingConfig();
    if (embCfg) return makeByokEmbed(embCfg)(texts);
    return null;  // keyword-only
  }, []);

  // 初始化 command search + agent(ggb 就绪后)
  useEffect(() => {
    if (!ggbReady || !ggbRef.current) return;
    if (!csRef.current) {
      const st = useConfigStore.getState();
      const modelKey = st.mode === 'trial'
        ? TRIAL_MODEL_KEY
        : st.getEmbeddingConfig()
          ? makeEmbeddingModelKey(
              st.getEmbeddingConfig()!.base_url,
              st.getEmbeddingConfig()!.model_name,
              st.getEmbeddingConfig()!.dimensions || 1024)
          : '';
      const cs = new CommandSearch(embedFn);
      cs.init(modelKey);
      csRef.current = cs;
    }
    if (!agentRef.current) {
      agentRef.current = new AgentEngine({ ggb: ggbRef.current, commandSearch: csRef.current, logger: loggerRef.current });
    }
  }, [ggbReady, embedFn, ggbRef]);

  // ── UI 状态 ──
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState('');
  const inputRef = useRef(input);
  inputRef.current = input;
  const tourPrefilledRef = useRef(false);
  const [sending, setSending] = useState(false);
  const [trace, setTrace] = useState<TraceItem[]>([]);
  const [execLines, setExecLines] = useState<ExecLine[]>([]);
  const [usage, setUsage] = useState<{ used: number; limit: number; remaining: number } | null>(null);
  const [error, setError] = useState('');
  const [imgPreview, setImgPreview] = useState<string | null>(null);
  const [lightbox, setLightbox] = useState<string | null>(null);   // 点气泡图片放大查看(null=关闭)

  // ── 导出菜单状态 ──
  const [exportOpen, setExportOpen] = useState(false);
  const [recording, setRecording] = useState(false);
  const exportMenuRef = useRef<HTMLDivElement>(null);


  // 仅首次调用生效(用于新手引导第2步预填示例, 上一步返回时不重填)
  const prefillDemo = useCallback((text: string) => {
    if (!tourPrefilledRef.current) {
      setInput(text);
      tourPrefilledRef.current = true;
    }
  }, []);

  const tourCtx: TourCtx = {
    setSidebarOpen,
    setExportOpen,
    setInput,
    getInput: () => inputRef.current,
    prefillDemo,
  };

  const [history, setHistory] = useState<any[]>([]);     // Agent 上下文(截断 8 条)
  const trialTokenRef = useRef<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  // ── 画布 XML 快照持久化 ──
  const restoringRef = useRef(false);                                   // restore 期间抑制捕获
  const persistTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // NOTE: 不在此处检查 restoringRef —— switchSession 的老会话自愈路径故意在 restoringRef=true 时调用本函数;
  // 防止过渡期误写的正确做法是 cancelPersist()(在 clearAll 前清掉待触发的防抖定时器), 而非在此 guard。
  const persistCanvasXml = useCallback(async () => {
    const sid = useSessionStore.getState().currentSessionId;
    if (!sid || !ggbRef.current) return;
    const xml = ggbRef.current.getXML();
    if (!xml) return;
    try {
      await fetch('/api/sessions', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'update', id: sid, canvas_xml: xml }),
      });
    } catch (e) { console.warn('画布快照持久化失败:', e); }
  }, [ggbRef]);
  const schedulePersist = useCallback(() => {
    if (restoringRef.current) return;                                   // 恢复期间不捕获
    if (persistTimerRef.current) clearTimeout(persistTimerRef.current);
    persistTimerRef.current = setTimeout(() => { void persistCanvasXml(); }, 800);
  }, [persistCanvasXml]);
  // 清掉待触发的防抖定时器: 切会话/新建/清空/卸载前调用, 防止过渡期误写脏 XML
  const cancelPersist = useCallback(() => {
    if (persistTimerRef.current) { clearTimeout(persistTimerRef.current); persistTimerRef.current = null; }
  }, []);

  // 手工绘制监听: onUpdate(add/remove/update) + onCommand(execCommand) → 防抖落 XML
  // GGB 实例整会话稳定(reinit 不换实例), subscribedRef 保证只订阅一次
  const subscribedRef = useRef(false);
  useEffect(() => {
    if (!ggbReady || !ggbRef.current || subscribedRef.current) return;
    subscribedRef.current = true;
    ggbRef.current.onUpdate(() => schedulePersist());
    ggbRef.current.onCommand(() => schedulePersist());
    return () => { cancelPersist(); };
  }, [ggbReady, schedulePersist, cancelPersist]);

  // 离开页面兜底: sendBeacon 同步落当前画布 XML
  useEffect(() => {
    const onUnload = () => {
      const sid = useSessionStore.getState().currentSessionId;
      if (!sid || !ggbRef.current) return;
      const xml = ggbRef.current.getXML();
      if (!xml) return;
      try {
        navigator.sendBeacon('/api/sessions', new Blob(
          [JSON.stringify({ action: 'update', id: sid, canvas_xml: xml })],
          { type: 'application/json' },
        ));
      } catch (e) { /* 静默 */ }
      cancelPersist();
    };
    window.addEventListener('beforeunload', onUnload);
    return () => window.removeEventListener('beforeunload', onUnload);
  }, [ggbRef, cancelPersist]);

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

  // ── 导出菜单:点外部关闭 ──
  useEffect(() => {
    if (!exportOpen) return;
    const onDown = (e: MouseEvent) => {
      if (exportMenuRef.current && !exportMenuRef.current.contains(e.target as Node)) setExportOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [exportOpen]);


  // ── 新手引导: 每次 tour 启动/重启时重置预填标记, 让第2步能再次预填 ──
  useEffect(() => { tourPrefilledRef.current = false; }, [active]);

  // ── 导出: 视频录制开始/停止(MP4 优先, WebM 兜底) ──
  const toggleRecord = useCallback(() => {
    if (recording) {
      stopRecording(ggbRef.current);
      setRecording(false);
      setError('');
    } else {
      const ok = startRecording(ggbRef.current);
      if (!ok) {
        setError('当前浏览器不支持视频录制, 请换 Chrome/Edge/Firefox, 或画布未就绪。');
        return;
      }
      setRecording(true);
      setError('');
      setExportOpen(false);
    }
  }, [recording]);

  // ── 会话管理(云端) ──

  // 新建空会话: create → 清空 state + 画布 → 设为当前
  const newSession = useCallback(async () => {
    // 已有会话且当前是空画布+无消息 → 无需重复新建
    if (currentSessionId && messages.length === 0 && !(ggbRef.current?.getCommandLog() || []).length) return;
    // 离开前持久化当前会话画布(防手工内容丢失)
    if (currentSessionId) await persistCanvasXml();
    cancelPersist();
    abortRef.current?.abort();
    setError('');
    const res = await fetch('/api/sessions', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'create', mode: config.mode, model: config.mode === 'trial' ? 'deepseek' : config.getActiveByok()?.model_name }),
    });
    const data = await res.json();
    const id: string = data.id;
    setMessages([]); setTrace([]); setExecLines([]); setHistory([]);
    await ggbRef.current?.clearAll();
    const now = new Date().toISOString();
    upsert({ id, title: null, mode: config.mode, model: null, created_at: now, updated_at: now });
    setCurrent(id);
    loggerRef.current.setSession(id);          // 修复: logger 绑定 sessionId
    setSidebarOpen(false);
    return id;
  }, [config, setSessions, setCurrent, upsert, cancelPersist, persistCanvasXml]);

  const clearWorkspace = useCallback(async () => {
    if (!currentSessionId) return;
    if (messages.length === 0 && !(ggbRef.current?.getCommandLog() || []).length) return;
    // 清空前持久化当前画布(防手工内容丢失)
    await persistCanvasXml();
    cancelPersist();
    abortRef.current?.abort();
    setError('');
    setMessages([]);
    setTrace([]);
    setExecLines([]);
    setHistory([]);
    await ggbRef.current?.clearAll();
    setCurrent(null);   // 解除侧边栏选中(旧会话已清空, 不算当前)
  }, [currentSessionId, messages, cancelPersist, persistCanvasXml, setCurrent]);

  // 切换会话: 先持久化离开的会话 → 加载 → 重建 chat/trace/history → setXML 还原画布 → 设为当前
  const switchSession = useCallback(async (id: string) => {
    if (id === currentSessionId) return;
    cancelPersist();
    abortRef.current?.abort();
    setError('');
    try {
      await persistCanvasXml();           // 离开前持久化"当前"会话画布(用旧 currentSessionId)
      const res = await fetch(`/api/sessions?id=${id}`, { cache: 'no-store' });
      if (!res.ok) return;
      const { session, messages }: { session: any; messages: ApiMessage[] } = await res.json();
      // 重建运行态
      const chatMsgs = rebuildChatMessages(messages);
      setMessages(chatMsgs.map((m, i) => ({ id: ++msgId, role: m.role, content: m.content })));
      setTrace(rebuildTrace(messages).map((t) => ({ id: ++msgId, ...t })));
      setHistory(rebuildHistory(messages));
      setExecLines(rebuildExecLines(messages));
      setCurrent(id);                      // 切到新会话(后续自愈 persistCanvasXml 用新 id)
      loggerRef.current.setSession(id);
      restoringRef.current = true;         // 抑制 setXML 触发的监听事件回写
      try {
        await ggbRef.current?.clearAll();
        if (session?.canvas_xml) {
          try { ggbRef.current?.setXML(session.canvas_xml); }
          catch (e) { console.warn('画布 setXML 恢复失败:', e); }
        } else {
          // 老会话回退: recipe 或原始命令重放, 成功后自愈落 XML, 下次直接 setXML
          const cmds: string[] = Array.isArray(session?.recipe) && session.recipe.length
            ? session.recipe : extractReplayCommands(messages);
          if (cmds.length) {
            try { await ggbRef.current?.execBatch(cmds.join('\n')); } catch (e) { console.warn('画布重放失败:', e); }
          }
          void persistCanvasXml();         // 自愈(currentSessionId 已是 id)
        }
      } finally {
        restoringRef.current = false;
      }
    } catch (e) {
      setError('切换会话失败: ' + (e as any).message);
    }
    setSidebarOpen(false);
  }, [currentSessionId, setCurrent, persistCanvasXml, cancelPersist]);

  // 首次进入: 加载会话列表, 无则建空会话; 绑定 logger sessionId
  useEffect(() => {
    if (!ggbReady) return;
    autoStartIfDue();   // 首次进入: 未看过基础教程则启动
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/sessions', { cache: 'no-store' });
        const data = await res.json();
        const list: any[] = data.sessions || [];
        if (cancelled) { setSessionsLoading(false); return; }
        setSessions(list);
        setSessionsLoading(false);
        // 刷新恢复: 优先"上次会话", 否则最近一条; currentSessionId 为 null → switchSession 不早退
        const last = getLastSessionId();
        const target = last && list.some((s) => s.id === last) ? last : (list[0]?.id ?? null);
        if (target) await switchSession(target);
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
    const typed = input.trim();
    const hasImage = !!imgPreview;
    if ((!typed && !hasImage) || sending) return;
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

    // 整个 send(含 OCR 阶段)共用一个 abort controller, 点"停止"可中断 OCR
    const controller = new AbortController();
    abortRef.current = controller;
    setSending(true);

    // 立刻把消息送进气泡: 图片与指令拆成两条 user 气泡(图在前, 指令在后), 再加 assistant 占位
    // —— 识别进度统一由输出气泡承载
    const imageMsg: Msg | null = hasImage ? { id: ++msgId, role: 'user', content: '', image: imgPreview! } : null;
    const textMsg: Msg | null = typed ? { id: ++msgId, role: 'user', content: typed } : null;
    const assistantMsg: Msg = {
      id: ++msgId, role: 'assistant', content: '', streaming: true,
      ocr: hasImage ? { state: 'loading' } : undefined,
    };
    const newUserMsgs = [imageMsg, textMsg].filter(Boolean) as Msg[];
    setMessages((prev) => [...prev, ...newUserMsgs, assistantMsg]);
    setInput('');
    setImgPreview(null);
    const sid = useSessionStore.getState().currentSessionId;

    // 带图: 后台 OCR(只转录题目文字), 完成后回填 assistant 气泡的识别内容; 纯文字直接用 typed
    let finalText = typed;
    if (imageMsg) {
      try {
        const ocrText = await Vision.recognize({
          image: imageMsg.image!,
          signal: controller.signal,
          visionFn: (img, prompt, sig) =>
            config.mode === 'trial'
              ? visionTrial({ image: img, prompt, trialCtx, signal: sig })
              : visionByok(config.vision as any, { image: img, prompt, signal: sig }),
        });
        if (!ocrText.trim()) throw new Error('未识别出有效文字');
        setMessages((prev) => prev.map((m) => (m.id === assistantMsg.id ? { ...m, ocr: { state: 'done', text: ocrText, expanded: false } } : m)));
        // 后台发给 LLM 的最终输入: 标明是图片识别内容(用户可能说"画出图中的…") + 用户提示词
        const ocrLabeled = `【以下为图片识别的题目内容】\n${ocrText}`;
        finalText = typed ? `${ocrLabeled}\n\n${typed}` : ocrLabeled;
      } catch (e: any) {
        // 识别失败/中止: 撤回本批所有新消息, 恢复草稿(图+文字)让用户重试
        const removeIds = new Set([...newUserMsgs.map((m) => m.id), assistantMsg.id]);
        setMessages((prev) => prev.filter((m) => !removeIds.has(m.id)));
        setImgPreview(imageMsg.image!);
        setInput(typed);
        setSending(false);
        if (e?.name !== 'AbortError') setError('图片识别失败: ' + (e?.message || e));
        return;
      }
    }

    // 持久化(用最终文本, 含 OCR) + 后台标题
    loggerRef.current.userTurn(finalText);
    if (sid && !useSessionStore.getState().sessions.find((s) => s.id === sid)?.title) {
      generateTitle(finalText, sid);
    }

    streamBuf.current = { id: assistantMsg.id, text: '' };

    try {
      const backend = buildBackend();
      const result = await agentRef.current.run({
        userInput: finalText,
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
            schedulePersist();
          },
        },
      });

      // 完成: 更新 assistant 消息
      if (rafRef.current != null) { cancelAnimationFrame(rafRef.current); rafRef.current = null; }
      flushStream();
      setMessages((prev) => prev.map((m) => (m.id === assistantMsg.id ? { ...m, content: result.finalText, streaming: false } : m)));

      // history 累积(截断 8 条, 只存文本)
      const newHistory = [...history, { role: 'user', content: finalText }, { role: 'assistant', content: result.finalText }].slice(-8);
      setHistory(newHistory);

      // 刷新额度
      if (config.mode === 'trial') fetchUsage();
    } catch (e: any) {
      const msg = e?.message || String(e);
      // 用户主动停止(轮间抛"已中止" 或 流式被中断如 BodyStreamBuffer aborted): 正常行为, 不弹提示
      const aborted = msg === '已中止' || e?.name === 'AbortError' || /abort/i.test(msg);
      if (msg === 'TRIAL_EXHAUSTED') {
        setError('试用次数已用完, 可切换到"自带 Key"模式继续使用');
        fetchUsage();
      } else if (aborted) {
        loggerRef.current.errorEvent('user_stop', e);
        // 兜底标题: 中止时若标题还没生成, 用占位"新会话"让会话进列表可识别
        const st = useSessionStore.getState();
        const cur = st.sessions.find((s) => s.id === st.currentSessionId);
        if (st.currentSessionId && cur && !cur.title) {
          st.patchCurrent({ title: '新会话' });
          fetch('/api/sessions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'update', id: st.currentSessionId, title: '新会话' }) }).catch(() => {});
        }
      } else {
        setError(msg);
      }
      setMessages((prev) => prev.map((m) => (m.id === assistantMsg.id
        ? { ...m, streaming: false, content: aborted ? m.content : (m.content || '（出错）') }
        : m)));
    } finally {
      // 落库(成功/中止/出错都落): 主动停止的会话也要持久化, 才会出现在历史列表
      loggerRef.current.flush();
      setSending(false);
      streamBuf.current = null;
    }
  }, [input, sending, imgPreview, config, usage, history, buildBackend, scheduleFlush, flushStream, fetchUsage, ggbRef, trialCtx, schedulePersist]);

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

  // 展开/收起某条图片消息的 OCR 识别内容
  const toggleOcr = useCallback((msgId: number) => {
    setMessages((prev) => prev.map((m) => (m.id === msgId && m.ocr ? { ...m, ocr: { ...m.ocr, expanded: !m.ocr.expanded } } : m)));
  }, []);

  // ── 附图(只压缩+预览, 不识别): OCR 推迟到 send 时再做, 用户可先补充提示词 ──
  const attachImage = useCallback(async (file: File) => {
    if (config.mode !== 'trial' && !config.isVisionValid()) {
      setError('BYOK 模式未配置视觉模型, 请到设置页填写');
      return;
    }
    setError('');
    try {
      const dataUrl = await Vision.compress(file);
      setImgPreview(dataUrl);
    } catch (e: any) {
      setError('图片处理失败: ' + (e.message || e));
    }
  }, [config]);

  // 粘贴图片进输入框 → 同上传(只附图, 识别留到 send)
  const onPasteImage = useCallback((e: React.ClipboardEvent) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (it.type.startsWith('image/')) {
        const file = it.getAsFile();
        if (file) { e.preventDefault(); attachImage(file); return; }
      }
    }
  }, [attachImage]);

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
          <button className="btn ghost" title="对话列表" data-tour="sessions-toggle" onClick={() => setSidebarOpen(true)}>☰</button>
          <button className="btn ghost" title="清空工作区" onClick={clearWorkspace}>+</button>
        </div>
        <div className="top-actions">
          {/* 模式切换 */}
          <div className="mode-switch" data-tour="mode-switch">
            <button className={config.mode === 'trial' ? 'active' : ''} onClick={() => config.setMode('trial')}>免费试用</button>
            <button className={config.mode === 'byok' ? 'active' : ''} onClick={() => config.setMode('byok')}>自带 Key</button>
          </div>
          {config.mode === 'trial' && usage && !adminLoading && !isAdmin && (
            <span className={`usage-badge ${remaining === 0 ? 'exhausted' : ''}`} title="剩余试用次数" data-tour="usage-badge">
              剩余 {remaining}/{usage.limit}
            </span>
          )}
          {config.mode === 'trial' && !adminLoading && isAdmin && (
            <span className="usage-badge" title="管理员不限次数" data-tour="usage-badge">管理员 ∞</span>
          )}
          {!adminLoading && isAdmin && <Link className="btn ghost" href="/admin">🛠 管理</Link>}
          <button className="btn ghost" data-tour="tutorial" onClick={() => start()}>📖 教程</button>
          <Link className="btn ghost" href="/settings">⚙ 设置</Link>
          {recording ? (
            <button className="btn rec-stop" onClick={toggleRecord} title="停止录制并下载视频">
              <span className="rec-dot" /> 停止录制
            </button>
          ) : (
            <div className="export-wrap" ref={exportMenuRef}>
              <button className="btn ghost" data-tour="export" onClick={() => setExportOpen((v) => !v)}>
                导出 <span className="caret">▾</span>
              </button>
              {exportOpen && (
                <div className="export-menu">
                  <button className="export-item" onClick={() => { exportPng(ggbRef.current); setExportOpen(false); }}>
                    <span className="export-icon">🖼️</span>
                    <span className="export-text">
                      <span className="export-title">PNG 图片</span>
                      <span className="export-desc">当前画面静态图</span>
                    </span>
                  </button>
                  <button className="export-item" onClick={toggleRecord}>
                    <span className="export-icon">🎬</span>
                    <span className="export-text">
                      <span className="export-title">{recordingFormat() === 'mp4' ? 'MP4 视频' : 'WebM 视频'}</span>
                      <span className="export-desc">实时录屏, 点开始/停止</span>
                    </span>
                  </button>
                </div>
              )}
            </div>
          )}
          <button className="btn ghost" onClick={() => signOut()}>退出</button>
        </div>
      </header>

      <SessionSidebar open={sidebarOpen} onClose={() => setSidebarOpen(false)} onNew={clearWorkspace} onSwitch={switchSession} />
      <main className="layout">
        <section className="pane chat-pane">
          <CommandBar execLines={execLines} />

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
            {messages.map((m) => {
              let body: React.ReactNode;
              if (m.role === 'system') {
                body = <div className="msg-content">{m.content}</div>;
              } else if (m.role === 'user' && m.image) {
                body = (
                  <img src={m.image} className="msg-image" alt="题目图片（点击放大）" onClick={() => setLightbox(m.image!)} />
                );
              } else if (m.role === 'assistant') {
                const preText = m.streaming && !m.content;
                body = (
                  <>
                    {m.ocr?.state === 'done' && (
                      <div className="ocr-block">
                        <button type="button" className="ocr-toggle" onClick={() => toggleOcr(m.id)}>
                          {m.ocr.expanded ? '收起识别内容 ▲' : '查看识别内容 ▾'}
                        </button>
                        {m.ocr.expanded && (
                          <div className="ocr-text"><MessageContent content={m.ocr.text || ''} /></div>
                        )}
                      </div>
                    )}
                    {preText ? <AssistantProgress msg={m} trace={trace} /> : <MessageContent content={m.content || ''} />}
                  </>
                );
              } else {
                body = <MessageContent content={m.content || ''} />;
              }
              return <div key={m.id} className={`msg ${m.role}${m.role === 'user' && m.image ? ' msg-image-only' : ''}`}>{body}</div>;
            })}
          </div>

          <div className="composer">
            {error && <div className="error-banner">{error}</div>}
            <div className="input-box" data-tour="composer">
              {imgPreview && (
                <div className="media-row">
                  <div className="img-preview-wrap">
                    <img src={imgPreview} className="img-preview" alt="预览" />
                    {!sending && (
                      <button type="button" className="img-preview-remove" title="移除图片" aria-label="移除图片" onClick={() => setImgPreview(null)}>✕</button>
                    )}
                  </div>
                </div>
              )}
              <textarea
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onPaste={onPasteImage}
                onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') send(); }}
                placeholder={imgPreview ? '可补充提示词（可选），点发送后先识别图片再画图…' : '描述你想画的数学图形，例如：画一个圆心在原点、半径为 3 的圆…'}
                rows={3}
              />
              <div className="toolbar">
                <button className="icon-btn" title="上传数学题图片（发送时识别）" aria-label="上传图片"
                  onClick={() => document.getElementById('image-file-input')?.click()} disabled={sending}>
                  <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="3" y="3" width="18" height="18" rx="3" />
                    <circle cx="8.5" cy="8.5" r="1.6" />
                    <path d="M21 15l-5-5L5 21" />
                  </svg>
                </button>
                <div className="toolbar-spacer" />
                {!sending ? (
                  <button className="send-btn" onClick={send} disabled={!canSend || (!input.trim() && !imgPreview)} title="发送" aria-label="发送">
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
              onChange={(e) => { const f = e.target.files?.[0]; if (f) attachImage(f); e.target.value = ''; }} />
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
      {active && (
        <OnboardingTour
          steps={buildTourSteps(tourCtx)}
          onFinish={() => { markSeen(); setActive(false); }}
        />
      )}
      {lightbox && (
        <div className="lightbox" role="dialog" aria-label="图片放大查看" onClick={() => setLightbox(null)}>
          <img src={lightbox} alt="放大查看" />
        </div>
      )}
    </div>
  );
}
