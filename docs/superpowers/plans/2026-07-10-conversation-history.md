# 历史会话（会话列表 + 切换恢复）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 登录用户可新建/切换历史会话，切换时恢复 chat 消息、GeoGebra 画布（recipe 重放）、工具轨迹、history 上下文。

**Architecture:** 复用已有的 Supabase `sessions`/`messages` 表 + `/api/sessions`。`sessions` 加 `recipe jsonb` 列存精简重建脚本；切换时重放 recipe 恢复画布。标题用独立端点 `/api/trial/title`（不扣次数、不碰 agent 核心）。前端用 zustand 会话存储 + `lib/conversation.ts` 纯函数重建状态，ChatApp 接线。

**Tech Stack:** Next.js 15 (App Router, TS, Edge) · Supabase · zustand · 无测试框架（`tsc --noEmit` + node 脚本 + 手动验证）

## Global Constraints

- **MVP 不做删除/重命名**（spec §2）——侧边栏只新建 + 切换。
- **不影响画布核心**（spec §2 硬约束）：agent 工具循环、`SYSTEM_PROMPT`、`cleanFinalText` 一律不动。
- **标题独立**：`/api/trial/title` 不扣试用次数、不碰 agent。
- **仅登录用户**（未登录已被 middleware 挡）。
- **提交规范**：commit message 末尾加 `Co-Authored-By: Claude <noreply@anthropic.com>`，每个 task 单独提交。
- **隔离性**：提交时只 stage 本 task 涉及文件（仓库有别的在途文件，勿混入）。

---

## File Structure

- **Modify** `supabase/schema.sql` — `sessions` 加 `recipe jsonb` 列。
- **Modify** `app/api/sessions/route.ts` — GET ?id= 返回 session(含 recipe)+messages；POST update 支持 recipe。
- **Create** `app/api/trial/title/route.ts` — 标题生成端点（服务端 key，不扣次数）。
- **Create** `lib/session-store.ts` — zustand：会话列表 + currentSessionId。
- **Create** `lib/conversation.ts` — 纯函数：从 API messages 重建 chat/trace/history + 提取重放命令。
- **Create** `components/SessionSidebar.tsx` — 可折叠侧边栏（新建 + 切换）。
- **Modify** `components/ChatApp.tsx` — 接线多会话（首次加载、建空会话、logger.setSession、recipe 持久化、标题生成、switchSession 恢复、挂侧边栏）。

---

## Task 1: schema 加 recipe 列

**Files:**
- Modify: `supabase/schema.sql`

**Interfaces:**
- Produces: `public.sessions.recipe` (jsonb) 列，供 Task 2 读写。

- [ ] **Step 1: 改 sessions 建表加 recipe 列**

在 `supabase/schema.sql` 的 sessions 建表（约 24-32 行）加 `recipe jsonb`：

```sql
create table if not exists public.sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete cascade,
  mode text not null,                    -- 'trial' | 'byok'
  title text,
  model text,                            -- 用了哪个模型(trial) 或 BYOK 的 model_name
  recipe jsonb,                          -- 该会话精简重建脚本命令数组(切换时重放恢复画布)
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
```

- [ ] **Step 2: 末尾加兼容 alter（已建的库补列）**

在 `supabase/schema.sql` 末尾（最后那个函数之后）追加：

```sql

-- ── 历史会话功能: 兼容已建库补 recipe 列 ──
alter table public.sessions add column if not exists recipe jsonb;
```

- [ ] **Step 3: 应用到 Supabase + 提交**

手动：到 Supabase 控制台 → SQL Editor，执行 `alter table public.sessions add column if not exists recipe jsonb;`（已建库需要这一步；新建库由 schema.sql 覆盖）。

```bash
git add supabase/schema.sql
git commit -m "feat(db): sessions 表加 recipe jsonb 列(历史会话画布重放)

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 2: /api/sessions 支持 recipe

**Files:**
- Modify: `app/api/sessions/route.ts`

**Interfaces:**
- Produces: `GET ?id=` 返回 `{ session: {..., recipe}, messages }`；`POST {action:'update', id, recipe?}` 可写 recipe。

- [ ] **Step 1: GET ?id= 返回完整 session（含 recipe）**

把 `app/api/sessions/route.ts` 里 GET 的 `if (id)` 分支（约 26-32 行）从只 select `id, user_id` 改为 `*`，并返回 session：

```ts
  if (id) {
    // 鉴权 + 取完整 session(含 recipe); 走 service_role 查避免 RLS 复杂性
    const { data: sess } = await admin.from('sessions').select('*').eq('id', id).maybeSingle();
    if (!sess || sess.user_id !== user.id) return json(404, { error: '会话不存在' });
    const { data: msgs } = await admin.from('messages').select('*').eq('session_id', id).order('id', { ascending: true });
    return json(200, { session: sess, messages: msgs || [] });
  }
```

- [ ] **Step 2: POST update 支持 recipe 字段**

把 POST 的 `if (body.action === 'update')` 分支（约 57-62 行）加 recipe：

```ts
  if (body.action === 'update') {
    const patch: any = { updated_at: new Date().toISOString() };
    if (body.title != null) patch.title = body.title;
    if (body.recipe !== undefined) patch.recipe = body.recipe;   // 历史会话: 持久化重建脚本
    await admin.from('sessions').update(patch).eq('id', body.id).eq('user_id', user.id);
    return json(200, { ok: true });
  }
```

- [ ] **Step 3: typecheck + 提交**

Run: `pnpm typecheck` → 期望无错误。

```bash
git add app/api/sessions/route.ts
git commit -m "feat(api): /api/sessions GET 返回 recipe + update 支持 recipe

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 3: /api/trial/title 标题生成端点

**Files:**
- Create: `app/api/trial/title/route.ts`

**Interfaces:**
- Produces: `POST /api/trial/title { text, model? }` → `{ title }`（≤15 字）。不扣试用次数。

- [ ] **Step 1: 创建端点**

新建 `app/api/trial/title/route.ts`（参考 `/api/trial/llm/route.ts` 的鉴权 + 模型配置，但非流式、不扣次数、固定 prompt）：

```ts
// 会话标题生成(独立轻量调用, 不扣试用次数, 不碰 agent 画布核心)
// 流程: 验 cookie JWT → 注入服务端 key 转发厂商(非流式) → 返回 ≤15 字标题

import { getUserFromCookie } from '@/lib/supabase';

export const runtime = 'edge';

interface ModelCfg { base_url: string; api_key: string; model_name: string; }

function getModelCfg(model?: string): ModelCfg {
  const want = model || process.env.TRIAL_DEFAULT_MODEL || 'deepseek';
  if (want === 'glm') {
    return { base_url: process.env.GLM_BASE_URL!, api_key: process.env.GLM_API_KEY!, model_name: process.env.GLM_MODEL || 'glm-4.6' };
  }
  return { base_url: process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com/v1', api_key: process.env.DEEPSEEK_API_KEY!, model_name: process.env.DEEPSEEK_MODEL || 'deepseek-chat' };
}

function joinUrl(base: string, path: string): string {
  const b = base.replace(/\/+$/, '');
  if (/\/v\d+$/.test(b)) return b + path;
  return b + '/v1' + path;
}

const TITLE_PROMPT = '给下面这段用户输入的数学问题生成一个简短的中文标题(不超过15字)。只输出标题文本, 不要解释、不要引号、不要句号。';

export async function POST(req: Request) {
  const user = await getUserFromCookie(req);
  if (!user) return json(401, { error: '未登录' });

  let body: any;
  try { body = await req.json(); } catch { return json(400, { error: '请求体解析失败' }); }
  const text = (body.text || '').trim().slice(0, 500);
  if (!text) return json(400, { error: '缺少 text' });

  const cfg = getModelCfg(body.model);
  const upstream = await fetch(joinUrl(cfg.base_url, '/chat/completions'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.api_key}` },
    body: JSON.stringify({
      model: cfg.model_name,
      messages: [
        { role: 'system', content: TITLE_PROMPT },
        { role: 'user', content: text },
      ],
      temperature: 0.2,
      max_tokens: 40,
      stream: false,
    }),
  });

  if (!upstream.ok) {
    const txt = await upstream.text().catch(() => '');
    return json(upstream.status || 502, { error: `标题生成失败: ${txt.slice(0, 200)}` });
  }

  const data = await upstream.json();
  const title = (data.choices?.[0]?.message?.content || '').trim().slice(0, 15).replace(/["""''。]/g, '');
  return json(200, { title: title || '新对话' });
}

function json(status: number, payload: any): Response {
  return new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json' } });
}
```

- [ ] **Step 2: typecheck + 提交**

Run: `pnpm typecheck` → 期望无错误。

```bash
git add app/api/trial/title/route.ts
git commit -m "feat(api): 新增 /api/trial/title 标题生成端点(不扣次数, 独立于画布核心)

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 4: zustand 会话存储

**Files:**
- Create: `lib/session-store.ts`

**Interfaces:**
- Produces: `useSessionStore` hook，含 `sessions: SessionMeta[]`、`currentSessionId`、`setSessions`、`setCurrent`、`upsert`、`patchCurrent`。供 Task 7/8 用。

- [ ] **Step 1: 创建 store**

新建 `lib/session-store.ts`：

```ts
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
```

- [ ] **Step 2: typecheck + 提交**

Run: `pnpm typecheck` → 期望无错误。

```bash
git add lib/session-store.ts
git commit -m "feat(store): zustand 会话存储(sessions 列表 + currentSessionId)

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 5: lib/conversation.ts 重建纯函数

**Files:**
- Create: `lib/conversation.ts`
- Create: `verify-conversation.mjs`（临时验证脚本，不提交）

**Interfaces:**
- Produces: `rebuildChatMessages`、`rebuildTrace`、`rebuildHistory`、`extractReplayCommands`（均接受 `ApiMessage[]`）。供 Task 7 switchSession 用。

- [ ] **Step 1: 创建纯函数模块**

新建 `lib/conversation.ts`（返回纯数据，不依赖 ChatApp 类型，避免循环依赖）：

```ts
// 从 /api/sessions 返回的 messages 行重建前端运行态的纯函数。
// 不依赖 ChatApp 类型(避免循环依赖), 返回纯数据由调用方包装(id/streaming 等)。

export interface ApiMessage {
  role: string;
  content: string | null;
  tool_name: string | null;
  tool_args: any;
  tool_result: any;
  round: number | null;
}

export interface ChatMsg { role: 'user' | 'assistant'; content: string }
export interface TraceEntry { name: string; args: any; result: any }

// 重建 chat 消息(只取 user/assistant 非空文本)
export function rebuildChatMessages(apiMsgs: ApiMessage[]): ChatMsg[] {
  return apiMsgs
    .filter((m) => (m.role === 'user' || m.role === 'assistant') && m.content != null && m.content !== '')
    .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content as string }));
}

// 重建 history(user/assistant 文本, 截 8 条, 给 agent 上下文)
export function rebuildHistory(apiMsgs: ApiMessage[]): Array<{ role: string; content: string }> {
  return rebuildChatMessages(apiMsgs).slice(-8).map((m) => ({ role: m.role, content: m.content }));
}

// 重建 trace(从 tool 消息)
export function rebuildTrace(apiMsgs: ApiMessage[]): TraceEntry[] {
  return apiMsgs
    .filter((m) => m.role === 'tool' && m.tool_name)
    .map((m) => ({ name: m.tool_name as string, args: m.tool_args, result: m.tool_result }));
}

// recipe 未就绪时的回退: 从 execute_command 的 tool 消息提取所有命令文本
export function extractReplayCommands(apiMsgs: ApiMessage[]): string[] {
  const cmds: string[] = [];
  for (const m of apiMsgs) {
    if (m.role === 'tool' && m.tool_name === 'execute_command' && m.tool_args && m.tool_args.command) {
      cmds.push(m.tool_args.command);
    }
  }
  return cmds;
}
```

- [ ] **Step 2: typecheck + 提交**

> 这些纯函数逻辑简单（filter/map），无独立测试框架，靠 `pnpm typecheck` + Task 7 的端到端切换验证。

Run: `pnpm typecheck` → 期望无错误。

```bash
git add lib/conversation.ts
git commit -m "feat(lib): conversation 重建纯函数(chat/trace/history/重放命令)

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 6: SessionSidebar 组件

**Files:**
- Create: `components/SessionSidebar.tsx`
- Modify: `app/globals.css`（加侧边栏样式）

**Interfaces:**
- Consumes: `useSessionStore`（Task 4）。
- Produces: `<SessionSidebar onNew={...} onSwitch={...} open onClose />`，供 Task 7 挂载。

- [ ] **Step 1: 创建组件**

新建 `components/SessionSidebar.tsx`：

```tsx
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
          <button className="btn sm ghost" onClick={onNew} title="新对话">+ 新建</button>
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
```

- [ ] **Step 2: 加侧边栏样式**

在 `app/globals.css` 末尾追加：

```css

/* ── 会话侧边栏(可折叠浮层) ── */
.sidebar-overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.25); z-index: 40; }
.session-sidebar {
  position: fixed; top: 0; left: 0; bottom: 0; width: 260px; background: #fff;
  border-right: 1px solid #e5e7eb; z-index: 41; display: flex; flex-direction: column;
  box-shadow: 2px 0 12px rgba(0,0,0,0.08);
}
.sidebar-head { display: flex; align-items: center; justify-content: space-between; padding: 14px 16px; font-weight: 700; border-bottom: 1px solid #f0f0f0; }
.sidebar-list { flex: 1; overflow-y: auto; padding: 8px; }
.sidebar-empty { color: #aaa; padding: 16px; text-align: center; font-size: 13px; }
.sidebar-item {
  display: flex; flex-direction: column; gap: 2px; width: 100%; text-align: left;
  padding: 10px 12px; border: none; background: transparent; border-radius: 8px; margin-bottom: 4px;
}
.sidebar-item:hover { background: #f5f5f5; }
.sidebar-item.active { background: #eef2ff; }
.sidebar-title { font-size: 14px; color: #1a1a1a; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sidebar-time { font-size: 11px; color: #999; }
```

- [ ] **Step 3: typecheck + 提交**

Run: `pnpm typecheck` → 期望无错误。

```bash
git add components/SessionSidebar.tsx app/globals.css
git commit -m "feat(ui): SessionSidebar 可折叠会话列表(新建+切换)

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 7: ChatApp 接线多会话（核心）

**Files:**
- Modify: `components/ChatApp.tsx`

**Interfaces:**
- Consumes: `useSessionStore`（Task 4）、`lib/conversation` 纯函数（Task 5）、`/api/sessions`（Task 2）、`/api/trial/title`（Task 3）、`SessionSidebar`（Task 6）。
- Produces: 多会话 ChatApp（首次加载、建空会话、logger.setSession、recipe 持久化、标题生成、switchSession 恢复）。

> 这个 task 改动集中在 ChatApp。按下面 7 个改动点逐一改，每点给出锚点 + 代码。`Msg`/`TraceItem` 接口保持不变（`Msg = { id, role, content, streaming? }`）。

- [ ] **Step 1: 加 import**

在 `components/ChatApp.tsx` 顶部 import 区（约 9-23 行）加：

```ts
import { useSessionStore } from '@/lib/session-store';
import { rebuildChatMessages, rebuildTrace, rebuildHistory, extractReplayCommands, type ApiMessage } from '@/lib/conversation';
import SessionSidebar from './SessionSidebar';
```

- [ ] **Step 2: 接 session-store + sidebarOpen state**

在 ChatApp 组件内，`useConfigStore()` 那行（约 43 行）下方加：

```ts
  const { sessions, currentSessionId, setSessions, setCurrent, upsert, patchCurrent } = useSessionStore();
  const [sidebarOpen, setSidebarOpen] = useState(false);
```

- [ ] **Step 3: 首次进入加载会话 + 建空会话 + logger.setSession**

在 ChatApp 内（`fetchUsage` 定义附近，或现有 useEffect 区）加一个 useEffect，ggb 就绪后执行一次：

```ts
  // 首次进入: 加载会话列表, 无则建空会话; 绑定 logger sessionId
  useEffect(() => {
    if (!ggbReady) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/sessions');
        const data = await res.json();
        const list: any[] = data.sessions || [];
        if (cancelled) return;
        setSessions(list);
        if (list.length === 0) {
          await newSession();          // 无会话 → 建空会话
        } else {
          await switchSession(list[0].id);   // 有 → 进最近会话
        }
      } catch (e) {
        console.warn('加载会话失败:', e);
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ggbReady]);
```

- [ ] **Step 4: newSession 函数**

在 ChatApp 内（`generateRecipe` 附近）加：

```ts
  // 新建空会话: create → 清空 state + 画布 → 设为当前
  const newSession = useCallback(async () => {
    abortRef.current?.abort();
    setError('');
    const res = await fetch('/api/sessions', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'create', mode: config.mode, model: config.mode === 'trial' ? 'deepseek' : config.getActiveByok()?.model_name }),
    });
    const data = await res.json();
    const id: string = data.id;
    setMessages([]); setTrace([]); setExecLines([]); setCommandLog([]); setRecipe(null); setHistory([]);
    await ggbRef.current?.clearAll();
    const now = new Date().toISOString();
    upsert({ id, title: null, mode: config.mode, model: null, created_at: now, updated_at: now });
    setCurrent(id);
    loggerRef.current.setSession(id);          // 修复: logger 绑定 sessionId
    setSidebarOpen(false);
    return id;
  }, [config, setSessions, setCurrent, upsert]);
```

- [ ] **Step 5: switchSession 函数（切换恢复）**

在 ChatApp 内加：

```ts
  // 切换会话: 加载 → 重建 chat/trace/history → 重放画布 → 设为当前
  const switchSession = useCallback(async (id: string) => {
    if (id === currentSessionId) return;
    abortRef.current?.abort();
    setError('');
    try {
      const res = await fetch(`/api/sessions?id=${id}`);
      if (!res.ok) return;
      const { session, messages }: { session: any; messages: ApiMessage[] } = await res.json();
      // 重建运行态
      const chatMsgs = rebuildChatMessages(messages);
      setMessages(chatMsgs.map((m, i) => ({ id: ++msgId, role: m.role, content: m.content })));
      setTrace(rebuildTrace(messages).map((t) => ({ id: ++msgId, ...t })));
      setHistory(rebuildHistory(messages));
      setRecipe(null);
      // 恢复画布: recipe 优先, 没有则回退重放 execute_command 命令
      await ggbRef.current?.clearAll();
      const recipe: string[] | null = session?.recipe ? (Array.isArray(session.recipe) ? session.recipe : null) : null;
      const cmds = recipe && recipe.length ? recipe : extractReplayCommands(messages);
      if (cmds.length) {
        try { await ggbRef.current?.execBatch(cmds.join('\n')); } catch (e) { console.warn('画布重放失败:', e); }
      }
      setCurrent(id);
      loggerRef.current.setSession(id);
    } catch (e) {
      setError('切换会话失败: ' + (e as any).message);
    }
    setSidebarOpen(false);
  }, [currentSessionId, setCurrent]);
```

- [ ] **Step 6: recipe 持久化 + 标题生成（改 generateRecipe 和 send）**

把现有 `generateRecipe`（约 245-253 行）末尾 `setRecipe(...)` 后加持久化 + 标题触发。改 `generateRecipe` 为：

```ts
  const generateRecipe = useCallback(async (backend: AgentBackend) => {
    const log = ggbRef.current?.getCommandLog() || [];
    if (!log.length) return;
    setRecipeLoading(true);
    try {
      const res = await Condenser.run(log, (p) => backend.chat(p));
      const cmds = res.commands.length ? res.commands : null;
      setRecipe(cmds);
      // 持久化 recipe 到当前会话(供切换重放)
      if (cmds && currentSessionId) {
        fetch('/api/sessions', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'update', id: currentSessionId, recipe: cmds }),
        }).catch(() => {});
      }
    } catch (e) { /* 静默 */ } finally { setRecipeLoading(false); }
  }, [ggbRef, currentSessionId]);
```

在 `send` 函数里，**首条消息发送后触发标题生成**。在 send 的 `setSending(true)` 之后（约 181 行后）加：

```ts
    // 首条消息后, 后台生成会话标题(当前会话无标题时)
    if (currentSessionId && !useSessionStore.getState().sessions.find((s) => s.id === currentSessionId)?.title) {
      generateTitle(text, currentSessionId);
    }
```

并在 ChatApp 内加 `generateTitle`：

```ts
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
```

- [ ] **Step 7: 挂载 SessionSidebar + ☰ 按钮**

在顶栏（`topbar`，约 305-319 行的 `<header>` 内）加 ☰ 按钮：

```tsx
          <button className="btn ghost" title="对话列表" onClick={() => setSidebarOpen(true)}>☰</button>
```

在 `<main className="layout">` 之前（或 ChatApp return 的最外层 `<div className="app">` 内首部）挂侧边栏：

```tsx
      <SessionSidebar open={sidebarOpen} onClose={() => setSidebarOpen(false)} onNew={newSession} onSwitch={switchSession} />
```

- [ ] **Step 8: typecheck + 手动验证 + 提交**

Run: `pnpm typecheck` → 期望无错误。

手动（dev server 已开）：
1. 刷新 `/app` → 侧边栏应有 ☰；点开看到至少一个"新对话"。
2. 发"画抛物线 y=x^2-4x+3" → 等画布生成；几秒后 ☰ 侧边栏该会话标题变为 AI 生成的标题。
3. 点 + 新建 → 画布清空、chat 清空。
4. 发另一题 → 切换。
5. 点 ☰ 切回第一个会话 → chat 消息、画布（抛物线）、工具轨迹都恢复。

```bash
git add components/ChatApp.tsx
git commit -m "feat(app): ChatApp 多会话(加载/新建/切换恢复/recipe持久化/AI标题)

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 8: 端到端验证 + 清理

**Files:** 无新改动（验证 + 清理临时文件）

- [ ] **Step 1: 完整端到端**

dev server 下完整跑一遍（Task 7 Step 8 的 5 步 + 以下）：
- 切换途中正在生成时点切换 → 应先 abort 再切，不崩。
- recipe 未就绪（刚发完立即切到另一个再切回）→ 回退重放 messages 命令，画布仍恢复。
- 多会话标题各不相同（AI 生成）。
- 画布核心未受影响：发一道 LaTeX 重渲染题，行内/行间公式仍正常（回归 Task 之前的修复）。

- [ ] **Step 2: 清理临时脚本（若有）**

```bash
rm -f verify-conversation.mjs
git status --short   # 确认无 scratch 残留被 add
```

- [ ] **Step 3: 收尾提交（如有遗漏改动）**

若 Step 1 发现小修，修完后提交。否则无额外提交。

---

## 完成定义（DoD）

1. 新建 / 切换会话可用；切换后 chat + 画布（recipe 重放）+ trace + history 全恢复。
2. `sessions.recipe` 持久化，切换时重放（回退 messages 命令）。
3. 标题由 `/api/trial/title` 独立生成（不扣次数、不碰画布核心）。
4. logger 带 sessionId（空会话 bug 修复）。
5. 画布核心（agent 循环 / 系统提示词 / cleanFinalText）零改动；LaTeX 渲染回归不破坏。
6. `pnpm typecheck` 通过；每个 task 单独提交。
