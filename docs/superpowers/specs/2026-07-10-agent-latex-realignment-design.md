# Agent 核心重新对齐 + LaTeX 回归修复

- **日期**：2026-07-10
- **状态**：已批准（待实现）
- **范围**：`lib/agent.ts`（agent loop / AI core）
- **参考实现**：`../ggb_fable/js/agent.js`（vanilla JS 原版，效果良好）

---

## 1. 背景与问题

web 版 `ggb-fable-web` 从原版 `ggb_fable` 迁移后，agent 产出质量明显回退，最突出的是 **LaTeX 渲染一直修不好**。用户在 `lib/agent.ts` 留下了一批未提交改动（137 行，多为提示词工程），其中部分有价值、部分可能是回归。需要对照参考实现审计，分离好坏，并修好 LaTeX。

### 审计结论（对照 `ggb_fable/js/agent.js` 逐行比对）

| 未提交改动 | 对照参考 | 判定 |
|---|---|---|
| 系统提示词补全（构造规划四字段、视觉规范、Few-shot 4 例） | 改动后与参考**逐字一致** | ✅ 保留 —— 修复了之前的降级 |
| 6 个工具 description | 与参考一致 | ✅ 保留 |
| `maxRounds` 30 → 50 | 与参考一致 | ✅ 保留 |
| `inspect_render` 视觉 prompt（三步法）+ `parseInspectIssues` | **有意分叉**，是用户的优化 | ✅ 保留（需实测验收） |
| `cleanFinalText` 坏分隔符正则 `\(\s+...\s+\)` → `\(([^()]*?)\)` | **偏离参考** | ⚠️ 回归，回退 |

### 渲染管线排查（已排除）

- `components/MessageContent.tsx` 是参考 `app.js` 占位符策略（`markdown-it` + `katex`，`@@MX` 占位 + `throwOnError:false`）的忠实移植。
- `app/layout.tsx` 已 `import 'katex/dist/katex.min.css'`，KaTeX 样式有加载。
- 流式路径：`ChatApp` 在 `onToken` 累积原始 token，回合结束时用 `result.finalText`（经 `cleanFinalText`）整体替换 —— 最终展示的就是清洗后文本。

**结论：LaTeX 坏掉不是渲染层的问题，是 agent 产出的内容在 `cleanFinalText` 里被破坏。**

### 根因推断（排除法）

模型已两边一致（参考与 web 试用均用 `deepseek-v4-pro`），系统提示词已对齐，渲染管线忠实。唯一指向 LaTeX 的代码差异就是 `cleanFinalText` 的正则分叉：

- **参考版**（保守）：`/\(\s+([\s\S]*?)\s+\)/g` —— 只匹配**带空格**的圆括号 `( \frac{...} )`，很少触发，内容基本原样通过。
- **web 偏离版**（激进）：`/\(([^()]*?)\)/g` —— 匹配**任意**非嵌套括号，只要内容含 LaTeX 命令就包成 `$...$`。会把 `(即 \text{面积})` 这类"散文括号里恰好含 LaTeX 命令"的正常文本强行包进公式，KaTeX 渲染中文/散文报红乱码。

> 注意：此根因靠排除法锁定，尚未用真实坏样本证实。故验证策略把"确定性复现"作为动代码前的去风险闸门。

---

## 2. 目标与范围

### 目标
恢复 web agent 产出质量至参考水平，修好 LaTeX。手段：(a) 回退 `cleanFinalText` 的回归正则；(b) 保留已对齐/有价值的未提交改动；(c) 实测验证修复；(d) 备好系统调试兜底路径。

### 范围
- **IN**：`lib/agent.ts` 的 `cleanFinalText` 正则回退（1 处 hunk）；确定性复现脚本；端到端 LaTeX 验证；保留其余未提交改动；视觉优化单独验收。
- **OUT（YAGNI）**：不加新功能；不重构 agent 循环；不改系统提示词；不动 condenser / vision 输入 / command-search（无观察到能力差距）；不引入测试框架（项目仅用 `tsc --noEmit`）。
- **隔离性**：本次只改 `lib/agent.ts` 一个 hunk，不碰其余 14 个未提交文件里的在途改动（auth 迁移、Supabase 等）。

---

## 3. 核心修复（1 处 hunk）

文件：`lib/agent.ts`，函数 `cleanFinalText` 的"坏分隔符"正则段。

**回退前（web 偏离版，过于激进）：**

```ts
t = t.replace(/\(([^()]*?)\)/g, (full, inner) => {
  const s = inner.trim();
  if (!s || s.includes('$')) return full;
  if (/\\(?:left|right|big|Big|bigg|Bigg)\b/.test(s)) return full;  // LaTeX 自带括号, 不动
  if (!/\\[a-zA-Z]/.test(s)) return full;  // 无 LaTeX 命令(散文括号), 不动
  return '$' + s + '$';
});
```

**回退后（= 参考版，要求带空格，保守）：**

```ts
t = t.replace(/\(\s+([\s\S]*?)\s+\)/g, (full, inner) => {
  const s = inner.trim();
  if (!s || s.includes('$')) return full;       // 已含 $ 或空, 不动
  if (!/\\[a-zA-Z]/.test(s)) return full;       // 不含 LaTeX 命令, 不动(防误伤散文括号)
  return '$' + s + '$';
});
```

**理由**：
- 模型已两边一致，本应产出基本正确的 `$...$`。回退后正则重新成为"罕见安全网"，行为与参考完全一致。
- `\left(...\right)` 因 `\right)` 前无空格天然不被匹配，故删去 `\left/\right/big` guard —— 与参考一致。
- 同时把注释改回参考的措辞（说明"只转带空格圆括号 + 含 LaTeX 命令"的保守理由），作为根因的文档化。

---

## 4. 保留项（已验证对齐/有意为之）

- 系统提示词、6 个工具 description、`maxRounds=50` —— 均已与参考对齐，保留。
- `inspect_render` 三步法 prompt + `parseInspectIssues` —— 用户的有意优化，保留，在第 3 步实测验收。
- `app/globals.css` 的 composer / trace 布局改动（纯样式），保留。

---

## 5. 验证策略（方案 C 的核心）

### 第 1 步 —— 确定性复现（无需 API，先证根因）【去风险闸门】

写一个一次性 Node 脚本（不提交进仓库，仅本地跑），构造一段贴近真实最终回复的字符串，覆盖各类括号用法：

- 坐标元组：`(2, 3)`、`(-6,6,-5,5)`
- 行内/行间正确 `$...$` / `$$...$$` 数学：`$f(x)=x^2$`、`$$y=\dfrac{1}{2}x^2$$`
- 散文括号里含 LaTeX 命令：`(即 \text{面积})`、`(见 \angle A)`
- 罕见坏分隔符：`(\frac{a}{b})`

对这段字符串分别跑**激进版**与**保守版**正则，打印结果。

- **预期**：激进版腐蚀（把散文/坐标包成 `$...$`），保守版原样保留合法内容、仅修正真正的坏分隔符。
- **若证实** → 进入第 2 步。
- **若证伪**（激进版在真实输入上其实安全，或两边结果一致）→ 正则不是元凶，跳到第 2 阶段系统调试。

### 第 2 步 —— 回退 + 端到端验证

- 应用第 3 节的回退。
- 跑 2–3 道已知会触发 LaTeX 翻车的经典 K12 题（分数 / 定值文本 `1/|OA|²+1/|OB|²` / 解析几何），确认：无红色 KaTeX 报错、无裸露 `\frac` 源码、散文没被包进公式块。
- 与参考 `ggb_fable` 跑**同一题**对比，LaTeX 质量应已对齐。
- `pnpm typecheck` 通过。

### 第 3 步 —— 视觉优化抽查

跑一道会触发 `inspect_render` 的题，确认三步法 prompt + 解析器产出合理行为（`验收通过` 或 `问题: ...` 行），无解析失败、不死循环。

### 第 2 阶段（仅当第 1/2 步失败）—— 系统调试

抓 web 翻车 run 的**原始** `assistant.content`（`cleanFinalText` 之前），与参考同输入的原始输出做精确 diff。若差异不在正则，会直接显形。手段：开启 `lib/logger.ts` 抓取 messages 数组对比。

---

## 6. 风险与回退

- **风险**：极小 —— 1 处正则回退到已知良好的参考行为。
- **回退**：`git` 还原该单 hunk 即可。
- 其余未提交改动不受影响。

---

## 7. 完成定义（DoD）

1. 经典题上 LaTeX 正常渲染（无红错 / 无裸源码），质量与参考对齐。
2. 根因由第 1 步确定性复现证实，并在 `agent.ts` 注释中文档化。
3. 好的未提交改动保留，视觉优化已实测验收。
4. `pnpm typecheck` 通过，改动提交。
