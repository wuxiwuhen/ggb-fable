// 会话列表 + 当前会话(zustand)。只存元数据; 运行态(messages/trace/画布)由 ChatApp 按当前会话持有, 切换时重建。
// currentSessionId 写 localStorage 作"上次会话"提示, 刷新后由 ChatApp 读取并自动 switchSession 恢复。
import { create } from 'zustand';

const LAST_KEY = 'ggb-current-session';

// 读"上次会话"id(刷新后用); SSR 安全
export function getLastSessionId(): string | null {
  if (typeof window === 'undefined') return null;
  return window.localStorage.getItem(LAST_KEY);
}

export interface SessionMeta {
  id: string;
  title: string | null;
  mode: string;
  model: string | null;
  pinned: boolean;
  created_at: string;
  updated_at: string;
}

export type SessionLoadState = 'loading' | 'ready' | 'error';

interface SessionState {
  sessions: SessionMeta[];
  currentSessionId: string | null;     // 始终从 null 开始(避免与 switchSession 的 id===current 早退冲突)
  loadState: SessionLoadState;         // 列表加载状态:加载中/就绪/失败(sidebar 四态 + 清空守卫共用,单一数据源)
  setSessions: (s: SessionMeta[]) => void;
  mergeSessions: (s: SessionMeta[]) => void;                 // 服务端列表与本地合并(不覆盖本地新会话)
  setLoadState: (s: SessionLoadState) => void;
  setCurrent: (id: string | null) => void;
  upsert: (s: SessionMeta) => void;                          // 新建或更新一条元数据
  patchCurrent: (patch: Partial<SessionMeta>) => void;       // 改当前会话元数据(如 title)
  renameSession: (id: string, title: string) => void;
  togglePin: (id: string) => void;
  removeSession: (id: string) => void;
}

export const useSessionStore = create<SessionState>()((set) => ({
  sessions: [],
  currentSessionId: null,
  loadState: 'loading',                    // 初始即 loading:首帧 sidebar 显示加载态,清空守卫阻塞
  setSessions: (sessions) => set({ sessions }),
  // 按 id 合并: 服务端行覆盖同 id 本地行(服务端为权威), 服务端快照里没有的本地条目保留——
  // 挂载加载/晚到响应若直接 setSessions 覆盖, 会把"已惰性创建但快照后于创建"的当前会话冲出列表(实测丢失)。
  mergeSessions: (incoming) => set((st) => {
    const byId = new Map(st.sessions.map((s) => [s.id, s]));
    for (const s of incoming) byId.set(s.id, { ...byId.get(s.id), ...s });
    return { sessions: [...byId.values()] };
  }),
  setLoadState: (loadState) => set({ loadState }),
  setCurrent: (currentSessionId) => {
    if (typeof window !== 'undefined') {
      if (currentSessionId) window.localStorage.setItem(LAST_KEY, currentSessionId);
      else window.localStorage.removeItem(LAST_KEY);
    }
    set({ currentSessionId });
  },
  upsert: (s) => set((st) => {
    const exists = st.sessions.some((x) => x.id === s.id);
    return { sessions: exists ? st.sessions.map((x) => (x.id === s.id ? { ...x, ...s } : x)) : [s, ...st.sessions] };
  }),
  patchCurrent: (patch) => set((st) => ({
    sessions: st.sessions.map((x) => (x.id === st.currentSessionId ? { ...x, ...patch } : x)),
  })),
  renameSession: (id, title) => set((st) => ({
    sessions: st.sessions.map((x) => (x.id === id ? { ...x, title } : x)),
  })),
  togglePin: (id) => set((st) => {
    const target = st.sessions.find((x) => x.id === id);
    if (!target) return st;
    return {
      sessions: st.sessions.map((x) => (x.id === id ? { ...x, pinned: !x.pinned, updated_at: new Date().toISOString() } : x)),
    };
  }),
  removeSession: (id) => set((st) => ({
    sessions: st.sessions.filter((x) => x.id !== id),
    currentSessionId: st.currentSessionId === id ? null : st.currentSessionId,
  })),
}));
