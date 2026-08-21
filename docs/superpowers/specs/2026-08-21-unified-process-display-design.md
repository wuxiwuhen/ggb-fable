# 生成过程统一展示（方案 A：最小推广）设计规格

**日期**: 2026-08-21
**状态**: 已获用户批准（含 finalText 语义变更：全程累加叙述，效果待用户实测）

## 背景与问题

现状两类体验割裂：

- **思考开时（好体验）**：气泡顶部"思考中…"折叠块 + 滚动思考流 + 下方状态行（`AssistantProgress`：规划中/解题中/执行第 N 步…）。
- **思考关时（差体验）**：状态行只在正文为空时显示（`preText = m.streaming && !m.content.trim()`），正文 token 一到就被挤掉；且 `onRound` 每轮清空 `streamBuf` 重写正文（[ChatApp.tsx:851-856](../../../components/ChatApp.tsx)）——纯文字气泡反复跳变，无结束信号。

**目标**：把思考流的展示形式推广到全部中间内容——生成中 = 状态行常驻 + 中间内容在过程区滚动变化；结束后只留一行可展开的折叠行 + 最终结果气泡。

## 已确认的产品决策

1. **结束后过程区**：折叠成一行可展开（"已思考 Ns · 查看过程 ▾"），事后可回看。
2. **叙述更新方式**：多轮累加 + 截尾（与思考流一致，`slice(-2000)`），轮间以空行分隔，不清空重写。
3. **finalText 语义**：`logTurnInterrupt`/中止路径的 `finalText` 从"当前轮文本"改为"全程累加叙述"（用户明确要求先这么改，看效果再优化）。
4. 方案选型：A（思考块原样保留，推广其交互模式给叙述文本）；B（合并单一过程区）、C（仅常驻状态行）已否决。

## 交互形态

### 生成中（assistant 气泡，自上而下）

```
┌─ OCR 识别块（有图时，行为不变）
├─ 思考块（思考开时，行为不变：『思考中…（点击收起）』toggle + 滚动思考流）
├─ 状态行（AssistantProgress，常驻——不再被正文出现挤掉）
└─ 叙述过程区（新增：暗色滚动块，复用 .thinking-text 样式，无 toggle）
```

- 叙述过程区显示累加叙述尾部（`slice(-2000)`），与思考流同款视觉（`max-height:180px; overflow-y:auto` 的自然滚动效果，无新增滚动逻辑）。
- `m.content` 在生成期间保持空字符串——流式正文不再直接进气泡；`preText` 概念删除。

### 结束后（成功/出错/中止且有内容）

```
┌─ 折叠行：『已思考 12s · 查看过程 ▾』（无思考则仅『查看过程 ▾』）
└─ 最终气泡：MessageContent(finalText) ——正文第一次以正常气泡出现
```

- 展开折叠行显示两段：思考过程（有则，小标题"思考过程"）+ 执行叙述（小标题"执行叙述"），段间留白。
- 过程文本 → 正常气泡的瞬间切换即"完成"信号。
- 默认折叠；展开态为组件内局部 state。

## 状态与数据流

### Msg 类型

```ts
interface Msg {
  // ...现有字段不变
  process?: { thinking?: string; narrative?: string; thinkSecs?: number };
}
```

- 仅内存态，turn 结束时一次性写入；不进 DB（刷新后历史轮只显示最终气泡，与今天思考流行为一致）。

### 流式缓冲

- `streamBuf`（rAF 缓冲）语义变更：**跨轮累加**。`onRound` 从"清空"改为：非 final 轮且缓冲非空时追加 `'\n\n'` 轮间分隔。
- `flushStream` 目标从 `m.content` 改为新 state `narrText`（与 `thinkingText` 平行，rAF 批量同模式）。
- `narrText` 与 `thinkingText` 同样挂靠 `thinkMsgId` 消息渲染。

### turn 收尾（三路径）

| 路径 | content | process | 其他 |
|---|---|---|---|
| 成功 | `finalText`，`streaming:false` | `{ thinking, narrative, thinkSecs }` 写入（**读 ref**：`thinkBufRef.current` / `streamBuf.current?.text`，不读 state——setState 异步，收尾时 state 可能尚未 flush） | 现有 history/persist 逻辑不变 |
| 出错 | 累加叙述（`streamBuf.current?.text`）`\|\| '（出错）'` | 同上写入 | error banner 照旧 |
| 中止 | 有文本→同出错；**无任何文本→移除空气泡（现状不变）** | 有文本则写入 | `logTurnInterrupt` 的 `finalText` 现在是全程累加叙述 |

- `finally` 块：取消 rAF、flush 两个缓冲、计算 `thinkSecs`、清 live state（`narrText` 与 `thinkingText` 一并清）。

## 组件与样式

- `AssistantProgress`：逻辑不动；挂载条件从 `preText` 改为 `m.streaming`（常驻生成期）。
- 新增纯展示组件 `ProcessTail`（同文件内函数组件即可，与 `AssistantProgress` 同层级）：
  - props: `process`；内部 `open` 局部 state，默认 false。
  - 折叠行文案：`thinkSecs ? \`已思考 ${thinkSecs}s · 查看过程 ▾\` : '查看过程 ▾'`；展开时 `▲`，内容为思考段（有则）+ 叙述段。
- 思考块（live）仅 `m.streaming` 时渲染；结束后由 `ProcessTail` 接管（不再渲染旧"已思考 Ns ▾"独立块）。
- 叙述过程区（live）：`m.streaming && m.id === thinkMsgId && narrText` 时渲染 `<pre className="thinking-text">{narrText.slice(-2000)}</pre>`。
- CSS：预计零新增（复用 `.thinking-block/.thinking-text/.ocr-toggle`）；至多加一两行分隔样式。

## 边界与回归保护

- OCR 块位置与行为不变（仍在最上）。
- `switchSession`/刷新恢复：历史消息无 `process` 字段，走纯 `MessageContent` 分支——渲染分支必须以 `m.process` 是否存在为门。
- 生成中切换会话/停止：沿用现有清理路径，`narrText` 清空避免残留到下一轮。
- 欢迎页、示例 chips、用户气泡、系统消息不受影响。
- turn-interrupt 落库（`logTurnInterrupt`）：仅 finalText 语义按决策 3 变化，其余不变。

## 测试（手动清单）

1. 思考关 + 简单题（圆锥螺线）：全程状态行 + 叙述区滚动；结束收成折叠行 + 最终气泡。
2. 思考开 + 复杂题（抛物线）：思考块 + 状态行 + 叙述区三层共存，阶段行随阶段切换（解题中→执行第 N 步）。
3. 生成中点"停止"（有文本/无文本两种）、上游报错路径：气泡与折叠行符合上表。
4. 刷新 / 切走再切回会话：历史轮只有最终气泡，无折叠行。
5. 带图输入：OCR 块在最上、位置不变。

单元测试：UI 渲染无现成组件测试基建，不新增；`onRound` 分隔与收尾写入逻辑如有可提取纯函数则顺手覆盖，否则以手动清单验收。

## 不做的事（YAGNI）

- 过程数据不持久化到 DB。
- 不做工具调用行进入过程区（状态行已覆盖阶段感知；完整命令日志在命令面板）。
- 不合并思考块与叙述区为单一容器（方案 B 已否决）。
- 不新增自动滚动逻辑（截尾 + 有限高容器即现状思考流行为）。
