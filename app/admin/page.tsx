'use client';

// 管理员页: 查看所有用户试用额度, 刷新某用户额度(used=0)或设置额度
// 仅 is_admin=true 可访问(后端 /api/admin/usage 二次鉴权)

import { useEffect, useState } from 'react';
import { useAuth } from '@/lib/auth';

interface UsageRow {
  user_id: string;
  email: string;
  used: number;
  limit: number;
  remaining: number;
}

export default function AdminPage() {
  const { user, loading } = useAuth();
  const [rows, setRows] = useState<UsageRow[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<string | null>(null);

  async function load() {
    setError('');
    const resp = await fetch('/api/admin/usage');
    if (resp.status === 403) { setError('需要管理员权限'); return; }
    if (!resp.ok) { setError('加载失败'); return; }
    const data = await resp.json();
    setRows(data.rows || []);
  }

  useEffect(() => { if (user) load(); /* eslint-disable-next-line */ }, [user]);

  async function refresh(userId: string) {
    setBusy(userId);
    try {
      await fetch('/api/admin/usage', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_id: userId, action: 'refresh' }),
      });
      await load();
    } finally { setBusy(null); }
  }

  async function setLimit(userId: string) {
    const val = prompt('设置该用户的试用额度上限:', '5');
    if (val == null) return;
    const n = Number(val);
    if (!Number.isFinite(n) || n < 0) return;
    setBusy(userId);
    try {
      await fetch('/api/admin/usage', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_id: userId, action: 'set_limit', limit: n }),
      });
      await load();
    } finally { setBusy(null); }
  }

  if (loading) return <main style={S.wrap}><p>加载中…</p></main>;
  if (!user) { if (typeof window !== 'undefined') window.location.href = '/login'; return null; }

  return (
    <main style={S.wrap}>
      <div style={S.card}>
        <h1 style={S.h1}>🛠 管理后台</h1>
        <p style={S.sub}>用户试用额度管理</p>

        {error && <div style={S.error}>{error}</div>}

        <table style={S.table}>
          <thead>
            <tr>
              <th style={S.th}>用户</th>
              <th style={S.th}>已用</th>
              <th style={S.th}>额度</th>
              <th style={S.th}>剩余</th>
              <th style={S.th}>操作</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.user_id}>
                <td style={S.td}>{r.email || r.user_id.slice(0, 8)}</td>
                <td style={S.td}>{r.used}</td>
                <td style={S.td}>{r.limit}</td>
                <td style={S.td}>{r.remaining}</td>
                <td style={S.td}>
                  <button style={S.btn} disabled={busy === r.user_id} onClick={() => refresh(r.user_id)}>刷新</button>
                  {' '}
                  <button style={S.btn} disabled={busy === r.user_id} onClick={() => setLimit(r.user_id)}>设额度</button>
                </td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr><td colSpan={5} style={{ ...S.td, textAlign: 'center', color: '#999' }}>暂无数据</td></tr>
            )}
          </tbody>
        </table>

        <a href="/" style={S.back}>← 返回应用</a>
      </div>
    </main>
  );
}

const S: Record<string, React.CSSProperties> = {
  wrap: { minHeight: '100vh', background: '#f7f8fa', padding: '40px 20px' },
  card: { maxWidth: 800, margin: '0 auto', background: '#fff', borderRadius: 12, padding: 28, boxShadow: '0 2px 12px rgba(0,0,0,0.06)' },
  h1: { margin: '0 0 4px', fontSize: 22 },
  sub: { margin: '0 0 20px', color: '#888', fontSize: 13 },
  error: { background: '#fef2f2', color: '#dc2626', padding: '10px 14px', borderRadius: 6, marginBottom: 16, fontSize: 14 },
  table: { width: '100%', borderCollapse: 'collapse', fontSize: 14 },
  th: { textAlign: 'left', padding: '10px 8px', borderBottom: '2px solid #eee', color: '#666', fontWeight: 600 },
  td: { padding: '10px 8px', borderBottom: '1px solid #f0f0f0' },
  btn: { padding: '5px 12px', border: '1px solid #ddd', borderRadius: 5, background: '#fafafa', cursor: 'pointer', fontSize: 13 },
  back: { display: 'inline-block', marginTop: 24, color: '#4f46e5', fontSize: 14 },
};
