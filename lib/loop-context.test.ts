// 循环内上下文压缩 + 共享输入 token 估算
// 背景: 工具循环每轮全量重发 messages, 输入随轮数二次膨胀, 触发 trial 路由
// "本次请求上下文过大" 429 与 deepseek 64K 单轮窗口。经典套路: 头部保留(系统+目标),
// 尾部保留(最近几轮), 中间轮的工具结果换占位符; 不做 LLM compact(吃自己预算, YAGNI)。
import { describe, it, expect } from 'vitest';
import { estimateInputTokens, compactLoopHistory, BUDGET_HINT_TOKENS } from './loop-context';

// —— 构造助手/工具消息的最小面 ——
const asst = (content = '') => ({ role: 'assistant' as const, content, tool_calls: undefined });
const asstTool = (content = '') => ({
  role: 'assistant' as const, content,
  tool_calls: [{ id: `c_${Math.random()}`, type: 'function' as const, function: { name: 'execute_command', arguments: '{}' } }],
});
const toolMsg = (name: string, content: object|string) => ({
  role: 'tool' as const, tool_call_id: `t_${name}_${Math.random()}`, _toolName: name,
  content: typeof content === 'string' ? content : JSON.stringify(content),
});

describe('estimateInputTokens — 与 trial 路由一致的粗估', () => {
  it('消息内容按 4 字符 1 token 向上取整', () => {
    expect(estimateInputTokens({ messages: [{ role: 'user', content: 'x'.repeat(8) }] })).toBe(2);
    expect(estimateInputTokens({ messages: [{ role: 'user', content: 'x'.repeat(9) }] })).toBe(3);
  });

  it('计入 tool_calls 与 tools 定义的 JSON 长度', () => {
    const withCalls = estimateInputTokens({
      messages: [{ role: 'assistant', content: '', tool_calls: [{ function: { name: 'f', arguments: '{"a":1}' } }] }],
    });
    const without = estimateInputTokens({ messages: [{ role: 'assistant', content: '' }] });
    expect(withCalls).toBeGreaterThan(without);
    const tools = estimateInputTokens({ messages: [{ role: 'user', content: '' }], tools: [{ type: 'function', function: { name: 't' } }] });
    expect(tools).toBeGreaterThan(0);
  });

  it('空入参返回 0', () => {
    expect(estimateInputTokens({})).toBe(0);
  });
});

describe('compactLoopHistory — 头保留/尾保留/中间占位', () => {
  const head: any[] = [
    { role: 'system', content: 'SYS' },
    { role: 'user', content: '旧轮次' }, asst('旧回复'),
    { role: 'user', content: '画个复杂的图' },
  ];
  // 6 个工具轮块, 每块 = 1 条 assistant(tool_calls) + 1~2 条 tool 消息
  const rounds: any[] = [
    [asstTool('轮1'), toolMsg('get_canvas_context', { elementCount: 3, elements: [{ label: 'A', definition: 'x'.repeat(400) }] })],
    [asstTool('轮2'), toolMsg('search_command', { hits: [{ cmd: 'Polygon', doc: 'y'.repeat(300) }] })],
    [asstTool('轮3'), toolMsg('execute_command', { rows: [{ cmd: 'A=(1,1)', ok: true }] })],
    [asstTool('轮4'), toolMsg('execute_command', { rows: [{ cmd: 'B=(2,2)', ok: true }], extra: 'z'.repeat(500) })],
    [asstTool('轮5'), toolMsg('get_canvas_context', { elementCount: 9, elements: [] })],
    [asstTool('轮6'), toolMsg('execute_command', { rows: [{ cmd: 'C=(3,3)', ok: true }] })],
  ];
  const msgs = () => [...head, ...rounds.flat()];

  it('头部(系统+跨轮历史+当前目标)与最近 3 轮原样保留', () => {
    const out = compactLoopHistory(msgs());
    // 头部逐条深相等
    expect(out.slice(0, 4)).toEqual(head);
    // 尾部 3 轮(轮4/5/6, 即最后 6 条)原样
    const tail = out.slice(-6);
    expect(tail).toEqual(rounds.slice(3).flat());
  });

  it('中间轮工具结果按工具名换占位符; 中间 assistant 叙述换短占位, 结构保留', () => {
    const out = compactLoopHistory(msgs());
    // 轮1: get_canvas_context 占位
    expect(out[5]._toolName).toBe('get_canvas_context');
    expect(out[5].content).toContain('历史画布快照已省略');
    // 轮2: search_command 占位
    expect(out[7].content).toContain('历史命令检索结果已省略');
    // 轮3: 其他工具默认占位
    expect(out[9].content).toContain('历史工具结果已省略');
    // 中间 assistant: content 换占位(长叙述是膨胀主力), tool_calls 原样保留(配对必需)
    expect(out[4].content).toContain('中间轮叙述已省略');
    expect(out[4].tool_calls).toEqual(rounds[0][0].tool_calls);
    expect(out[6].content).toContain('中间轮叙述已省略');
  });

  it('占位后保留 role/tool_call_id/_toolName(结构不变)', () => {
    const src = msgs();
    const out = compactLoopHistory(src);
    for (let i = 5; i <= 9; i += 2) {
      expect(out[i].role).toBe('tool');
      expect(out[i].tool_call_id).toBe(src[i].tool_call_id);
      expect(out[i]._toolName).toBe(src[i]._toolName);
    }
  });

  it('幂等: 二次压缩不改变任何内容', () => {
    const once = compactLoopHistory(msgs());
    const twice = compactLoopHistory(once);
    expect(twice).toEqual(once);
  });

  it('轮块数 ≤ keepRounds 时原样返回(同一引用)', () => {
    const src = [...head, ...rounds.slice(0, 3).flat()];
    expect(compactLoopHistory(src)).toBe(src);
  });
});

describe('BUDGET_HINT_TOKENS — 收敛提示阈值', () => {
  it('为 100K 预算的 80%', () => {
    expect(BUDGET_HINT_TOKENS).toBe(80000);
  });
});
