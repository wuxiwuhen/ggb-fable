# 历史会话（会话列表 + 切换恢复）设计

- **日期**：2026-07-10
- **状态**：已批准（待实现）
- **参考**：DeepSeek 网页端 / ChatGPT 网页版

---

## 1. 目标

登录用户可**新建 / 切换**历史会话；切换时该会话的全部数据恢复——聊天消息、GeoGebra 画布、工具轨迹、history 上下文。

## 2. 范围

**IN**：可折叠侧边栏（新建 + 切换）、多会话状态隔离、画布 recipe 重放恢复、消息实时持久化、AI 生成会话标题、顺手修 logger 不带 sessionId 的 bug。

**OUT（MVP，后续再做）**：删除会话、重命名会话。未登录不支持（已被 middleware 挡去登录页）。

**硬约束**：不影响画布生成的核心逻辑（agent 工具循环、系统提示词、`cleanFinalText` 一律不动）。

## 3. 现状（探索结论）

- `supabase/schema.sql` 已有 `sessions` + `messages` 表（含 RLS、用户隔离）。
- `/api/sessions` 已有 create / append / update(仅 title) / list / get。**缺 delete**（MVP 不需要）。
- 但**前端从未用过这套做历史会话**——只有 `logger.ts` 往里塞分析数据，且 logger 没带 sessionId（每次 flush 建空会话，bug）。
- ChatApp 是纯单会话 `useState`（messages / history / trace / recipe 刷新就没）。
- recipe（重建脚本）只在前端 state（`generateRecipe` 用 Condenser 生成），**未持久化**。

## 4. 数据模型（Supabase，小改）

- `sessions` 表**加一列** `recipe jsonb`（存该会话精简重建脚本的命令数组）：
  ```sql
  alter table public.sessions add column if not exists recipe jsonb;
  ```
- `messages` 表**不变**（已能存对话 + 工具轨迹）。
- `/api/sessions` 改动：
  - `GET ?id=UUID` 返回值由 `{ messages }` 改为 `{ session: { id, title, recipe, ... }, messages }`（带上 recipe）。
  - `POST update` 除 `title` 外，支持 `recipe` 字段写入。
  - 不加 delete（MVP 不做删除）。

## 5. 画布恢复 —— recipe 重放

- **持久化**：`generateRecipe` 跑完（Condenser 已生成精简命令），前端调 `POST /api/sessions { action:'update', id, recipe }` 存入 `sessions.recipe`。
- **切换恢复**：读 `session.recipe` → `ggb.clearAll()` → `ggb.execBatch(recipe)` 重放。
- **回退**：recipe 是异步生成，若切换时该会话 recipe 尚未就绪（null）→ 回退为从 `messages` 里提取所有 `execute_command` 的命令重放（保证有东西可恢复，不阻塞）。
- 不引入 XML / `setXML`，不改 `ggb.ts` 的核心构造逻辑（只用已有的 `clearAll` + `execBatch`）。

## 6. 会话标题 —— 独立 AI 调用（不碰画布核心）

- **新 API route** `app/api/trial/title/route.ts`：
  - `POST { text }` → 用服务端 key 调 LLM（deepseek-v4-pro），prompt 固定：「给下面这段数学问题生成一个 ≤15 字的中文标题，只输出标题文本」→ 返回 `{ title }`。
  - **不扣试用次数**（不调 `deduct`；标题是产品功能，不该耗用户额度）。
  - 走 cookie JWT 鉴权（同 `/api/trial/llm`）。
- **BYOK 模式**：前端用用户自己的 key 直连生成（`chatByok` 风格，不经过我方后端）。
- **时机**：会话首条 user 消息发出后，后台异步生成，成功则 `update session.title`。
- **失败兜底**：生成失败/超时 → 保留"新对话"占位，不阻塞主流程。
- **不碰**：agent 的工具循环、系统提示词、`cleanFinalText`。标题是完全独立的链路。

## 7. 状态隔离（ChatApp 单会话 → 多会话）

引入会话存储（zustand，项目已用 zustand 做 config）：
- `sessions`: 已加载的会话列表（元数据，来自 `GET /api/sessions`）。
- `currentSessionId`: 当前激活会话。
- 每会话的运行态（messages / history / trace / recipe / commandLog）按 sessionId 缓存；切换时换入对应快照。

**切换流程**：
1. 当前会话的 recipe 已实时持久化（见 §5），无需额外存。
2. `GET /api/sessions?id=<目标>` → `{ session, messages }`。
3. 重建 chat 消息（role=user/assistant 的 content）+ trace（role=tool 的 tool_name/args/result）。
4. 恢复画布：`clearAll` + 重放 `session.recipe`（或回退 messages 命令）。
5. 重建 history（从 user/assistant messages 文本，截断 8 条）。

**实时持久化**：修复 logger 带 sessionId（`logger.setSession(sessionId)` 在创建/切换会话后调用），沿用 `append` 把 user / tool / turn_end 事件实时写 Supabase。

## 8. UI —— 可折叠侧边栏

- 新组件 `components/SessionSidebar.tsx`：
  - ☰ 按钮常驻顶栏（或 chat-pane 角落）；点击 `sidebarOpen=true` 浮出列表（绝对定位浮层，不挤 chat/canvas）。
  - 列表项：标题（或"新对话"）+ 相对时间；当前会话高亮。
  - 操作：`+` 新建、点项切换。（MVP 无删除/重命名。）
- 状态：`sidebarOpen`（默认 false）。

## 9. 生命周期

- **首次进入应用**：`GET /api/sessions` 拿列表；若无会话，自动 `create` 一个空会话（标题"新对话"），设为 current。
- **新建**：`create` 空会话 → 设为 current → `clearAll` 画布 → 清空 chat/trace。
- **首条消息后**：后台触发标题生成（§6）。
- **发送/工具/回复**：实时 `append` 到当前 session。
- **turn 结束**：`generateRecipe` → 存 `session.recipe`。

## 10. 边界与错误处理

- 仅登录用户（未登录被 middleware 重定向）。
- recipe 异步未就绪 → 回退 messages 命令重放（§5）。
- 标题生成失败 → 保留"新对话"。
- 画布重放失败（execBatch 异常）→ `clearAll` + 提示"画布恢复失败，可重新发送"，不阻塞 chat。
- 切换时若正在 sending → 先 abort 当前 agent 请求（`abortRef.current.abort()`）再切换，避免并发污染会话状态。

## 11. 验证

- `pnpm typecheck` 通过。
- 手动端到端：
  1. 新建会话 A → 发"画抛物线 y=x²-4x+3" → 等画布生成 + 标题出现。
  2. 新建会话 B → 发另一题 → 画布切换。
  3. 切回 A → 确认 chat 消息、画布（抛物线恢复）、工具轨迹、history 都回来。
  4. 侧边栏显示 AI 生成的标题。
- 暗访：recipe 未就绪时切换能回退重放。

## 12. 完成定义（DoD）

1. 新建 / 切换会话可用，切换后 chat + 画布 + trace + history 全部恢复。
2. 画布靠 recipe 重放恢复；recipe 持久化到 `sessions.recipe`。
3. 会话标题由独立 AI 调用生成（不影响画布核心）。
4. logger 带 sessionId（空会话 bug 修复）。
5. `pnpm typecheck` 通过；改动提交。
