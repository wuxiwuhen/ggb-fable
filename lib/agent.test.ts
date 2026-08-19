// 引擎三段式接入: 用脚本化假 backend + 假 deps 驱动 run(), 验证逐轮 thinking/后缀/信号升级
import { describe, it, expect } from 'vitest';
import { AgentEngine, type AgentBackend, type AssistantMessage } from './agent';

// —— 假 deps: 只实现 dispatchTool 会碰到的最小面 ——
const makeDeps = (over: { execOk?: boolean; labels?: string } = {}) => {
  const execRow = (line: string) => ({
    cmd: line,
    ok: over.execOk !== false,
    labels: over.execOk !== false ? (over.labels ?? 'A') : '',
    error: over.execOk !== false ? '' : '命令未定义',
  });
  return {
    ggb: {
      getCanvasContext: async () => ({ elementCount: 0, elements: [] }),
      execBatch: async (t: string) => t.split('\n').filter(Boolean).map(execRow),
      measure: async () => ({ ok: true, value: '1', numeric: 1 }),
      getPNGBase64: () => 'data:image/png;base64,AAA',
      clearAll: async () => {},
      getAPI: () => ({}),
    },
    commandSearch: { search: async () => [], format: () => '' },
    logger: { toolCall: () => {}, turnEnd: () => {} },
    systemPrompt: 'SYS',
  } as any;
};

// 脚本化 backend: 依次吐出预设 assistant 消息, 记录每次 chat 的入参
class ScriptBackend implements AgentBackend {
  calls: Array<{ messages: any[]; thinking?: string }> = [];
  constructor(private script: AssistantMessage[]) {}
  async chat(p: any) {
    this.calls.push(p);
    p.onThinking?.('思考增量');   // 模拟上游思考流, 验证引擎把它透传给 hooks
    const next = this.script.shift();
    return next ?? { role: 'assistant' as const, content: '完成', tool_calls: undefined };
  }
  async vision() { return '验收通过'; }
  visionReady() { return true; }
}

const toolCall = (name: string, args: object) => ({
  id: `c_${name}_${Math.random()}`, type: 'function' as const,
  function: { name, arguments: JSON.stringify(args) },
});
const execTurn = (cmd = 'A=(1,1)') => ({ role: 'assistant' as const, content: '', tool_calls: [toolCall('execute_command', { command: cmd })] });
const finalTurn = { role: 'assistant' as const, content: '做好了', tool_calls: undefined };

describe('AgentEngine — 三段式思考策略', () => {
  it('auto: 第 1 轮 enabled 无后缀; 第 2 轮 disabled 且 system 临时后缀, 历史不被污染', async () => {
    const backend = new ScriptBackend([execTurn(), finalTurn]);
    const engine = new AgentEngine(makeDeps());
    const r = await engine.run({
      userInput: '画个点', history: [],
      config: { max_tool_rounds: 5, thinking_mode: 'auto' }, backend: backend as any,
    });
    expect(backend.calls[0].thinking).toBe('enabled');
    expect(backend.calls[0].messages[0].content).toBe('SYS');            // PLAN 轮无后缀
    expect(backend.calls[1].thinking).toBe('disabled');
    expect(backend.calls[1].messages[0].content).toContain('执行阶段');   // EXECUTE 轮后缀
    expect(r.messages[0].content).toBe('SYS');                            // 会话历史不残留后缀
    expect(r.finalText).toBe('做好了');
  });

  it('触发①: 连续 2 轮批失败 → 第 3 轮 RECOVER(enabled + 恢复后缀)', async () => {
    const deps = makeDeps({ execOk: false });
    const backend = new ScriptBackend([execTurn('Bad1'), execTurn('Bad2'), finalTurn]);
    const engine = new AgentEngine(deps);
    await engine.run({
      userInput: 'x', history: [],
      config: { max_tool_rounds: 6, thinking_mode: 'auto' }, backend: backend as any,
    });
    expect(backend.calls[2].thinking).toBe('enabled');
    expect(backend.calls[2].messages[0].content).toContain('恢复阶段');
  });

  it('触发④: 连续 2 轮零新建 → RECOVER', async () => {
    const deps = makeDeps({ execOk: true, labels: '' });   // 执行 ok 但 createdLabels 空
    const backend = new ScriptBackend([execTurn(), execTurn(), finalTurn]);
    const engine = new AgentEngine(deps);
    await engine.run({
      userInput: 'x', history: [],
      config: { max_tool_rounds: 6, thinking_mode: 'auto' }, backend: backend as any,
    });
    expect(backend.calls[2].thinking).toBe('enabled');
  });

  it('thinking_mode always/never 全程覆盖状态机', async () => {
    const bAlways = new ScriptBackend([execTurn(), execTurn(), finalTurn]);
    await new AgentEngine(makeDeps()).run({
      userInput: 'x', history: [], config: { max_tool_rounds: 6, thinking_mode: 'always' }, backend: bAlways as any,
    });
    expect(bAlways.calls.every((c) => c.thinking === 'enabled')).toBe(true);

    const bNever = new ScriptBackend([execTurn(), finalTurn]);
    await new AgentEngine(makeDeps()).run({
      userInput: 'x', history: [], config: { max_tool_rounds: 6, thinking_mode: 'never' }, backend: bNever as any,
    });
    expect(bNever.calls.every((c) => c.thinking === 'disabled')).toBe(true);
  });

  it('onThinking/onStage hooks 透传; tool 结果仍以 JSON 字符串入 messages', async () => {
    const backend = new ScriptBackend([execTurn(), finalTurn]);
    const stages: string[] = [];
    const thoughts: string[] = [];
    const engine = new AgentEngine(makeDeps());
    const r = await engine.run({
      userInput: 'x', history: [],
      config: { max_tool_rounds: 5, thinking_mode: 'auto' }, backend: backend as any,
      hooks: {
        onThinking: (t) => thoughts.push(t),
        onStage: (s) => stages.push(s),
      },
    });
    expect(thoughts.length).toBe(2);          // 每轮 chat 各一次(脚本 backend 主动调用)
    expect(stages[0]).toBe('PLAN');
    expect(stages[1]).toBe('EXECUTE');
    const toolMsg = r.messages.find((m) => m.role === 'tool');
    expect(typeof toolMsg.content).toBe('string');
    expect(JSON.parse(toolMsg.content).ok).toBe(true);
  });
});
