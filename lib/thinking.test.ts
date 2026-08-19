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

  it('阶段后缀: EXECUTE 注入执行指令, PLAN 不注入', () => {
    const c = new ThinkingController('auto');
    expect(c.systemSuffix()).toBeNull();                       // PLAN 轮: v2 prompt 已含规划要求
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
