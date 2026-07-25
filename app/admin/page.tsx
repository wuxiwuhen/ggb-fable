'use client';

// 管理员页: 试用额度管理 + 用户反馈 + 用户指令
// 仅 is_admin=true 可访问(后端二次鉴权)

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useAuth } from '@/lib/auth';

interface UsageRow {
  user_id: string;
  email: string;
  used: number;
  limit: number;
  remaining: number;
}

interface FeedbackRow {
  id: number;
  email: string;
  content: string;
  created_at: string;
}

interface MessageRow {
  id: number;
  email: string;
  content: string;
  session_title: string;
  created_at: string;
}

interface PromptVersionInfo {
  id: string;
  label: string;
  description?: string;
}

const TABS = ['额度管理', '用户反馈', '用户指令', '提示词版本'] as const;
type Tab = (typeof TABS)[number];
const PAGE_SIZE = 20; // 额度管理每页条数

export default function AdminPage() {
  const { user, loading, isAdmin, adminLoading } = useAuth();
  const [tab, setTab] = useState<Tab>('额度管理');
  const [search, setSearch] = useState('');
  const [usageRows, setUsageRows] = useState<UsageRow[]>([]);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [feedbackRows, setFeedbackRows] = useState<FeedbackRow[]>([]);
  const [messageRows, setMessageRows] = useState<MessageRow[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [loadingTab, setLoadingTab] = useState(false);
  const [pvActive, setPvActive] = useState<string | null>(null);
  const [pvPreview, setPvPreview] = useState<string | null>(null);
  const [pvManifest, setPvManifest] = useState<PromptVersionInfo[]>([]);
  const [pvSelected, setPvSelected] = useState<string>('');
  const [pvBusy, setPvBusy] = useState(false);
  const [pvMsg, setPvMsg] = useState('');

  function buildParams(extra: Record<string, string> = {}): string {
    const p = new URLSearchParams(extra);
    if (search.trim()) p.set('email', search.trim());
    return p.toString();
  }

  async function loadUsage(targetPage: number) {
    setError(''); setLoadingTab(true);
    const resp = await fetch(`/api/admin/usage?${buildParams({ page: String(targetPage), pageSize: String(PAGE_SIZE) })}`);
    setLoadingTab(false);
    if (resp.status === 403) { setError('需要管理员权限'); return; }
    if (!resp.ok) { setError('加载失败'); return; }
    const data = await resp.json();
    const t = data.total ?? 0;
    // 越界兜底: 当前页空且非第 1 页(如翻页期间有用户注销) → 回退到末页重查
    if ((!data.rows || data.rows.length === 0) && targetPage > 1 && t > 0) {
      const last = Math.max(1, Math.ceil(t / PAGE_SIZE));
      if (last < targetPage) return loadUsage(last);
    }
    setUsageRows(data.rows || []);
    setTotal(t);
    setPage(targetPage);
  }

  async function loadFeedback() {
    setError(''); setLoadingTab(true);
    const resp = await fetch(`/api/admin/insights?${buildParams({ type: 'feedback', limit: '50' })}`);
    setLoadingTab(false);
    if (resp.status === 403) { setError('需要管理员权限'); return; }
    if (!resp.ok) { setError('加载失败'); return; }
    const data = await resp.json();
    setFeedbackRows(data.rows || []);
  }

  async function loadMessages() {
    setError(''); setLoadingTab(true);
    const resp = await fetch(`/api/admin/insights?${buildParams({ type: 'messages', limit: '50' })}`);
    setLoadingTab(false);
    if (resp.status === 403) { setError('需要管理员权限'); return; }
    if (!resp.ok) { setError('加载失败'); return; }
    const data = await resp.json();
    setMessageRows(data.rows || []);
  }

  function labelOf(id: string | null): string {
    if (!id) return '—';
    return pvManifest.find((v) => v.id === id)?.label || id;
  }

  async function loadPromptVersions() {
    setError(''); setLoadingTab(true);
    const resp = await fetch('/api/admin/prompt-version');
    setLoadingTab(false);
    if (resp.status === 403) { setError('需要管理员权限'); return; }
    if (!resp.ok) { setError('加载失败'); return; }
    const data = await resp.json();
    setPvActive(data.active || null);
    setPvPreview(data.preview || null);
    setPvManifest(data.manifest?.versions || []);
    if (!pvSelected) setPvSelected(data.active || data.manifest?.versions?.[0]?.id || '');
  }

  async function pvPreviewAction() {
    if (!pvSelected) return;
    setPvBusy(true); setPvMsg('');
    try {
      const resp = await fetch('/api/admin/prompt-version', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'preview', version: pvSelected }),
      });
      const data = await resp.json();
      if (!resp.ok) { setPvMsg('失败: ' + (data.error || resp.status)); return; }
      setPvPreview(pvSelected);
      setPvMsg(`已设为仅自己预览「${pvSelected}」(跨设备生效, 刷新 /app 后生效)`);
    } finally { setPvBusy(false); }
  }

  async function pvPublishAction() {
    if (!pvSelected) return;
    if (!confirm(`确认把「${pvSelected}」发布给所有用户? 所有人下一条消息起生效。`)) return;
    setPvBusy(true); setPvMsg('');
    try {
      const resp = await fetch('/api/admin/prompt-version', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'publish', version: pvSelected }),
      });
      const data = await resp.json();
      if (!resp.ok) { setPvMsg('失败: ' + (data.error || resp.status)); return; }
      setPvActive(pvSelected); setPvPreview(null);
      setPvMsg(`已发布「${pvSelected}」给所有用户(自己的预览已同步清除)`);
    } finally { setPvBusy(false); }
  }

  useEffect(() => { if (user) loadUsage(1); /* eslint-disable-next-line */ }, [user]);
  // 搜索触发所有 tab 重新加载
  useEffect(() => {
    if (!user) return;
    if (tab === '额度管理') loadUsage(1); // 搜索时回到第 1 页
    else if (tab === '用户反馈') loadFeedback();
    else if (tab === '用户指令') loadMessages();
    /* eslint-disable-next-line */
  }, [search]);

  // tab 切换时按需加载
  useEffect(() => {
    if (!user) return;
    if (tab === '额度管理' && usageRows.length === 0) loadUsage(page);
    else if (tab === '用户反馈' && feedbackRows.length === 0) loadFeedback();
    else if (tab === '用户指令' && messageRows.length === 0) loadMessages();
    else if (tab === '提示词版本' && pvManifest.length === 0) loadPromptVersions();
    /* eslint-disable-next-line */
  }, [tab]);

  async function refresh(userId: string) {
    setBusy(userId);
    try {
      await fetch('/api/admin/usage', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_id: userId, action: 'refresh' }),
      });
      await loadUsage(page);
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
      await loadUsage(page);
    } finally { setBusy(null); }
  }

  // 等 session + is_admin 都查清再决定
  if (loading || adminLoading) return <main style={S.wrap}><p>加载中…</p></main>;
  if (!user) { if (typeof window !== 'undefined') window.location.href = '/login'; return null; }
  if (!isAdmin) {
    return (
      <main style={S.wrap}>
        <div style={S.card}>
          <h1 style={S.h1}>🛠 管理后台</h1>
          <p style={{ color: '#dc2626', fontSize: 14 }}>当前账号没有管理员权限。</p>
          <Link href="/app" style={S.back}>← 返回工作台</Link>
        </div>
      </main>
    );
  }

  // 额度管理分页派生值
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const pageNumbers = Array.from({ length: totalPages }, (_, i) => i + 1);

  return (
    <main style={S.wrap}>
      <div style={S.card}>
        <h1 style={S.h1}>🛠 管理后台</h1>

        {/* Tab 导航 + 搜索 */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, margin: '16px 0', flexWrap: 'wrap' }}>
          <div style={S.tabs}>
            {TABS.map((t) => (
              <button
                key={t}
                style={{ ...S.tabBtn, ...(tab === t ? S.tabBtnActive : {}) }}
                onClick={() => setTab(t)}
              >
                {t}
              </button>
            ))}
          </div>
          <div style={{ flex: 1, minWidth: 200 }}>
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="搜索邮箱（留空则显示全部）…"
              style={{
                width: '100%', padding: '7px 12px', border: '1px solid #e5e7eb',
                borderRadius: 8, fontSize: 13, outline: 'none',
              }}
            />
          </div>
        </div>

        {error && <div style={{ background: '#fef2f2', color: '#dc2626', padding: '10px 14px', borderRadius: 6, marginBottom: 16, fontSize: 14 }}>{error}</div>}
        {loadingTab && <div style={{ textAlign: 'center', color: '#888', padding: '20px 0', fontSize: 14 }}>加载中…</div>}

        {/* Tab: 额度管理 */}
        {tab === '额度管理' && (
          <>
            <p style={S.sub}>
              {search ? `搜索 "${search}" · 匹配 ${total} 人` : `共 ${total} 人`}
              <button style={{ ...S.btn, marginLeft: 12 }} onClick={() => loadUsage(page)} disabled={loadingTab}>刷新</button>
            </p>
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
                {usageRows.map((r) => (
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
                {usageRows.length === 0 && !loadingTab && (
                  <tr><td colSpan={5} style={{ ...S.td, textAlign: 'center', color: '#999' }}>
                    {search ? '未找到匹配用户' : '暂无数据'}
                  </td></tr>
                )}
              </tbody>
            </table>

            {/* 分页器: 仅一页时不显示 */}
            {total > PAGE_SIZE && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 16, flexWrap: 'wrap', fontSize: 13 }}>
                <button style={S.btn} disabled={loadingTab || page <= 1} onClick={() => loadUsage(page - 1)}>‹ 上一页</button>
                {pageNumbers.map((n) => (
                  <button
                    key={n}
                    disabled={loadingTab}
                    onClick={() => loadUsage(n)}
                    style={{ ...S.btn, ...(n === page ? { background: '#4f46e5', color: '#fff', borderColor: '#4f46e5' } : {}) }}
                  >
                    {n}
                  </button>
                ))}
                <button style={S.btn} disabled={loadingTab || page >= totalPages} onClick={() => loadUsage(page + 1)}>下一页 ›</button>
                <span style={{ color: '#888', marginLeft: 4 }}>第 {page} 页 / 共 {totalPages} 页</span>
              </div>
            )}
          </>
        )}

        {/* Tab: 用户反馈 */}
        {tab === '用户反馈' && (
          <>
            <p style={S.sub}>
              {search ? `搜索 "${search}" · ` : ''}最近 {feedbackRows.length} 条反馈
              <button style={{ ...S.btn, marginLeft: 12 }} onClick={loadFeedback} disabled={loadingTab}>刷新</button>
            </p>
            <div style={{ maxHeight: 520, overflowY: 'auto' }}>
              <table style={S.table}>
                <thead>
                  <tr>
                    <th style={{ ...S.th, width: 140 }}>用户</th>
                    <th style={S.th}>反馈内容</th>
                    <th style={{ ...S.th, width: 150 }}>时间</th>
                  </tr>
                </thead>
                <tbody>
                  {feedbackRows.map((r) => (
                    <tr key={r.id}>
                      <td style={{ ...S.td, fontSize: 12 }}>{r.email || '-'}</td>
                      <td style={{ ...S.td, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{r.content}</td>
                      <td style={{ ...S.td, fontSize: 12, color: '#888' }}>{fmtTime(r.created_at)}</td>
                    </tr>
                  ))}
                  {feedbackRows.length === 0 && !loadingTab && (
                    <tr><td colSpan={3} style={{ ...S.td, textAlign: 'center', color: '#999' }}>
                      {search ? '未找到匹配的反馈' : '暂无反馈'}
                    </td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </>
        )}

        {/* Tab: 用户指令 */}
        {tab === '用户指令' && (
          <>
            <p style={S.sub}>
              {search ? `搜索 "${search}" · ` : ''}最近 {messageRows.length} 条用户输入
              <button style={{ ...S.btn, marginLeft: 12 }} onClick={loadMessages} disabled={loadingTab}>刷新</button>
            </p>
            <div style={{ maxHeight: 520, overflowY: 'auto' }}>
              <table style={S.table}>
                <thead>
                  <tr>
                    <th style={{ ...S.th, width: 140 }}>用户</th>
                    <th style={S.th}>输入内容</th>
                    <th style={{ ...S.th, width: 120 }}>会话</th>
                    <th style={{ ...S.th, width: 130 }}>时间</th>
                  </tr>
                </thead>
                <tbody>
                  {messageRows.map((r) => (
                    <tr key={r.id}>
                      <td style={{ ...S.td, fontSize: 12 }}>{r.email}</td>
                      <td style={{ ...S.td, whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxWidth: 360 }}>
                        {r.content.length > 200 ? r.content.slice(0, 200) + '…' : r.content}
                      </td>
                      <td style={{ ...S.td, fontSize: 12, color: '#666', maxWidth: 120, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {r.session_title || '-'}
                      </td>
                      <td style={{ ...S.td, fontSize: 12, color: '#888' }}>{fmtTime(r.created_at)}</td>
                    </tr>
                  ))}
                  {messageRows.length === 0 && !loadingTab && (
                    <tr><td colSpan={4} style={{ ...S.td, textAlign: 'center', color: '#999' }}>
                      {search ? '未找到匹配的指令' : '暂无数据'}
                    </td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </>
        )}

        {/* Tab: 提示词版本 */}
        {tab === '提示词版本' && (
          <>
            <p style={S.sub}>
              当前线上版本：<b>{pvActive ? labelOf(pvActive) : '—'}</b>
              ｜我的预览版本：<b>{pvPreview ? labelOf(pvPreview) : '未设置'}</b>
              <button style={{ ...S.btn, marginLeft: 12 }} onClick={loadPromptVersions} disabled={loadingTab}>刷新</button>
            </p>
            <div style={{ display: 'flex', gap: 10, alignItems: 'center', margin: '12px 0', flexWrap: 'wrap' }}>
              <select
                value={pvSelected}
                onChange={(e) => setPvSelected(e.target.value)}
                style={{ padding: '7px 10px', border: '1px solid #e5e7eb', borderRadius: 8, fontSize: 13 }}
              >
                {pvManifest.map((v) => (
                  <option key={v.id} value={v.id}>{v.id} · {v.label}</option>
                ))}
              </select>
              <button style={S.btn} disabled={pvBusy || !pvSelected} onClick={pvPreviewAction}>仅自己预览</button>
              <button
                style={{ ...S.btn, background: '#4f46e5', color: '#fff', borderColor: '#4f46e5' }}
                disabled={pvBusy || !pvSelected}
                onClick={pvPublishAction}
              >发布给所有用户</button>
              {pvSelected && (
                <a href={`/api/admin/prompt-version/file?id=${pvSelected}`} target="_blank" rel="noreferrer" style={{ fontSize: 13, color: '#4f46e5' }}>查看内容 ↗</a>
              )}
            </div>
            {pvMsg && (
              <div style={{ background: '#f0f9ff', color: '#0369a1', padding: '10px 14px', borderRadius: 6, marginBottom: 16, fontSize: 13 }}>{pvMsg}</div>
            )}
            <table style={S.table}>
              <thead>
                <tr>
                  <th style={S.th}>版本</th>
                  <th style={S.th}>标签</th>
                  <th style={S.th}>说明</th>
                  <th style={S.th}>状态</th>
                </tr>
              </thead>
              <tbody>
                {pvManifest.map((v) => (
                  <tr key={v.id}>
                    <td style={S.td}>{v.id}</td>
                    <td style={S.td}>{v.label}</td>
                    <td style={S.td}>{v.description || '-'}</td>
                    <td style={S.td}>{v.id === pvActive ? '线上' : v.id === pvPreview ? '我的预览' : '-'}</td>
                  </tr>
                ))}
                {pvManifest.length === 0 && !loadingTab && (
                  <tr><td colSpan={4} style={{ ...S.td, textAlign: 'center', color: '#999' }}>暂无版本</td></tr>
                )}
              </tbody>
            </table>
          </>
        )}

        <Link href="/app" style={S.back}>← 返回工作台</Link>
      </div>
    </main>
  );
}

function fmtTime(iso: string): string {
  if (!iso) return '-';
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const S: Record<string, React.CSSProperties> = {
  wrap: { minHeight: '100vh', background: '#f7f8fa', padding: '40px 20px' },
  card: { maxWidth: 900, margin: '0 auto', background: '#fff', borderRadius: 12, padding: 28, boxShadow: '0 2px 12px rgba(0,0,0,0.06)' },
  h1: { margin: '0 0 4px', fontSize: 22 },
  sub: { margin: '0 0 16px', color: '#888', fontSize: 13 },
  tabs: { display: 'flex', gap: 6, margin: '16px 0' },
  tabBtn: {
    padding: '7px 18px', border: '1px solid #e5e7eb', borderRadius: 20,
    background: '#fafafa', cursor: 'pointer', fontSize: 13, color: '#555',
    transition: 'all 0.15s',
  },
  tabBtnActive: { background: '#4f46e5', color: '#fff', border: '1px solid #4f46e5' },
  table: { width: '100%', borderCollapse: 'collapse', fontSize: 14 },
  th: { textAlign: 'left', padding: '10px 8px', borderBottom: '2px solid #eee', color: '#666', fontWeight: 600 },
  td: { padding: '10px 8px', borderBottom: '1px solid #f0f0f0' },
  btn: { padding: '5px 12px', border: '1px solid #ddd', borderRadius: 5, background: '#fafafa', cursor: 'pointer', fontSize: 13 },
  back: { display: 'inline-block', marginTop: 24, color: '#4f46e5', fontSize: 14 },
};
