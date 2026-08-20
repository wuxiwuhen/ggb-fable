// rebuildHistory 截断口径: 超长回复不能全量进 agent 上下文(会撑爆每轮输入头部)
import { describe, it, expect } from 'vitest';
import { rebuildHistory, rebuildChatMessages } from './conversation';

const msg = (role: string, content: string) => ({ role, content, tool_name: null, tool_args: null, tool_result: null, round: null });

describe('rebuildHistory — 单条 800 字截断', () => {
  it('超长 assistant 回复截到 800 字', () => {
    const h = rebuildHistory([msg('user', '画图'), msg('assistant', 'x'.repeat(12000))]);
    expect(h).toHaveLength(2);
    expect(h[1].content.length).toBe(800);
  });

  it('短文本原样保留', () => {
    const h = rebuildHistory([msg('user', '画图'), msg('assistant', '好的')]);
    expect(h[1].content).toBe('好的');
  });
});

describe('rebuildChatMessages — 只取非空文本行', () => {
  it('空 content 行(如出错兜底行)被过滤, tool 行不进对话', () => {
    const out = rebuildChatMessages([
      msg('user', 'hi'), msg('assistant', ''), msg('tool', '...') as any, msg('assistant', 'done'),
    ]);
    expect(out).toEqual([{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'done' }]);
  });
});
