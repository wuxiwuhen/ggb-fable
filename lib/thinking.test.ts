import { describe, it, expect } from 'vitest';
import { ThinkingController, EMPTY_SIGNAL } from './thinking';

// 便捷构造: 部分覆盖 EMPTY_SIGNAL
const sig = (o: Partial<typeof EMPTY_SIGNAL> = {}) => ({ ...EMPTY_SIGNAL, ...o });

describe('ThinkingController — auto 默认三段式', () => {
  it('第 1 轮 PLAN 思考开; 观察后落 EXECUTE 思考关', () => {
    const c = new ThinkingController('auto');
    expect(c.currentStage).toBe('PLAN');
    expect(c.thinkingFor()).toBe('enabled');
    c.observeRound(sig());
    expect(c.currentStage).toBe('EXECUTE');
    expect(c.thinkingFor()).toBe('disabled');
  });

  it('触发①: 连续 2 轮批失败 → RECOVER 思考开; 恢复一轮后回 EXECUTE', () => {
    const c = new ThinkingController('auto');
    c.observeRound(sig());                                     // PLAN → EXECUTE
    c.observeRound(sig({ execRan: true, execFailed: true }));  // 第 1 次失败, 不触发
    expect(c.currentStage).toBe('EXECUTE');
    c.observeRound(sig({ execRan: true, execFailed: true }));  // 连续第 2 次 → RECOVER
    expect(c.currentStage).toBe('RECOVER');
    expect(c.thinkingFor()).toBe('enabled');
    expect(c.systemSuffix()).toMatch(/恢复阶段/);
    c.observeRound(sig());                                     // RECOVER 一轮后回 EXECUTE
    expect(c.currentStage).toBe('EXECUTE');
    expect(c.thinkingFor()).toBe('disabled');
  });

  it('触发②: verify 失败立即 RECOVER(无需连续)', () => {
    const c = new ThinkingController('auto');
    c.observeRound(sig({ verifyFailed: true }));
    expect(c.currentStage).toBe('RECOVER');
  });

  it('触发③: 第 2 次 inspect 未过 → RECOVER(第 1 次不触发)', () => {
    const c = new ThinkingController('auto');
    c.observeRound(sig({ inspectFailed: true }));
    expect(c.currentStage).toBe('EXECUTE');
    c.observeRound(sig({ inspectFailed: true }));
    expect(c.currentStage).toBe('RECOVER');
  });

  it('触发④: 连续 2 轮 execute 零新建空转 → RECOVER', () => {
    const c = new ThinkingController('auto');
    c.observeRound(sig());
    c.observeRound(sig({ execRan: true, createdLabels: 0 }));
    expect(c.currentStage).toBe('EXECUTE');
    c.observeRound(sig({ execRan: true, createdLabels: 0 }));
    expect(c.currentStage).toBe('RECOVER');
  });

  it('恢复上限 2 次: 达上限后触发不再进 RECOVER(best-effort 继续)', () => {
    const c = new ThinkingController('auto');
    c.observeRound(sig());                                     // → EXECUTE
    c.observeRound(sig({ verifyFailed: true }));               // RECOVER #1
    c.observeRound(sig());                                     // → EXECUTE
    c.observeRound(sig({ verifyFailed: true }));               // RECOVER #2
    expect(c.recoveryCount).toBe(2);
    c.observeRound(sig());                                     // → EXECUTE
    c.observeRound(sig({ verifyFailed: true }));               // 已达上限, 不再升级
    expect(c.currentStage).toBe('EXECUTE');
    expect(c.recoveryCount).toBe(2);
  });

  it('阶段后缀: EXECUTE 注入执行指令, PLAN 注入 ⟨deep⟩ 自判指令', () => {
    const c = new ThinkingController('auto');
    expect(c.systemSuffix()).toMatch(/⟨deep⟩/);
    c.observeRound(sig());
    expect(c.systemSuffix()).toMatch(/执行阶段/);
    expect(c.systemSuffix()).toMatch(/批量提交/);
  });
});

describe('ThinkingController — always / never 覆盖', () => {
  it('always: 恒 enabled, 不注入阶段后缀, 不因信号改阶段', () => {
    const c = new ThinkingController('always');
    c.observeRound(sig({ verifyFailed: true, execFailed: true }));
    expect(c.thinkingFor()).toBe('enabled');
    expect(c.systemSuffix()).toBeNull();
    expect(c.currentStage).toBe('PLAN');                       // 状态机不推进(无意义)
  });

  it('never: 恒 disabled', () => {
    const c = new ThinkingController('never');
    expect(c.thinkingFor()).toBe('disabled');
    c.observeRound(sig({ verifyFailed: true }));
    expect(c.thinkingFor()).toBe('disabled');
  });

  it('缺省构造 = auto', () => {
    expect(new ThinkingController().thinkingFor()).toBe('enabled');
  });
});

describe('ThinkingController — autolow 轻思考档(PLAN 全思考/EXECUTE 轻思考/RECOVER 全思考)', () => {
  it('planFor: PLAN 与 RECOVER 全思考(无 effort); EXECUTE enabled+low', () => {
    const c = new ThinkingController('autolow');
    expect(c.planFor('PLAN')).toEqual({ thinking: 'enabled' });
    expect(c.planFor('EXECUTE')).toEqual({ thinking: 'enabled', reasoningEffort: 'low' });
    expect(c.planFor('RECOVER')).toEqual({ thinking: 'enabled' });
  });

  it('状态机照常推进: PLAN 观察后落 EXECUTE(轻思考), 触发②后 RECOVER(全思考), 恢复一轮回 EXECUTE', () => {
    const c = new ThinkingController('autolow');
    expect(c.planFor(c.currentStage)).toEqual({ thinking: 'enabled' });           // PLAN
    c.observeRound(sig());
    expect(c.currentStage).toBe('EXECUTE');
    expect(c.planFor(c.currentStage)).toEqual({ thinking: 'enabled', reasoningEffort: 'low' });
    c.observeRound(sig({ verifyFailed: true }));
    expect(c.currentStage).toBe('RECOVER');
    expect(c.planFor(c.currentStage)).toEqual({ thinking: 'enabled' });           // RECOVER 无 effort
    c.observeRound(sig());
    expect(c.currentStage).toBe('EXECUTE');
    expect(c.planFor(c.currentStage)).toEqual({ thinking: 'enabled', reasoningEffort: 'low' });
  });

  it('阶段后缀与 auto 同: EXECUTE 注入执行指令, PLAN 注入 ⟨deep⟩ 自判', () => {
    const c = new ThinkingController('autolow');
    expect(c.systemSuffix()).toMatch(/⟨deep⟩/);
    c.observeRound(sig());
    expect(c.systemSuffix()).toMatch(/执行阶段/);
    expect(c.systemSuffix()).toMatch(/恢复阶段|批量提交/);
  });
});

describe('planFor — 各档位对照', () => {
  it('auto: EXECUTE 关思考且无 effort; always/never 任意阶段恒定', () => {
    expect(new ThinkingController('auto').planFor('EXECUTE')).toEqual({ thinking: 'disabled' });
    expect(new ThinkingController('auto').planFor('RECOVER')).toEqual({ thinking: 'enabled' });
    const always = new ThinkingController('always');
    for (const s of ['PLAN', 'EXECUTE', 'RECOVER'] as const) {
      expect(always.planFor(s)).toEqual({ thinking: 'enabled' });
    }
    const never = new ThinkingController('never');
    for (const s of ['PLAN', 'EXECUTE', 'RECOVER'] as const) {
      expect(never.planFor(s)).toEqual({ thinking: 'disabled' });
    }
  });
});

describe('ThinkingController — ⟨deep⟩ 复杂度自判', () => {
  it('PLAN 轮后缀含 ⟨deep⟩ 自判指令; EXECUTE/RECOVER 不含', () => {
    const c = new ThinkingController('auto');
    expect(c.systemSuffix()).toMatch(/⟨deep⟩/);
    c.observeRound(sig());
    expect(c.systemSuffix()).not.toMatch(/⟨deep⟩/);
  });

  it('absorbDeepFlag: PLAN 轮命中标记 → 清除标记并置 deep, EXECUTE 升全思考(无 effort)', () => {
    const c = new ThinkingController('auto');
    const cleaned = c.absorbDeepFlag('规划如下。\n⟨deep⟩\n');
    expect(cleaned).toBe('规划如下。');
    expect(c.isDeep).toBe(true);
    c.observeRound(sig());
    expect(c.planFor('EXECUTE')).toEqual({ thinking: 'enabled' });   // 不带 low effort
  });

  it('absorbDeepFlag: 非 PLAN 阶段只清除标记不置 deep; 无标记原样返回', () => {
    const c = new ThinkingController('auto');
    c.observeRound(sig());                                    // → EXECUTE
    expect(c.absorbDeepFlag('继续 ⟨deep⟩')).toBe('继续');
    expect(c.isDeep).toBe(false);
    expect(c.absorbDeepFlag('普通叙述')).toBe('普通叙述');
  });

  it('deep + autolow: EXECUTE 从轻思考升为全思考(复杂题不省这点力度)', () => {
    const c = new ThinkingController('autolow');
    c.absorbDeepFlag('规划\n⟨deep⟩');
    c.observeRound(sig());
    expect(c.planFor('EXECUTE')).toEqual({ thinking: 'enabled' });
  });

  it('absorbDeepFromReasoning: 思考流里出现 ⟨deep⟩ 也置位(deepseek 思考完直接发工具, 正文可能为空)', () => {
    const c = new ThinkingController('auto');
    const rc = c.absorbDeepFromReasoning('分析: 这是轨迹定值问题, 复杂。\n⟨deep⟩');
    expect(rc).not.toContain('⟨deep⟩');
    expect(c.isDeep).toBe(true);
    c.observeRound(sig());
    expect(c.planFor('EXECUTE')).toEqual({ thinking: 'enabled' });
  });

  it('always/never: 不注入自判指令, 标记只被清除', () => {
    const never = new ThinkingController('never');
    expect(never.systemSuffix()).toBeNull();
    expect(never.absorbDeepFlag('x\n⟨deep⟩')).toBe('x');
    expect(never.isDeep).toBe(false);
    expect(new ThinkingController('always').systemSuffix()).toBeNull();
  });
});

describe('ThinkingController — 触发⑤ 空转升级', () => {
  it('连续 3 轮只感知不执行(idleRounds>=3) → RECOVER 思考开', () => {
    const c = new ThinkingController('auto');
    c.observeRound(sig({ idleRounds: 1 }));
    c.observeRound(sig({ idleRounds: 2 }));
    expect(c.currentStage).toBe('EXECUTE');
    c.observeRound(sig({ idleRounds: 3 }));
    expect(c.currentStage).toBe('RECOVER');
    expect(c.thinkingFor()).toBe('enabled');
  });

  it('execute 打断后 idleRounds 重新累计, 不误触发', () => {
    const c = new ThinkingController('auto');
    c.observeRound(sig({ idleRounds: 1 }));
    c.observeRound(sig({ idleRounds: 2 }));
    c.observeRound(sig({ execRan: true, idleRounds: 0 }));   // 执行打断
    c.observeRound(sig({ idleRounds: 1 }));
    expect(c.currentStage).toBe('EXECUTE');
  });
});
