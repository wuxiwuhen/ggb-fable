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
   - 自由变量：每个 Slider/自由点，**Min、Max、初值三者同时确定**（初值属规划本身，非事后补）。区间匹配定义域；初值选非退化、具代表性的中段值。初值靠紧跟 Slider 的 SetValue 落地。**角度量必须带度符号**。
   - 依赖链：1-3 条核心派生对象如何依赖自由变量（如 m=sqrt(...)、A=Intersect(...)）。
   - 不变关系：本题最该让学生看到的不变结论（如"OA⊥OB 恒成立"）。无则写"无（纯构造题）"。
   - 视觉重点：画完后应一眼看到什么。
   这块是后续验证的契约——"不变关系"喂给 verify_geometry，"视觉重点+不变关系"喂给 inspect_render 的 focus。
   **选动画变量（关键决策，别选错）**：多个自由变量时，选哪个做动画要看"哪个变量动起来能完整演示解题过程/题设的几何运动"，而非哪个更显眼。
2. **感知与规划**：调 get_canvas_context 读当前状态 → 用 search_command 查不熟悉的命令签名。
3. **执行与对账验证**：调 execute_command 提交构造命令 → 用 verify_geometry 验"不变关系"字段 → 若有主变量滑块，收尾启动动画 → 主构造完成后调 1 次 inspect_render 对账，按反馈最多改 1 轮。

---

# 输出规范（视觉与交互）

## 视觉规范（K12 课件的"好看"基线）

1. **画布范围自适应**：几何题默认 SetCoordSystem(-6,6,-5,5)；解析几何/函数题按实际范围收紧，四周留约 15% 留白。
2. **线型语义化**：主线段实线；辅助线（高、中线、角平分线、构造垂线）一律虚线 SetLineStyle(_, 2)。
3. **配色按关系分组**：相等的线段/角同色；关键对象用最醒目色+加粗。颜色不超过 4 种。
4. **标签显隐有取舍**：关键点显示标签；构造中间量隐藏标签。
5. **角度标记极简（默认不标）**：默认什么都不标；仅当【该角是不变关系/结论本身】或【题目核心直角】时才标，每题通常 0-1 个角。

## 最终回复契约（构造完成后输出，结构固定）

最终回复只负责"讲解"，**绝不贴 GeoGebra 命令**。固定三段，用**加粗小标题**分段（不用 emoji、不用 markdown 表格、不用 ### 标题）：

1. **数学解答**：完整推导——方程、步骤、最终答案。数学用 $...$ / $$...$$。
2. **课件说明**：画布上画了什么、关键对象含义与配色。
3. **交互引导**：拖哪个滑块/对象看什么变化。

## 其他输出规范

- **数值回答（LaTeX 格式铁律）**：行内 $...$，行间/独立方程 $$...$$ 独占一行。用标准命令 \\sqrt{}、\\frac{}{}、\\angle、\\triangle。**严禁** Unicode 符号（√、²、∠）或圆括号/方括号作公式分隔符。
- **画布 Text（含数学符号必须开 LaTeX 渲染）**：Text 第4参数传 true，数学用 LaTeX 命令，动态值用 + 拼接。反斜杠只写一层；纯文字部分用 \\text{ } 包裹。
- **3D 视角**：立体几何主动执行 SetViewDirection((1,1,1)) 并提示切换视角。
- **诚实原则**：超出 GeoGebra 能力的需求直接说明。

---

# Few-shot 演示（K12 高频场景全覆盖）

例 1：数学关系编码（代数约束）
   ❌ k=Slider(-5,5), m=Slider(-2,2), l:y=kx+m → 拖动时垂直关系丢失。
   ✅ k=Slider(-5,5), m=sqrt(2*(1+k^2)/3), l:y=k*x+m。把 m 定义为 k 的函数，垂直关系自动保持。

例 2：几何约束替代硬编码（动态几何）
   ❌ M=(1.5, 3) → 手算中点坐标，拖动 A/B 时 M 不动。
   ✅ M=Midpoint(A, B) → 几何关系由命令保证，任意拖动都成立。

例 3：交互显隐编码（条件触发）
   ❌ 在回复中写"当 a>2 时，圆会显现"。
   ✅ a=Slider(0,3,0.01), SetConditionToShowObject(c, a>2) → 显隐条件编码进命令。

例 4：主变量滑块动画（有主变量滑块时收尾必须启动）
   Slider 签名: Slider(Min, Max, 增量, 速度, 宽度, 是否角, 水平, 是否动画, 随机)。
   ✅ k = Slider(-5, 5, 0.01, 1, 200, false, true, true)
   ✅ k = Slider(-5, 5, 0.01, 1, 200); StartAnimation(k, true)
   ❌ StartAnimation(k) 单参语义是"恢复所有动画"不稳。

---`;

const TOOLS: ToolDef[] = [
  {
    name: 'get_canvas_context',
    description: '读取画布真实状态: elements(每个对象的当前 definition/type)。改某对象时看它的 definition, 重发 "label = 新定义" 即重定义, 不要凭空猜测。',
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'search_command',
    description: '检索 GeoGebra 命令的真实签名、示例与陷阱。使用不熟悉的命令前务必先查。',
    parameters: { type: 'object', properties: { query: { type: 'string', description: '命令名或功能关键词, 如 Circle / 切线 / 滑块' } }, required: ['query'] },
  },
  {
    name: 'execute_command',
    description: '执行 GeoGebra 英文命令, 支持一次传多条(每条一行)。返回摘要化: 成功行只回灌 createdLabels, 失败行逐条列出含 rootCause。命令名必须英文(US)。',
    parameters: { type: 'object', properties: { command: { type: 'string', description: '一条或多条 GeoGebra 命令, 英文; 多条用换行分隔' } }, required: ['command'] },
  },
  {
    name: 'verify_geometry',
    description: '测量几何量以验证非平凡约束。垂直用 ArePerpendicular 而非 Angle。仅当对相切/垂直/共线没把握时用一次。每 turn 最多 3 次。',
    parameters: { type: 'object', properties: { expression: { type: 'string', description: 'GeoGebra 数值表达式, 如 Slope(g) 或 Angle(A,B,C)' }, expect: { type: 'string', description: '可选: 期望值或说明' } }, required: ['expression'] },
  },
  {
    name: 'inspect_render',
    description: '截图当前画布交视觉模型做"验收检查", 按清单逐项判定并对账 focus。仅在主构造完成、准备输出最终回复前调用 1 次。返回 issues: 为空=验收通过立即输出最终回复; 非空=只改被点名的项, 本题最多改 1 轮。本题最多 2 次。',
    parameters: { type: 'object', properties: { focus: { type: 'string', description: '对账依据: 取构造规划里的"视觉重点+不变关系"字段' } }, required: [] },
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
  const summaryMatch = text.match(/问题汇总[:：]\s*(.+)/);
  if (summaryMatch) {
    const s = summaryMatch[1].trim();
    if (/^无|^none|^无问题/i.test(s)) return [];
    return s.split(/[;；]/).map((x) => x.trim()).filter(Boolean);
  }
  const issues: string[] = [];
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*([-^一-龥A-Za-z0-9_／/]+?)\s*[:：]\s*yes\b/i);
    if (m) issues.push(m[1].trim());
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
          const focusItem = args.focus
            ? `- 重点对账: 题目声明要凸显的【${args.focus}】是否在图上清晰可见? 若看不见或被遮挡 → 答 yes(问题)。`
            : '';
          const prompt = `你是 K12 数学课件审图员。下面是一张 GeoGebra 画布截图。严格按清单逐项判定, 每项只输出一行: "项名: yes|no — 一句话说明"。只在确有问题时答 yes, 拿不准答 no。

检查清单:
- 图形退化: 整体是否退化压扁/点挤成一团/不可读?
- 标签遮挡: 任何文字标签是否互相重叠、或盖住关键几何元素?
- 贴边切割: 图形是否贴画布边缘、或被坐标轴切掉一部分?
- 比例失调: 坐标系两轴比例是否严重失真(如圆画成椭圆)?
- 辅助线线型: 辅助线是否该虚线却画成实线?
- 轨迹可见: 若题含动点轨迹, 轨迹线是否可见且醒目?
- 角标记: 角度弧是否画反侧/画成 >180° 的大角?
${focusItem}
最后另起一行, 以 "问题汇总:" 开头, 用分号列出所有答 yes 的项(没有则写"无")。不要解题, 不要给修改命令。`;
          const raw = await backend.vision(dataUrl, prompt, signal);
          const issues = parseInspectIssues(raw);
          const passed = issues.length === 0;
          result = {
            ok: true, passed, issues, rawFeedback: raw,
            advisory: passed
              ? '验收通过: 视觉未发现问题。【立即输出最终回复, 禁止再调 execute_command】。'
              : '视觉指出上述问题(仅供参考, 可能误判)。只针对被点名的项改, 本题最多因视觉反馈调整 1 轮, 调完即输出最终回复。',
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
    const maxRounds = config.max_tool_rounds || 30;

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
