// 三段式思考策略状态机(spec: docs/superpowers/specs/2026-08-19-speed-optimization-design.md §3.1)
// 纯逻辑无 IO: 引擎每轮 chat 前调 planFor(stage)/systemSuffix(), 工具跑完后调 observeRound() 回报信号。
//   PLAN(第 1 轮, 思考开) → [deep? SOLVE(纯文本完整解题, 先解后画)] → EXECUTE --触发--> RECOVER(思考开, 上限 2) --一轮--> EXECUTE
// thinking_mode: auto=三段式(默认) / autolow=三段式但 EXECUTE 轻思考(enabled+reasoning_effort:low)
//                / always=全程思考(v1 基线语义) / never=全程关(fast 臂)。

export type ThinkingMode = 'auto' | 'autolow' | 'always' | 'never';
export type ThinkingDecision = 'enabled' | 'disabled';
export type ReasoningEffort = 'low' | 'medium' | 'high';
export type Stage = 'PLAN' | 'SOLVE' | 'EXECUTE' | 'RECOVER';

// 某阶段的思考配置(每轮 backend.chat 之前由 planFor(当前阶段) 取)
export interface StagePlan {
  thinking: ThinkingDecision;
  reasoningEffort?: ReasoningEffort;   // 仅轻思考档的 EXECUTE 携带
}

// 一轮工具执行后的信号(由引擎从工具结果汇总, 全部来自现有结果字段)
export interface RoundSignal {
  execRan: boolean;        // 本轮调用过 execute_command
  execFailed: boolean;     // 本轮 ≥1 批次 failedCount > 0
  createdLabels: number;   // 本轮 execute_command 新建标签总数
  verifyFailed: boolean;   // 本轮 ≥1 verify_geometry 结果 ok === false
  inspectFailed: boolean;  // 本轮 ≥1 inspect_render 结果 passed === false
  inspectRan: boolean;     // 本轮调用过 inspect_render(无论通过与否)——进入收尾阶段的信号
  idleRounds: number;      // 连续"只感知不执行"轮数(含本轮; execute 打断即归零)
}

export const EMPTY_SIGNAL: RoundSignal = {
  execRan: false, execFailed: false, createdLabels: 0, verifyFailed: false, inspectFailed: false, inspectRan: false, idleRounds: 0,
};

export const EXECUTE_SUFFIX = '【执行阶段】按既定规划继续执行, 不要重新整体规划; 剩余构造优先批量提交(一次 execute_command 传多条)。';
export const RECOVER_SUFFIX = '【恢复阶段】刚才的执行出现失败或空转。先从 failures 与画布上下文定位根因, 只修正被点名的问题后继续按既定规划执行, 不要从零重画。';
// SOLVE 轮(先解后画): 复杂题在作图前专门完整解题——把推理集中到一轮做完, 不被工具循环摊薄
// (839s 抛物线案: 交错工具把解题摊在多轮, 第二问结论算错; 网页版单轮集中推理一次解对)
export const SOLVE_SUFFIX = '【解题阶段】本题已判定为复杂题。请先用思考把整道题从头到尾完整解出来（每一问的推导过程、关键坐标/方程/数值结论一步不省），然后在正文输出完整解答。本轮不画图、不调用任何工具（本轮也不提供工具）。写完解答即结束本轮，下一轮会基于你的解答开始作图。';
// PLAN 轮复杂度自判: 复杂题让模型自己标记, 引擎据此插入 SOLVE 轮(先解后画)并把执行轮切回思考
// (关思考时复杂题的推导无处安放, 会溢出到正文——实测"重新生成"把 1 万字推导写进循环叙述)
export const DEEP_ASK_SUFFIX = '【复杂度自判】先快速判断本题复杂度，再决定本轮动作：复杂题（涉及立体几何、轨迹/最值/定值、多对象联动约束、或需要长推导）→ 本轮不要展开解题推导，只在正文简要列出各问需要画的对象与顺序，并调用一次 request_solve 工具，同时在回复最末尾另起一行输出 ⟨deep⟩ 作为备用信号，下一轮会专门完整解题后再作图；简单题或微调 → 直接完成规划并开始作图，不要调用 request_solve 也不要输出该标记。';

const RECOVERY_CAP = 2;

export class ThinkingController {
  private stage: Stage = 'PLAN';
  private recoveries = 0;
  private lastSignal: RoundSignal | null = null;   // 上一轮信号(observeRound 时作为 prev)
  private inspectFails = 0;
  private inspectSeen = false;                       // inspect_render 已跑过 → 进入收尾阶段
  private deep = false;                             // PLAN 轮自判为复杂题: 先 SOLVE 解题, EXECUTE 也开思考

  constructor(private mode: ThinkingMode = 'auto') {}

  get currentStage(): Stage { return this.stage; }
  get recoveryCount(): number { return this.recoveries; }
  get isDeep(): boolean { return this.deep; }

  // 指定阶段的思考配置(每轮 backend.chat 之前调 planFor(currentStage))
  planFor(stage: Stage): StagePlan {
    if (this.mode === 'always') return { thinking: 'enabled' };
    if (this.mode === 'never') return { thinking: 'disabled' };
    if (stage === 'EXECUTE') {
      // 收尾修正轮(inspect 已跑过): 主构造完成, 只剩挪文本/补标签等视觉微调,
      // 关思考(实测开思考时挪四个文本也要重推全题 60-100s/轮, 839s 案收尾段烧 345s);
      // 微调失败会照常升级 RECOVER(全思考)兜底
      if (this.inspectSeen) return { thinking: 'disabled' };
      // 复杂题(deep): 执行轮升全思考(autolow 的 low 也升)——推导进思考空间, 不溢出正文
      if (this.deep) return { thinking: 'enabled' };
      // auto: EXECUTE 关思考; autolow: EXECUTE 轻思考(保留思考但压低力度)
      return this.mode === 'autolow'
        ? { thinking: 'enabled', reasoningEffort: 'low' }
        : { thinking: 'disabled' };
    }
    return { thinking: 'enabled' };                          // PLAN / SOLVE / RECOVER 全思考
  }

  // 吸收 assistant 回复中的 ⟨deep⟩ 标记: 返回清除后的文本。
  // PLAN 阶段(auto/autolow)命中 → 置 deep; 其余阶段/档位只清除不置位(防标记漏进历史污染下游)
  absorbDeepFlag(content: string): string {
    const cleaned = content.replace(/\n*\s*⟨deep⟩\s*/g, '').trim();
    if (/⟨deep⟩/.test(content) && this.stage === 'PLAN'
        && (this.mode === 'auto' || this.mode === 'autolow')) this.deep = true;
    return cleaned;
  }

  // 同上, 但扫思考流(reasoning_content): deepseek 思考完常直接发工具调用, 正文为空——
  // 复杂题的 ⟨deep⟩ 标记更可能出现在思考里而非正文(抛物线空回复案实测)
  absorbDeepFromReasoning(reasoning: string): string {
    const cleaned = reasoning.replace(/\n*\s*⟨deep⟩\s*/g, '').trim();
    if (/⟨deep⟩/.test(reasoning) && this.stage === 'PLAN'
        && (this.mode === 'auto' || this.mode === 'autolow')) this.deep = true;
    return cleaned;
  }

  // 本轮 chat 的 thinking 参数(向后兼容; 等价 planFor(当前阶段).thinking)
  thinkingFor(): ThinkingDecision {
    return this.planFor(this.stage).thinking;
  }

  // 阶段指令(注入本轮 system 后缀)
  // auto 与 autolow 同为三段式, 后缀一致; always/never 无阶段概念
  systemSuffix(): string | null {
    if (this.mode !== 'auto' && this.mode !== 'autolow') return null;
    if (this.stage === 'EXECUTE') return EXECUTE_SUFFIX;
    if (this.stage === 'RECOVER') return RECOVER_SUFFIX;
    if (this.stage === 'SOLVE') return SOLVE_SUFFIX;
    return DEEP_ASK_SUFFIX;                                 // PLAN: 复杂度自判指令
  }

  // SOLVE 轮(纯文本解答)结束: 引擎收到解答文本后调用, 进入执行段开始翻译成作图
  solveDone(): void {
    if (this.stage === 'SOLVE') this.stage = 'EXECUTE';
  }

  // PLAN 轮纯文本即宣告复杂(未调任何工具, observeRound 不会发生) → 直接切入 SOLVE。
  // 否则"本轮只列要点, 下一轮解题"的回复会被当成最终回复, 整个对话提前结束(实测踩坑)
  enterSolve(): void {
    if (this.stage === 'PLAN' && this.deep) this.stage = 'SOLVE';
  }

  // request_solve 工具调用(复杂度的主信号, 结构化可靠): 与 ⟨deep⟩ 标记同效。
  // 仅 PLAN 轮生效——与 absorbDeep* 的置位语义一致, 防后续轮误触发
  markDeep(): void {
    if (this.stage === 'PLAN' && (this.mode === 'auto' || this.mode === 'autolow')) this.deep = true;
  }

  // 工具跑完后回报本轮信号, 推进状态机(每轮 dispatchTool 全部结束后调用)
  observeRound(s: RoundSignal): void {
    if (s.inspectFailed) this.inspectFails++;
    if (s.inspectRan) this.inspectSeen = true;
    if (this.mode !== 'auto' && this.mode !== 'autolow') return;   // always/never: 状态机不推进
    const prev = this.lastSignal;                            // 上一轮信号(s = 刚结束的这轮)
    this.lastSignal = s;
    if (this.stage === 'RECOVER') { this.stage = 'EXECUTE'; return; }  // 恢复一轮即回执行
    if (this.shouldEscalate(s, prev)) this.escalate();
    // PLAN 轮观察后: 复杂题先进 SOLVE 专门解题(先解后画), 简单题直接执行
    else if (this.stage === 'PLAN') this.stage = this.deep ? 'SOLVE' : 'EXECUTE';
  }

  // 升级判定(spec §3.1 四触发 + ⑤ 空转): s=刚结束的这轮, prev=上一轮
  private shouldEscalate(s: RoundSignal, prev: RoundSignal | null): boolean {
    if (s.verifyFailed) return true;                          // ② verify 不达预期(单轮即触发)
    if (this.inspectFails >= 2) return true;                  // ③ 二次 inspect 仍有 issues
    if (s.execFailed && prev?.execFailed) return true;        // ① 连续 2 轮批失败
    if (s.execRan && s.createdLabels === 0
        && prev?.execRan && prev.createdLabels === 0) return true;   // ④ 连续 2 轮零新建空转
    if (s.idleRounds >= 3) return true;                       // ⑤ 连续 3 轮只感知不执行(关思考高发)
    return false;
  }

  private escalate(): void {
    if (this.recoveries >= RECOVERY_CAP) return;             // 达上限: 按现状 best-effort 收尾
    this.recoveries++;
    this.stage = 'RECOVER';
  }
}
