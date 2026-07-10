// 会话列表 + 当前会话(zustand)。只存元数据; 运行态(messages/trace/画布)由 ChatApp 按当前会话持有, 切换时重建。
import { create } from 'zustand';

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
  currentSessionId: string | null;
  setSessions: (s: SessionMeta[]) => void;
  setCurrent: (id: string | null) => void;
  upsert: (s: SessionMeta) => void;                          // 新建或更新一条元数据
  patchCurrent: (patch: Partial<SessionMeta>) => void;       // 改当前会话元数据(如 title)
}

export const useSessionStore = create<SessionState>()((set) => ({
  sessions: [],
  currentSessionId: null,
  setSessions: (sessions) => set({ sessions }),
  setCurrent: (currentSessionId) => set({ currentSessionId }),
  upsert: (s) => set((st) => {
    const exists = st.sessions.some((x) => x.id === s.id);
    return { sessions: exists ? st.sessions.map((x) => (x.id === s.id ? { ...x, ...s } : x)) : [s, ...st.sessions] };
  }),
  patchCurrent: (patch) => set((st) => ({
    sessions: st.sessions.map((x) => (x.id === st.currentSessionId ? { ...x, ...patch } : x)),
  })),
}));
