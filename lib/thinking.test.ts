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

describe('ThinkingController — SOLVE 先解后画(deep 触发)', () => {
  it('deep: PLAN 观察后落 SOLVE(全思考+解题后缀); solveDone 后进 EXECUTE(deep 全思考)', () => {
    const c = new ThinkingController('auto');
    c.absorbDeepFlag('要点清单\n⟨deep⟩');
    c.observeRound(sig());
    expect(c.currentStage).toBe('SOLVE');
    expect(c.planFor('SOLVE')).toEqual({ thinking: 'enabled' });
    expect(c.systemSuffix()).toMatch(/解题阶段/);
    c.solveDone();
    expect(c.currentStage).toBe('EXECUTE');
    expect(c.planFor('EXECUTE')).toEqual({ thinking: 'enabled' });   // deep 执行轮全思考
  });

  it('非 deep: PLAN 直接落 EXECUTE, 不经过 SOLVE(简单题不加解题轮)', () => {
    const c = new ThinkingController('auto');
    c.observeRound(sig());
    expect(c.currentStage).toBe('EXECUTE');
    expect(c.systemSuffix()).toMatch(/执行阶段/);
  });

  it('deep 从思考流置位(autolow)同样进 SOLVE; PLAN 后缀改写后仍含 ⟨deep⟩ 指令', () => {
    const c = new ThinkingController('autolow');
    expect(c.systemSuffix()).toMatch(/⟨deep⟩/);
    expect(c.systemSuffix()).toMatch(/不要展开解题推导/);
    c.absorbDeepFromReasoning('复杂轨迹题\n⟨deep⟩');
    c.observeRound(sig());
    expect(c.currentStage).toBe('SOLVE');
  });
});

describe('ThinkingController — 收尾修正轮关思考(inspect 已跑过)', () => {
  it('inspectRan 信号后: EXECUTE 关思考(即便 deep); RECOVER 仍全思考兜底, 回 EXECUTE 维持关', () => {
    const c = new ThinkingController('auto');
    c.absorbDeepFlag('⟨deep⟩');
    c.observeRound(sig());                                        // PLAN → SOLVE
    c.solveDone();                                                // → EXECUTE(deep 全思考)
    expect(c.planFor('EXECUTE')).toEqual({ thinking: 'enabled' });
    c.observeRound(sig({ execRan: true, createdLabels: 5 }));      // 构造轮
    expect(c.planFor('EXECUTE')).toEqual({ thinking: 'enabled' }); // deep 仍全思考
    c.observeRound(sig({ inspectRan: true }));                     // 核验跑过(通过与否都算收尾)
    expect(c.planFor('EXECUTE')).toEqual({ thinking: 'disabled' });
    c.observeRound(sig({ execRan: true, execFailed: true }));      // 微调失败第 1 次(不升级)
    expect(c.currentStage).toBe('EXECUTE');
    c.observeRound(sig({ execRan: true, execFailed: true }));      // 连续失败 → RECOVER
    expect(c.currentStage).toBe('RECOVER');
    expect(c.planFor('RECOVER')).toEqual({ thinking: 'enabled' }); // 安全阀
    c.observeRound(sig());                                         // 回 EXECUTE
    expect(c.planFor('EXECUTE')).toEqual({ thinking: 'disabled' }); // 收尾态维持
  });

  it('inspect 未跑过: deep EXECUTE 保持全思考(原行为不变)', () => {
    const c = new ThinkingController('auto');
    c.absorbDeepFlag('⟨deep⟩');
    c.observeRound(sig());
    c.solveDone();
    c.observeRound(sig({ execRan: true, createdLabels: 3 }));
    expect(c.planFor('EXECUTE')).toEqual({ thinking: 'enabled' });
  });

  it('inspectFailed 轮同样携带 inspectRan(引擎汇总处保证), 触发③不受影响', () => {
    const c = new ThinkingController('auto');
    c.observeRound(sig());
    c.observeRound(sig({ inspectFailed: true, inspectRan: true }));
    expect(c.planFor('EXECUTE')).toEqual({ thinking: 'disabled' });
    c.observeRound(sig({ inspectFailed: true, inspectRan: true })); // 第 2 次未过 → RECOVER
    expect(c.currentStage).toBe('RECOVER');
  });
});

describe('ThinkingController — enterSolve(PLAN 纯文本直接切 SOLVE)', () => {
  it('PLAN+deep 时切入 SOLVE; 非 deep 不动(防误触发)', () => {
    const c = new ThinkingController('auto');
    c.absorbDeepFlag('⟨deep⟩');
    c.enterSolve();
    expect(c.currentStage).toBe('SOLVE');
    expect(c.systemSuffix()).toMatch(/解题阶段/);
    const plain = new ThinkingController('auto');
    plain.enterSolve();
    expect(plain.currentStage).toBe('PLAN');
  });
});

describe('ThinkingController — markDeep(request_solve 工具信号)', () => {
  it('PLAN 轮 markDeep 与 ⟨deep⟩ 标记同效; 非 PLAN 轮或 always/never 档不置位', () => {
    const c = new ThinkingController('auto');
    c.markDeep();
    expect(c.isDeep).toBe(true);
    c.observeRound(sig());
    expect(c.currentStage).toBe('SOLVE');
    const late = new ThinkingController('auto');
    late.observeRound(sig());          // → EXECUTE
    late.markDeep();                    // 非 PLAN 轮: 不置位(与 absorb 语义一致)
    expect(late.isDeep).toBe(false);
    const nv = new ThinkingController('never');
    nv.markDeep();                      // never 档: 置位被档位守卫忽略
    expect(nv.isDeep).toBe(false);
  });
});
