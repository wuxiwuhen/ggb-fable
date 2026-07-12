# 画布 XML 持久化 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用 `getXML`/`setXML` 会话级 XML 快照替代命令重放来持久化画布，修复"刷新/切会话后手工绘制内容丢失"，并退役 Condenser/recipe 机制。

**Architecture:** 命令是 agent 的写语言（不动）；XML 是声明式持久化快照（新增）。**Capture**：防抖 `getXML()` → 写 `sessions.canvas_xml`，三个触发点（AI `onExec` + 手工 `onUpdate`/`onCommand` + 切会话/`beforeunload`）。**Restore**：`switchSession` 里 `setXML(canvas_xml)` 优先，老会话回退重放并自愈落 XML。执行历史改读 `execLines`（从 `messages` 重建），不再依赖 re-execute 的副作用。刷新时持久化 `currentSessionId` 自动恢复上次会话。

**Tech Stack:** Next.js 15 (App Router, TS, Edge) · Supabase · zustand · 无测试框架（`pnpm typecheck` + 手动 E2E）

## Global Constraints

- **画布核心零改动**：`lib/agent.ts` 的工具循环 / `SYSTEM_PROMPT` / `cleanFinalText` 一律不动；`get_canvas_context` 不改（已读 live 画布）。
- **`recipe` 列保留不 drop**（老会话回退重放还要读一次）；`messages` 表不动。
- **无测试框架**：每个 task 用 `pnpm typecheck` 通过 + 手动验证，再提交。
- **生产 DB 加列由用户在 Supabase 控制台手动跑**（`alter table public.sessions add column if not exists canvas_xml text;`）；`supabase/schema.sql` 同步更新供新建库。
- **提交规范**：commit message 末尾加 `Co-Authored-By: Claude <noreply@anthropic.com>`，每个 task 单独提交，`git add` 只 stage 本 task 涉及文件。
- **当前分支**：`feat/canvas-xml-persistence`（已建好，spec 已在其上提交）。

---

## File Structure

- **Modify** `supabase/schema.sql` — `sessions` 加 `canvas_xml text` 列 + 兼容 alter。
- **Modify** `app/api/sessions/route.ts` — POST `update` 白名单加 `canvas_xml`。
- **Modify** `lib/ggb.ts` — 暴露 `getXML()` / `setXML()` 公开方法。
- **Modify** `components/CommandBar.tsx` — 砍成单 tab「执行历史」，读 `execLines`，按 `ggbTmp` 过滤临时测量。
- **Modify** `components/ChatApp.tsx` — capture（`persistCanvasXml`+防抖+订阅+`onExec`+`beforeunload`）、restore（`switchSession` setXML+回退+自愈）、退役 recipe/Condenser、移除 `commandLog` state、reload 自动恢复。
- **Modify** `lib/session-store.ts` — 持久化 `currentSessionId`（localStorage 提示）。
- **Modify** `lib/onboarding-steps.ts` — 删 recipe-tab 引导步、更新文案。
- **Delete** `lib/condenser.ts`。

---

## Task 1: 后端——schema 加 canvas_xml 列 + API 支持

**Files:**
- Modify: `supabase/schema.sql:24-33`（建表）+ `supabase/schema.sql:169-171`（兼容 alter）
- Modify: `app/api/sessions/route.ts:60-67`（POST update 白名单）

**Interfaces:**
- Produces: `public.sessions.canvas_xml text` 列；`POST /api/sessions {action:'update', id, canvas_xml}` 可写；`GET ?id=` 已 `select('*')`（`route.ts:29`）自动带出 `canvas_xml`，无需改 GET。

- [ ] **Step 1: schema 建表加 canvas_xml 列**

`supabase/schema.sql` 的 sessions 建表（`:24-33`），在 `recipe jsonb` 那行下方加 `canvas_xml text`：

```sql
create table if not exists public.sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete cascade,
  mode text not null,                    -- 'trial' | 'byok'
  title text,
  model text,                            -- 用了哪个模型(trial) 或 BYOK 的 model_name
  recipe jsonb,                          -- [已退役, 仅老会话回退重放读] 该会话精简重建脚本命令数组
  canvas_xml text,                       -- 该会话画布完整 GeoGebra XML 快照(刷新/切换 setXML 无损还原, 含手工绘制)
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
```

- [ ] **Step 2: schema 末尾加兼容 alter（已建库补列）**

在 `supabase/schema.sql` 最末尾（现有 `alter ... add column if not exists recipe jsonb;` 之后）追加：

```sql

-- ── 画布 XML 持久化: 兼容已建库补 canvas_xml 列 ──
alter table public.sessions add column if not exists canvas_xml text;
```

- [ ] **Step 3: API POST update 支持 canvas_xml 字段**

`app/api/sessions/route.ts` 的 `if (body.action === 'update')` 分支（`:60-67`），在 `recipe` 那行下方加 `canvas_xml`：

```ts
  if (body.action === 'update') {
    const patch: any = { updated_at: new Date().toISOString() };
    if (body.title != null) patch.title = body.title;
    if (body.recipe !== undefined) patch.recipe = body.recipe;       // [已退役, 仅老会话回退读]
    if (body.canvas_xml !== undefined) patch.canvas_xml = body.canvas_xml;   // 画布 XML 快照持久化
    const { data: rows } = await admin.from('sessions')
      .update(patch).eq('id', body.id).eq('user_id', user.id).select('id');
    return json(200, { ok: true, affected: rows?.length ?? 0 });
  }
```

- [ ] **Step 4: typecheck + 提交**

Run: `pnpm typecheck` → 期望无错误。

```bash
git add supabase/schema.sql app/api/sessions/route.ts
git commit -m "feat(db): sessions 加 canvas_xml 列 + API update 支持

Co-Authored-By: Claude <noreply@anthropic.com>"
```

> **用户侧（部署前）**：到 Supabase 控制台 SQL Editor 跑 `alter table public.sessions add column if not exists canvas_xml text;`（给已存在的线上库补列）。

---

## Task 2: GGB 暴露 getXML / setXML 公开方法

**Files:**
- Modify: `lib/ggb.ts`（在 `getBase64()` 之后、`getCanvas()` 之前加两个方法）

**Interfaces:**
- Produces: `GGB.prototype.getXML(): string`、`GGB.prototype.setXML(xml: string): void`。供 Task 4（capture）和 Task 5（restore）调用。

- [ ] **Step 1: 加 getXML / setXML 方法**

在 `lib/ggb.ts` 的 `getBase64()` 方法（`:363-366`）之后插入：

```ts
  // 画布完整 XML 快照(与 get_canvas_context 解析的同源, 含手工绘制); 持久化用
  getXML(): string {
    if (!this.applet) return '';
    try { return this.applet.getXML?.() || ''; } catch (e) { return ''; }
  }

  // 从 XML 快照无损还原画布(含手工绘制); restore 用
  setXML(xml: string): void {
    if (!this.applet || !xml) return;
    try { this.applet.setXML?.(xml); } catch (e) { console.warn('setXML 失败:', e); }
  }
```

- [ ] **Step 2: typecheck + 提交**

Run: `pnpm typecheck` → 期望无错误。

```bash
git add lib/ggb.ts
git commit -m "feat(ggb): 暴露 getXML/setXML 公开方法(持久化与还原用)

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 3: 退役 recipe/Condenser + CommandBar 改读 execLines

> 本 task 是"拆除旧 recipe 机制 + 历史源切换"。拆完后恢复仍走 `extractReplayCommands` 重放（与今天回退行为一致），手工绘制丢失直到 Task 5 才修。typecheck 必须通过、send 仍能画图。

**Files:**
- Delete: `lib/condenser.ts`
- Modify: `components/CommandBar.tsx`（整文件重写为单 tab）
- Modify: `components/ChatApp.tsx`（删 recipe/Condenser/commandLog 相关代码）

**Interfaces:**
- Consumes: `ExecLine`（`components/TracePanel.tsx` 导出，形状 `{ cmd: string; result: { ok: boolean; labels: string; error: string } }`）；`execLines` state（`ChatApp.tsx:130`，已在 `onExec` 和 `switchSession` 维护）。
- Produces: `CommandBar` 单 props `<CommandBar execLines={ExecLine[]} />`；ChatApp 不再持有 `recipe`/`recipeLoading`/`commandLog` state。

- [ ] **Step 1: 重写 CommandBar 为单 tab「执行历史」**

`components/CommandBar.tsx` 整文件替换为：

```tsx
'use client';

// 命令条: 展示 AI 执行历史(每条 GeoGebra 命令 + 成功/失败)。
// 数据源 execLines: live 由 onExec 维护, 恢复态由 rebuildExecLines 从 messages 重建 → 刷新后不空。

import type { ExecLine } from './TracePanel';

interface Props {
  execLines: ExecLine[];
}

// 临时测量命令(verify_geometry 建的 ggbTmpM 等)不展示
function isTempMeasure(cmd: string): boolean {
  return /^ggbTmp\w*\s*=/.test((cmd || '').trim());
}

export default function CommandBar({ execLines }: Props) {
  const visible = execLines.filter((e) => !isTempMeasure(e.cmd));
  return (
    <details className="cmd-bar">
      <summary data-tour="command-history">
        🧱 执行历史 <span className="count">{visible.length}</span>
      </summary>
      <div className="cmd-bar-body">
        <div className="cmd-list">
          {visible.length === 0 && <div className="cmd-empty">尚无命令</div>}
          {visible.map((e, i) => (
            <div key={i} className={`cmd-row ${e.result.ok ? 'ok' : 'fail'}`}>
              <span className="cmd-idx">{i + 1}.</span>
              <code>{e.cmd}</code>
              <span className="cmd-status">{e.result.ok ? '✓' : '✗'}</span>
              <span className="cmd-meta">{e.result.ok ? e.result.labels : e.result.error}</span>
            </div>
          ))}
        </div>
      </div>
    </details>
  );
}
```

- [ ] **Step 2: 删除 condenser.ts**

```bash
git rm lib/condenser.ts
```

- [ ] **Step 3: ChatApp 删 Condenser import**

`components/ChatApp.tsx:20` 删除这一行：

```ts
import { Condenser } from '@/lib/condenser';
```

- [ ] **Step 4: ChatApp 删 commandLog / recipe / recipeLoading state**

`components/ChatApp.tsx` 删除这三行（`:131-133`）：

```ts
  const [commandLog, setCommandLog] = useState<Array<{ cmd: string; ok: boolean; labels: string; error: string; ephemeral?: boolean }>>([]);
  const [recipe, setRecipe] = useState<string[] | null>(null);
  const [recipeLoading, setRecipeLoading] = useState(false);
```

- [ ] **Step 5: newSession / clearWorkspace 删 setRecipe(null)**

`newSession`（`:241`）那一行的 `setRecipe(null);` 删除；`clearWorkspace`（`:261`）那一行的 `setRecipe(null);` 删除。两处 `setMessages([]) ...; setHistory([]);` 等保留，仅去掉 `setRecipe(null);` 一个 token。

示例（newSession，删掉中间的 `setRecipe(null);`）：
```ts
    setMessages([]); setTrace([]); setExecLines([]); setCommandLog([]); setHistory([]);
```
变为：
```ts
    setMessages([]); setTrace([]); setExecLines([]); setHistory([]);
```
（注意：`setCommandLog([])` 也在同一行 —— 一并删除。clearWorkspace 同理删 `setCommandLog([]);` 和 `setRecipe(null);`。）

- [ ] **Step 6: switchSession 改为纯命令回退（去掉 recipe 逻辑 + setCommandLog）**

`components/ChatApp.tsx` 的 `switchSession`（`:266-296`），把"恢复画布"那一段（从 `await ggbRef.current?.clearAll();` 到 `setCommandLog(...)`）替换为：

```ts
      // 重建运行态
      const chatMsgs = rebuildChatMessages(messages);
      setMessages(chatMsgs.map((m, i) => ({ id: ++msgId, role: m.role, content: m.content })));
      setTrace(rebuildTrace(messages).map((t) => ({ id: ++msgId, ...t })));
      setHistory(rebuildHistory(messages));
      setExecLines(rebuildExecLines(messages));
      // 恢复画布: 暂用命令回放(XML 快照恢复见 Task 5); 执行历史显示已由 execLines 重建
      await ggbRef.current?.clearAll();
      const cmds = extractReplayCommands(messages);
      if (cmds.length) {
        try { await ggbRef.current?.execBatch(cmds.join('\n')); } catch (e) { console.warn('画布重放失败:', e); }
      }
      setCurrent(id);
      loggerRef.current.setSession(id);
```

（删除了原 `recipe` 提取、`setRecipe(...)`、`setCommandLog(...)` 三处。）

- [ ] **Step 7: onExec 删 setCommandLog**

`send` 里的 `onExec` 钩子（`:435-438`）改为：

```ts
          onExec: (cmd, r) => {
            setExecLines((prev) => [...prev, { cmd, result: r }]);
          },
```

- [ ] **Step 8: send 删 generateRecipe 调用**

`send` 的 try 块末尾（`:454-455`）删除这两行：

```ts
      // 后台生成重建脚本
      if (!result.stopped) generateRecipe(backend);
```

- [ ] **Step 9: 删 generateRecipe / saveRecipe / replay 三个函数**

删除 `generateRecipe`（`:486-504`）、`saveRecipe`（`:506-519`）、`replay`（`:562-567`）整段。注意保留它们之间的 `generateTitle`（`:521-553`）和 `stop`（`:555`）。

- [ ] **Step 10: CommandBar 接线改为单 prop**

`components/ChatApp.tsx:678-685` 的 `<CommandBar ... />` 替换为：

```tsx
          <CommandBar execLines={execLines} />
```

- [ ] **Step 11: typecheck + 手动验证 + 提交**

Run: `pnpm typecheck` → 期望无错误（重点确认无 `recipe`/`commandLog`/`Condenser`/`generateRecipe`/`saveRecipe`/`replay` 悬空引用）。

手动（dev server）：
1. 发"画一个圆心在原点、半径 3 的圆" → 画布出图，🧱 执行历史显示命令、单 tab（无"重建脚本"）。
2. 工具栏手动画一个点 → 历史仍只显示 AI 命令（手工不进历史，符合预期）。
3. 切到另一会话再切回 → chat + 执行历史恢复（画布暂仍走命令回放）。

```bash
git add components/CommandBar.tsx components/ChatApp.tsx
git commit -m "refactor: 退役 recipe/Condenser, CommandBar 改读 execLines 执行历史

删 condenser.ts + generateRecipe/saveRecipe/replay + recipe/commandLog state,
省每次 send 一次 Condenser LLM 调用。历史源改 execLines(从 messages 重建)。

Co-Authored-By: Claude <noreply@anthropic.com>"
```

（`lib/condenser.ts` 的删除已在 Step 2 `git rm` 暂存，随本次提交一起进。）

---

## Task 4: Capture——画布 XML 防抖持久化

**Files:**
- Modify: `components/ChatApp.tsx`

**Interfaces:**
- Consumes: `GGB.getXML()`（Task 2）、`POST /api/sessions {action:'update', canvas_xml}`（Task 1）、`GGB.onUpdate`/`onCommand`（`lib/ggb.ts:121-122`，监听器已在 `:156-159` 注册）。
- Produces: `persistCanvasXml()`（async，读 `currentSessionId` + `getXML` → POST）、`schedulePersist()`（防抖 800ms，`restoringRef` 抑制）；订阅手工监听器；`onExec` 触发；`beforeunload` sendBeacon。供 Task 5 调用。

- [ ] **Step 1: 加 restoringRef + persistCanvasXml + schedulePersist**

在 `components/ChatApp.tsx` 的 `history` state 附近（`:163-165` 一带，`trialTokenRef`/`abortRef` 旁边）加：

```ts
  // ── 画布 XML 快照持久化 ──
  const restoringRef = useRef(false);                                   // restore 期间抑制捕获
  const persistTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
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
```

- [ ] **Step 2: 订阅 onUpdate / onCommand（捕获手工绘制 + AI 命令）**

在 `components/ChatApp.tsx` 加一个 useEffect（放在 agent 初始化 effect `:110-120` 之后）：

```ts
  // 手工绘制监听: onUpdate(add/remove/update) + onCommand(execCommand) → 防抖落 XML
  // GGB 实例整会话稳定(reinit 不换实例), subscribedRef 保证只订阅一次
  const subscribedRef = useRef(false);
  useEffect(() => {
    if (!ggbReady || !ggbRef.current || subscribedRef.current) return;
    subscribedRef.current = true;
    ggbRef.current.onUpdate(() => schedulePersist());
    ggbRef.current.onCommand(() => schedulePersist());
  }, [ggbReady, schedulePersist]);
```

- [ ] **Step 3: onExec 触发 schedulePersist**

`send` 里的 `onExec` 钩子（Task 3 后已是两行）加一行：

```ts
          onExec: (cmd, r) => {
            setExecLines((prev) => [...prev, { cmd, result: r }]);
            schedulePersist();
          },
```

并把 `schedulePersist` 加入 `send` 的 `useCallback` 依赖数组（`:484` 那行末尾的 `[..., ggbRef, trialCtx]` 改为 `[..., ggbRef, trialCtx, schedulePersist]`）。

- [ ] **Step 4: beforeunload 用 sendBeacon 兜底落盘**

在 `components/ChatApp.tsx` 加一个 useEffect（放在上面订阅 effect 之后）：

```ts
  // 离开页面兜底: sendBeacon 同步落当前画布 XML
  useEffect(() => {
    const onUnload = () => {
      const sid = useSessionStore.getState().currentSessionId;
      if (!sid || !ggbRef.current) return;
      const xml = ggbRef.current.getXML();
      if (!xml) return;
      try {
        navigator.sendBeacon('/api/sessions', new Blob(
          [JSON.stringify({ action: 'update', id: sid, canvas_xml: xml })],
          { type: 'application/json' },
        ));
      } catch (e) { /* 静默 */ }
    };
    window.addEventListener('beforeunload', onUnload);
    return () => window.removeEventListener('beforeunload', onUnload);
  }, [ggbRef]);
```

- [ ] **Step 5: typecheck + 手动验证 + 提交**

Run: `pnpm typecheck` → 期望无错误。

手动（dev server，需已跑 Task 1 的 Supabase 加列）：
1. 发"画抛物线 y=x^2-4x+3" → 等出图 + ~1s。
2. Supabase → Table Editor → `sessions` → 当前会话行 → `canvas_xml` 列**非空**（含 `<geogebra>` XML）。
3. 工具栏手工加一个点 → ~1s → 该行 `canvas_xml` **更新**（含新点的 label）。

```bash
git add components/ChatApp.tsx
git commit -m "feat(canvas): 画布 XML 防抖持久化(AI+手工+离开三触发点)

persistCanvasXml 防抖落 sessions.canvas_xml; 订阅 onUpdate/onCommand
捕获手工绘制; onExec 触发; beforeunload sendBeacon 兜底。

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 5: Restore——switchSession 用 setXML 还原（含老会话回退 + 自愈）

**Files:**
- Modify: `components/ChatApp.tsx`（`switchSession`）

**Interfaces:**
- Consumes: `GGB.setXML()`（Task 2）、`session.canvas_xml`（Task 1 GET 带出）、`persistCanvasXml`/`restoringRef`（Task 4）、`extractReplayCommands`（`lib/conversation.ts`，老会话回退）。
- Produces: `switchSession` 无损还原画布；老会话首次打开回退重放后自愈落 XML。

- [ ] **Step 1: 重写 switchSession 恢复逻辑**

`components/ChatApp.tsx` 的 `switchSession`（Task 3 后的版本）整段替换为：

```ts
  // 切换会话: 先持久化离开的会话 → 加载 → 重建 chat/trace/history → setXML 还原画布 → 设为当前
  const switchSession = useCallback(async (id: string) => {
    if (id === currentSessionId) return;
    abortRef.current?.abort();
    setError('');
    try {
      await persistCanvasXml();           // 离开前持久化"当前"会话画布(用旧 currentSessionId)
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
      loggerRef.current.setSession(id);
      restoringRef.current = true;         // 抑制 setXML 触发的监听事件回写
      try {
        await ggbRef.current?.clearAll();
        if (session?.canvas_xml) {
          try { ggbRef.current?.setXML(session.canvas_xml); }
          catch (e) { console.warn('画布 setXML 恢复失败:', e); }
        } else {
          // 老会话回退: recipe 或原始命令重放, 成功后自愈落 XML, 下次直接 setXML
          const cmds: string[] = Array.isArray(session?.recipe) && session.recipe.length
            ? session.recipe : extractReplayCommands(messages);
          if (cmds.length) {
            try { await ggbRef.current?.execBatch(cmds.join('\n')); } catch (e) { console.warn('画布重放失败:', e); }
          }
          void persistCanvasXml();         // 自愈(currentSessionId 已是 id)
        }
      } finally {
        restoringRef.current = false;
      }
    } catch (e) {
      setError('切换会话失败: ' + (e as any).message);
    }
    setSidebarOpen(false);
  }, [currentSessionId, setCurrent, persistCanvasXml]);
```

- [ ] **Step 2: typecheck + 手动验证 + 提交**

Run: `pnpm typecheck` → 期望无错误。

手动（dev server）—— **核心验收**：
1. 会话 A：AI 画图 + 工具栏手工加一个点/圆。
2. 等 ~1s（capture 落盘），点 ☰ 切到会话 B，再切回 A。
3. **画布上 AI 图形 + 手工点/圆都在**（手工内容不再丢失）。
4. 老会话（升级前 `canvas_xml` 为 NULL 的）：首次切过去走重放（画布出图），再切走再切回 → 走 setXML（该会话行 `canvas_xml` 现已非空，自愈成功）。

```bash
git add components/ChatApp.tsx
git commit -m "feat(canvas): switchSession 用 setXML 无损还原画布(含手工绘制)

canvas_xml 优先 setXML; 老会话回退重放+自愈落 XML; restoringRef 抑制
setXML 触发的回写; 离开前 persistCanvasXml 兜底。修手工绘制切会话丢失。

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 6: 刷新自动恢复——持久化 currentSessionId

**Files:**
- Modify: `lib/session-store.ts`
- Modify: `components/ChatApp.tsx`（`ggbReady` effect `:299-318`）

**Interfaces:**
- Produces: `getLastSessionId(): string | null`（读 localStorage 提示）；`setCurrent` 写 localStorage；刷新后 `ggbReady` effect 自动 `switchSession` 上次会话。

- [ ] **Step 1: session-store 持久化 currentSessionId**

`lib/session-store.ts` 整文件替换为：

```ts
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
```

- [ ] **Step 2: ChatApp ggbReady effect 刷新自动恢复上次会话**

`components/ChatApp.tsx` 顶部 import 区（`:26` 的 `useSessionStore` import 那行）改为同时引入 `getLastSessionId`：

```ts
import { useSessionStore, getLastSessionId } from '@/lib/session-store';
```

`ggbReady` effect（`:299-318`）里的 async 块替换为（保留 `autoStartIfDue()` 和 `cancelled` 逻辑）：

```ts
  useEffect(() => {
    if (!ggbReady) return;
    autoStartIfDue();   // 首次进入: 未看过基础教程则启动
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/sessions', { cache: 'no-store' });
        const data = await res.json();
        const list: any[] = data.sessions || [];
        if (cancelled) { setSessionsLoading(false); return; }
        setSessions(list);
        setSessionsLoading(false);
        // 刷新恢复: 优先"上次会话", 否则最近一条; currentSessionId 为 null → switchSession 不早退
        const last = getLastSessionId();
        const target = last && list.some((s) => s.id === last) ? last : (list[0]?.id ?? null);
        if (target) await switchSession(target);
      } catch (e) {
        console.warn('加载会话失败:', e);
        setSessionsLoading(false);
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ggbReady]);
```

- [ ] **Step 3: typecheck + 手动验证 + 提交**

Run: `pnpm typecheck` → 期望无错误。

手动（dev server）：
1. 会话 A 画图 + 手工加内容 → 等 ~1s。
2. **浏览器刷新** → 自动回到会话 A，画布（AI + 手工）+ chat + 执行历史全恢复（不再空白）。
3. localStorage 里 `ggb-current-session` = 当前会话 id（DevTools → Application → Local Storage 查看）。

```bash
git add lib/session-store.ts components/ChatApp.tsx
git commit -m "fix(app): 刷新自动恢复上次会话(currentSessionId 持久化)

session-store 持久化 currentSessionId 到 localStorage; ggbReady effect
用 getLastSessionId 自动 switchSession 上次会话, 修刷新画布空白。

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 7: 清理新手引导里的 recipe 引用

**Files:**
- Modify: `lib/onboarding-steps.ts`
- Modify: `components/ChatApp.tsx:636`（教程菜单文案）

**Interfaces:** 无新接口。

- [ ] **Step 1: 删 switchCmdTab helper 及其注释**

`lib/onboarding-steps.ts` 删除 `:32-45`（从"DOM 操纵 helper"注释到 `switchCmdTab` 函数结束），仅保留 `openCmdBar`。即删掉：

```ts
// 切换 CommandBar 的 tab: 派发对应 .cmd-tab 的 click 触发其 React onClick -> setMode
export function switchCmdTab(tab: 'history' | 'recipe'): void {
  const tabs = document.querySelectorAll<HTMLButtonElement>('.cmd-toggle .cmd-tab');
  const target = tab === 'history' ? tabs[0] : tabs[1];
  target?.click();
}
```

- [ ] **Step 2: 基础教程结束卡去掉"重建脚本"**

`lib/onboarding-steps.ts` 基础教程结束卡（`:96-103`）的 body 改为：

```ts
      body: '你已能画图并导出。还想看看进阶功能（历史对话、执行历史）吗？',
```

- [ ] **Step 3: 进阶教程删第 9 步（recipe-tab）+ 第 8 步去掉 switchCmdTab**

进阶教程 `buildAdvancedSteps`（`:108-142`）：
- 第 8 步（执行历史，`:120-128`）的 `preEnter` 改为 `() => { openCmdBar(); }`（删掉 `switchCmdTab('history')`）。
- 删除整个第 9 步（`:129-140`，"重建脚本"步，`anchor: '[data-tour="recipe-tab"]'`）。

改完后 `buildAdvancedSteps` 返回数组只有两步（对话与历史、执行历史）。

- [ ] **Step 4: ChatApp 教程菜单文案去掉"重建脚本"**

`components/ChatApp.tsx:636` 进阶教程菜单项描述改为：

```tsx
                  <span className="export-text"><span className="export-title">🧱 进阶教程</span><span className="export-desc">历史、执行记录</span></span>
```

- [ ] **Step 5: typecheck + 手动验证 + 提交**

Run: `pnpm typecheck` → 期望无错误。

手动（dev server）：点 📖 教程 → 进阶教程 → 不再出现"重建脚本"步；执行历史步正常高亮 🧱 面板。

```bash
git add lib/onboarding-steps.ts components/ChatApp.tsx
git commit -m "chore(tour): 清理 recipe-tab 引导步与文案(已退役)

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 8: 端到端验证 + 收尾

**Files:** 无新改动（验证 + 可能的小修）。

- [ ] **Step 1: 完整 E2E（dev server）**

按 spec §10 全跑：
1. AI 画图 → 工具栏手工加一个点/圆 → **刷新** → AI 图 + 手工内容**都在**（核心验收）。
2. 切到另一会话再切回 → 画布（AI + 手工）+ chat + 执行历史全恢复。
3. 刷新后自动回到上次会话、画布非空。
4. 老会话（无 canvas_xml）首次打开走重放、自愈落 XML；二次打开直接 setXML（Supabase 该行 canvas_xml 已非空）。
5. 🧱 仅「执行历史」单 tab，无「重建脚本」；临时测量（verify_geometry 的 ggbTmpM）不在历史里。
6. 画布核心回归：发一道题完整跑 agent 工具循环、LaTeX 行内/行间公式正常、OCR 识图流程正常、试用次数正常扣减。

- [ ] **Step 2: 最终 typecheck + 构建验证**

```bash
pnpm typecheck
pnpm build
```
均期望通过。

- [ ] **Step 3: 收尾提交（若有小修）**

若 Step 1/2 发现小修，修完后单独提交；否则无额外提交。

---

## 完成定义（DoD）

1. 刷新/切会话后，AI 绘制 + 手工绘制内容均无损还原（`setXML`）。
2. `sessions.canvas_xml` 随 AI 作图与手工编辑防抖落盘；切会话/`beforeunload` 兜底落盘。
3. `lib/condenser.ts` 删除；`generateRecipe`/`saveRecipe`/`replay`/recipe-tab 移除；每次 send 省一次 LLM 调用。
4. 执行历史从 `messages` 重建（`execLines`），刷新后历史 tab 非空。
5. 刷新后自动恢复上次会话（`currentSessionId` 持久化 + 自动 `switchSession`）。
6. 老会话回退重放 + 自愈落 XML，向后兼容。
7. `pnpm typecheck` + `pnpm build` 通过；画布核心（agent 循环 / 系统提示词 / LaTeX / OCR / 试用扣减）零回归。
8. 每个 task 单独提交，commit message 末尾含 `Co-Authored-By: Claude <noreply@anthropic.com>`。
