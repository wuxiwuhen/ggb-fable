import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Logger } from './logger';

// 「切换会话后 AI 回复消失」根因之一: 组件重挂载后新 Logger 未回绑(sessionId=''),
// 事件被 groupBySession 静默丢弃 → 运行成功但零落库。
// 本文件锁住 ChatApp 回绑 effect 依赖的语义: getSessionId 判空 + 绑定后才发 append。

describe('Logger 会话绑定', () => {
  beforeEach(() => { vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true })); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('新实例未绑定: getSessionId 返回空串', () => {
    expect(new Logger().getSessionId()).toBe('');
  });

  it('setSession 后可读回(回绑路径)', () => {
    const l = new Logger();
    l.setSession('s1');
    expect(l.getSessionId()).toBe('s1');
  });

  it('未绑定时事件被丢弃, 不发任何 append', async () => {
    const l = new Logger();
    l.userTurn('你好');
    await l.flush();
    expect((fetch as any).mock.calls.length).toBe(0);
  });

  it('绑定后事件按 sessionId 发 append', async () => {
    const l = new Logger();
    l.setSession('s1');
    l.userTurn('你好');
    await l.flush();
    expect((fetch as any).mock.calls.length).toBe(1);
    const body = JSON.parse((fetch as any).mock.calls[0][1].body);
    expect(body.action).toBe('append');
    expect(body.sessionId).toBe('s1');
    expect(body.events[0].type).toBe('user_input');
  });
});
