# Agent LaTeX 回归修复 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修好 web 版 `lib/agent.ts` 的 LaTeX 渲染回归，方式是把 `cleanFinalText` 里偏离参考的激进坏分隔符正则回退到参考 `ggb_fable/js/agent.js` 的保守版，并验证修复。

**Architecture:** 改动隔离在 `lib/agent.ts` 的 `cleanFinalText` 函数一处正则。先用一个一次性 Node 脚本对照"激进版 vs 保守版"在真实 K12 文本上的行为差异（去风险闸门 + 根因证据），再回退正则，最后端到端跑真实题目验证 LaTeX 渲染与视觉优化。回退无论根因是否唯一都该做（消除分叉、严格更安全）。

**Tech Stack:** Next.js 15 (TS) · 无测试框架（仅 `tsc --noEmit`）· Node 跑一次性 `.mjs` 复现脚本 · 手动端到端验证（`pnpm dev` + 浏览器）

## Global Constraints

- **隔离性**：本次只改 `lib/agent.ts` 一个 hunk。**禁止** `git add` 仓库里其余 14 个在途未提交文件（auth 迁移、Supabase 等）—— 提交时只 stage `lib/agent.ts`。
- **模型**：参考与 web 试用均为 `deepseek-v4-pro`（用户已在 `.env.local` 设 `DEEPSEEK_MODEL`）。
- **无测试框架**：不引入 jest/vitest。验证靠"确定性复现脚本 + 手动端到端"。
- **参考实现**：`/Users/wuxi/claudecode/first_try/ggb_fable/js/agent.js`（只读对照，勿改）。
- **提交规范**：commit message 末尾加 `Co-Authored-By: Claude <noreply@anthropic.com>`。

---

## File Structure

- **Modify**: `lib/agent.ts` —— 函数 `cleanFinalText`（约 244-266 行），回退"坏分隔符"正则段 + 改注释文档化根因。这是唯一的生产代码改动。
- **Scratch (不提交)**: `repro-cleanfinal.mjs`（仓库根目录，一次性诊断脚本）—— 对照激进/保守两版在样本文本上的输出。本地保留、**禁止 `git add`**；整个工作结束后删除。
- 不新建任何生产文件，不动其它模块。

---

## Task 1: 确定性复现 —— 激进 vs 保守正则差异（根因证据 + 去风险闸门）

**Files:**
- Create: `repro-cleanfinal.mjs`（仓库根目录，scratch，不提交）

**Interfaces:**
- Consumes: 无（自包含，内联两版 `cleanFinalText` 的精确拷贝）
- Produces: 一份打印输出，作为"激进版是否腐蚀真实 LaTeX"的证据，决定 Task 3 端到端验证的预期（是否回退即可完全修好，还是可能还有第二原因）。

**说明**：回退（Task 2）**无论本任务结论如何都执行**——消除分叉、严格更安全。本任务的作用是判断"回退能否单独修好 LaTeX"，而非是否回退。

- [ ] **Step 1: 创建复现脚本**

写入 `repro-cleanfinal.mjs`（完整内容如下。两版函数逐字拷贝自 `lib/agent.ts` 当前未提交版 与 `ggb_fable/js/agent.js`，仅分隔符正则不同）：

```js
// 一次性诊断: cleanFinalText 激进版 vs 保守版(参考) 在 K12 文本上的差异。
// 不提交进仓库。跑完看 DIFF 行 —— 激进版会破坏合法行内公式 $...(\latex)...$。
function cleanAggressive(text) {
  if (!text) return text;
  let t = text;
  t = t.replace(/```(?:geo|ggb|geogebra)?\s*\n([\s\S]*?)```/g, (full, inner) => {
    return /(?:=\s*\(|(?:Slider|Segment|Circle|Point|Line|Polygon|Text|SetColor|SetLineStyle|SetValue|Intersect|Midpoint)\s*\()/.test(inner) ? '' : full;
  });
  let prev;
  for (let pass = 0; pass < 2; pass++) {
    prev = t;
    t = t.replace(/\(([^()]*?)\)/g, (full, inner) => {
      const s = inner.trim();
      if (!s || s.includes('$')) return full;
      if (/\\(?:left|right|big|Big|bigg|Bigg)\b/.test(s)) return full;
      if (!/\\[a-zA-Z]/.test(s)) return full;
      return '$' + s + '$';
    });
    if (t === prev) break;
  }
  return t.replace(/\n{3,}/g, '\n\n').trim();
}

function cleanConservative(text) {
  if (!text) return text;
  let t = text;
  t = t.replace(/```(?:geo|ggb|geogebra)?\s*\n([\s\S]*?)```/g, (full, inner) => {
    return /(?:=\s*\(|(?:Slider|Segment|Circle|Point|Line|Polygon|Text|SetColor|SetLineStyle|SetValue|Intersect|Midpoint)\s*\()/.test(inner) ? '' : full;
  });
  let prev;
  for (let pass = 0; pass < 2; pass++) {
    prev = t;
    t = t.replace(/\(\s+([\s\S]*?)\s+\)/g, (full, inner) => {
      const s = inner.trim();
      if (!s || s.includes('$')) return full;
      if (!/\\[a-zA-Z]/.test(s)) return full;
      return '$' + s + '$';
    });
    if (t === prev) break;
  }
  return t.replace(/\n{3,}/g, '\n\n').trim();
}

const cases = [
  { name: 'C1 行内公式含括号分数(高频: 函数值)',
    input: '当 $x=2$ 时, 函数值 $f(\\frac{x}{2})$ 等于 3。' },
  { name: 'C2 行内公式含括号分数(高频: 顶点坐标)',
    input: '抛物线顶点在 $(-\\frac{b}{2a}, \\frac{4ac-b^2}{4a})$ 处。' },
  { name: 'C3 行内公式 f(x) 无 LaTeX 命令(应不动)',
    input: '定义 $f(x) = x^2 + 1$, 定义域 $x \\in (0, 5)$。' },
  { name: 'C4 坐标元组无 LaTeX 命令(应不动)',
    input: '坐标系用 SetCoordSystem(-6,6,-5,5) 并显示网格。' },
  { name: 'C5 全角括号夹 $...$(中文习惯, 应不动)',
    input: '拖动滑块（其中 $\\alpha$ 为倾斜角）观察图像变化。' },
  { name: 'C6 散文括号(ASCII)夹 LaTeX 命令+中文',
    input: '斜率范围 (由 \\alpha 决定, \\alpha 为倾斜角) 限制图像。' },
];

// 真实样本槽: 把一条 web 实际翻车的最终回复粘进来再跑, 最具决定性。
const REAL_OUTPUT = '';

function show(label, fn) {
  console.log(`\n===== ${label} =====`);
  const all = REAL_OUTPUT ? [...cases, { name: 'REAL 真实翻车回复', input: REAL_OUTPUT }] : cases;
  for (const c of all) {
    const out = fn(c.input);
    console.log(`[${c.name}]`);
    console.log(`  IN : ${c.input}`);
    console.log(`  OUT: ${out}`);
  }
}
show('AGGRESSIVE (web 当前)', cleanAggressive);
show('CONSERVATIVE (参考)', cleanConservative);

console.log('\n===== 差异摘要 =====');
const all = REAL_OUTPUT ? [...cases, { name: 'REAL', input: REAL_OUTPUT }] : cases;
for (const c of all) {
  const a = cleanAggressive(c.input), b = cleanConservative(c.input);
  console.log(`${a === b ? 'SAME ' : 'DIFF '} | ${c.name}`);
  if (a !== b) { console.log(`   AGG : ${a}\n   CONS: ${b}`); }
}
```

- [ ] **Step 2: 跑脚本，确认根因**

Run: `node repro-cleanfinal.mjs`

Expected: 差异摘要里 **C1、C2 标 DIFF**，且 AGGRESSIVE 把合法行内公式切碎。具体预期：

- C1 `当 $x=2$ 时, 函数值 $f(\frac{x}{2})$ 等于 3。`
  - AGGRESSIVE：把内层 `(\frac{x}{2})` 替换成 `$\frac{x}{2}$`，于是原 `$f(\frac{x}{2})$` 变成 `$f` + `$\frac{x}{2}$` + `$`，即 **`$` 配对被错乱**（多出/错位的 `$`）—— 渲染必坏。只要 AGGRESSIVE 输出 ≠ 原文即视为命中。
  - CONSERVATIVE 输出 = 原文不变（`(` 后无空格，正则不匹配）。
- C2 顶点坐标同理被 AGGRESSIVE 切碎，CONSERVATIVE 不变。
- C3/C4/C5 标 SAME（两版都不动）—— 控制组，证明差异只命中"括号内含 LaTeX 命令"的行。
- C6 标 DIFF（AGGRESSIVE 把中文散文包进 `$(...)$` → KaTeX 对中文报错；CONSERVATIVE 不动）。

**判定**：
- 若 C1/C2 确实 DIFF 且 AGGRESSIVE 切碎公式 → **根因证实**。回退（Task 2）预期可单独修好 LaTeX，Task 3 端到端应通过。
- 若 C1/C2 意外 SAME（激进版其实没切）→ 根因存疑。仍做 Task 2 回退（消除分叉），但 Task 3 若不通过则直接走 Fallback（系统调试）。

- [ ] **Step 3: 暂不提交，保留 scratch 文件**

`repro-cleanfinal.mjs` 留在本地供 Task 3 失败时复用。**不要 `git add` 它**。整个工作结束后（Task 3 通过后）在最后一个任务的清理步骤删除它。

---

## Task 2: 回退 cleanFinalText 正则到参考版

**Files:**
- Modify: `lib/agent.ts`（`cleanFinalText` 函数内"坏分隔符"正则段）

**Interfaces:**
- Consumes: Task 1 的根因结论（决定 Task 3 预期，不阻断本任务）
- Produces: `cleanFinalText` 行为与参考 `ggb_fable/js/agent.js` 一致；行内公式 `$...(\latex)...$` 不再被切碎。

- [ ] **Step 1: 回退正则 + 文档化根因（Edit）**

在 `lib/agent.ts` 中，把 `cleanFinalText` 里的以下**当前内容**：

```ts
    // 坏分隔符: 用圆括号当公式定界的 (e=\dfrac{...}) / ( \frac{...} ) → $...$
    // 条件: 圆括号内含 LaTeX 命令(\xxx); 排除 \left/\right 等 LaTeX 自带括号、和无 LaTeX 的散文括号
    t = t.replace(/\(([^()]*?)\)/g, (full, inner) => {
      const s = inner.trim();
      if (!s || s.includes('$')) return full;
      if (/\\(?:left|right|big|Big|bigg|Bigg)\b/.test(s)) return full;  // LaTeX 自带括号, 不动
      if (!/\\[a-zA-Z]/.test(s)) return full;  // 无 LaTeX 命令(散文括号), 不动
      return '$' + s + '$';
    });
```

**替换为**（与参考 `ggb_fable/js/agent.js` 一致，并加根因注释）：

```ts
    // 坏分隔符: ( \frac{...} ) → $\frac{...}$ (带空格圆括号 + 含 LaTeX 命令)
    // 只转"带空格圆括号 + 内容含 LaTeX 命令"的, 避开真正的数学括号(不带空格)和散文括号。
    // 关键: 必须要求括号内带前导/尾随空格 —— 否则会误伤形如 $f(\frac{x}{2})$、$(-\frac{b}{2a}, c)$
    // 的合法行内公式(把 $...(\latex)...$ 错切成 $...$ + 裸 LaTeX + 残留 $$), 破坏渲染。
    // 详见 docs/superpowers/specs/2026-07-10-agent-latex-realignment-design.md
    t = t.replace(/\(\s+([\s\S]*?)\s+\)/g, (full, inner) => {
      const s = inner.trim();
      if (!s || s.includes('$')) return full;             // 已含 $ 或空, 不动
      if (!/\\[a-zA-Z]/.test(s)) return full;             // 不含 LaTeX 命令, 不动(防误伤散文括号)
      return '$' + s + '$';
    });
```

- [ ] **Step 2: 类型检查**

Run: `pnpm typecheck`
Expected: 无错误退出（exit 0）。

- [ ] **Step 3: 只 stage agent.ts 并提交**

Run:
```bash
git add lib/agent.ts
git commit -m "fix(agent): 回退 cleanFinalText 坏分隔符正则到参考保守版

激进版正则会切碎含括号 LaTeX 的合法行内公式, 破坏渲染。
回退到参考 ggb_fable 的保守版(要求括号内带空格), 行为与参考一致。
详见 docs/superpowers/specs/2026-07-10-agent-latex-realignment-design.md

Co-Authored-By: Claude <noreply@anthropic.com>"
```
Expected: 提交成功，仅 `lib/agent.ts` 一个文件。

---

## Task 3: 端到端验证（手动）

**Files:** 无改动（验证步骤）

**Interfaces:**
- Consumes: Task 2 的回退；`.env.local` 里 `DEEPSEEK_API_KEY` + `DEEPSEEK_MODEL=deepseek-v4-pro`
- Produces: 确认 LaTeX 渲染正常、视觉优化工作正常。

**前置检查**：确认 `.env.local` 含 `DEEPSEEK_API_KEY=...` 与 `DEEPSEEK_MODEL=deepseek-v4-pro`（用户已设；若缺失，E2E 会用默认 `deepseek-chat`，结果不可比）。

- [ ] **Step 1: 启动 dev**

Run: `pnpm dev`
Expected: 监听 `http://localhost:3000`，无编译错误。

- [ ] **Step 2: LaTeX 渲染验证（2-3 道经典题）**

浏览器打开 `http://localhost:3000/app`，登录后依次输入下面题目，每题等 agent 构造完成，**观察最终回复的 LaTeX**：

1. **顶点坐标题**（命中 C2 模式）：`画抛物线 y=x^2-4x+3，标出顶点坐标和与坐标轴交点`
2. **函数值题**（命中 C1 模式）：`画函数 f(x)=sqrt(x)/2 的图像，标出 x=4 时的函数值`
3. **定值文本题**（命中画布 Text LaTeX）：`画椭圆 x^2/4+y^2=1，过焦点作两条互相垂直的弦，验证 1/|OA|^2+1/|OB|^2 为定值并显示该定值文本`

每题通过标准：
- ✅ 行内/行间公式正常渲染（分数、根号、上下标可见，无红色 KaTeX 报错块）
- ✅ 回复里**没有**裸露的 LaTeX 源码（如 `\frac`、`^2`、反斜杠堆叠的原始字符）
- ✅ 回复散文**没有**被错误包进公式块（没有红色块裹住中文）

**分诊**（若某题不通过，按失败形态判断）：
- 失败形态 = 红色 KaTeX 块裹住散文/中文，或 `$...$` 配对错乱 → 仍是 cleanFinalText 类问题，回 Fallback。
- 失败形态 = 裸露 `\frac`/`^2` 源码（根本没渲染）→ 模型未用 `$` 定界，**不是** cleanFinalText 问题 → 走 Fallback 抓原始输出。

- [ ] **Step 3: 视觉优化抽查（命中 inspect_render）**

输入一道会触发视觉检查的题：`画等腰三角形 ABC，AB=AC，D 是 BC 中点，作高 AD 并标出直角，配色干净`。

展开页面上的"工具轨迹"面板，找到 `inspect_render` 调用，确认：
- ✅ 调用了 `inspect_render`（轨迹里出现该工具）
- ✅ 返回的 `advisory` 是合理的"验收通过 / 视觉指出问题（仅供参考）"二选一，未解析失败
- ✅ 未出现死循环（视觉检查 ≤ 2 次，且验收通过后 agent 输出最终回复而非继续 execute_command）

- [ ] **Step 4: 关停 dev + 清理 scratch**

Run: 在 dev 终端按 `Ctrl+C` 关停。
然后删除复现脚本：
```bash
rm repro-cleanfinal.mjs
```
Expected: 文件删除（确认 `git status` 里不再有它；它从未被 add，故不影响提交历史）。

- [ ] **Step 5: 判定收尾**

- 若 Step 2 全部 ✅ 且 Step 3 ✅ → **完成**。LaTeX 回归已修复，视觉优化验收通过。
- 若任一不通过 → 进入 Fallback。

---

## Fallback: 系统调试（仅当 Task 1 证伪 或 Task 3 不通过时执行）

**目的**：抓 web 翻车 run 的**原始** `assistant.content`（`cleanFinalText` 之前），与参考同输入原始输出做精确 diff，定位真正的分叉。

- [ ] **F1: 临时加日志抓原始输出**

在 `lib/agent.ts` 的 `run()` 里，`return r` 之前（无工具调用分支，约 449 行；以及上限停止分支），临时插入：

```ts
console.log('[DEBUG raw assistant.content]', JSON.stringify(assistant.content));
```

（仅本地调试，**不要提交此日志**。）

- [ ] **F2: 复现翻车 + 抓原文**

`pnpm dev` → 跑 Task 3 Step 2 里翻车的那道题 → 从终端日志复制 `[DEBUG raw assistant.content]` 后的 JSON 字符串。

- [ ] **F3: 对照参考**

在参考项目 `/Users/wuxi/claudecode/first_try/ggb_fable`（原版，`node serve.js` 或其既有启动方式）跑**同一题**，抓其 `assistant.content`。

- [ ] **F4: diff 定位**

对比两条原始输出：
- 若 web 原始输出本身就用坏分隔符/裸 LaTeX（与参考不同）→ 问题在**模型调用层**（trial proxy 的 `temperature`、messages 结构、或模型路由）。查 `app/api/trial/llm/route.ts` 与参考 `js/llm.js` 的请求构造差异。
- 若 web 原始输出与参考**一致**但渲染仍坏 → 问题在**渲染层**。查 `components/MessageContent.tsx` 与参考 `js/app.js` 渲染分支的细微差异（占位符正则、`breaks`、CSS）。
- 修完后移除 F1 的临时日志，重跑 Task 3。

---

## 完成定义（DoD）

1. Task 3 Step 2 全部题目 LaTeX 正常渲染（无红错、无裸源码、散文未被包进公式）。
2. 根因已由 Task 1 复现证实，并在 `lib/agent.ts` 注释中文档化（Task 2 Step 1 已含）。
3. 视觉优化（inspect_render 三步法）经 Task 3 Step 3 实测验收通过。
4. `pnpm typecheck` 通过；仅 `lib/agent.ts` 一处提交（`7c311d2` 之后的 spec 提交之外）。
5. `repro-cleanfinal.mjs` 已删除，仓库无 scratch 残留。
