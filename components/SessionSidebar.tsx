'use client';

import { useState, useRef, useEffect } from 'react';
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
  const { sessions, currentSessionId, renameSession, togglePin, removeSession } = useSessionStore();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState('');
  const [menuId, setMenuId] = useState<string | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);
  const editRef = useRef<HTMLInputElement>(null);

  // 双击标题进入编辑
  function startEdit(s: SessionMeta) {
    setEditingId(s.id);
    setEditTitle(s.title || '');
    setMenuId(null);
  }

  // 保存重命名
  async function finishEdit() {
    const id = editingId;
    const title = editTitle.trim();
    setEditingId(null);
    if (!id) return;
    if (title) {
      renameSession(id, title);
      fetch('/api/sessions', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'update', id, title }),
      }).catch(() => {});
    }
  }

  // 切换置顶
  async function doTogglePin(s: SessionMeta) {
    const pinned = !s.pinned;
    togglePin(s.id);
    setMenuId(null);
    fetch('/api/sessions', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'update', id: s.id, pinned }),
    }).catch(() => {});
  }

  // 删除
  async function doDelete(id: string) {
    removeSession(id);
    setDeleteConfirm(null);
    setMenuId(null);
    fetch('/api/sessions', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'delete', id }),
    }).catch(() => {});
  }

  // 编辑框自动聚焦
  useEffect(() => {
    if (editingId) editRef.current?.focus();
  }, [editingId]);

  // 排序: 置顶在前, 其余按 updated_at 倒序
  const sorted = [...sessions].sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    return new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime();
  });

  if (!open) return null;

  return (
    <>
      <div className="sidebar-overlay" onClick={onClose} />
      <aside className="session-sidebar">
        <div className="sidebar-head">
          <span>对话</span>
          <button className="btn sm ghost" onClick={() => { onNew(); onClose(); }} title="新对话">+ 新建</button>
        </div>
        <div className="sidebar-list" data-tour="session-list">
          {sorted.length === 0 && <div className="sidebar-empty">暂无对话</div>}
          {sorted.map((s: SessionMeta) => {
            const isActive = s.id === currentSessionId;
            const isEditing = s.id === editingId;
            return (
              <div
                key={s.id}
                className={`sidebar-item ${isActive ? 'active' : ''}`}
                onClick={() => { if (!isEditing) { onSwitch(s.id); onClose(); } }}
                onDoubleClick={() => startEdit(s)}
              >
                {/* 置顶图标 */}
                <button
                  className="sidebar-pin"
                  title={s.pinned ? '取消置顶' : '置顶'}
                  onClick={(e) => { e.stopPropagation(); doTogglePin(s); }}
                >
                  {s.pinned ? '📌' : '📍'}
                </button>

                {/* 标题+时间 */}
                <div className="sidebar-item-body">
                  {isEditing ? (
                    <input
                      ref={editRef}
                      className="sidebar-title-input"
                      value={editTitle}
                      onChange={(e) => setEditTitle(e.target.value)}
                      onBlur={finishEdit}
                      onKeyDown={(e) => { if (e.key === 'Enter') finishEdit(); if (e.key === 'Escape') setEditingId(null); }}
                      onClick={(e) => e.stopPropagation()}
                      maxLength={30}
                    />
                  ) : (
                    <span className="sidebar-title">{s.title || '新对话'}</span>
                  )}
                  <span className="sidebar-time">{timeAgo(s.updated_at)}</span>
                </div>

                {/* "…" 菜单 */}
                <button
                  className="sidebar-menu-btn"
                  title="更多"
                  onClick={(e) => { e.stopPropagation(); setMenuId(menuId === s.id ? null : s.id); }}
                >…</button>

                {menuId === s.id && (
                  <div className="sidebar-dropdown">
                    <button onClick={(e) => { e.stopPropagation(); startEdit(s); }}>✏ 重命名</button>
                    <button onClick={(e) => { e.stopPropagation(); doTogglePin(s); }}>{s.pinned ? '📍 取消置顶' : '📌 置顶'}</button>
                    <button className="danger" onClick={(e) => {
                      e.stopPropagation();
                      setDeleteConfirm(s.id);
                      setMenuId(null);
                    }}>🗑 删除</button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </aside>

      {/* 删除确认弹窗 */}
      {deleteConfirm && (
        <div className="sidebar-overlay" onClick={() => setDeleteConfirm(null)}>
          <div className="modal-confirm" onClick={(e) => e.stopPropagation()}>
            <p>确定删除该对话？画布和聊天记录将被永久删除，不可恢复。</p>
            <div className="modal-actions">
              <button className="btn ghost" onClick={() => setDeleteConfirm(null)}>取消</button>
              <button className="btn danger" onClick={() => doDelete(deleteConfirm)}>确认删除</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
