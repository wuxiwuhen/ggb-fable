'use client';

// 公开分享页: 通过 /share/<shareId> 查看只读画布 + 对话历史, 无需登录
// 布局: 左侧对话记录 + 右侧画布(与登录用户体验一致)
// 画布始终撑满, 对话区域独立滚动(复用主应用 .layout/.pane 模式)

import { useEffect, useRef, useState, useCallback } from 'react';
import { useParams } from 'next/navigation';
import { GGB } from '@/lib/ggb';
import { rebuildChatMessages, type ChatMsg } from '@/lib/conversation';
import MessageContent from '@/components/MessageContent';

const DEPLOY_SRC = 'https://www.geogebra.org/apps/deployggb.js';

let scriptPromise: Promise<void> | null = null;
function loadDeployScript(): Promise<void> {
  if (typeof window === 'undefined') return Promise.reject(new Error('SSR'));
  if ((window as any).GGBApplet) {
    scriptPromise = Promise.resolve();
    return scriptPromise;
  }
  if (scriptPromise) return scriptPromise;
  scriptPromise = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = DEPLOY_SRC;
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => { scriptPromise = null; reject(new Error('deployggb.js 加载失败')); };
    document.head.appendChild(s);
  });
  return scriptPromise;
}

type LoadState = 'loading' | 'ok' | 'not-found' | 'error';

export default function SharePage() {
  const { shareId } = useParams<{ shareId: string }>();
  const [state, setState] = useState<LoadState>('loading');
  const [errorMsg, setErrorMsg] = useState('');
  const [title, setTitle] = useState('');
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [mobile, setMobile] = useState(false);
  const [ggbReady, setGgbReady] = useState(false);

  const containerRef = useRef<HTMLDivElement>(null);
  const ggbRef = useRef<GGB | null>(null);
  const initDone = useRef(false);

  // 移动端检测
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 640px)');
    setMobile(mq.matches);
    const on = (e: MediaQueryListEvent) => setMobile(e.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);

  // GGB canvas 尺寸适配
  const applySize = useCallback(() => {
    const api = ggbRef.current?.getAPI() as any;
    const el = containerRef.current;
    if (api?.setSize && el) {
      const w = el.clientWidth;
      const h = el.clientHeight;
      if (w > 0 && h > 0) { try { api.setSize(w, h); } catch {} }
    }
  }, []);

  // 初始化: 先加载数据, 再初始化 GGB
  useEffect(() => {
    if (initDone.current) return;
    initDone.current = true;

    let cancelled = false;

    (async () => {
      try {
        const res = await fetch(`/api/share?shareId=${encodeURIComponent(shareId)}`, { cache: 'no-store' });

        if (!res.ok) {
          if (res.status === 404) { if (!cancelled) setState('not-found'); }
          else { if (!cancelled) { setState('error'); setErrorMsg(`服务器错误 (${res.status})`); } }
          return;
        }
        const data = await res.json();
        const { session, messages: apiMsgs } = data;
        if (cancelled) return;

        setTitle(session.title || '未命名会话');
        const chatMsgs = rebuildChatMessages(apiMsgs || []);
        setMessages(chatMsgs);

        await loadDeployScript();
        if (cancelled) return;

        const ggb = new GGB();
        ggbRef.current = ggb;

        await ggb.init('ggb-share-container', {
          showToolBar: false,
          showMenuBar: false,
          showAlgebraInput: false,
          enableRightClick: true,
          enableShiftDragZoom: true,
          showAnimationButton: true,
          errorDialogsActive: false,
          useBrowserForJS: true,
          language: 'zh',
        });
        if (cancelled) return;

        if (session.canvas_xml) {
          try { ggb.setXML(session.canvas_xml); } catch { /* ignore */ }
        }
        if (session.perspective) {
          try { ggb.getAPI()?.setPerspective?.(session.perspective); } catch {}
        }

        setTimeout(applySize, 200);
        setTimeout(applySize, 600);
        setGgbReady(true);

        setState('ok');
      } catch (e: any) {
        if (!cancelled) {
          setState('error');
          setErrorMsg(e.message || '未知错误');
        }
      }
    })();

    return () => { cancelled = true; };
  }, [shareId, applySize]);

  // 窗口 resize 时更新 GGB 尺寸
  useEffect(() => {
    if (!ggbReady) return;
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(applySize);
    ro.observe(el);
    window.addEventListener('resize', applySize);
    return () => { ro.disconnect(); window.removeEventListener('resize', applySize); };
  }, [ggbReady, applySize]);

  // ------ 渲染 ------

  // 加载态: 容器始终渲染(隐藏), 确保 GGB.init 能找到 DOM
  if (state === 'loading') {
    return (
      <div style={S.wrapper}>
        <div style={{ ...S.center, position: 'absolute', inset: 0, zIndex: 1, background: '#f7f8fa' }}>
          <div style={S.spinner} />
          <p style={S.hint}>正在加载分享…</p>
        </div>
        <div style={{ flex: 1, visibility: 'hidden' }}>
          <div id="ggb-share-container" ref={containerRef} style={{ width: '100%', height: '100%' }} />
        </div>
      </div>
    );
  }

  if (state === 'not-found') {
    return (
      <div style={S.center}>
        <p style={S.iconLarge}>🔗</p>
        <h2 style={S.heading}>分享不存在或已关闭</h2>
        <p style={S.hint}>该链接可能已被分享者关闭，或者链接地址有误</p>
      </div>
    );
  }

  if (state === 'error') {
    return (
      <div style={S.center}>
        <p style={S.iconLarge}>⚠️</p>
        <h2 style={S.heading}>加载失败</h2>
        <p style={S.hint}>{errorMsg}</p>
        <button style={S.retryBtn} onClick={() => window.location.reload()}>重试</button>
      </div>
    );
  }

  const isMobile = mobile;

  return (
    <div style={S.wrapper}>
      <header style={S.header}>
        <span style={S.headerTitle}>{title}</span>
        <span style={S.headerBadge}>只读 · 分享链接</span>
      </header>

      {/* 主体: 复用主应用的 .layout 模式 —— 左侧对话 + 右侧画布 */}
      <div style={{ ...S.layout, flexDirection: isMobile ? 'column' : 'row' }}>
        {/* 左侧: 对话记录(固定宽度, 独立滚动) */}
        <div style={S.chatPane(isMobile)}>
          <div style={S.chatHeader}>对话记录</div>
          <div style={S.messages}>
            {messages.length === 0 ? (
              <p style={S.emptyHint}>暂无对话记录</p>
            ) : (
              messages.map((m, i) => (
                <div key={i} style={{
                  ...S.bubble,
                  alignSelf: m.role === 'user' ? 'flex-end' : 'flex-start',
                  background: m.role === 'user' ? '#e8f0fe' : '#f5f5f5',
                }}>
                  <div style={S.bubbleRole}>{m.role === 'user' ? '👤' : '🤖'}</div>
                  <MessageContent content={m.content} />
                </div>
              ))
            )}
          </div>
        </div>

        {/* 右侧: 画布(撑满剩余空间) */}
        <div style={S.canvasPane}>
          <div id="ggb-share-container" ref={containerRef} style={S.canvasWrap} />
        </div>
      </div>
    </div>
  );
}

const S: Record<string, any> = {
  // 整页: 100vh + overflow:hidden 防止 body 层滚动条
  wrapper: {
    height: '100vh',
    display: 'flex',
    flexDirection: 'column',
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
    color: '#333',
    overflow: 'hidden',
    position: 'relative' as const,
  },
  // 加载/错误/404 居中
  center: {
    height: '100vh',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 40,
    gap: 12,
  },
  spinner: { width: 32, height: 32, border: '3px solid #e0e0e0', borderTopColor: '#4285f4', borderRadius: '50%', animation: 'spin 0.8s linear infinite' },
  iconLarge: { fontSize: 48, margin: 0 },
  heading: { fontSize: 20, fontWeight: 600, margin: 0 },
  hint: { color: '#888', fontSize: 14, margin: 0 },
  retryBtn: { marginTop: 8, padding: '8px 20px', border: '1px solid #ddd', borderRadius: 6, background: '#fff', cursor: 'pointer', fontSize: 14 },

  // 顶栏
  header: {
    display: 'flex',
    alignItems: 'center',
    gap: 12,
    padding: '10px 20px',
    borderBottom: '1px solid #e5e7eb',
    background: '#fafafa',
    flexShrink: 0,
  },
  headerTitle: { fontWeight: 600, fontSize: 15 },
  headerBadge: { fontSize: 12, color: '#888', background: '#f0f0f0', padding: '2px 8px', borderRadius: 4 },

  // 主体布局: flex:1 + overflow:hidden (关键: 禁止溢出到 body 滚动条)
  layout: { flex: 1, display: 'flex', overflow: 'hidden', minHeight: 0 },

  // 对话面板: 固定宽度(桌面) / 全宽(手机), 内部独立滚动
  chatPane: (mobile: boolean) => ({
    width: mobile ? '100%' : '44%',
    minWidth: mobile ? undefined : 360,
    maxWidth: mobile ? undefined : 500,
    maxHeight: mobile ? '45vh' : undefined,
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
    borderRight: mobile ? undefined : '1px solid #e5e7eb',
    borderBottom: mobile ? '1px solid #e5e7eb' : undefined,
    background: '#fff',
    flexShrink: 0,
  }),
  chatHeader: {
    padding: '10px 16px',
    borderBottom: '1px solid #eee',
    fontWeight: 600,
    fontSize: 14,
    color: '#666',
    flexShrink: 0,
  },

  // 消息列表: flex:1 + overflow-y:auto → 只有这里滚动
  messages: {
    flex: 1,
    overflowY: 'auto' as const,
    padding: '12px 16px',
    display: 'flex',
    flexDirection: 'column',
    gap: 10,
  },

  // 画布面板: 撑满剩余空间
  canvasPane: {
    flex: 1,
    minWidth: 0,
    background: '#fafbfc',
    position: 'relative' as const,
    overflow: 'hidden',
  },
  canvasWrap: {
    width: '100%',
    height: '100%',
    position: 'absolute' as const,
    inset: 0,
  } as React.CSSProperties,

  // 消息气泡
  bubble: {
    maxWidth: '90%',
    padding: '8px 12px',
    borderRadius: 8,
    fontSize: 14,
    lineHeight: 1.55,
    wordBreak: 'break-word' as const,
  },
  bubbleRole: { fontSize: 12, marginBottom: 2 },
  emptyHint: { color: '#999', fontSize: 13, textAlign: 'center' as const, marginTop: 24 },
};
