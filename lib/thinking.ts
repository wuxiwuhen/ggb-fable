// 三段式思考策略状态机(spec: docs/superpowers/specs/2026-08-19-speed-optimization-design.md §3.1)
// 纯逻辑无 IO: 引擎每轮 chat 前调 planFor(stage)/systemSuffix(), 工具跑完后调 observeRound() 回报信号。
//   PLAN(第 1 轮, 思考开) → EXECUTE(思考关) --触发--> RECOVER(思考开, 上限 2) --一轮--> EXECUTE
// thinking_mode: auto=三段式(默认) / autolow=三段式但 EXECUTE 轻思考(enabled+reasoning_effort:low)
//                / always=全程思考(v1 基线语义) / never=全程关(fast 臂)。

export type ThinkingMode = 'auto' | 'autolow' | 'always' | 'never';
export type ThinkingDecision = 'enabled' | 'disabled';
export type ReasoningEffort = 'low' | 'medium' | 'high';
export type Stage = 'PLAN' | 'EXECUTE' | 'RECOVER';

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
  idleRounds: number;      // 连续"只感知不执行"轮数(含本轮; execute 打断即归零)
}

export const EMPTY_SIGNAL: RoundSignal = {
  execRan: false, execFailed: false, createdLabels: 0, verifyFailed: false, inspectFailed: false, idleRounds: 0,
};

export const EXECUTE_SUFFIX = '【执行阶段】按既定规划继续执行, 不要重新整体规划; 剩余构造优先批量提交(一次 execute_command 传多条)。';
export const RECOVER_SUFFIX = '【恢复阶段】刚才的执行出现失败或空转。先从 failures 与画布上下文定位根因, 只修正被点名的问题后继续按既定规划执行, 不要从零重画。';
// PLAN 轮复杂度自判: 复杂题让模型自己标记, 引擎据此把执行轮也切回思考
// (关思考时复杂题的推导无处安放, 会溢出到正文——实测"重新生成"把 1 万字推导写进循环叙述)
export const DEEP_ASK_SUFFIX = '【复杂度自判】完成规划后判断本题复杂度：若涉及立体几何、轨迹/最值/定值、多对象联动约束、或需要长推导，在你本轮回复的最末尾另起一行输出 ⟨deep⟩；简单题或微调不要输出该标记。';

const RECOVERY_CAP = 2;

export class ThinkingController {
  private stage: Stage = 'PLAN';
  private recoveries = 0;
  private lastSignal: RoundSignal | null = null;   // 上一轮信号(observeRound 时作为 prev)
  private inspectFails = 0;
  private deep = false;                             // PLAN 轮自判为复杂题: EXECUTE 也开思考

  constructor(private mode: ThinkingMode = 'auto') {}

  get currentStage(): Stage { return this.stage; }
  get recoveryCount(): number { return this.recoveries; }
  get isDeep(): boolean { return this.deep; }

  // 指定阶段的思考配置(每轮 backend.chat 之前调 planFor(currentStage))
  planFor(stage: Stage): StagePlan {
    if (this.mode === 'always') return { thinking: 'enabled' };
    if (this.mode === 'never') return { thinking: 'disabled' };
    if (stage === 'EXECUTE') {
      // 复杂题(deep): 执行轮升全思考(autolow 的 low 也升)——推导进思考空间, 不溢出正文
      if (this.deep) return { thinking: 'enabled' };
      // auto: EXECUTE 关思考; autolow: EXECUTE 轻思考(保留思考但压低力度)
      return this.mode === 'autolow'
        ? { thinking: 'enabled', reasoningEffort: 'low' }
        : { thinking: 'disabled' };
    }
    return { thinking: 'enabled' };                          // PLAN / RECOVER 全思考
  }

  // 吸收 assistant 回复中的 ⟨deep⟩ 标记: 返回清除后的文本。
  // PLAN 阶段(auto/autolow)命中 → 置 deep; 其余阶段/档位只清除不置位(防标记漏进历史污染下游)
  absorbDeepFlag(content: string): string {
    const cleaned = content.replace(/\n*\s*⟨deep⟩\s*/g, '').trim();
    if (cleaned !== content && this.stage === 'PLAN'
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
    return DEEP_ASK_SUFFIX;                                 // PLAN: 复杂度自判指令
  }

  // 工具跑完后回报本轮信号, 推进状态机(每轮 dispatchTool 全部结束后调用)
  observeRound(s: RoundSignal): void {
    if (s.inspectFailed) this.inspectFails++;
    if (this.mode !== 'auto' && this.mode !== 'autolow') return;   // always/never: 状态机不推进
    const prev = this.lastSignal;                            // 上一轮信号(s = 刚结束的这轮)
    this.lastSignal = s;
    if (this.stage === 'RECOVER') { this.stage = 'EXECUTE'; return; }  // 恢复一轮即回执行
    if (this.shouldEscalate(s, prev)) this.escalate();
    else if (this.stage === 'PLAN') this.stage = 'EXECUTE';  // 第 1 轮观察后即进入执行段
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
