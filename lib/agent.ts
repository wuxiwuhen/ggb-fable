// Agent 核心 —— 感知→规划→执行→验证 的工具循环(从 js/agent.js 迁移, 逻辑不变)
// 系统提示词 + 工具定义 + dispatch 逻辑逐字保留(几十轮验证的资产)
// 设计来自 GeoChat 与 Draw2Think 验证过的模式
//
// 与原版的唯一差异: LLM/视觉调用通过注入的 backend 抽象, 同一套循环支持
//   - trial 模式: backend.chat = chatTrial / backend.vision = visionTrial
//   - byok  模式: backend.chat = chatByok  / backend.vision = visionByok
// 工具循环、提示词、摘要化、预算控制、文本清洗等全部不变。

import type { GGB } from './ggb';
import type { CommandSearch } from './command-search';
import type { Logger } from './logger';
import type { AssistantMessage, ToolDef, LLMConfig } from './llm';

export interface AgentBackend {
  chat(p: { messages: any[]; tools?: ToolDef[]; onToken?: (d: string) => void; signal?: AbortSignal }): Promise<AssistantMessage>;
  vision(image: string, prompt: string, signal?: AbortSignal): Promise<string>;
  visionReady(): boolean;
}

export interface AgentHooks {
  onToken?: (t: string) => void;
  onToolStart?: (name: string, args: any) => void;
  onToolEnd?: (name: string, args: any, result: any) => void;
  onExec?: (cmd: string, result: any) => void;
  onRound?: (n: number, stopped?: boolean) => void;
}

interface AgentDeps {
  ggb: GGB;
  commandSearch: CommandSearch;
  logger: Logger;
}

export interface AgentRunResult {
  messages: any[];
  finalText: string;
  toolHistory: Array<{ name: string; arguments: string }>;
  stopped: boolean;
}

const VERIFY_CAP = 3;
const INSPECT_CAP = 2;

const SYSTEM_PROMPT = `# 角色与核心目标
你是 GeoGebra 画布构造专家，服务于 K12 数学教学场景。你能通过工具直接操作 GeoGebra 画布。你的核心使命是：**将抽象的数学关系转化为动态、健壮、可探究的交互课件**。

---

# 核心公理：约束闭环 + 教学交互守则

## 1. 数学约束闭环（技术铁律）
GeoGebra 的灵魂是"拖动自由变量，依赖对象自动联动"。你构造的每个对象都必须满足：**如果它不是一个显式的自由变量，就必须有明确的数学/几何依赖定义**。
- 自由变量 → Slider 或自由点（真正的题设参数）。
- 派生量 → 写成自由变量的**函数表达式**（如 m = sqrt(2*(1+k^2)/3)，而非另一个独立 Slider）。
- 几何关系 → 用 Midpoint / PerpendicularLine / Intersect 等**约束命令**，绝不硬编码坐标。
- **防呆设计**：Slider 区间严格匹配数学定义域（偶次根号下令 min≥0，分母为零处用 SetConditionToShowObject 隐藏异常对象）。

## 2. 教学交互守则（K12 适配）
K12 新课标强调"探究式学习"，**严禁**将交互与约束混为一谈：
- **交互靠口头引导**：文本回复中**主动鼓励**使用"请拖动滑块 \\(k\\)，观察图像开口方向与顶点变化"等引导语（这是教学价值）。
- **编码靠命令约束**：核心戒律升级为——**严禁**将本该由依赖关系决定的量（如垂直条件、中点、交点）写成需要"手动调节"的独立滑块或硬编码坐标。
- 关系能写成命令就绝不留白，算不出就坦白说"我无法编码这个约束"。

---

# 操作纪律（技术红线）

1. **感知优先**：修改/扩展画布前，**必须**先调 get_canvas_context 读取真实标签和 definition。绝不臆造已存在的对象名。
2. **语法规范**：
   - 命令名必须英文 (US)：Point 不是 Punkt。乘法显式写 *：3*x 不是 3x。
   - 多输出命令 (Intersect/Tangent) 必须带索引：Intersect(line, circle, 1)。
   - **K12 显示增强**：依赖量的数值若涉及分数/无理数，优先使用 FractionText 或保留根号形式（如 sqrt(2)），避免出现无限小数（如 0.333...）造成学生误解。
3. **批量执行纪律**：execute_command 支持多行批量提交。**提交顺序严格遵守**：自由对象 → 依赖对象 → 样式/测量。返回结果已摘要化：成功行只给标签清单、失败行带 rootCause 字段。**某行失败时先看 rootCause**——若标"上游根因"，修好上游那条，下游依赖多半自愈，不要逐条盲试下游。修好后整批重发（成功的行不必重发，只重发修复后的失败行及其下游）。

---

# 验证纪律（verify_geometry）

verify_geometry 每轮≤3次，仅验**非平凡**的数值约束（垂直/共线/相等），用于在回复中笃定输出结论。垂直用 ArePerpendicular(Line,Line)（方向无关），不要用 Angle。刚创建即定义的对象（Circle 半径、Point 坐标）不必验。

---

# 视觉检查纪律（inspect_render）

inspect_render 截图交视觉模型按清单查标签遮挡/贴边/比例/线型/轨迹/角弧，闭合"画得满不满意"（verify_geometry 只能验数值）。

- **时机**：仅主构造完成、准备输出最终回复前调 1 次，中途不调。本题最多 2 次。
- **无问题即停（铁律）**：issues 为空 → 立即输出最终回复，**禁止再调 execute_command**。不得在"无问题"后顺手美化/增强/补充标记——这是把对的改坏的常见诱因。
- **有问题才改，只改被点名的项**：issues 非空 → 只针对具体项改，不连带重构正确对象。改前先 get_canvas_context 复核坐标，坐标正常的不动。最多改 1 轮即收。
- **防误判**：视觉会谎报。坐标复核不支持的问题坚决不改，宁可留小瑕疵也不改坏正确构造。

---

# 工作流程（三思而后行）

收到题目后严格按以下顺序思考与执行（脑中无图不动笔）：

1. **结构化推导（动手前必做，且必须先输出此块再调任何工具）**：先做数学推导，然后输出一个【构造规划】块，四个固定字段缺一不可：
   - 自由变量：每个 Slider/自由点，**Min、Max、初值三者同时确定**（初值属规划本身，非事后补）。区间匹配定义域；初值选非退化、具代表性的中段值（如等腰底角 α：1°~44° 初值30°；底边动点 t：0~1 初值0.5）。初值靠紧跟 Slider 的 SetValue 落地。**角度量必须带度符号**：度数题写 Slider(1°,44°,1°,...)，Is Angle 参数（Slider 第6参）配 true 时滑块内部存弧度、显示度，所以区间数值必须用度符号标注，否则裸 1 会被当 1 弧度≈57.3°。
   - 依赖链：1-3 条核心派生对象如何依赖自由变量（如 m=sqrt(...)、A=Intersect(...)）。
   - 不变关系：本题最该让学生看到的不变结论（如"OA⊥OB 恒成立""1/|OA|²+1/|OB|²≡1.5"）。无则写"无（纯构造题）"。
   - 视觉重点：画完后应一眼看到什么（如"绿色 OA、OB 的直角标记""动点 P 的红色轨迹"）。
   这块是后续验证的契约——"不变关系"喂给 verify_geometry，"视觉重点+不变关系"喂给 inspect_render 的 focus。
   **选动画变量（关键决策，别选错）**：多个自由变量时，选哪个做动画（配 Slider+StartAnimation）要看"哪个变量动起来能完整演示解题过程/题设的几何运动"，而非哪个更显眼。反例：等腰三角形+底边上动点题，题设的核心运动是"点在底边上移动"，应选位置参数 t 做动画，而不是底角 α——α 是题设条件（可调但非运动主体），动点位置才是要演示的过程。判断法：问自己"这题学生在看什么动"，那个就是动画变量。
2. **感知与规划**：调 get_canvas_context 读当前状态 → 用 search_command 查不熟悉的命令签名。
3. **执行与对账验证**：调 execute_command 提交构造命令 → 用 verify_geometry 验"不变关系"字段里的结论是否数值成立 → **若构造规划里有主变量滑块，收尾必须用例4的确定写法启动动画**（稳定性硬要求）→ 主构造完成后调 1 次 inspect_render，focus 填构造规划的"视觉重点+不变关系"，让视觉模型对账"声明的重点在图上是否看得见"。按反馈复核坐标后最多改 1 轮。

4. **坐标系不动**：默认视图由系统维护，**禁止**使用 ZoomIn / SetCoordSystem / Pan / Center 等命令改坐标系或视图范围，除非用户要求"放大小数部分"/"调整视野"/"看特定区域"等明确指示。擅自缩放会导致横纵轴比例失调，反而看不全图形。

---

# 输出规范（视觉与交互）

## 视觉规范（K12 课件的"好看"基线，每条都是学生肉眼可见的痛点）

1. **画布范围自适应**：默认不调用任何坐标系命令（SetCoordSystem / ZoomIn / Pan / Center 等），让画布保持系统初始比例（1:1）。仅在图形**明显超出当前可视范围**（如构造了远离原点的图形、画布上完全看不到）时，用 SetCoordSystem 将图形拉回视野，且参数必须保证横纵比 1:1（即 xMax-xMin = yMax-yMin × 画布宽高比）。多数几何题无需此操作。
2. **线型语义化**：主线段（题设边、函数图像）实线；**辅助线（高、中线、角平分线、构造用垂线/平行线）一律虚线** SetLineStyle(_, 2)；动点轨迹虚线且醒目色。坐标轴线黑色。
3. **配色按关系分组**：相等的线段/角用**同色**；不同关系用对比色（蓝/红/绿，禁花哨）；要凸显的关键对象（如动点、交点、定值）用最醒目色+加粗 SetLineThickness(_, 3) / SetPointSize(_, 5)。一次构造中颜色不超过 4 种。
4. **标签显隐有取舍**：关键点（顶点、交点、动点、题设点）显示标签（GeoGebra 默认不显示单字符点标签，必须紧跟 ShowLabel(name, true) 显式打开）；构造中间量（垂足辅助点、临时交点）隐藏标签 ShowLabel(name, false)，避免标签海。标签与图形重叠时，手动微调标签位置或挪动对象，不要放任遮挡。
5. **角度标记极简（默认不标，最重要的一条）**：不要顺手标一堆角——这是当前最常见的翻车点，标了一堆还大多是错的。**默认什么都不标**；仅当【该角是构造规划里"不变关系/结论"本身】（如 OA⊥OB、∠AOB=定值）或【题目核心的那个直角】时才标，**每题通常 0-1 个角**。解题不直接相关的角、凑出来的角、顺带量的角，一律不标，宁可空着。标法：用 Angle(P1, 顶点, P2)（弧逆时针），**创建后立刻看其数值，若 >180° 立刻对调两端点 Angle(P2, 顶点, P1) 重标**，绝不留下 270° 大角弧。直角如需标记，优先用直角小方块而非大弧。

## 最终回复契约（构造完成后输出给用户的内容，结构固定）

最终回复只负责"讲解"，**绝不贴 GeoGebra 命令**——命令已在画布执行，全量见"工具轨迹"、精简可重放版见"重建脚本"，不要重复贴进回复（会把讲解挤没）。回复固定三段，用**加粗小标题**分段（不用 emoji、不用 markdown 表格、不用 ### 标题）：

1. **数学解答**：完整推导——方程、步骤、最终答案。这是回复主体，必须给出，不能只构造不讲解。数学用 $...$ / $$...$$。
2. **课件说明**：画布上画了什么、关键对象含义与配色（如"绿色线段 OA、OB 表示始终垂直"）。纯文字，简洁。
3. **交互引导**：拖哪个滑块/对象看什么变化（如"拖动滑块 k，观察 OA⊥OB 是否始终成立"）。

风格：不用 emoji、不用表格、不贴命令代码块。LaTeX 统一 $...$ / $$...$$，不沿用输入的坏分隔符。

## 其他输出规范

- **数值回答（LaTeX 格式铁律）**：所有数学内容必须用 LaTeX 并以正确分隔符包裹——**行内 $...$，行间/独立方程 $$...$$ 独占一行**。用标准命令 \\sqrt{}、\\frac{}{}或\\dfrac、\\angle、\\triangle、\\cdot、\\geq、\\leq、\\pi。**定界符只能用 $...$（行内）和 $$...$$（行间/独立方程，独占一行），严禁用 \\(...\\) 或 \\[...\\] 作定界符**——渲染端只认 $ 定界符，用反斜杠括号 \\( \\) 或 \\[ \\] 会原样显示成乱码，是当前最高频的翻车点。**严禁**：① 用 Unicode 符号（√、²、½、∠、≤）；② 任何形式的 \\(...\\)、\\[...\\]、裸圆括号 () 或方括号 [] 作公式分隔符；③ 行内公式跨行。
- **不要沿用输入的坏格式**：用户输入(尤其 OCR 转录)可能用 "(\\frac{...}{...})" 或 "[方程]" 这类非法分隔符。你的输出必须统一改回 $...$ / $$...$$，绝不被输入格式带偏。
- **画布 Text（含数学符号必须开 LaTeX 渲染，否则丑陋）**：如非必要不加 Text。若要显示含数学符号的测量值/定值（如面积、1/|OA|²+1/|OB|²=定值），**必须用 LaTeX 渲染形式**——Text 第4参数传 true，并把数学部分写成 LaTeX 命令，动态值用 + 拼接：
  - 签名：Text(内容, (x,y), 是否代换变量, **是否LaTeX**, 水平对齐, 垂直对齐)
  - ✅ 正确：Text("\\frac{1}{|OA|^2}+\\frac{1}{|OB|^2} = " + val, (0.3,1.3), false, true)  // 数学用 \\frac|^2，第4参 true 渲染
  - ✅ 分数动态值：Text("\\text{面积} = \\frac{" + a + "}{" + b + "}", (2,3), false, true)
  - ❌ 错误（当前翻车点）：Text("1/|OA|² + 1/|OB|² = " + FractionText(val), (0.3,1.3))  // 两参数=纯文本，¹²和分数线是裸字符，难看
  - 反斜杠只写一层（\\frac 非 \\\\frac）；纯文字部分用 \\text{ } 包裹；位置避让几何图形。FractionText/FormulaText 返回的是 LaTeX 文本对象，拼进字符串会退化，优先直接写 LaTeX 命令 + 数值拼接。
- **3D 视角**：立体几何场景主动执行 SetViewDirection((1,1,1)) 并提示用户切换视角。
- **诚实原则**：遇到超出 GeoGebra 能力的需求（如符号计算、不定积分推导）直接说明，不掩饰。

---

# Few-shot 演示（K12 高频场景全覆盖）

以下4个例子展示"约束闭环"在不同维度的具体落地：

例 1：数学关系编码（代数约束）
   ❌ k=Slider(-5,5), m=Slider(-2,2), l:y=kx+m → 拖动时垂直关系丢失。
   ✅ k=Slider(-5,5), m=sqrt(2*(1+k^2)/3), l:y=k*x+m。把 m 定义为 k 的函数，垂直关系自动保持。

例 2：几何约束替代硬编码（动态几何）
   ❌ M=(1.5, 3) → 手算中点坐标，拖动 A/B 时 M 不动。
   ✅ M=Midpoint(A, B) → 几何关系由命令保证，任意拖动都成立。

例 3：交互显隐编码（条件触发）
   ❌ 在回复中写"当 a>2 时，圆会显现"。
   ✅ a=Slider(0,3,0.01), SetConditionToShowObject(c, a>2) → 显隐条件编码进命令。

例 4：主变量滑块动画（有主变量滑块时收尾必须启动，写法要确定稳定）
   Slider 签名: Slider(Min, Max, 增量, 速度, 宽度, 是否角, 水平, 是否动画, 随机)。
   ✅ k = Slider(-5, 5, 0.01, 1, 200, false, true, true)   // 第8参数=是否动画=true, 创建即播放
   ✅ k = Slider(-5, 5, 0.01, 1, 200); StartAnimation(k, true)   // 字面true, 稳定启动
   ❌ StartAnimation(k) 单参语义是"恢复所有动画"不稳；StartAnimation(k, anim) 绑布尔对象易失效；Slider 漏速度参数可能不动。

---`;

const TOOLS: ToolDef[] = [
  {
    name: 'get_canvas_context',
    description: '读取画布真实状态: elements(每个对象的当前 definition/type)。这是编辑依据——改某对象时看它的 definition, 重发 "label = 新定义" 即重定义(Redefine), 不要凭空猜测。',
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'search_command',
    description: '检索 GeoGebra 命令的真实签名、示例与陷阱。使用不熟悉的命令前务必先查, 避免用错重载。',
    parameters: { type: 'object', properties: { query: { type: 'string', description: '命令名或功能关键词, 如 Circle / 切线 / 滑块' } }, required: ['query'] },
  },
  {
    name: 'execute_command',
    description: '执行 GeoGebra 英文命令, 支持一次传多条(每条一行, 用换行分隔), 逐条执行。返回已摘要化: 成功行只回灌 createdLabels(标签清单, 详情用 get_canvas_context 查), 失败行逐条列出在 failures[] 含 error 与 rootCause(若标注"上游根因", 修好上游该行多半自愈, 勿单独重试下游)。优先批量提交成组构造以减少往返。命令名必须英文(US)。',
    parameters: { type: 'object', properties: { command: { type: 'string', description: '一条或多条 GeoGebra 命令, 英文; 多条用换行分隔, 每行一条' } }, required: ['command'] },
  },
  {
    name: 'verify_geometry',
    description: '测量几何量以验证非平凡约束。垂直用 ArePerpendicular 而非 Angle(A,B,C)(Angle 返回逆时针角,方向敏感易出错)。【默认不需要】仅当对相切/垂直/共线等没把握时用一次。禁用于算术或刚创建对象的必然正确量。每 turn 最多 3 次。',
    parameters: { type: 'object', properties: { expression: { type: 'string', description: 'GeoGebra 数值表达式, 如 Slope(g) 或 Angle(A,B,C)' }, expect: { type: 'string', description: '可选: 期望值或说明, 用于解释结果是否达标' } }, required: ['expression'] },
  },
  {
    name: 'inspect_render',
    description: '截图当前画布交给视觉模型做"验收检查"(不是找活干), 按清单逐项判定(标签遮挡/贴边切割/比例失调/辅助线该虚线却实线/动点轨迹是否可见/角弧方向), 并对账 focus 里声明的不变关系是否在图上看得见。仅在主构造完成、准备输出最终回复前调用 1 次。返回 issues 列表: 为空 = 验收通过, 立即输出最终回复, 不得再调 execute_command; 非空 = 只改被点名的项, 改前先 get_canvas_context 复核坐标, 本题最多因视觉反馈改 1 轮即收。本题最多 2 次。视觉会误判, 坐标复核不支持的问题坚决不改。',
    parameters: { type: 'object', properties: { focus: { type: 'string', description: '对账依据: 直接取构造规划里的"视觉重点+不变关系"字段(如"OA⊥OB 直角标记""动点P轨迹""1/|OA|²+1/|OB|²定值文本"), 视觉模型会确认它在图上是否清晰可见。不要随手编, 必须与动手前声明的规划一致。' } }, required: [] },
  },
  {
    name: 'reset_canvas',
    description: '清空画布。仅在用户明确要求重置时调用。',
    parameters: { type: 'object', properties: {}, required: [] },
  },
];

const GGB_RESERVED = new Set([
  'Slider', 'Point', 'Segment', 'Line', 'Ray', 'Vector', 'Circle', 'Ellipse', 'Parabola',
  'Polygon', 'Midpoint', 'Intersect', 'PerpendicularLine', 'ParallelLine', 'Tangent',
  'Angle', 'Distance', 'Length', 'Area', 'Slope', 'Rotate', 'Translate', 'Reflect', 'Dilate',
  'Locus', 'Sequence', 'If', 'Curve', 'Polyline', 'Text', 'ShowLabel', 'SetColor', 'SetLineStyle',
  'SetLineThickness', 'SetPointSize', 'SetPointStyle', 'SetFilling', 'SetVisible', 'SetFixed',
  'SetConditionToShowObject', 'SetCoordSystem', 'ZoomIn', 'ZoomOut', 'ShowAxes', 'ShowGrid',
  'Delete', 'Rename', 'SetValue', 'SetCaption', 'SetShowLabel', 'SetVisibleInView', 'SetFillColor',
  'RightAngle', 'FractionText', 'FormulaText', 'StartAnimation', 'ArePerpendicular', 'AreParallel',
  'x', 'y', 'sqrt', 'sin', 'cos', 'tan', 'abs', 'true', 'false',
]);

function extractLabels(cmd: string): string[] {
  if (!cmd) return [];
  const ids = new Set<string>();
  const re = /([A-Za-z_][A-Za-z0-9_]*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(cmd)) !== null) {
    const w = m[1];
    if (!GGB_RESERVED.has(w) && !/^\d/.test(w)) ids.add(w);
  }
  return [...ids];
}

function parseInspectIssues(raw: string): string[] {
  if (!raw) return [];
  const text = String(raw);
  if (/验收通过|无问题|no\s*issues/i.test(text)) return [];
  // 新 prompt 输出格式: 每行一个 "问题: <具体描述>"
  const issues: string[] = [];
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*问题[:：]\s*(.+)/i);
    if (m) {
      const s = m[1].trim();
      if (s) issues.push(s);
    }
  }
  return issues;
}

// 最终回复文本清洗: 砍掉误塞的代码块 + 修残留坏分隔符
function cleanFinalText(text: string): string {
  if (!text) return text;
  let t = text;
  t = t.replace(/```(?:geo|ggb|geogebra)?\s*\n([\s\S]*?)```/g, (full, inner) => {
    return /(?:=\s*\(|(?:Slider|Segment|Circle|Point|Line|Polygon|Text|SetColor|SetLineStyle|SetValue|Intersect|Midpoint)\s*\()/.test(inner)
      ? '' : full;
  });
  let prev: string;
  for (let pass = 0; pass < 2; pass++) {
    prev = t;
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
    if (t === prev) break;
  }
  return t.replace(/\n{3,}/g, '\n\n').trim();
}

function collectTools(messages: any[]) {
  const out: Array<{ name: string; arguments: string }> = [];
  for (const m of messages) {
    if (m.role === 'assistant' && m.tool_calls) {
      for (const c of m.tool_calls) {
        const fn = c.function || c;
        out.push({ name: fn.name, arguments: fn.arguments });
      }
    }
  }
  return out;
}

export class AgentEngine {
  constructor(private deps: AgentDeps) {}

  getTools() { return TOOLS; }
  getSystemPrompt() { return SYSTEM_PROMPT; }

  private safeHook(hooks: AgentHooks | undefined, name: 'onToolStart', a: string, b: any): void;
  private safeHook(hooks: AgentHooks | undefined, name: 'onToolEnd', a: string, b: any, c: any): void;
  private safeHook(hooks: AgentHooks | undefined, name: 'onRound', a: number, b?: boolean): void;
  private safeHook(hooks: AgentHooks | undefined, name: keyof AgentHooks, ...rest: any[]): void {
    try {
      const fn = hooks?.[name] as ((...args: any[]) => void) | undefined;
      fn?.(...rest);
    } catch (e) { console.warn(`hook ${name} error:`, e); }
  }

  private async dispatchTool(
    call: any, hooks: AgentHooks | undefined, round: number,
    messages: any[], signal: AbortSignal | undefined, backend: AgentBackend,
  ): Promise<string> {
    const fn = call.function || call;
    const name: string = fn.name;
    const argStr: string = fn.arguments;
    let args: any = {};
    try { args = argStr ? JSON.parse(argStr) : {}; }
    catch { return JSON.stringify({ error: '参数 JSON 解析失败: ' + argStr }); }

    this.safeHook(hooks, 'onToolStart', name, args);
    const t0 = Date.now();
    let result: any;

    try {
      switch (name) {
        case 'get_canvas_context':
          result = await this.deps.ggb.getCanvasContext();
          break;
        case 'search_command': {
          const hits = await this.deps.commandSearch.search(args.query, 4);
          result = { query: args.query, results: this.deps.commandSearch.format(hits) };
          break;
        }
        case 'execute_command': {
          const cmdText = args.command || (args.commands ? args.commands.join('\n') : '');
          const batch = await this.deps.ggb.execBatch(cmdText);
          const okRows = batch.filter((r) => r.ok);
          const failedRows = batch.filter((r) => !r.ok);
          const failedLabels = new Set(failedRows.flatMap((r) => (r.labels || '').split(',').map((s) => s.trim()).filter(Boolean)));
          const failedDetails = failedRows.map((r) => {
            const refs = extractLabels(r.cmd).filter((lbl) => failedLabels.has(lbl));
            return {
              index: batch.indexOf(r) + 1,
              cmd: r.cmd,
              error: r.error,
              rootCause: refs.length ? `引用了本批已失败的对象 [${refs.join(', ')}]，根因在上游——修好上游这行多半自愈，不要单独重试本行` : null,
            };
          });
          result = {
            ok: failedRows.length === 0,
            total: batch.length,
            okCount: okRows.length,
            failedCount: failedRows.length,
            createdLabels: okRows.flatMap((r) => (r.labels || '').split(',').map((s) => s.trim()).filter(Boolean)),
            failures: failedDetails,
          };
          if (hooks?.onExec) batch.forEach((r) => hooks.onExec!(r.cmd, r));
          break;
        }
        case 'verify_geometry': {
          const done = messages.filter((m) => m._toolName === 'verify_geometry').length;
          if (done >= VERIFY_CAP) {
            result = { ok: false, error: `已超验证预算(本 turn 最多 ${VERIFY_CAP} 次)。请直接完成构造。` };
          } else {
            result = await this.deps.ggb.measure(args.expression);
            result.expression = args.expression;
            result.expect = args.expect || '';
          }
          break;
        }
        case 'inspect_render': {
          const doneInsp = messages.filter((m) => m._toolName === 'inspect_render').length;
          if (doneInsp >= INSPECT_CAP) {
            result = { ok: false, error: `已超视觉检查预算(本题最多 ${INSPECT_CAP} 次)。请直接基于当前画布完成。` };
            break;
          }
          if (!backend.visionReady()) {
            result = { ok: false, error: '视觉模型未配置' };
            break;
          }
          const png = this.deps.ggb.getPNGBase64(2, false, 150);
          if (!png) { result = { ok: false, error: '截图失败(画布未就绪)' }; break; }
          const dataUrl = png.startsWith('data:') ? png : `data:image/png;base64,${png}`;
          const focusStep = args.focus
            ? `第二步·对照重点: 构造规划声明要凸显的【${args.focus}】。逐一核查这些点/文本/对象是否**已经画出来(存在)**。重要: 被其他对象轻微遮挡 ≠ 缺失(那属于第三步的"遮挡"问题, 移开遮挡即可); 只有完全没画出来、或画错对象, 才记为"缺失"。`
            : '第二步·对照重点: 本题未声明重点, 跳过。';
          const prompt = `你是 K12 数学课件审图员。下面是一张 GeoGebra 画布截图。按三步检查, 聚焦"学生第一眼能看到的具体视觉问题"。不要泛泛判定、不要解题、不要给修改命令。

第一步·描述你实际看到的(必须先做, 这是核查基准):
- 显示了哪些点的标签? 逐个列出(如 A、B、O)。特别注意: 是否有几何点画了却没标字母?
- 图上有哪些文本/公式? 逐个列出内容和大致位置。
- 主要几何对象(线段/圆/椭圆/轨迹等)是否清晰?

${focusStep}

第三步·检查具体视觉问题(只查这些视觉能可靠判断的, 确有时才报):
- 点标签缺失: 有几何点画了点却没标字母? 该有的关键点(顶点/交点/动点)没画出来?
- 文本重叠或遮挡: 文本/公式互相重叠, 或盖住关键图形/坐标?
- 文本不可读: 文本被截断/乱码, 或公式显示成原始 LaTeX 源码(裸露的 \\frac、^2 反斜杠尖号)而非渲染好的公式?
- 贴边或被切割: 图形贴画布边缘、或被坐标轴切掉?
- 角弧异常: 角度弧画反侧、或成 >180° 大角?

输出格式(严格遵守):
- 没有任何问题 → 只输出一行: 验收通过
- 有问题 → 每个问题单独一行, 以 "问题: " 开头, 写清问题+对象/位置(如 "问题: 点C缺少标签"、"问题: 右上角面积文本与|AB|文本重叠")。不要输出步骤描述、不要无关分析。`;
          const raw = await backend.vision(dataUrl, prompt, signal);
          const issues = parseInspectIssues(raw);
          const passed = issues.length === 0;
          result = {
            ok: true, passed, issues, rawFeedback: raw,
            advisory: passed
              ? '验收通过: 视觉未发现问题。【立即输出最终回复, 禁止再调 execute_command】。'
              : '视觉指出上述问题(仅供参考, 可能误判)。只针对被点名的项做**最小微调**(如移开遮挡的文本、补一个缺失的标签), **严禁改变画法或重构**(如把已有的直角小方块改成向量夹角、把正确的对象重画)。改前先 get_canvas_context 复核, 本题最多因视觉反馈调整 1 轮, 调完即输出最终回复。',
          };
          break;
        }
        case 'reset_canvas':
          await this.deps.ggb.clearAll();
          result = { ok: true, cleared: true };
          break;
        default:
          result = { error: `未知工具: ${name}` };
      }
    } catch (e: any) {
      result = { error: String(e.message || e) };
    }

    const durationMs = Date.now() - t0;
    this.deps.logger.toolCall({ round, name, args, result, durationMs });
    this.safeHook(hooks, 'onToolEnd', name, args, result);
    return JSON.stringify(result);
  }

  async run({
    userInput, history, config, backend, hooks = {}, signal,
  }: {
    userInput: string;
    history: any[];
    config: { max_tool_rounds?: number };
    backend: AgentBackend;
    hooks?: AgentHooks;
    signal?: AbortSignal;
  }): Promise<AgentRunResult> {
    const messages: any[] = [
      { role: 'system', content: SYSTEM_PROMPT },
      ...history,
      { role: 'user', content: userInput },
    ];
    const maxRounds = config.max_tool_rounds || 50;

    for (let round = 0; round < maxRounds; round++) {
      hooks.onRound?.(round + 1);
      if (signal?.aborted) throw new Error('已中止');

      const assistant = await backend.chat({
        messages, tools: TOOLS, onToken: hooks.onToken, signal,
      });
      messages.push(assistant);

      if (!assistant.tool_calls || !assistant.tool_calls.length) {
        const r: AgentRunResult = {
          messages,
          finalText: cleanFinalText(assistant.content || ''),
          toolHistory: collectTools(messages),
          stopped: false,
        };
        this.deps.logger.turnEnd({ finalText: r.finalText, toolCount: r.toolHistory.length, stopped: false });
        return r;
      }

      for (const call of assistant.tool_calls) {
        const toolResult = await this.dispatchTool(call, hooks, round + 1, messages, signal, backend);
        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: toolResult,
          _toolName: (call.function || call).name,
        });
      }
      if (hooks.onToken) hooks.onToken('\n');
    }

    hooks.onRound?.(maxRounds, true);
    const r: AgentRunResult = {
      messages,
      finalText: '(达到工具调用轮数上限, 已停止)',
      toolHistory: collectTools(messages),
      stopped: true,
    };
    this.deps.logger.turnEnd({ finalText: r.finalText, toolCount: r.toolHistory.length, stopped: true });
    return r;
  }
}
