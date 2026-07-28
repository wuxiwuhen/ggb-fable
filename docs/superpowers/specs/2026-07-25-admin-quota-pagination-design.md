# 管理后台 · 额度管理列表 —— 分页 + 总人数 + 懒加载

## 背景

管理后台「额度管理」Tab 当前只显示 10 条用户记录。

**根因**：前端 `app/admin/page.tsx:67` 的 `loadUsage` 硬编码发送 `limit: '10'`。虽然上一个 commit `d858c9d` 把 API 默认 limit 提到了 200，但前端一直带着 `limit=10`，所以页面上无搜索路径拿到的仍是 10 条（且因加了 `order by updated_at desc`，漏的总是「最久没更新的人」）。API 返回结构只有 `{ rows: [...] }`，**没有 total / count / page / hasMore**，全代码库没有任何分页先例。

## 目标

- 顶部显示**总人数**（搜索时显示匹配数）
- 底部分页器**翻页**（上一页 / 页码 / 下一页），每页 **20 条**
- **懒加载**：点页码才请求对应页，不累积、不一次拉全
- 看到所有用户

## 关键决策

### 数据口径：B —— 以 `profiles` 表为数据源（所有注册用户）

列表改为以 `profiles`（用户档案）为主表，LEFT 补 `usage` 的 `used` / `trial_limit`。

**关于「注册但从未试用的用户」的澄清**（读 `supabase/schema.sql:56-87` 后修正）：
schema 里有注册触发器 `handle_new_user`，新用户注册时**会同时插入 `profiles` 行和 `usage` 行（`used=0`, `trial_limit` 取 `app.trial_default_limit` 默认 5）**。因此注册未试用的用户**本来就在 `usage` 表里**（`used=0`），A/B 两方案在正常情况下行数几乎一致。选 B 的真正理由：
- `email` 字段直接在 `profiles` 上，搜索无需现状那套「先 ilike profiles 拿 id 再 in usage」两跳；
- 语义上 `profiles` = 用户，列表名正言顺；
- 防御触发器遗漏的边缘情况（老数据 / 触发器失败）—— 以 profiles 为准不会漏人。

### 交互形式：分页器（用户已确认）

每页 20 条，底部 `‹ 上一页  1 2 3 4 5  下一页 ›` +「第 X 页 / 共 Y 页」。能跳页、能看总数与当前位置，适合管理后台数据表。不选加载更多 / 无限滚动。

### 技术实现：offset 分页

Supabase `.range(from, to)` + `{ count: 'exact' }`。用户量小，offset 无性能问题；Supabase 一条主查询即可同时拿到当前页数据与 total。不选游标分页（不支持跳页）、不选一次拉全部前端切页（不算懒加载、不可扩展）。

### 查询结构：两次查询（非嵌套）

`profiles.user_id` 与 `usage.user_id` **没有直接外键**（二者都只 `references auth.users(id)`），PostgREST 嵌套 select 的自动 join 不可用。故采用：主查 `profiles`（分页 + count + 可选 email 过滤）→ 用当前页 `user_id` 批量补 `usage` → 内存合并。结构与现有 `enrichUsage` 同构，只是主从表对调。

### 排序：`profiles.created_at desc`

注册倒序，所有行都有值、稳定，且不受「刷新额度改变 `usage.updated_at`」影响（不会因刷新导致行跳动）。`profiles.created_at` 目前无索引，全表 sort，当前用户量可接受；量大时再加索引（见「不做 / 后续」）。

## 设计

### 数据流

```
app/admin/page.tsx  loadUsage(page)
  → GET /api/admin/usage?page=1&pageSize=20[&email=q]
    → requireAdmin(req)                    // 鉴权, 保持不变
    → getSupabaseAdmin()                   // service_role, 绕过 RLS
    → [1] profiles.select(..., {count:'exact'}) [ilike email] order created_at desc range
    → [2] usage.select(user_id,used,trial_limit).in('user_id', 当前页 ids)
    → 内存合并 + coalesce
    ← { rows: [...], total, page, pageSize }
  ← 渲染当前页 + 分页器（仅 total > pageSize 时显示）
```

### 后端 API（`app/api/admin/usage/route.ts`，仅改 GET）

**入参**（query string）：
- `page`：页码，默认 `1`，<1 视为 1
- `pageSize`：每页条数，默认 `20`，上限 `100`
- `email`：可选，邮箱搜索（ilike）

**返回**：
```json
{
  "rows": [
    { "user_id": "uuid", "email": "...", "used": 3, "limit": 5, "remaining": 2 }
  ],
  "total": 87,
  "page": 1,
  "pageSize": 20
}
```
`rows` 字段名与现状一致（前端 `UsageRow` 接口不动），仅新增 `total` / `page` / `pageSize` 三个顶层字段。

**查询逻辑**：
```ts
const page = Math.max(1, Number(url.searchParams.get('page')) || 1);
const pageSize = Math.min(Number(url.searchParams.get('pageSize')) || 20, 100);
const email = url.searchParams.get('email')?.trim() || '';
const from = (page - 1) * pageSize;
const to = from + pageSize - 1;

// [1] 主查询: profiles + count + 可选搜索 + 分页
let query = admin.from('profiles')
  .select('user_id, email, is_admin, created_at', { count: 'exact' })
  .order('created_at', { ascending: false })
  .range(from, to);
if (email) query = query.ilike('email', `%${email}%`);
const { data: profileRows, count, error } = await query;
if (error) return Response.json({ error: error.message }, { status: 500 });

// [2] 补 usage
const ids = (profileRows ?? []).map(r => r.user_id);
const usageMap = new Map<string, { used: number; trial_limit: number }>();
if (ids.length) {
  const { data: uRows } = await admin.from('usage')
    .select('user_id, used, trial_limit')
    .in('user_id', ids);
  (uRows ?? []).forEach(r => usageMap.set(r.user_id, r));
}

// [3] 合并 + coalesce（默认 5 对应 schema 里 trial_limit default / 触发器 trial_default）
const DEFAULT_LIMIT = 5;
const rows = (profileRows ?? []).map(p => {
  const u = usageMap.get(p.user_id);
  const limit = u?.trial_limit ?? DEFAULT_LIMIT;
  const used = u?.used ?? 0;
  return { user_id: p.user_id, email: p.email, used, limit, remaining: limit - used };
});

return Response.json({ rows, total: count ?? 0, page, pageSize });
```

- 鉴权 `requireAdmin(req)`（route.ts:13-19）保持不变，非 admin 返回 403。
- `runtime = 'edge'` 保持不变（两次 await 在 Edge runtime 可用，现状已是 Edge）。
- POST（刷新 / 设额度，route.ts:83-103）完全不动。
- 删除旧 GET 里的「无搜索 / 搜索」分支与 `enrichUsage`，由上面的统一逻辑取代（搜索只是主查询上多挂一个 `.ilike`）。

### 前端（`app/admin/page.tsx`）

**State**：
- 新增 `page`（默认 1）、`total`（默认 0）
- 新增常量 `PAGE_SIZE = 20`
- 删除「显示前 N 条」相关的旧文案逻辑

**`loadUsage` 改造**（page.tsx:59-67）：
- 去掉硬编码 `limit: '10'`
- `buildParams` 拼 `page` + `pageSize`（+ 可选 `email`）
- 解析返回的 `total` 写入 state
- 用当前 `page` 请求，翻页不累积

**搜索行为**（page.tsx:146-152 的 useEffect）：
- `search` 变化时先 `setPage(1)` 再 `loadUsage`（回到第 1 页）

**UI**：
- 顶部条数文案（page.tsx:245-248）：`共 {total} 人`；搜索时 `匹配 {total} 人`。替换原「前 {n} 条」。
- 表格列保持不变（用户 / 已用 / 额度 / 剩余 / 操作）。
- 底部分页器（仅当 `total > PAGE_SIZE` 时渲染）：
  - `‹ 上一页`（`page > 1` 可点，否则灰）
  - 页码按钮 `1 .. totalPages`（用户量小先全显示；若 `totalPages > 7` 再加 `…` 折叠——见「不做」）
  - `下一页 ›`（`page < totalPages` 可点，否则灰）
  - 辅助文案 `第 {page} 页 / 共 {totalPages} 页`
- 翻页交互：点击 → `setPage(n)` → `loadUsage(n)`
- 加载中：分页按钮 `disabled` + 文案「加载中…」
- 样式：沿用现有 `S` 常量（inline style、indigo `#4f46e5` 主色），不引入 Tailwind / 组件库

### 边界与错误处理

- `total === 0`：表格区显示空状态（「暂无用户」/ 搜索无结果时「无匹配用户」）
- `page` 越界（例如翻页期间有用户注销导致总数下降）：API 端不额外 clamp（`range` 越界 Supabase 返回空数组 + 正确 count），前端发现当前页空且 `page > 1` 时自动回退到上一页重查
- 单页（`total <= PAGE_SIZE`）：隐藏分页器，只显示总数
- 单用户「刷新 / 设额度」后：用当前 `page` 重新 `loadUsage`，停留在本页、不跳页（排序按 `created_at`，行不会因 `updated_at` 变化而跳动）
- 请求失败：沿用现有错误处理，分页器 disabled

## 测试（手动）

本地 `pnpm dev` 或公网 URL，以 admin 登录后：

- [ ] 默认进入第 1 页，显示 20 条 + 顶部「共 N 人」，N 与 DB `select count(*) from profiles` 一致
- [ ] 点页码 / 上一页 / 下一页，数据正确切换、不串味、不重复
- [ ] `used=0` 的注册用户（未试用）出现在列表，limit 显示 5
- [ ] 搜索某邮箱 → 自动回到第 1 页，顶部变「匹配 N 人」，结果正确
- [ ] 用户总数 ≤ 20 时分页器隐藏
- [ ] 单用户「刷新额度」后，当前页数据更新且不跳页
- [ ] 非 admin 访问 `/api/admin/usage` 仍返回 403
- [ ] `next build` 通过

## 不做（YAGNI）

- 不做 URL 同步页码（`?page=2`）—— 后台够用，刷新回第 1 页可接受
- 不做页码折叠省略号（除非将来 `totalPages > 7`）
- 不做每页大小切换器（固定 20）
- 不改 POST（刷新 / 设额度）逻辑
- 不给 `profiles.created_at` 加索引（量小；量大时再加 `create index ... on profiles(created_at desc)`）
- 不改其他三个 Tab（用户反馈 / 用户指令 / 提示词版本）

## 涉及文件

| 文件 | 改动 |
|---|---|
| `app/api/admin/usage/route.ts` | GET 重构为分页（profiles 主 + 补 usage + count），删除旧分支与 enrichUsage；POST 不动 |
| `app/admin/page.tsx` | `loadUsage` 带 page/pageSize、去硬编码 limit=10；新增 page/total state；顶部总数文案；底部新增分页器 UI |
| `supabase/schema.sql` | **不改**（无 FK 需求、无索引需求） |
