'use client';

import { useSessionStore, type SessionMeta } from '@/lib/session-store';

interface Props {
  open: boolean;
  onClose: () => void;
  onNew: () => void;
  onSwitch: (id: string) => void;
}

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return '刚刚';
  if (m < 60) return `${m} 分钟前`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} 小时前`;
  return `${Math.floor(h / 24)} 天前`;
}

export default function SessionSidebar({ open, onClose, onNew, onSwitch }: Props) {
  const { sessions, currentSessionId } = useSessionStore();
  if (!open) return null;
  return (
    <>
      <div className="sidebar-overlay" onClick={onClose} />
      <aside className="session-sidebar">
        <div className="sidebar-head">
          <span>对话</span>
          <button className="btn sm ghost" onClick={() => { onNew(); onClose(); }} title="新对话">+ 新建</button>
        </div>
        <div className="sidebar-list">
          {sessions.length === 0 && <div className="sidebar-empty">暂无对话</div>}
          {sessions.map((s: SessionMeta) => (
            <button
              key={s.id}
              className={`sidebar-item ${s.id === currentSessionId ? 'active' : ''}`}
              onClick={() => { onSwitch(s.id); onClose(); }}
            >
              <span className="sidebar-title">{s.title || '新对话'}</span>
              <span className="sidebar-time">{timeAgo(s.updated_at)}</span>
            </button>
          ))}
        </div>
      </aside>
    </>
  );
}
