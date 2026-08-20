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
import { estimateInputTokens, compactLoopHistory, BUDGET_HINT_TOKENS, BUDGET_HINT_SUFFIX, LOOP_STOP_TOKENS, LOOP_STOP_NOTICE } from './loop-context';
import type { AssistantMessage, ToolDef, LLMConfig } from './llm';
import { ThinkingController, EMPTY_SIGNAL, type RoundSignal, type ThinkingMode } from './thinking';

export type { AssistantMessage };

export interface AgentBackend {
  chat(p: { messages: any[]; tools?: ToolDef[]; onToken?: (d: string) => void; onThinking?: (d: string) => void; thinking?: 'enabled' | 'disabled'; reasoningEffort?: 'low' | 'medium' | 'high'; signal?: AbortSignal }): Promise<AssistantMessage>;
  vision(image: string, prompt: string, signal?: AbortSignal): Promise<string>;
  visionReady(): boolean;
}

export interface AgentHooks {
  onToken?: (t: string) => void;
  onThinking?: (t: string) => void;                                  // 思考流增量(reasoning_content)
  onStage?: (stage: 'PLAN' | 'SOLVE' | 'EXECUTE' | 'RECOVER', round: number) => void;  // 阶段状态(UI 状态行)
  onToolStart?: (name: string, args: any) => void;
  onToolEnd?: (name: string, args: any, result: any) => void;
  onExec?: (cmd: string, result: any) => void;
  onRound?: (n: number, stopped?: boolean) => void;
}

interface AgentDeps {
  ggb: GGB;
  commandSearch: CommandSearch;
  logger: Logger;
  systemPrompt: string;   // 由 loader 按生效版本注入; 不再有内置默认
}

export interface AgentRunResult {
  messages: any[];
  finalText: string;
  toolHistory: Array<{ name: string; arguments: string }>;
  stopped: boolean;
}

const VERIFY_CAP = 3;
const INSPECT_CAP = 2;

// SOLVE 轮(先解后画)结束后的续作指令(引擎注入的 user 消息): 把已给出的解答翻译成构造, 不重新推导
const SOLVE_ACK = '【解答已收到】接下来把上述解答翻译成 GeoGebra 构造：按解答里的坐标/方程/结论逐步建对象，不要重新推导数学。先简列构造顺序，然后优先批量提交成组命令；每问完成后用文本标注要凸显的结论。';

// PLAN 轮纯文本宣告复杂(未调工具)时的解题触发指令(引擎注入的 user 消息):
// 纯文本 assistant 之后必须补一条 user 才能继续下一轮请求
const SOLVE_KICKOFF = '【开始解题】请现在完整解题：先用思考把整道题从头到尾解出来（每一问的推导、关键坐标/方程/数值结论一步不省），然后在正文输出完整解答。本轮不画图、不调用工具。';

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
    name: 'set_perspective',
    description: '切换 GeoGebra 视图布局。3D 几何题必须先调此工具打开 3D 绘图区(view="T")，否则 3D 对象落入 2D 视图变成奇怪投影。全屏模式下代数区自动打开。可用视图: G=2D绘图, A=代数, T=3D绘图。组合: AG=代数+2D, AT=代数+3D。',
    parameters: { type: 'object', properties: { view: { type: 'string', description: '视图布局字符串, 如 AG / AT / G / T' } }, required: ['view'] },
  },
  {
    name: 'reset_canvas',
    description: '清空画布。仅在用户明确要求重置时调用。',
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'request_solve',
    description: '标记本题为复杂题，请求进入专门解题阶段。判定标准：立体几何、轨迹/最值/定值、多对象联动约束、或需要长推导。调用后下一轮将不带画图工具、专心把整道题完整解出来。仅在规划轮调用一次；简单题不要调用。',
    parameters: { type: 'object', properties: {}, required: [] },
  },
];

const GGB_RESERVED = new Set([
  'Slider', 'Point', 'Segment', 'Line', 'Ray', 'Vector', 'Circle', 'Ellipse', 'Parabola',
  'Polygon', 'Midpoint', 'Intersect', 'PerpendicularLine', 'ParallelLine', 'Tangent',
  'Angle', 'Distance', 'Length', 'Area', 'Slope', 'Rotate', 'Translate', 'Reflect', 'Dilate',
  'Locus', 'Sequence', 'If', 'Curve', 'Polyline', 'Text', 'ShowLabel', 'SetColor', 'SetLineStyle',
  'SetLineThickness', 'SetPointSize', 'SetPointStyle', 'SetFilling', 'SetVisible', 'SetFixed',
  'SetConditionToShowObject', 'SetCoordSystem', 'SetPerspective', 'SetActiveView', 'ZoomIn', 'ZoomOut', 'ShowAxes', 'ShowGrid',
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
  getSystemPrompt() { return this.deps.systemPrompt; }

  private safeHook(hooks: AgentHooks | undefined, name: 'onToolStart', a: string, b: any): void;
  private safeHook(hooks: AgentHooks | undefined, name: 'onToolEnd', a: string, b: any, c: any): void;
  private safeHook(hooks: AgentHooks | undefined, name: 'onRound', a: number, b?: boolean): void;
  private safeHook(hooks: AgentHooks | undefined, name: 'onStage', a: 'PLAN' | 'SOLVE' | 'EXECUTE' | 'RECOVER', b: number): void;
  private safeHook(hooks: AgentHooks | undefined, name: keyof AgentHooks, ...rest: any[]): void {
    try {
      const fn = hooks?.[name] as ((...args: any[]) => void) | undefined;
      fn?.(...rest);
    } catch (e) { console.warn(`hook ${name} error:`, e); }
  }

  private async dispatchTool(
    call: any, hooks: AgentHooks | undefined, round: number,
    messages: any[], signal: AbortSignal | undefined, backend: AgentBackend,
  ): Promise<any> {
    const fn = call.function || call;
    const name: string = fn.name;
    const argStr: string = fn.arguments;
    let args: any = {};
    try { args = argStr ? JSON.parse(argStr) : {}; }
    catch { return { error: '参数 JSON 解析失败: ' + argStr }; }

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
        case 'set_perspective': {
          const view = String(args.view || 'AG');
          try { this.deps.ggb.getAPI()?.setPerspective?.(view); } catch {}
          result = { ok: true, view };
          break;
        }
        case 'reset_canvas':
          await this.deps.ggb.clearAll();
          result = { ok: true, cleared: true };
          break;
        case 'request_solve':
          result = { ok: true, granted: true, note: '已确认复杂题。下一轮进入解题阶段（无画图工具），请把整道题完整解出来。' };
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
    return result;
  }

  async run({
    userInput, history, config, backend, hooks = {}, signal,
  }: {
    userInput: string;
    history: any[];
    config: { max_tool_rounds?: number; thinking_mode?: ThinkingMode; vision_verify?: 'auto' | 'off'; input_budget_tokens?: number | (() => number | undefined) };
    backend: AgentBackend;
    hooks?: AgentHooks;
    signal?: AbortSignal;
  }): Promise<AgentRunResult> {
    const messages: any[] = [
      { role: 'system', content: this.deps.systemPrompt },
      ...history,
      { role: 'user', content: userInput },
    ];
    const maxRounds = config.max_tool_rounds || 50;
    const tc = new ThinkingController(config.thinking_mode || 'auto');
    // 视觉核验开关(设置页「高级」): off = 移除 inspect_render, 模型物理上无法调用
    // (省视觉模型 API 花费 + 每次触发 10-50s 延迟); 缺省/auto = 模型自行判断
    const tools = config.vision_verify === 'off'
      ? TOOLS.filter((t) => t.name !== 'inspect_render')
      : TOOLS;
    let tokensUsed = 0;        // 本意图累计输入(与 trial 路由同一把尺子累加, 供 80% 收敛提示/90K 硬顶)
    let budgetStopped = false; // 90K 硬顶触发: 优雅收手, 不让路由 429 在循环中途炸掉整个 turn
    // 预算上限可覆盖: 90K 硬停只为预判 trial 路由 100K 累计上限; BYOK 直连厂商无路由限制,
    // 长构造(20+ 轮)在 90K 下会被误掐 —— 调用方传 input_budget_tokens 放宽, 提示阈值随之取 80%。
    // 支持函数形式: trial 的路由真实上限要等首轮响应头(x-trial-budget)才知道, 每轮重新解析
    const resolveBudget = () => (typeof config.input_budget_tokens === 'function'
      ? config.input_budget_tokens()
      : config.input_budget_tokens);
    let idleStreak = 0;        // 连续"只感知不执行"轮数(get_canvas_context/search_command 空转检测)

    for (let round = 0; round < maxRounds; round++) {
      hooks.onRound?.(round + 1);
      if (signal?.aborted) throw new Error('已中止');

      // 阶段指令以本轮 system 临时后缀注入(浅拷贝, 不写入 messages 历史) —— prompt v2 本体不动
      // 累计输入逼近预算 80% 时附加收敛指令, 抢在路由 429("上下文过大")之前让模型收尾
      tokensUsed += estimateInputTokens({ messages, tools });
      const budget = resolveBudget();
      const stopTokens = budget ?? LOOP_STOP_TOKENS;
      const hintTokens = budget ? Math.floor(budget * 0.8) : BUDGET_HINT_TOKENS;
      if (tokensUsed >= stopTokens) { budgetStopped = true; break; }
      // 空转提醒: 连续 3+ 轮只读画布/搜命令没执行构造 → 逼模型收敛, 省无谓轮次(关思考时高发)
      const idleHint = idleStreak >= 3
        ? `【空转提醒】你已连续 ${idleStreak} 轮只读取画布/检索命令而未执行任何构造命令。不要再重复感知：基于画布现状直接批量执行最终构造命令，或立即给出最终回复说明无法继续的原因。`
        : '';
      const suffix = [tc.systemSuffix(), tokensUsed >= hintTokens ? BUDGET_HINT_SUFFIX : '', idleHint]
        .filter(Boolean).join('\n\n');
      const chatMessages = suffix
        ? [{ ...messages[0], content: `${messages[0].content}\n\n${suffix}` }, ...messages.slice(1)]
        : messages;
      this.safeHook(hooks, 'onStage', tc.currentStage, round + 1);

      const plan = tc.planFor(tc.currentStage);
      // SOLVE 轮(先解后画): 不下发工具定义, 物理上逼出纯文本解答——推理集中一轮做完, 不被工具循环摊薄
      const solveRound = tc.currentStage === 'SOLVE';
      let assistant = await backend.chat({
        messages: chatMessages, tools: solveRound ? undefined : tools, onToken: hooks.onToken,
        onThinking: hooks.onThinking, thinking: plan.thinking,
        reasoningEffort: plan.reasoningEffort, signal,
      });
      // ⟨deep⟩ 复杂度自判: PLAN 轮命中标记 → 本题进 SOLVE 先解题、执行轮升全思考; 标记本身不进历史。
      // 正文与思考流都扫: deepseek 思考完常直接发工具调用, 标记可能只出现在 reasoning 里
      const cleanedContent = tc.absorbDeepFlag(assistant.content || '');
      if (cleanedContent !== assistant.content) assistant = { ...assistant, content: cleanedContent };
      if (assistant.reasoning_content) {
        const cleanedRc = tc.absorbDeepFromReasoning(assistant.reasoning_content);
        if (cleanedRc !== assistant.reasoning_content) assistant = { ...assistant, reasoning_content: cleanedRc };
      }
      // SOLVE 轮未提供工具定义时模型仍幻觉出 tool_calls → 丢弃, 只按解答文本处理(防 SOLVE 死循环)
      if (solveRound && assistant.tool_calls?.length) {
        assistant = { ...assistant, tool_calls: undefined };
      }
      // assistant 原样入历史(含 reasoning_content): enabled 轮的思考随历史回传, 避免端点 400-strip 静默降级
      messages.push(assistant);

      if (!assistant.tool_calls || !assistant.tool_calls.length) {
        // SOLVE 轮纯文本 = 预期形态: 解答入历史, 注入"翻译成作图"续作消息, 阶段落 EXECUTE 继续
        if (solveRound) {
          const solution = cleanFinalText(assistant.content || '');
          if (!solution) {
            throw new Error(`模型返回空回复(解题阶段思考耗尽输出上限被截断, finish_reason=${assistant.finish_reason || '未知'}), 请重试`);
          }
          tc.solveDone();
          messages.push({ role: 'user', content: SOLVE_ACK });
          continue;
        }
        // PLAN 轮纯文本且已判 ⟨deep⟩(未调任何工具): 不是最终回复——切 SOLVE 专门解题,
        // 防止"本轮只列要点, 下一轮解题"的回复把整个对话提前结束
        if (tc.currentStage === 'PLAN' && tc.isDeep) {
          tc.enterSolve();
          messages.push({ role: 'user', content: SOLVE_KICKOFF });
          continue;
        }
        const rawFinal = cleanFinalText(assistant.content || '');
        // 空回复护栏: 开思考轮的输出被推理耗尽时 content/tool_calls 双空(deepseek 思考 token
        // 计入 max_tokens, 实测 8192/8192 全是 reasoning)。全程零工具 + 空文本 = 截断, 抛错让
        // 用户重试, 不再无声空白结束; 跑过工具的空总结用占位文案收尾(画布已有成果)
        if (!rawFinal && collectTools(messages).length === 0) {
          throw new Error(`模型返回空回复(思考耗尽输出上限被截断, finish_reason=${assistant.finish_reason || '未知'}), 请重试`);
        }
        const r: AgentRunResult = {
          messages,
          finalText: rawFinal || '（模型未给出总结，画布已保留构造结果）',
          toolHistory: collectTools(messages),
          stopped: false,
        };
        this.deps.logger.turnEnd({ finalText: r.finalText, toolCount: r.toolHistory.length, stopped: false });
        return r;
      }

      // 汇总本轮工具信号喂状态机(全部来自现有结果字段, 无新检测机制)
      const roundSignal: RoundSignal = { ...EMPTY_SIGNAL };
      for (const call of assistant.tool_calls) {
        const fnName = (call.function || call).name;
        const result = await this.dispatchTool(call, hooks, round + 1, messages, signal, backend);
        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: JSON.stringify(result),
          _toolName: fnName,
        });
        if (fnName === 'execute_command') {
          roundSignal.execRan = true;
          if ((result?.failedCount || 0) > 0) roundSignal.execFailed = true;
          roundSignal.createdLabels += (result?.createdLabels || []).length;
        } else if (fnName === 'verify_geometry') {
          // 预算超限的 ok:false 也计入②——模型在无益空转, 升级恢复一轮合理(spec §3.1②"不达预期")
          if (result?.ok === false) roundSignal.verifyFailed = true;
        } else if (fnName === 'inspect_render') {
          roundSignal.inspectRan = true;                    // 无论过没过: 主构造已完成, 进入收尾阶段
          if (result?.passed === false) roundSignal.inspectFailed = true;
        } else if (fnName === 'request_solve') {
          tc.markDeep();   // 复杂度主信号(结构化工具调用), 先于 observeRound 置位 → PLAN 轮后落 SOLVE
        }
      }
      // 空转计数: 本轮执行过构造命令即归零, 否则累加(供下一轮空转提醒与触发⑤升级共用)
      idleStreak = roundSignal.execRan ? 0 : idleStreak + 1;
      roundSignal.idleRounds = idleStreak;
      tc.observeRound(roundSignal);
      // 循环内压缩: 中间轮工具结果换占位符(头/尾保留), 抑制全量重发的二次膨胀;
      // 不动本轮结果与结构字段, toolHistory/日志不受影响(前者只读 assistant.tool_calls)
      const compacted = compactLoopHistory(messages);
      if (compacted !== messages) messages.splice(0, messages.length, ...compacted);
    }

    // 循环退出: 轮数上限或预算硬顶。预算硬顶保留最近叙述 + 停止说明(正常收尾路径,
    // turn_end 照常落库, 刷新后消息不丢 —— 与路由 429 的报错路径本质不同)
    hooks.onRound?.(maxRounds, true);
    const lastNarration = [...messages].reverse().find((m) => m.role === 'assistant' && m.content)?.content || '';
    const r: AgentRunResult = {
      messages,
      finalText: budgetStopped
        ? (lastNarration ? `${lastNarration}\n\n${LOOP_STOP_NOTICE}` : LOOP_STOP_NOTICE)
        : '(达到工具调用轮数上限, 已停止)',
      toolHistory: collectTools(messages),
      stopped: true,
    };
    this.deps.logger.turnEnd({ finalText: r.finalText, toolCount: r.toolHistory.length, stopped: true });
    return r;
  }
}
