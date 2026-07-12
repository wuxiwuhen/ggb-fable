# 画布状态持久化：用 XML 快照替代命令重放（Design）

**日期：** 2026-07-12
**状态：** 已与用户确认设计，待写实施计划
**范围：** 解决"刷新/切会话后人工绘制内容丢失"，并退役 Condenser/recipe 重放机制

---

## 1. 背景与问题

产品用 AI 生成 GeoGebra 绘图命令（`execute_command` 工具）在画布上作图。当前画布恢复完全依赖**重放命令字符串**：`switchSession` 里 `clearAll` → 取 `recipe`（或回退 `extractReplayCommands`）→ `execBatch` 逐条 re-execute（`components/ChatApp.tsx:267-296`）。

问题：
- 画布对用户完全开放手工绘制（`lib/ggb.ts:139-148` toolbar/menubar/right-click 全开），但手工操作**不经过 `execCommand`**，因此不进 `commandLog`、不进 `messages`、不进 `recipe`。
- 于是刷新 / 切会话 / 清空工作区后，**人工绘制内容静默丢失**。
- 连带副作用：`get_canvas_context` 工具（`lib/ggb.ts:276`）读的是 *恢复后的* 画布；画布恢复不全 → agent 刷新后读不到手工内容。

**根因诊断**：把"agent 怎么画"和"画布怎么存"两个本该分层的关心点，压在了同一套表示（命令/recipe）上。命令是 agent 的**写语言**（祈使句），无法表达拖拽缩放、视图设置、属性编辑等手工操作；它不该兼任持久化。

## 2. 核心决策

**分层，不二选一：**
- **命令 = agent 的写语言**（保留）。AI 继续用 `execute_command` 画图，`lib/agent.ts` 工具循环、`SYSTEM_PROMPT` 零改动。
- **XML = 声明式持久化快照**（新增）。`getXML()` 与画布内容 1:1、无损、含手工绘制；`setXML()` 一次性还原。

二者天然合成：AI 用命令画 → 结果进画布 → `getXML()` 存快照 → 刷新/切会话 `setXML()` 无损还原。

**已确认的子决策（与用户逐项确认）：**
1. 走路线 A（会话级 XML 快照），不做路线 B（按消息级时间点回溯）。
2. 退役 Condenser（省一次 LLM 调用）；recipe 从"LLM 蒸馏重放脚本"改为**不再生成**。
3. 执行历史的恢复态**从 `messages` 重建**（不另存 recipe 列）。
4. `recipe` 列**保留不 drop**（免迁移），仅作为老会话（无 `canvas_xml`）的回退重放源被读一次。
5. `CommandBar` 砍成单 tab「执行历史」，删掉「重建脚本」tab 及其生成/编辑/重放。
6. 老会话回退重放后**自愈落 XML**，下次直接 `setXML`。

## 3. 数据模型

### 3.1 `supabase/schema.sql`

- `sessions` 建表加列 `canvas_xml text`（语义：该会话画布的完整 GeoGebra XML 快照）。
- 末尾兼容 alter：
  ```sql
  alter table public.sessions add column if not exists canvas_xml text;
  ```
- `recipe jsonb` 列**保留不动**（停写，仅老会话回退读）。
- `messages` 表**不动**。

### 3.2 `app/api/sessions/route.ts`

- **GET `?id=`**（`:26-35` 已是 `select('*')`）：加列后 `canvas_xml` 自动随 `session` 返回，**无需改代码**。
- **GET 列表**（`:37-42`，select 固定列）：**不**含 `canvas_xml`（避免大 XML 进列表 payload），无需改。
- **POST `update`**（`:60-67` 白名单）：加一行
  ```ts
  if (body.canvas_xml !== undefined) patch.canvas_xml = body.canvas_xml;
  ```

## 4. 恢复路径（`switchSession`，`components/ChatApp.tsx:267`）

替换现在的 recipe/execBatch 重放为 XML 优先 + 老会话回退：

```
clearAll()
if (session.canvas_xml) {
  ggb.setXML(session.canvas_xml)               // 无损还原，含手工绘制
} else {
  // 老会话回退：recipe 或原始命令 → execBatch 重放
  const cmds = session.recipe?.length ? session.recipe : extractReplayCommands(messages)
  if (cmds.length) await ggb.execBatch(cmds.join('\n'))
  persistCanvasXml()                            // 自愈：重放成功后立即落 XML，下次直接 setXML
}
setExecLines(rebuildExecLines(messages))        // 执行历史显示（已存在 :280）
```

关键：`setXML` 不走 `execCommand`，故 GGB 内部 `commandLog` 为空；但历史 tab 读 `execLines`（live 由 `onExec` 维护、恢复态由 `rebuildExecLines` 从 `messages` 的 `ggb_exec` 行重建，`lib/conversation.ts:48`），**不依赖 `commandLog`**，因此不会空。

**恢复抑制**：恢复期间（`setXML` 或回退重放）用 `restoringRef` 置位，抑制 §5 的 `schedulePersist`——否则 `setXML` 触发的 add/update 监听事件会把刚还原的相同 XML 又写回一遍（无害但浪费，且避免边界环）。恢复完成后复位。

## 5. 捕获路径（新增防抖 `persistCanvasXml`）

新增防抖（~800ms）函数：`xml = ggb.getXML()` → `POST /api/sessions { action:'update', id, canvas_xml: xml }`。三个触发点覆盖 AI 命令 + 手工绘制两条路径：

1. **AI 画完**：`onExec` 钩子（`ChatApp.tsx:435-438`）加 `schedulePersist()`。
2. **手工绘制**：把现在**空转的监听器接上**——`lib/ggb.ts:121-122` 的 `onUpdate()` / `onCommand()` 已定义但全代码无订阅者；在 ChatApp 里 `useEffect` 订阅 → `schedulePersist()`。（监听器本身在 `:156-159` 已注册：client/add/remove/update。）这是手工内容能进快照的关键。
3. **离开兜底**：`switchSession` 开头先 `persistCanvasXml()` 当前会话；`beforeunload` 用 `navigator.sendBeacon` best-effort 落盘。

**`lib/ggb.ts` 补两个公开方法**（现仅内联用于 `reinit:188` / `getCanvasContext:276` / `clearAll:333`）：
- `getXML(): string` — `this.applet?.getXML?.() || ''`
- `setXML(xml: string)` — `this.applet?.setXML?.(xml)`（参考 `reinit:202` 的等就绪恢复写法）

## 6. Condenser / recipe 退役清单

**删除：**
- `lib/condenser.ts` 整文件。
- `components/ChatApp.tsx`：
  - `import { Condenser } from '@/lib/condenser'`（`:20`）
  - `generateRecipe`（`:487-504`）
  - `saveRecipe`（`:507-519`）
  - `replay`（`:562-567`）
  - send 里的 `if (!result.stopped) generateRecipe(backend)`（`:455`）
  - `recipe` / `recipeLoading` state（`:132-133`）
  - `CommandBar` 调用里的 recipe 相关 props（`:678-685`）
- `components/CommandBar.tsx`：「重建脚本」tab、🔄生成 / ✏编辑 / ▶重放 按钮、相关 props 与 state。**保留「执行历史」单 tab**（移除 tab 切换 UI）。
- 进阶教程菜单文案「重建脚本」（`ChatApp.tsx:636`）、onboarding 里 `data-tour="recipe-tab"` 等引用（`lib/onboarding-steps.ts` 内）随之删/改。

**保留并复用：**
- `extractReplayCommands`（`lib/conversation.ts:36`）——老会话回退用。
- `rebuildExecLines`（`lib/conversation.ts:48`）——执行历史恢复态。
- **`CommandBar` 改读 `execLines`（单一数据源）**：live（`onExec` 已维护）与恢复（`rebuildExecLines`）都正确。`ChatApp` 移除 `commandLog` state 及 `onExec` 里的 `setCommandLog`（`:437`）。`CommandBar` 的 prop 从 `commandLog: {cmd,ok,labels,error,ephemeral?}[]` 改为 `execLines`（形状 `{cmd, result:{ok,labels,error}}`），内部渲染相应调整。
- **临时测量过滤**：原 `commandLog` 靠 `!ephemeral` 过滤 `verify_geometry` 的临时测量命令。改读 `execLines` 后无 `ephemeral` 标志，改在 `CommandBar` 显示层按命令模式过滤（临时测量标签硬编码为 `ggbTmpM`，见 `lib/ggb.ts:315`）：`visibleLog = execLines.filter(e => !/^ggbTmp\w*\s*=/.test(e.cmd))`。`TracePanel`（admin，同样读 execLines）不过滤、保持现状。

## 7. 顺带修复：刷新画布空白

现状：`ChatApp.tsx:299-318` 的 `ggbReady` effect 只 `setSessions(list)`，**从不选中上一个会话、也不 `switchSession`**；`useSessionStore`（`lib/session-store.ts`）非持久化 → 刷新后 `currentSessionId=null`、画布空。

修复：
- `lib/session-store.ts`：把 `currentSessionId` 持久化到 `localStorage`（手写或 zustand `persist` 中间件，仅持久这一个字段）。
- `ChatApp.tsx:299` effect：读完列表后，若存在持久化的 `currentSessionId` 则 `switchSession(lastId)`，否则维持现有"无会话→建空会话/进最近会话"逻辑。

这是路线 A 能跑完整的必要前提。

## 8. 错误处理与取舍

- **`beforeunload` sendBeacon 偶发不可靠** → 由 §5.1/§5.2（AI 画完、手工编辑时）防抖落盘兜底；最坏只丢"最后一次操作后未再触发改动"的尾态。
- **`getXML()` 是否含视图状态（缩放/平移）**：实施时验证。若不含，对象（含手工）仍无损还原（本需求核心）；视图状态可作为后续增强。
- **`setXML` / `getXML` 失败**：`try/catch` + `console.warn`，不阻塞 UI（与现有 `reinit` 恢复写法一致）。
- **老会话回退重放**仍带历史缺陷（重放失败命令会再报错），但一次性；自愈落 XML 后即升级，不再走重放。
- **`newSession`/`clearWorkspace` 的空判守卫**（`:232`/`:254`）依赖 `getCommandLog().length`，setXML 恢复后该值为空——但守卫同时检查 `messages.length`，恢复态 messages 非空，故不误判。无需改（实施时回归确认）。

## 9. 明确不在本次范围

- **按消息级回溯画布**（回到第 N 条消息那一刻的画布）= 路线 B，将来需要再做。
- **agent 感知手工内容**：已具备（`get_canvas_context` 读 live 画布；快照无损后刷新即读到真实状态）。无需新工具。

## 10. 验证策略

无测试框架（项目约定 `tsc --noEmit` + node 脚本 + 手动验证）：
- `pnpm typecheck` 通过（删 Condenser 后无悬空引用）。
- 手动 E2E（dev server）：
  1. AI 画图 → 工具栏手工加一个点/圆 → 刷新 → **手工内容仍在**（核心验收）。
  2. 切到另一会话再切回 → 画布（AI + 手工）+ chat + 执行历史全恢复。
  3. 刷新后自动回到上次会话、画布非空（§7 验收）。
  4. 老会话（无 canvas_xml）首次打开走重放、随后自愈为 XML；二次打开直接 setXML。
  5. CommandBar 仅「执行历史」单 tab，无「重建脚本」。
  6. 画布核心回归：agent 工具循环、LaTeX 渲染、OCR 流程未受影响。

## 11. 完成定义（DoD）

1. 刷新/切会话后，AI 绘制 + 手工绘制内容均无损还原（setXML）。
2. `sessions.canvas_xml` 随 AI 作图与手工编辑防抖落盘；切会话/beforeunload 兜底落盘。
3. Condenser 删除；`generateRecipe`/`saveRecipe`/recipe-tab 移除；每次 send 省一次 LLM 调用。
4. 执行历史从 `messages` 重建，刷新后历史 tab 非空。
5. 刷新后自动恢复上次会话（currentSessionId 持久化 + 自动 switchSession）。
6. 老会话回退重放 + 自愈落 XML，向后兼容。
7. `pnpm typecheck` 通过；画布核心（agent 循环 / 系统提示词 / LaTeX / OCR）零回归。

## 12. 涉及文件清单

| 文件 | 改动 |
|---|---|
| `supabase/schema.sql` | 加 `canvas_xml text` 列 + 兼容 alter |
| `app/api/sessions/route.ts` | POST `update` 白名单加 `canvas_xml` |
| `lib/ggb.ts` | 暴露 `getXML()` / `setXML()` 公开方法 |
| `components/ChatApp.tsx` | switchSession 改 setXML+回退+自愈；新增 `persistCanvasXml`+防抖+`restoringRef` 抑制；订阅 `onUpdate`/`onCommand`；onExec 触发 persist；移除 commandLog state 与 onExec 的 setCommandLog；beforeunload sendBeacon；删 Condenser/recipe/replay；reload 自动 switchSession |
| `components/CommandBar.tsx` | 砍成单 tab「执行历史」；prop 改读 `execLines`；按 `ggbTmp` 模式过滤临时测量；删 recipe 相关 props/UI |
| `lib/condenser.ts` | **删除** |
| `lib/conversation.ts` | 无需改（复用 `rebuildExecLines`/`extractReplayCommands`） |
| `lib/session-store.ts` | 持久化 `currentSessionId` 到 localStorage |
| `lib/onboarding-steps.ts` | 删/改 recipe-tab 相关 tour 步骤与文案 |
