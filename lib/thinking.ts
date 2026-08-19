// 三段式思考策略状态机(spec: docs/superpowers/specs/2026-08-19-speed-optimization-design.md §3.1)
// 纯逻辑无 IO: 引擎每轮 chat 前调 thinkingFor()/systemSuffix(), 工具跑完后调 observeRound() 回报信号。
//   PLAN(第 1 轮, 思考开) → EXECUTE(思考关) --触发--> RECOVER(思考开, 上限 2) --一轮--> EXECUTE
// thinking_mode: auto=三段式(默认) / always=全程思考(v1 基线语义) / never=全程关(fast 臂)。

export type ThinkingMode = 'auto' | 'always' | 'never';
export type ThinkingDecision = 'enabled' | 'disabled';
export type Stage = 'PLAN' | 'EXECUTE' | 'RECOVER';

// 一轮工具执行后的信号(由引擎从工具结果汇总, 全部来自现有结果字段)
export interface RoundSignal {
  execRan: boolean;        // 本轮调用过 execute_command
  execFailed: boolean;     // 本轮 ≥1 批次 failedCount > 0
  createdLabels: number;   // 本轮 execute_command 新建标签总数
  verifyFailed: boolean;   // 本轮 ≥1 verify_geometry 结果 ok === false
  inspectFailed: boolean;  // 本轮 ≥1 inspect_render 结果 passed === false
}

export const EMPTY_SIGNAL: RoundSignal = {
  execRan: false, execFailed: false, createdLabels: 0, verifyFailed: false, inspectFailed: false,
};

export const EXECUTE_SUFFIX = '【执行阶段】按既定规划继续执行, 不要重新整体规划; 剩余构造优先批量提交(一次 execute_command 传多条)。';
export const RECOVER_SUFFIX = '【恢复阶段】刚才的执行出现失败或空转。先从 failures 与画布上下文定位根因, 只修正被点名的问题后继续按既定规划执行, 不要从零重画。';

const RECOVERY_CAP = 2;

export class ThinkingController {
  private stage: Stage = 'PLAN';
  private recoveries = 0;
  private lastSignal: RoundSignal | null = null;   // 上一轮信号(observeRound 时作为 prev)
  private inspectFails = 0;

  constructor(private mode: ThinkingMode = 'auto') {}

  get currentStage(): Stage { return this.stage; }
  get recoveryCount(): number { return this.recoveries; }

  // 本轮 chat 的 thinking 参数(每轮 backend.chat 之前调用)
  thinkingFor(): ThinkingDecision {
    if (this.mode === 'always') return 'enabled';
    if (this.mode === 'never') return 'disabled';
    return this.stage === 'PLAN' || this.stage === 'RECOVER' ? 'enabled' : 'disabled';
  }

  // 阶段指令(注入本轮 system 后缀; PLAN 轮与 v2 prompt 规划要求重复, 不注入)
  systemSuffix(): string | null {
    if (this.mode !== 'auto') return null;
    if (this.stage === 'EXECUTE') return EXECUTE_SUFFIX;
    if (this.stage === 'RECOVER') return RECOVER_SUFFIX;
    return null;
  }

  // 工具跑完后回报本轮信号, 推进状态机(每轮 dispatchTool 全部结束后调用)
  observeRound(s: RoundSignal): void {
    if (s.inspectFailed) this.inspectFails++;
    if (this.mode !== 'auto') return;                        // always/never: 状态机不推进
    const prev = this.lastSignal;                            // 上一轮信号(s = 刚结束的这轮)
    this.lastSignal = s;
    if (this.stage === 'RECOVER') { this.stage = 'EXECUTE'; return; }  // 恢复一轮即回执行
    if (this.shouldEscalate(s, prev)) this.escalate();
    else if (this.stage === 'PLAN') this.stage = 'EXECUTE';  // 第 1 轮观察后即进入执行段
  }

  // 升级判定(spec §3.1 四触发): s=刚结束的这轮, prev=上一轮
  private shouldEscalate(s: RoundSignal, prev: RoundSignal | null): boolean {
    if (s.verifyFailed) return true;                          // ② verify 不达预期(单轮即触发)
    if (this.inspectFails >= 2) return true;                  // ③ 二次 inspect 仍有 issues
    if (s.execFailed && prev?.execFailed) return true;        // ① 连续 2 轮批失败
    if (s.execRan && s.createdLabels === 0
        && prev?.execRan && prev.createdLabels === 0) return true;   // ④ 连续 2 轮零新建空转
    return false;
  }

  private escalate(): void {
    if (this.recoveries >= RECOVERY_CAP) return;             // 达上限: 按现状 best-effort 收尾
    this.recoveries++;
    this.stage = 'RECOVER';
  }
}
