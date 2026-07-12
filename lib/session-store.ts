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
  created_at: string;
  updated_at: string;
}

interface SessionState {
  sessions: SessionMeta[];
  currentSessionId: string | null;     // 始终从 null 开始(避免与 switchSession 的 id===current 早退冲突)
  setSessions: (s: SessionMeta[]) => void;
  setCurrent: (id: string | null) => void;
  upsert: (s: SessionMeta) => void;                          // 新建或更新一条元数据
  patchCurrent: (patch: Partial<SessionMeta>) => void;       // 改当前会话元数据(如 title)
}

export const useSessionStore = create<SessionState>()((set) => ({
  sessions: [],
  currentSessionId: null,
  setSessions: (sessions) => set({ sessions }),
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
}));
