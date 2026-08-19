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
import { getEffectivePrompt, EMERGENCY_PROMPT } from '@/lib/prompt-loader';
import { makeTrialEmbed, makeByokEmbed } from '@/lib/embed';
import { chatTrial, visionTrial, visionByok, type TrialContext } from '@/lib/llm';
import { Vision } from '@/lib/vision';
import { fetchWithRetry } from '@/lib/retry';
import { useGeogebra } from '@/hooks/useGeogebra';
import { exportPng, startRecording, stopRecording, recordingFormat } from '@/lib/export-media';
import MessageContent from './MessageContent';
import TracePanel, { type TraceItem, type ExecLine } from './TracePanel';
import GgbCommandPanel from './GgbCommandPanel';

import { useSessionStore, getLastSessionId } from '@/lib/session-store';
import { rebuildChatMessages, rebuildTrace, rebuildHistory, rebuildExecLines, type ApiMessage } from '@/lib/conversation';
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
  { label: '正六边形', prompt: '画一个圆，作出它的内接正六边形，用不同颜色区分圆和六边形' },
  { label: '二次函数', prompt: '画抛物线 y = x^2 - 4x + 3, 标出对称轴、顶点、与 x 轴交点' },
  { label: '圆的周长', prompt: '画一个半径为 r 的圆，让它沿 x 轴纯滚动一周。用滑块 r（1~4，初值2）控制半径。标注圆心起点和终点，展示圆心移动距离 = 圆周长 2πr。启动动画演示滚动过程。' },
  { label: '圆锥螺线', prompt: '画一个高为6、底面半径为3的圆锥体。在圆锥表面上创建一个动点P，让它从底面边缘沿圆锥表面螺旋上升到顶点，画出P的运动轨迹（圆锥螺线），启动动画展示动点盘旋上升的过程。' },
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

const STAGE_LABEL: Record<'PLAN' | 'EXECUTE' | 'RECOVER', string> = {
  PLAN: '规划中', EXECUTE: '执行中', RECOVER: '恢复中',
};

// 输出气泡"首字文本前"的过程面板: 单行动态切换(只显示当前阶段, 不堆叠)
function AssistantProgress({ msg, trace, stage }: {
  msg: Msg; trace: TraceItem[];
  stage: { stage: 'PLAN' | 'EXECUTE' | 'RECOVER'; round: number } | null;
}) {
  const phases = trace.filter((t) => PHASE_LABEL[t.name]);
  const ocrLoading = msg.ocr?.state === 'loading';

  // 找到第一个进行中的 phase
  const activeIdx = phases.findIndex((t) => t.result == null);
  const hasPhases = phases.length > 0;
  const allDone = hasPhases && activeIdx < 0;

  let label: string;
  let showSpinner: boolean;
  if (ocrLoading) {
    label = '图片识别中';
    showSpinner = true;
  } else if (activeIdx >= 0) {
    // 有阶段正在执行
    label = PHASE_LABEL[phases[activeIdx].name] || phases[activeIdx].name;
    showSpinner = true;
  } else if (stage) {
    // 阶段状态行(工具间隙的 LLM 调用期): 规划中 / 执行第 N 步 / 恢复中
    label = stage.stage === 'EXECUTE' ? `执行第 ${Math.max(1, stage.round - 1)} 步` : STAGE_LABEL[stage.stage];
    showSpinner = true;
  } else if (allDone) {
    // 工具阶段全部完成, 等待 LLM 输出最终回复文字
    label = '正在组织回复';
    showSpinner = true;
  } else {
    label = '正在思考';
    showSpinner = true;
  }

  return (
    <div className="assistant-progress">
      <div className={`phase-item ${showSpinner ? 'active' : 'done'}`}>
        {showSpinner ? <span className="spinner" /> : <span className="phase-check">✓</span>}
        <span>{label}{showSpinner ? '…' : ''}</span>
      </div>
    </div>
  );
}

function fallbackCopy(text: string) {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.left = '-9999px';
  ta.style.top = '-9999px';
  document.body.appendChild(ta);
  ta.focus();
  ta.select();
  try { document.execCommand('copy'); } catch { /* ignore */ }
  document.body.removeChild(ta);
}

export default function ChatApp() {
  const { user, isAdmin, adminLoading, signOut } = useAuth();
  const config = useConfigStore();
  const { sessions, currentSessionId, loadState, setSessions, setLoadState, setCurrent, upsert, patchCurrent } = useSessionStore();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [chatCollapsed, setChatCollapsed] = useState(false);
  const [commandPanelOpen, setCommandPanelOpen] = useState(false);
  const [commandPanelKey, setCommandPanelKey] = useState(0);
  const [canvasPerspective, setCanvasPerspective] = useState<string | null>(null); // 当前画布视角(null=2D)
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const [feedbackText, setFeedbackText] = useState('');
  const [feedbackSending, setFeedbackSending] = useState(false);
  const [feedbackSent, setFeedbackSent] = useState(false);
  const { active, setActive, autoStartIfDue, start, markSeen } = useOnboarding();
  const sessionsLoadAbortRef = useRef<AbortController | null>(null); // 加载会话的 controller(自动/手动重试 + StrictMode 互斥)
  const [switching, setSwitching] = useState(false); // 切换会话中(聊天区显示 loading)
  const switchingCountRef = useRef(0); // 活跃切换计数(快速连点时 loading 不被先完成的那个误关)

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
      let cancelled = false;
      getEffectivePrompt().then(({ text }) => {
        if (cancelled || !ggbRef.current || !csRef.current) return;
        agentRef.current = new AgentEngine({
          ggb: ggbRef.current,
          commandSearch: csRef.current,
          logger: loggerRef.current,
          systemPrompt: text,
        });
      }).catch(() => {
        // loader 已有内部回退, 此处理论不会到; 真到则用 EMERGENCY 兜底保证引擎仍可用
        if (cancelled || !ggbRef.current || !csRef.current) return;
        agentRef.current = new AgentEngine({
          ggb: ggbRef.current,
          commandSearch: csRef.current,
          logger: loggerRef.current,
          systemPrompt: EMERGENCY_PROMPT,
        });
      });
      return () => { cancelled = true; };
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

  // ── 三段式思考策略的 UI 态(spec §3.3): 阶段状态行 + 思考流折叠块 ──
  const [stage, setStage] = useState<{ stage: 'PLAN' | 'EXECUTE' | 'RECOVER'; round: number } | null>(null);
  const [thinkingText, setThinkingText] = useState('');
  const [thinkMsgId, setThinkMsgId] = useState<number | null>(null);   // 思考块挂在哪个 assistant 气泡
  const [thinkOpen, setThinkOpen] = useState(false);
  const [thinkSecs, setThinkSecs] = useState<number | null>(null);     // 回合结束后的"已思考 Ns"
  const thinkBufRef = useRef('');
  const thinkRafRef = useRef<number | null>(null);
  const thinkStartRef = useRef<number | null>(null);

  // 思考流 rAF 批量 flush(与正文 streamBuf 同模式, 避免每个增量一次 setState)
  const flushThink = useCallback(() => {
    thinkRafRef.current = null;
    setThinkingText(thinkBufRef.current);
  }, []);
  const scheduleThinkFlush = useCallback(() => {
    if (thinkRafRef.current == null) thinkRafRef.current = requestAnimationFrame(flushThink);
  }, [flushThink]);

  // ── 导出菜单状态 ──
  const [exportOpen, setExportOpen] = useState(false);
  const [recording, setRecording] = useState(false);
  const exportMenuRef = useRef<HTMLDivElement>(null);

  // ── 分享状态 ──
  const [shareEnabled, setShareEnabled] = useState(false);
  const [shareId, setShareId] = useState<string | null>(null);
  const [shareOpen, setShareOpen] = useState(false);
  const [shareChatVisible, setShareChatVisible] = useState(true);
  const [regenerateConfirm, setRegenerateConfirm] = useState(false);


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
    setCommandPanelOpen,
    setChatCollapsed,
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
    // 撤销保护: 若撤销到空白步(来自 reset)，自动 redo 弹回
    try {
      (ggbRef.current?.getAPI() as any)?.registerStoreUndoListener?.(() => {
        const xml = ggbRef.current?.getXML?.() || '';
        if (!/<element\b/.test(xml)) {
          try { (ggbRef.current?.getAPI() as any)?.redo?.(); } catch {}
        }
      });
    } catch {}
    return () => { cancelPersist(); };
  }, [ggbReady, schedulePersist, cancelPersist]);

  // 离开页面兜底: sendBeacon 同步落当前画布 XML
  useEffect(() => {
    const onUnload = () => {
      const sid = useSessionStore.getState().currentSessionId;
      // 画布 XML 兜底
      if (sid && ggbRef.current) {
        const xml = ggbRef.current.getXML();
        if (xml) {
          try {
            navigator.sendBeacon('/api/sessions', new Blob(
              [JSON.stringify({ action: 'update', id: sid, canvas_xml: xml })],
              { type: 'application/json' },
            ));
          } catch (e) { /* 静默 */ }
        }
      }
      // 消息兜底: 关页面前把残留消息按 sessionId 分组 sendBeacon 落库(与画布对称, 防刷新丢消息)
      loggerRef.current.flushNow();
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

  // ── 分享开关(乐观更新: 先改 UI 再同步 API) ──
  const toggleShare = useCallback(async () => {
    const sid = useSessionStore.getState().currentSessionId;
    if (!sid) return;
    const next = !shareEnabled;

    // 乐观更新 UI(链接持久化: 关闭不丢 shareId, 再开启复用)
    if (next) {
      setShareEnabled(true);
      setShareOpen(true);
      if (!shareEnabled) setShareChatVisible(true);
    } else {
      setShareEnabled(false);
      setShareOpen(false);
    }

    // 异步同步 API(不阻塞 UI)
    try {
      const res = await fetch('/api/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'share', id: sid, share_enabled: next, share_chat_visible: next ? true : undefined }),
        cache: 'no-store',
      });
      if (!res.ok) throw new Error(`请求失败 (${res.status})`);
      const data = await res.json();
      setShareEnabled(data.share_enabled);
      if (data.share_id) setShareId(data.share_id);
      if (typeof data.share_chat_visible === 'boolean') setShareChatVisible(data.share_chat_visible);
    } catch (e: any) {
      setError(e.message || '分享操作失败');
      setShareEnabled(!next);
      if (next) setShareOpen(false);
    }
  }, [shareEnabled]);

  // 仅切换对话可见性(不改链接)
  const toggleChatVisible = useCallback(async (visible: boolean) => {
    const sid = useSessionStore.getState().currentSessionId;
    if (!sid || !shareId) return;
    setShareChatVisible(visible);  // 乐观
    fetch('/api/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'share', id: sid, share_chat_visible: visible }),
      cache: 'no-store',
    }).catch(() => {
      setShareChatVisible(!visible);  // 回滚
    });
  }, [shareId]);

  // 重新生成分享链接(旧链接永久作废)
  const regenerateShare = useCallback(async () => {
    const sid = useSessionStore.getState().currentSessionId;
    if (!sid) return;
    const oldShareId = shareId;      // 暂存旧值, 失败时回退
    setShareId(null);                // 先清空 → 显示「正在生成链接…」
    setRegenerateConfirm(false);
    try {
      const res = await fetch('/api/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'regenerate-share', id: sid }),
        cache: 'no-store',
      });
      if (!res.ok) throw new Error(`请求失败 (${res.status})`);
      const data = await res.json();
      setShareId(data.share_id);
      setShareEnabled(true);
    } catch (e: any) {
      setShareId(oldShareId);  // 失败回退旧链接
      setError(e.message || '重新生成链接失败');
    }
  }, [shareId]);

  // ── 会话管理(云端) ──

  const creatingSessionRef = useRef(false);

  // 新建空会话: 客户端预生成 UUID → 清空 state + 画布 → 乐观设为当前 → 异步落库。
  // 不等待服务端 create 响应——消除 send 时的网络卡顿。
  const newSession = useCallback(async () => {
    if (creatingSessionRef.current) return;
    const curId = useSessionStore.getState().currentSessionId;   // 读 fresh 值, 避免闭包陈旧
    if (curId && messages.length === 0 && !(ggbRef.current?.getCommandLog() || []).length) return;
    creatingSessionRef.current = true;
    if (curId) await persistCanvasXml();
    cancelPersist();
    abortRef.current?.abort();
    setError('');
    try {
      const id = crypto.randomUUID();
      setMessages([]); setTrace([]); setExecLines([]); setHistory([]);
      await ggbRef.current?.clearAll();
      const now = new Date().toISOString();
      upsert({ id, title: null, mode: config.mode, model: null, pinned: false, created_at: now, updated_at: now });
      setCurrent(id);
      // 切换前先把旧会话(curId)的消息可靠落库(分组 fetch), 再切到新会话——与 persistCanvasXml 对称。
      // 替代旧的 setSession→flushNow(sendBeacon): sendBeacon 不保证送达, 是消息丢失根因。
      await loggerRef.current.switchTo(id);
      setCanvasPerspective(null);
      setSidebarOpen(false);
      // 异步注册到服务端(不阻塞 UI); flush() 的 append 动作也会自动建会话——双保险
      fetch('/api/sessions', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'create', id, mode: config.mode, model: config.mode === 'trial' ? 'deepseek' : config.getActiveByok()?.model_name }),
      }).catch(() => {});
      return id;
    } finally {
      creatingSessionRef.current = false;
    }
  }, [config, setSessions, setCurrent, upsert, cancelPersist, persistCanvasXml]);

  const clearWorkspace = useCallback(async () => {
    // 重置命令面板（保持在命令面板模式，仅清空输入）
    setCommandPanelKey((k) => k + 1);

    const hasCommands = (ggbRef.current?.getCommandLog() || []).length > 0;
    const hasCanvasElements = /<element\b/.test(ggbRef.current?.getXML?.() || '');
    const hasContent = hasCommands || hasCanvasElements;
    const curId = useSessionStore.getState().currentSessionId;   // 读 fresh 值, 避免闭包陈旧

    // 无会话但有画布内容（如直接在命令面板绘图） → 捕获 XML + execLines → 清空 → 自动保存为新会话
    if (!curId && hasContent) {
      const xml = ggbRef.current?.getXML?.() || '';
      const capturedExecs = execLines.filter((e) => e.result?.ok);  // 入库前捕获成功命令
      cancelPersist();
      abortRef.current?.abort();
      setError('');
      setMessages([]);
      setTrace([]);
      setExecLines([]);
      setHistory([]);
      await ggbRef.current?.clearAll();
      const id = crypto.randomUUID();
      const now = new Date().toISOString();
      upsert({ id, title: '手动绘制', mode: config.mode, model: null, pinned: false, created_at: now, updated_at: now });
      setCanvasPerspective(null);
      setSidebarOpen(false);
      // 创建会话 + 写入画布 XML + 写入命令历史
      await fetch('/api/sessions', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'create', id, mode: config.mode, model: config.mode === 'trial' ? 'deepseek' : config.getActiveByok()?.model_name, canvas_xml: xml, title: '手动绘制' }),
      });
      if (capturedExecs.length > 0) {
        const events = capturedExecs.map((e) => ({
          ts: Date.now(),
          type: 'ggb_exec' as const,
          command: e.cmd,
          ok: e.result?.ok ?? true,
          labels: e.result?.labels ?? '',
          error: e.result?.error ?? '',
        }));
        await fetch('/api/sessions', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'append', sessionId: id, events }),
        });
      }
      return;
    }

    if (!curId) return;
    if (messages.length === 0 && !hasContent) return;
    // 清空前持久化当前画布 + 消息(防丢失): 画布走 persistCanvasXml, 消息走 logger.flush, 两者对称 await。
    await persistCanvasXml();
    await loggerRef.current.flush();   // 旧会话消息可靠落库(分组 fetch), 与画布同等可靠
    cancelPersist();
    abortRef.current?.abort();
    setError('');
    setMessages([]);
    setTrace([]);
    setExecLines([]);
    setHistory([]);
    await ggbRef.current?.clearAll();
    setCurrent(null);   // 解除侧边栏选中(旧会话已清空, 不算当前)
    loggerRef.current.setSession('');  // 标记无会话: 防止后续 ggb.execCommand 内部 ggbExec 把无会话态画图事件 stamp 到旧会话造成污染
    setCanvasPerspective(null);
  }, [messages, execLines, cancelPersist, persistCanvasXml, setCurrent, upsert, ggbRef]);

  // 切换会话: 先持久化离开的会话 → 加载 → 重建 chat/trace/history → setXML 还原画布 → 设为当前
  const switchSession = useCallback(async (id: string) => {
    if (id === useSessionStore.getState().currentSessionId) return;   // 读 fresh 值, 避免闭包陈旧导致保护失效
    cancelPersist();
    abortRef.current?.abort();
    setError('');
    switchingCountRef.current++;             // 进入一次切换
    setSwitching(true);                      // 切换中:聊天区显示 loading
    try {
      await persistCanvasXml();
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
      // 切换前先把离开会话的消息可靠落库(分组 fetch), 再切到新会话——与 persistCanvasXml 对称。
      // 替代旧的 setSession→flushNow(sendBeacon): sendBeacon 不保证送达, 是消息丢失根因。
      await loggerRef.current.switchTo(id);
      restoringRef.current = true;
      try {
        // 回退到线上已验证的恢复逻辑: reset + setXML (线上 clearAll 无 setPerspective)
        // skipSetXml: 紧随的 setXML(saved) 会替换全量构造并触发重渲染, 无需中间空白帧
        await ggbRef.current?.clearAll({ keepPerspective: true, skipSetXml: true });
        if (session?.canvas_xml) {
          try { ggbRef.current?.setXML(session.canvas_xml); }
          catch (e) { console.warn('画布 setXML 恢复失败:', e); }
          // setUndoPoint 建 undo 步骤(替代原来的 setXML(getXML)，省一次 GGB 全量渲染)
          try { (ggbRef.current?.getAPI() as any)?.setUndoPoint?.(); } catch {}
        }
      } finally {
        restoringRef.current = false;
      }
      // 恢复视角; 全屏模式下补开代数区
      const base = session?.perspective || 'G';
      const p = chatCollapsed ? (base === 'T' ? 'AT' : 'AG') : base;
      try { ggbRef.current?.getAPI()?.setPerspective?.(p); } catch {}
      setCanvasPerspective(base);

      // 恢复分享状态(share_id 持久化, share_enabled 控制开关)
      setShareEnabled(session?.share_enabled === true);
      if (session?.share_id) setShareId(session.share_id);
      setShareChatVisible(session?.share_chat_visible ?? true);
      setShareOpen(false);
    } catch (e) {
      setError('切换会话失败: ' + (e as any).message);
    } finally {
      switchingCountRef.current = Math.max(0, switchingCountRef.current - 1);
      if (switchingCountRef.current === 0) setSwitching(false);  // 所有活跃切换都结束才关 loading
    }
    setSidebarOpen(false);
  }, [setCurrent, persistCanvasXml, cancelPersist, chatCollapsed]);

  // 加载会话列表:递增超时重试 [8s,16s,30s] + 退避 [1.5s,3s],抗慢网络/冷启动。
  // 自动重试与手动重试(侧栏按钮)共用;StrictMode 复挂载靠首行 abort 互斥。
  const loadSessions = useCallback(async () => {
    sessionsLoadAbortRef.current?.abort();            // 覆盖:中断上一次 in-flight
    const controller = new AbortController();
    sessionsLoadAbortRef.current = controller;
    setLoadState('loading');
    try {
      const res = await fetchWithRetry('/api/sessions', { signal: controller.signal });
      if (controller.signal.aborted) return;          // 防:await 后再核
      if (!res.ok) { setLoadState('error'); return; } // 非 2xx(5xx 末次/4xx)→ 错误态,让用户点重试
      const data = await res.json();
      if (controller.signal.aborted) return;
      setSessions(data.sessions || []);
      setLoadState('ready');
    } catch (e) {
      if (controller.signal.aborted) return;          // 被 abort → 静默,不写 error 污染后到者
      console.warn('加载会话失败:', e);
      setLoadState('error');
    } finally {
      if (sessionsLoadAbortRef.current === controller) sessionsLoadAbortRef.current = null;
    }
  }, [setSessions, setLoadState]);

  // 首次进入: 加载会话列表供侧边栏展示, 不自动恢复会话(刷新后直接空白画布)
  useEffect(() => {
    if (!ggbReady) return;
    autoStartIfDue();
    loadSessions();
    return () => { sessionsLoadAbortRef.current?.abort(); };  // 真正中断 fetch+退避(旧代码只置 cancelled,白跑一次跨区请求)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ggbReady]);

  // 当前会话被删除(如在侧边栏删除) → 清空画布与消息, 恢复到初始空白态
  // loadState !== 'loading' 守卫: 避免初始加载期(currentSessionId 尚未赋值)误清空
  // 外加内容检查: 初始空白态(无消息无命令)无需清空, 避免无意义的 clearAll 闪烁
  useEffect(() => {
    if (currentSessionId === null && ggbReady && loadState !== 'loading') {
      const cmdLen = (ggbRef.current?.getCommandLog() || []).length;
      if (cmdLen === 0 && messages.length === 0) return; // 初始空白态, 无需清空
      cancelPersist();
      abortRef.current?.abort();
      setMessages([]);
      setTrace([]);
      setExecLines([]);
      setHistory([]);
      ggbRef.current?.clearAll();
    }
  }, [currentSessionId, ggbReady, loadState]);

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
    if (!useSessionStore.getState().currentSessionId) {
      await newSession();  // 惰性创建
      // 重入保护: newSession 可能因并发调用而提前返回; 再次确认是否已有会话
      if (!useSessionStore.getState().currentSessionId) return;
    }
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
    setStage(null);
    thinkBufRef.current = '';
    thinkStartRef.current = null;
    setThinkingText('');
    setThinkSecs(null);
    setThinkOpen(false);
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
    setThinkMsgId(assistantMsg.id);
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
        config: {
          max_tool_rounds: config.maxToolRounds,
          // 全局思考模式(设置页「高级」)优先, 试用/BYOK 均生效; 未选则 byok profile(eval 注入)兜底, 再缺省引擎 auto
          thinking_mode: config.thinkingMode ?? (config.mode === 'byok' ? config.getActiveByok()?.thinking_mode : undefined),
        },
        backend,
        signal: controller.signal,
        hooks: {
          onToken: (delta) => {
            if (streamBuf.current) { streamBuf.current.text += delta; scheduleFlush(); }
          },
          onThinking: (delta) => {
            if (thinkStartRef.current == null) { thinkStartRef.current = Date.now(); setThinkOpen(true); }
            thinkBufRef.current += delta;
            scheduleThinkFlush();
          },
          onStage: (s, round) => setStage({ stage: s, round }),
          onToolStart: (name, args) => {
            setTrace((prev) => [...prev, { id: ++msgId, name, args, result: null }]);
          },
          onToolEnd: (name, args, res) => {
            setTrace((prev) => prev.map((t, i) => (i === prev.length - 1 ? { ...t, result: res } : t)));
            // set_perspective 工具调用后持久化视角到 DB + 更新 React 状态
            if (name === 'set_perspective' && res?.ok) {
              setCanvasPerspective(args.view);
              const sid = useSessionStore.getState().currentSessionId;
              if (sid) {
                fetch('/api/sessions', {
                  method: 'POST', headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ action: 'update', id: sid, perspective: args.view }),
                }).catch(() => {});
              }
            }
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
      const newHistory = [...history, { role: 'user', content: finalText }, { role: 'assistant', content: result.finalText }].slice(-20);
      setHistory(newHistory);

      // AI 全部完成后立即持久化画布
      await persistCanvasXml();

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
        // 补 turn_end(stopped): agent abort 时(throw '已中止')不调 turnEnd, 中止会话会缺 assistant 消息(只剩 user)。
        // 用流式已累积文本 + 工具数生成 assistant 行, 保证中止会话切回后对话气泡完整。
        loggerRef.current.turnEnd({ finalText: streamBuf.current?.text || '', toolCount: trace.length, stopped: true });
        // 保留用户意图到 history: 取消后输入"继续"时 LLM 知道刚才在做什么, 而非拿到空上下文
        setHistory((prev) => [...prev, { role: 'user', content: finalText }].slice(-20));
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
      setMessages((prev) => {
        const cur = prev.find((m) => m.id === assistantMsg.id);
        // 取消时若还没有文字内容, 直接移除空气泡
        if (aborted && cur && !cur.content.trim()) {
          return prev.filter((m) => m.id !== assistantMsg.id);
        }
        return prev.map((m) => (m.id === assistantMsg.id
          ? { ...m, streaming: false, content: m.content || '（出错）' }
          : m));
      });
    } finally {
      // 落库(成功/中止/出错都落): 主动停止的会话也要持久化, 才会出现在历史列表
      await loggerRef.current.flush();
      // 思考流收尾: 折叠为"已思考 Ns"
      if (thinkRafRef.current != null) { cancelAnimationFrame(thinkRafRef.current); thinkRafRef.current = null; }
      flushThink();
      if (thinkStartRef.current != null) setThinkSecs(Math.max(1, Math.round((Date.now() - thinkStartRef.current) / 1000)));
      setThinkOpen(false);
      setStage(null);
      setSending(false);
      streamBuf.current = null;
    }
  }, [input, sending, imgPreview, config, usage, history, buildBackend, scheduleFlush, flushStream, fetchUsage, ggbRef, trialCtx, schedulePersist, scheduleThinkFlush, flushThink]);

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
            thinking: 'disabled',
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

  // 收起/展开对话框: 切换画布全屏 + 代数区显隐
  const toggleChatCollapse = useCallback(() => {
    setChatCollapsed((prev) => {
      const next = !prev;
      const is3D = canvasPerspective === 'T';
      const targetP = next ? (is3D ? 'AT' : 'AG') : (is3D ? 'T' : 'G');
      ggbRef.current?.getAPI()?.setPerspective?.(targetP);
      setTimeout(() => {
        const api = ggbRef.current?.getAPI() as any;
        const el = document.querySelector('.canvas-wrap');
        if (api?.setSize && el) {
          try { api.setSize(el.clientWidth, el.clientHeight); } catch {}
        }
      }, 300);
      return next;
    });
  }, [canvasPerspective]);

  // 提交用户反馈
  const submitFeedback = useCallback(async () => {
    if (!feedbackText.trim() || feedbackSending) return;
    setFeedbackSending(true);
    try {
      await fetch('/api/feedback', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: feedbackText.trim() }),
      });
      setFeedbackSent(true);
      setFeedbackText('');
    } catch (e) { /* 静默 */ }
    setFeedbackSending(false);
  }, [feedbackText, feedbackSending, user]);

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
          <button className="btn ghost topbar-icon-btn" title="对话列表" data-tour="sessions-toggle" onClick={() => setSidebarOpen(true)}>☰</button>
          <button className="btn ghost topbar-icon-btn" title="清空工作区" onClick={clearWorkspace}>+</button>
          <button className="btn ghost topbar-icon-btn" title={chatCollapsed ? '展开对话框' : '收起对话框（全屏画布）'} data-tour="collapse-chat" onClick={toggleChatCollapse}>
            {chatCollapsed ? '◨' : '◧'}
          </button>
          <button
            className={`btn ghost topbar-icon-btn${commandPanelOpen ? ' active' : ''}`}
            title={commandPanelOpen ? '返回对话模式' : 'GeoGebra 命令面板'}
            data-tour="command-panel"
            onClick={() => setCommandPanelOpen((v) => !v)}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="4 17 10 11 4 5" />
              <line x1="12" y1="19" x2="20" y2="19" />
            </svg>
          </button>
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
          <button className="btn ghost" title="反馈建议" data-tour="feedback-btn" onClick={() => { setFeedbackOpen(true); setFeedbackSent(false); setFeedbackText(''); }}>💬 反馈</button>
          <button className="btn ghost" data-tour="tutorial" onClick={() => start()}>📖 教程</button>
          <Link className="btn ghost" href="/settings" data-tour="settings-link">⚙ 设置</Link>
          {recording ? (
            <button className="btn rec-stop" onClick={toggleRecord} title="停止录制并下载视频">
              <span className="rec-dot" /> 停止录制
            </button>
          ) : (
            <>
              {/* 分享按钮 */}
              <button
                className={`btn ghost ${shareEnabled ? 'active' : ''}`}
                title={shareEnabled ? '查看分享链接' : '分享会话'}
                data-tour="share-btn"
                onClick={() => { if (shareEnabled) { setShareOpen(true); } else { toggleShare(); } }}
                disabled={!currentSessionId}
              >
                🔗 {shareEnabled ? '已分享' : '分享'}
              </button>
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
            </>
          )}
          <button className="btn ghost" onClick={() => signOut()}>退出</button>
        </div>
      </header>

      <SessionSidebar open={sidebarOpen} onClose={() => setSidebarOpen(false)} onNew={clearWorkspace} onSwitch={switchSession} onRetry={loadSessions} />
      <main className="layout">
        {!chatCollapsed && (
        <section className="pane chat-pane">
          {commandPanelOpen ? (
            <GgbCommandPanel
              key={commandPanelKey}
              ggbRef={ggbRef}
              execLines={execLines}
              currentSessionId={currentSessionId}
              onClose={() => setCommandPanelOpen(false)}
              onExec={(cmd, r) => {
                setExecLines((prev) => [...prev, { cmd, result: r }]);
                // 入库统一由 ggb.execCommand 内部(logger.ggbExec)单源承担, 此处不再重复 push
                // (原双源导致手动命令历史重复)。无会话态命令不入库, 由 clearWorkspace 路径1 的 capturedExecs 处理。
              }}
            />
          ) : (
          <>
          <div className="messages">
            {switching && (
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, height: '100%', minHeight: 160, color: '#888' }}>
                <span className="spinner" /> 加载会话中…
              </div>
            )}
            {!switching && messages.length === 0 && (
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
            {!switching && messages.map((m) => {
              let body: React.ReactNode;
              if (m.role === 'system') {
                body = <div className="msg-content">{m.content}</div>;
              } else if (m.role === 'user' && m.image) {
                body = (
                  <img src={m.image} className="msg-image" alt="题目图片（点击放大）" onClick={() => setLightbox(m.image!)} />
                );
              } else if (m.role === 'assistant') {
                const preText = m.streaming && !m.content.trim();
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
                    {m.id === thinkMsgId && thinkingText && (
                      <div className="thinking-block">
                        <button type="button" className="ocr-toggle" onClick={() => setThinkOpen((v) => !v)}>
                          {m.streaming
                            ? `思考中…（点击${thinkOpen ? '收起' : '展开'}）`
                            : `已思考 ${thinkSecs ?? '—'}s ▾`}
                        </button>
                        {thinkOpen && <pre className="thinking-text">{thinkingText.slice(-2000)}</pre>}
                      </div>
                    )}
                    {preText ? <AssistantProgress msg={m} trace={trace} stage={stage} /> : <MessageContent content={m.content || ''} />}
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
          </>
          )}
        </section>
        )}

        <section className={`pane canvas-pane${chatCollapsed ? ' canvas-full' : ''}`}>
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

      {/* 用户反馈弹窗 */}
      {feedbackOpen && (
        <>
          <div className="sidebar-overlay" onClick={() => setFeedbackOpen(false)} />
          <div className="modal-confirm feedback-modal" style={{ maxWidth: 420 }} onClick={(e) => e.stopPropagation()}>
            <h3 style={{ margin: '0 0 4px', fontSize: 17 }}>💬 反馈建议</h3>
            <p style={{ margin: '0 0 14px', fontSize: 13, color: '#888' }}>
              欢迎提出功能建议、使用体验或报告问题。你的反馈将帮助我们改进产品。
            </p>
            {feedbackSent ? (
              <div style={{ textAlign: 'center', padding: '20px 0', color: '#10b981', fontSize: 15 }}>
                ✅ 感谢你的反馈！
              </div>
            ) : (
              <>
                <textarea
                  className="feedback-textarea"
                  value={feedbackText}
                  onChange={(e) => setFeedbackText(e.target.value)}
                  placeholder="请输入你的建议或反馈…"
                  rows={5}
                  maxLength={2000}
                />
                <div className="modal-actions" style={{ marginTop: 14 }}>
                  <button className="btn ghost" onClick={() => setFeedbackOpen(false)}>取消</button>
                  <button className="btn primary" onClick={submitFeedback} disabled={!feedbackText.trim() || feedbackSending}>
                    {feedbackSending ? '提交中…' : '提交反馈'}
                  </button>
                </div>
              </>
            )}
          </div>
        </>
      )}

      {/* 分享链接弹窗 */}
      {shareOpen && (
        <>
          <div className="sidebar-overlay" onClick={() => setShareOpen(false)} />
          <div className="modal-confirm" style={{ maxWidth: 420 }} onClick={(e) => e.stopPropagation()}>
            <h3 style={{ margin: '0 0 4px', fontSize: 17 }}>🔗 分享链接</h3>
            <p style={{ margin: '0 0 14px', fontSize: 13, color: '#888' }}>
              打开此链接即可查看画布和对话记录（只读，无需登录）。
            </p>
            <div style={{
              display: 'flex', gap: 8, alignItems: 'center',
              background: '#f5f5f7', borderRadius: 10, padding: '6px 6px 6px 14px',
              fontFamily: 'SF Mono, Menlo, monospace', fontSize: 13, wordBreak: 'break-all',
            }}>
              {shareId ? (
                <>
                  <span style={{ flex: 1, color: '#333' }}>{`${typeof window !== 'undefined' ? window.location.origin : ''}/share/${shareId}`}</span>
                  <button
                    className="btn primary sm"
                    onClick={() => {
                      const url = `${window.location.origin}/share/${shareId}`;
                      if (navigator.clipboard?.writeText) {
                        navigator.clipboard.writeText(url).catch(() => fallbackCopy(url));
                      } else {
                        fallbackCopy(url);
                      }
                    }}
                    style={{ flexShrink: 0 }}
                  >
                    复制
                  </button>
                </>
              ) : (
                <span style={{ flex: 1, color: '#aaa', fontSize: 12 }}>正在生成链接…</span>
              )}
            </div>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 12, cursor: 'pointer', fontSize: 13, color: '#555' }}>
              <input
                type="checkbox"
                checked={!shareChatVisible}
                onChange={(e) => toggleChatVisible(!e.target.checked)}
                style={{ width: 16, height: 16, cursor: 'pointer' }}
              />
              仅分享画布，不显示对话记录
            </label>
            {shareId && !regenerateConfirm && (
              <div style={{ marginTop: 12, textAlign: 'right' }}>
                <button
                  style={{ border: 'none', background: 'transparent', color: '#999', cursor: 'pointer', fontSize: 12 }}
                  onClick={() => setRegenerateConfirm(true)}
                >
                  重新生成链接
                </button>
              </div>
            )}
            {regenerateConfirm && (
              <div style={{ marginTop: 12, padding: '10px 12px', background: '#fff8e1', borderRadius: 8, fontSize: 13, color: '#b45309' }}>
                ⚠️ 之前的分享链接将永久作废，确定重新生成？
                <div style={{ display: 'flex', gap: 8, marginTop: 8, justifyContent: 'flex-end' }}>
                  <button className="btn ghost sm" onClick={() => setRegenerateConfirm(false)}>取消</button>
                  <button className="btn primary sm" onClick={regenerateShare}>确认重新生成</button>
                </div>
              </div>
            )}
            <div className="modal-actions" style={{ marginTop: 14 }}>
              <button className="btn ghost" onClick={async () => { await toggleShare(); setShareOpen(false); }}>关闭分享</button>
              <button className="btn primary" onClick={() => setShareOpen(false)}>完成</button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
