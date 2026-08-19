import { describe, it, expect, vi } from 'vitest';
import { logTurnInterrupt } from './turn-interrupt';

// 会话缺 assistant 消息 bug 的回归测试:
// catch 的错误分支(TRIAL_EXHAUSTED / 上游 4xx 5xx)只 setError 不落 turn_end,
// user_input 行存在而 turn_end 行缺失 → 切换会话后只剩用户气泡。
// 不变量: 每种中断都要补 errorEvent + turn_end(stopped)。

function spyLogger() {
  return { errorEvent: vi.fn(), turnEnd: vi.fn() };
}

describe('logTurnInterrupt — 中断轮补记 turn_end', () => {
  const err = new Error('AI 服务暂时不可用');

  it('真错误且无流式文本: 兜底"（出错）", 与 live 气泡文案一致', () => {
    const logger = spyLogger();
    logTurnInterrupt(logger, 'turn_error', err, { finalText: '', toolCount: 3 });
    expect(logger.errorEvent).toHaveBeenCalledWith('turn_error', err);
    expect(logger.turnEnd).toHaveBeenCalledWith({ finalText: '（出错）', toolCount: 3, stopped: true });
  });

  it('真错误但有部分流式文本: 保留原文', () => {
    const logger = spyLogger();
    logTurnInterrupt(logger, 'turn_error', err, { finalText: '已画出三角形', toolCount: 5 });
    expect(logger.turnEnd).toHaveBeenCalledWith({ finalText: '已画出三角形', toolCount: 5, stopped: true });
  });

  it('额度耗尽: 同样补记且空文本兜底', () => {
    const logger = spyLogger();
    logTurnInterrupt(logger, 'trial_exhausted', new Error('TRIAL_EXHAUSTED'), { finalText: '', toolCount: 0 });
    expect(logger.errorEvent).toHaveBeenCalledWith('trial_exhausted', expect.any(Error));
    expect(logger.turnEnd).toHaveBeenCalledWith({ finalText: '（出错）', toolCount: 0, stopped: true });
  });

  it('用户主动停止: 不兜底(空文本合法, live 侧移除空气泡), where=user_stop', () => {
    const logger = spyLogger();
    logTurnInterrupt(logger, 'user_stop', err, { finalText: '', toolCount: 2 });
    expect(logger.errorEvent).toHaveBeenCalledWith('user_stop', err);
    expect(logger.turnEnd).toHaveBeenCalledWith({ finalText: '', toolCount: 2, stopped: true });
  });

  it('用户主动停止且有部分文本: 保留原文', () => {
    const logger = spyLogger();
    logTurnInterrupt(logger, 'user_stop', err, { finalText: '画到一半', toolCount: 4 });
    expect(logger.turnEnd).toHaveBeenCalledWith({ finalText: '画到一半', toolCount: 4, stopped: true });
  });

  it('每种中断只补一次 errorEvent 和一次 turnEnd', () => {
    const logger = spyLogger();
    logTurnInterrupt(logger, 'turn_error', err, { finalText: '', toolCount: 1 });
    expect(logger.errorEvent).toHaveBeenCalledTimes(1);
    expect(logger.turnEnd).toHaveBeenCalledTimes(1);
  });
});
