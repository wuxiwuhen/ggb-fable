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
  calls: Array<{ messages: any[]; tools?: any[]; thinking?: string; reasoningEffort?: string }> = [];
  constructor(private script: AssistantMessage[]) {}
  async chat(p: any) {
    // messages 切片快照: 引擎的循环内压缩是原地 splice, 直接存引用会看到"最终状态"
    this.calls.push({ ...p, messages: p.messages.slice() });
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
  it('auto: 第 1 轮 enabled + ⟨deep⟩ 自判后缀; 第 2 轮 disabled 且 system 临时后缀, 历史不被污染', async () => {
    const backend = new ScriptBackend([execTurn(), finalTurn]);
    const engine = new AgentEngine(makeDeps());
    const r = await engine.run({
      userInput: '画个点', history: [],
      config: { max_tool_rounds: 5, thinking_mode: 'auto' }, backend: backend as any,
    });
    expect(backend.calls[0].thinking).toBe('enabled');
    expect(backend.calls[0].messages[0].content).toMatch(/^SYS/);        // PLAN 轮带自判后缀
    expect(backend.calls[0].messages[0].content).toContain('⟨deep⟩');
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

describe('AgentEngine — autolow 轻思考接线', () => {
  it('autolow: EXECUTE 轮收到 {thinking:"enabled", reasoningEffort:"low"}; auto: {thinking:"disabled"} 且无 effort', async () => {
    const bAuto = new ScriptBackend([execTurn(), execTurn(), finalTurn]);
    await new AgentEngine(makeDeps()).run({
      userInput: 'x', history: [], config: { max_tool_rounds: 6, thinking_mode: 'auto' }, backend: bAuto as any,
    });
    expect(bAuto.calls[0].thinking).toBe('enabled');           // PLAN
    expect(bAuto.calls[0].reasoningEffort).toBeUndefined();
    expect(bAuto.calls[1].thinking).toBe('disabled');          // EXECUTE(auto): 关思考
    expect(bAuto.calls[1].reasoningEffort).toBeUndefined();

    const bLow = new ScriptBackend([execTurn(), execTurn(), finalTurn]);
    await new AgentEngine(makeDeps()).run({
      userInput: 'x', history: [], config: { max_tool_rounds: 6, thinking_mode: 'autolow' }, backend: bLow as any,
    });
    expect(bLow.calls[0].thinking).toBe('enabled');            // PLAN 全思考
    expect(bLow.calls[0].reasoningEffort).toBeUndefined();
    expect(bLow.calls[1].thinking).toBe('enabled');            // EXECUTE(autolow): 轻思考
    expect(bLow.calls[1].reasoningEffort).toBe('low');
  });

  it('autolow: RECOVER 轮回到全思考(无 effort)', async () => {
    const deps = makeDeps({ execOk: false });                  // 连续批失败 → 触发①
    const backend = new ScriptBackend([execTurn('B1'), execTurn('B2'), finalTurn]);
    await new AgentEngine(deps).run({
      userInput: 'x', history: [], config: { max_tool_rounds: 6, thinking_mode: 'autolow' }, backend: backend as any,
    });
    expect(backend.calls[2].thinking).toBe('enabled');
    expect(backend.calls[2].reasoningEffort).toBeUndefined();
    expect(backend.calls[2].messages[0].content).toContain('恢复阶段');
  });

  it('assistant.reasoning_content 随历史 push 回传(下一轮 chat 的 messages 可见)', async () => {
    const rcTurn = { role: 'assistant' as const, content: '', reasoning_content: '我在想内切圆画法', tool_calls: [toolCall('execute_command', { command: 'A=(1,1)' })] };
    const backend = new ScriptBackend([rcTurn, finalTurn]);
    const engine = new AgentEngine(makeDeps());
    const r = await engine.run({
      userInput: 'x', history: [], config: { max_tool_rounds: 5, thinking_mode: 'autolow' }, backend: backend as any,
    });
    // 第 2 轮 chat 收到的历史里, assistant 消息仍带 reasoning_content
    const histAssistant = backend.calls[1].messages.find((m) => m.role === 'assistant');
    expect(histAssistant.reasoning_content).toBe('我在想内切圆画法');
    // 最终 messages 同样保留
    expect(r.messages.find((m) => m.role === 'assistant')?.reasoning_content).toBe('我在想内切圆画法');
  });
});

describe('AgentEngine — 循环内上下文压缩 + 预算收敛提示', () => {
  it('第 5 轮起, 旧于最近 3 轮的工具结果被占位符替换, 最近 3 轮原样', async () => {
    const backend = new ScriptBackend([execTurn('A1'), execTurn('A2'), execTurn('A3'), execTurn('A4'), execTurn('A5'), finalTurn]);
    await new AgentEngine(makeDeps()).run({
      userInput: '画图', history: [], config: { max_tool_rounds: 10, thinking_mode: 'never' }, backend: backend as any,
    });
    // 第 5 次 chat(第 5 轮) 时, 末轮压缩已把轮1 占位(4 块 → 保留 2/3/4)
    const tools5 = backend.calls[4].messages.filter((m: any) => m.role === 'tool');
    expect(tools5.length).toBe(4);
    expect(tools5[0].content).toContain('已省略');
    for (const t of tools5.slice(1)) expect(t.content).not.toContain('已省略');
    // 结构字段保留
    expect(tools5[0].tool_call_id).toBeTruthy();
    expect(tools5[0]._toolName).toBe('execute_command');
  });

  it('累计输入 ≥ 80K 时 system 临时后缀注入收敛指令, 且不污染 messages 历史', async () => {
    // 两轮各 ~41K(160K 字符): 第 1 轮未越线, 第 2 轮累计 ≥80K 注入提示(< 90K 硬顶, 循环继续)
    const backend = new ScriptBackend([execTurn(), finalTurn]);
    const r = await new AgentEngine(makeDeps()).run({
      userInput: 'x'.repeat(160000), history: [], config: { max_tool_rounds: 5, thinking_mode: 'never' }, backend: backend as any,
    });
    expect(backend.calls[0].messages[0].content).not.toContain('上下文预算提示');
    expect(backend.calls[1].messages[0].content).toContain('上下文预算提示');
    // 后缀是浅拷贝注入, 引擎内部历史(最终返回的 messages)不受污染
    expect(r.messages[0].content).toBe('SYS');
  });

  it('累计输入 ≥ 90K 时优雅收手: 不再发请求, finalText 带最近叙述+停止说明', async () => {
    const narrated = { role: 'assistant' as const, content: '正在画螺线', tool_calls: [toolCall('execute_command', { command: 'A=(1,1)' })] };
    const backend = new ScriptBackend([narrated, execTurn(), finalTurn]);
    const r = await new AgentEngine(makeDeps()).run({
      userInput: 'x'.repeat(340000), history: [], config: { max_tool_rounds: 5, thinking_mode: 'never' }, backend: backend as any,
    });
    expect(backend.calls.length).toBe(1);   // 第 2 轮累计 ≥90K, 循环在 chat 前收手
    expect(r.stopped).toBe(true);
    expect(r.finalText).toContain('正在画螺线');
    expect(r.finalText).toContain('预算上限');
  });

  it('短循环(≤3 轮)不触发压缩: 所有工具结果原样回传', async () => {
    const backend = new ScriptBackend([execTurn('A1'), execTurn('A2'), finalTurn]);
    await new AgentEngine(makeDeps()).run({
      userInput: '画图', history: [], config: { max_tool_rounds: 5, thinking_mode: 'never' }, backend: backend as any,
    });
    const tools = backend.calls[2].messages.filter((m: any) => m.role === 'tool');
    for (const t of tools) expect(t.content).not.toContain('已省略');
  });
});

describe('AgentEngine — 空转轮收敛提示', () => {
  const ctxTurn = () => ({ role: 'assistant' as const, content: '', tool_calls: [toolCall('get_canvas_context', {})] });

  it('连续 3 轮只感知不执行 → 第 4 轮 system 注入空转提醒; streak<3 不注入', async () => {
    const backend = new ScriptBackend([ctxTurn(), ctxTurn(), ctxTurn(), ctxTurn(), finalTurn]);
    await new AgentEngine(makeDeps()).run({
      userInput: 'x', history: [], config: { max_tool_rounds: 8, thinking_mode: 'never' }, backend: backend as any,
    });
    // 轮1-3 进入时 streak 分别为 0/1/2 → 无提醒; 轮4 进入时 streak=3 → 注入
    expect(backend.calls[0].messages[0].content).not.toContain('空转提醒');
    expect(backend.calls[2].messages[0].content).not.toContain('空转提醒');
    expect(backend.calls[3].messages[0].content).toContain('空转提醒');
  });

  it('execute_command 打断计数: 空转重新累计, 提醒不重复出现在 streak<3 的轮', async () => {
    const backend = new ScriptBackend([ctxTurn(), ctxTurn(), ctxTurn(), ctxTurn(), execTurn(), ctxTurn(), ctxTurn(), finalTurn]);
    await new AgentEngine(makeDeps()).run({
      userInput: 'x', history: [], config: { max_tool_rounds: 10, thinking_mode: 'never' }, backend: backend as any,
    });
    // 轮4 注入(streak=3), 轮5 执行命令归零, 轮6/7(streak=1/2)不再注入
    expect(backend.calls[3].messages[0].content).toContain('空转提醒');
    expect(backend.calls[5].messages[0].content).not.toContain('空转提醒');
    expect(backend.calls[6].messages[0].content).not.toContain('空转提醒');
  });
});

describe('AgentEngine — BYOK 预算放宽', () => {
  it('input_budget_tokens 覆盖默认 90K 硬停: 同样输入不再中途收手', async () => {
    const narrated = { role: 'assistant' as const, content: '正在画', tool_calls: [toolCall('execute_command', { command: 'A=(1,1)' })] };
    const backend = new ScriptBackend([narrated, execTurn(), finalTurn]);
    const r = await new AgentEngine(makeDeps()).run({
      // 每轮 ~85K: 默认 90K 会在第 2 轮前收手; 放宽到 400K 后 3 轮全部发出并正常完结
      userInput: 'x'.repeat(340000), history: [],
      config: { max_tool_rounds: 5, thinking_mode: 'never', input_budget_tokens: 400000 },
      backend: backend as any,
    });
    expect(backend.calls.length).toBe(3);
    expect(r.stopped).toBe(false);
    expect(r.finalText).toBe('做好了');
  });

  it('80% 收敛提示随自定义预算缩放(400K 预算 → 320K 触发), 不再用固定 80K', async () => {
    const narrated = () => ({ role: 'assistant' as const, content: '', tool_calls: [toolCall('execute_command', { command: 'A=(1,1)' })] });
    const backend = new ScriptBackend([narrated(), narrated(), narrated(), finalTurn]);
    await new AgentEngine(makeDeps()).run({
      // 累计: 轮1 85K, 轮2 170K, 轮3 255K, 轮4 340K ≥ 320K → 轮4 注入预算提示(< 400K 不收手)
      userInput: 'x'.repeat(340000), history: [],
      config: { max_tool_rounds: 6, thinking_mode: 'never', input_budget_tokens: 400000 },
      backend: backend as any,
    });
    expect(backend.calls[2].messages[0].content).not.toContain('上下文预算提示');
    expect(backend.calls[3].messages[0].content).toContain('上下文预算提示');
  });

  it('input_budget_tokens 支持函数: trial 路由预算首轮响应头才知, 每轮重新解析(未知时走默认 90K)', async () => {
    const narrated = () => ({ role: 'assistant' as const, content: '', tool_calls: [toolCall('execute_command', { command: 'A=(1,1)' })] });
    // 每轮 ~28K(用户输入 100K 字符≈25K + system/tools), 4 轮累计 > 90K:
    // 第 1 次解析返回 undefined(默认 90K), 之后放宽 400K → 不得在 90K 误停
    let reads = 0;
    const budgetFn = () => (++reads <= 1 ? undefined : 400000);
    const backend = new ScriptBackend([narrated(), narrated(), narrated(), narrated(), finalTurn]);
    const r = await new AgentEngine(makeDeps()).run({
      userInput: 'x'.repeat(100000), history: [],
      config: { max_tool_rounds: 8, thinking_mode: 'never', input_budget_tokens: budgetFn },
      backend: backend as any,
    });
    expect(backend.calls.length).toBe(5);       // 跑满 5 轮, 没被默认 90K 掐断
    expect(r.stopped).toBe(false);
    expect(r.finalText).toBe('做好了');
  });
});

describe('AgentEngine — ⟨deep⟩ 复杂度自判接线(先解后画)', () => {
  it('PLAN 回复带 ⟨deep⟩ → 标记清除; 先进 SOLVE 解题轮(无工具/全思考/解题后缀), 后续 EXECUTE 升全思考', async () => {
    const deepPlan = { role: 'assistant' as const, content: '构造要点: 分段。\n⟨deep⟩', tool_calls: [toolCall('execute_command', { command: 'A=(1,1)' })] };
    const solution = { role: 'assistant' as const, content: '完整解答：第一问 A(1,0)；第二问② 最小值 7/2。', tool_calls: undefined };
    const backend = new ScriptBackend([deepPlan, solution, execTurn(), finalTurn]);
    const r = await new AgentEngine(makeDeps()).run({
      userInput: '画复杂立体图', history: [],
      config: { max_tool_rounds: 6, thinking_mode: 'auto' }, backend: backend as any,
    });
    expect(backend.calls[1].thinking).toBe('enabled');                  // SOLVE 全思考
    expect(backend.calls[1].tools).toBeUndefined();                     // 解题轮不下发工具定义
    expect(backend.calls[1].messages[0].content).toContain('解题阶段');  // SOLVE 后缀
    expect(backend.calls[2].thinking).toBe('enabled');                  // deep EXECUTE 不再关思考
    // 解答入历史, 续作指令注入其后(解答 assistant 与 ack user 相邻有序)
    const iSol = r.messages.findIndex((m: any) => m.role === 'assistant' && /完整解答/.test(m.content || ''));
    const iAck = r.messages.findIndex((m: any) => m.role === 'user' && /解答已收到/.test(m.content || ''));
    expect(iAck).toBeGreaterThan(iSol);
    // 标记已清除: 历史与最终消息都看不到 ⟨deep⟩
    expect(backend.calls[1].messages.some((m: any) => (m.content || '').includes('⟨deep⟩'))).toBe(false);
    expect(r.messages.some((m: any) => (m.content || '').includes('⟨deep⟩'))).toBe(false);
    expect(r.finalText).toBe('做好了');
  });

  it('SOLVE 轮模型幻觉出 tool_calls → 被丢弃按解答文本处理, 不执行不卡死', async () => {
    const deepPlan = { role: 'assistant' as const, content: '要点\n⟨deep⟩', tool_calls: [toolCall('search_command', { query: 'x' })] };
    const hallucinated = { role: 'assistant' as const, content: '解答全文如下。', tool_calls: [toolCall('execute_command', { command: 'B=(2,2)' })] };
    const backend = new ScriptBackend([deepPlan, hallucinated, execTurn(), finalTurn]);
    const r = await new AgentEngine(makeDeps()).run({
      userInput: 'x', history: [],
      config: { max_tool_rounds: 6, thinking_mode: 'auto' }, backend: backend as any,
    });
    expect(r.toolHistory.filter((t) => t.name === 'execute_command')).toHaveLength(1);  // 幻觉调用未执行
    expect(r.finalText).toBe('做好了');
  });

  it('SOLVE 轮空文本 → 抛空回复错误(可重试), 不无声结束', async () => {
    const deepPlan = { role: 'assistant' as const, content: '要点\n⟨deep⟩', tool_calls: [toolCall('search_command', { query: 'x' })] };
    const empty = { role: 'assistant' as const, content: '', tool_calls: undefined, finish_reason: 'length' };
    const backend = new ScriptBackend([deepPlan, empty]);
    await expect(new AgentEngine(makeDeps()).run({
      userInput: 'x', history: [],
      config: { max_tool_rounds: 5, thinking_mode: 'auto' }, backend: backend as any,
    })).rejects.toThrow(/空回复.*解题阶段/);
  });

  it('PLAN 回复无标记 → EXECUTE 维持关思考(简单题快)', async () => {
    const backend = new ScriptBackend([execTurn(), finalTurn]);
    await new AgentEngine(makeDeps()).run({
      userInput: '画个点', history: [],
      config: { max_tool_rounds: 5, thinking_mode: 'auto' }, backend: backend as any,
    });
    expect(backend.calls[1].thinking).toBe('disabled');
  });
});

describe('AgentEngine — 空回复护栏', () => {
  it('content 空 + 无 tool_calls + 全程零工具 → 抛错(思考耗尽输出上限的截断, 不再无声空白结束)', async () => {
    const empty = { role: 'assistant' as const, content: '', tool_calls: undefined };
    const backend = new ScriptBackend([empty]);
    await expect(new AgentEngine(makeDeps()).run({
      userInput: '画图', history: [],
      config: { max_tool_rounds: 5, thinking_mode: 'auto' }, backend: backend as any,
    })).rejects.toThrow(/空回复/);
  });

  it('跑过工具后最终轮 content 空 → 兜底占位文案, 不抛错(画布已有成果)', async () => {
    const empty = { role: 'assistant' as const, content: '', tool_calls: undefined };
    const backend = new ScriptBackend([execTurn('A=(1,1)'), empty]);
    const r = await new AgentEngine(makeDeps()).run({
      userInput: '画图', history: [],
      config: { max_tool_rounds: 5, thinking_mode: 'auto' }, backend: backend as any,
    });
    expect(r.finalText).toContain('画布已保留');
    expect(r.stopped).toBe(false);
  });
});

describe('AgentEngine — 视觉核验开关', () => {
  it("vision_verify='off': inspect_render 从工具列表移除(模型无法调用), 其余工具保留", async () => {
    const backend = new ScriptBackend([finalTurn]);
    await new AgentEngine(makeDeps()).run({
      userInput: 'x', history: [],
      config: { max_tool_rounds: 5, thinking_mode: 'never', vision_verify: 'off' },
      backend: backend as any,
    });
    const names = backend.calls[0]!.tools!.map((t: any) => t.name);
    expect(names).not.toContain('inspect_render');
    expect(names).toContain('execute_command');
    expect(names).toContain('get_canvas_context');
  });

  it("vision_verify='auto'(默认/未设置): inspect_render 保留", async () => {
    const backend = new ScriptBackend([finalTurn]);
    await new AgentEngine(makeDeps()).run({
      userInput: 'x', history: [],
      config: { max_tool_rounds: 5, thinking_mode: 'never' },
      backend: backend as any,
    });
    expect(backend.calls[0]!.tools!.map((t: any) => t.name)).toContain('inspect_render');
  });
});

describe('AgentEngine — 收尾修正轮关思考(inspect 之后)', () => {
  const inspectTurn = { role: 'assistant' as const, content: '', tool_calls: [toolCall('inspect_render', { focus: '轨迹' })] };
  it('inspect_render 跑过后: 后续轮 thinking=disabled(deep 也关); 修正失败升级 RECOVER 时恢复全思考兜底', async () => {
    // deep + inspect 后微调: R0 PLAN(deep 标记) → R1 SOLVE → R2 构造 → R3 核验 → R4 微调(关思考) → R5 最终(关思考)
    const deepPlan = { role: 'assistant' as const, content: '要点\n⟨deep⟩', tool_calls: [toolCall('search_command', { query: 'x' })] };
    const solution = { role: 'assistant' as const, content: '完整解答: 略。', tool_calls: undefined };
    const backend = new ScriptBackend([deepPlan, solution, execTurn(), inspectTurn, execTurn('SetCaption(A,"P")'), finalTurn]);
    const r = await new AgentEngine(makeDeps()).run({
      userInput: 'x', history: [],
      config: { max_tool_rounds: 10, thinking_mode: 'auto' }, backend: backend as any,
    });
    expect(backend.calls[2].thinking).toBe('enabled');   // deep EXECUTE 构造轮: 全思考
    expect(backend.calls[3].thinking).toBe('enabled');   // 核验轮(构造后): deep 仍全思考
    expect(backend.calls[4].thinking).toBe('disabled');  // inspect 已跑过 → 收尾微调关思考
    expect(backend.calls[5].thinking).toBe('disabled');  // 最终回复轮同样收尾态
    expect(r.finalText).toBe('做好了');
  });

  it('微调连续失败 → RECOVER 恢复全思考(安全阀), 回 EXECUTE 后仍收尾关思考', async () => {
    const backend = new ScriptBackend([execTurn(), inspectTurn, execTurn('Bad1'), execTurn('Bad2'), finalTurn]);
    const engine = new AgentEngine(makeDeps({ execOk: false, labels: '' }));
    await engine.run({
      userInput: 'x', history: [],
      config: { max_tool_rounds: 10, thinking_mode: 'auto' }, backend: backend as any,
    });
    expect(backend.calls[3].thinking).toBe('disabled');  // 第一次失败(尚不升级)
    expect(backend.calls[4].thinking).toBe('enabled');   // 连续失败 → RECOVER 全思考
  });
});

describe('AgentEngine — PLAN 轮纯文本不提前结束', () => {
  it('PLAN 轮纯文本+⟨deep⟩(未调任何工具) → 不作为最终回复: 注入解题指令直接进 SOLVE, 后续照常', async () => {
    const planText = { role: 'assistant' as const, content: '本题涉及角度最值与多对象联动约束，属复杂题，本轮先列要点。\n⟨deep⟩', tool_calls: undefined };
    const solution = { role: 'assistant' as const, content: '完整解答：第一问 45°；第二问 定值 2。', tool_calls: undefined };
    const backend = new ScriptBackend([planText, solution, execTurn(), finalTurn]);
    const r = await new AgentEngine(makeDeps()).run({
      userInput: 'x', history: [],
      config: { max_tool_rounds: 6, thinking_mode: 'auto' }, backend: backend as any,
    });
    expect(backend.calls.length).toBe(4);                              // 没有在第 1 轮提前结束
    expect(backend.calls[1].tools).toBeUndefined();                    // SOLVE 轮无工具
    expect(backend.calls[1].messages[0].content).toContain('解题阶段');
    expect(backend.calls[1].messages.at(-1).content).toContain('开始解题');  // 解题触发指令已注入
    expect(backend.calls[2].thinking).toBe('enabled');                 // deep 执行轮全思考
    expect(r.finalText).toBe('做好了');
  });

  it('PLAN 轮纯文本但无 ⟨deep⟩ → 仍按最终回复正常结束(简单题直答不受影响)', async () => {
    const planText = { role: 'assistant' as const, content: '这是一道简单题的直答。', tool_calls: undefined };
    const backend = new ScriptBackend([planText]);
    const r = await new AgentEngine(makeDeps()).run({
      userInput: 'x', history: [],
      config: { max_tool_rounds: 5, thinking_mode: 'auto' }, backend: backend as any,
    });
    expect(backend.calls.length).toBe(1);
    expect(r.finalText).toBe('这是一道简单题的直答。');
  });
});

describe('AgentEngine — request_solve 工具为主复杂度信号', () => {
  it('规划轮调用 request_solve(不带 ⟨deep⟩ 标记) → 照样进 SOLVE; 工具结果可读', async () => {
    const solveReq = { role: 'assistant' as const, content: '要点: 三对象联动。', tool_calls: [toolCall('request_solve', {})] };
    const solution = { role: 'assistant' as const, content: '完整解答：略。', tool_calls: undefined };
    const backend = new ScriptBackend([solveReq, solution, execTurn(), finalTurn]);
    const r = await new AgentEngine(makeDeps()).run({
      userInput: 'x', history: [],
      config: { max_tool_rounds: 6, thinking_mode: 'auto' }, backend: backend as any,
    });
    expect(backend.calls[1].tools).toBeUndefined();                    // SOLVE 轮
    expect(backend.calls[1].messages[0].content).toContain('解题阶段');
    expect(backend.calls[2].thinking).toBe('enabled');                 // deep 执行轮
    const req = r.messages.find((m: any) => m._toolName === 'request_solve');
    expect(JSON.parse(req.content).granted).toBe(true);
    expect(r.finalText).toBe('做好了');
  });

  it('request_solve 与其他工具同轮混用: 感知照常执行, 仍进 SOLVE', async () => {
    const mixed = { role: 'assistant' as const, content: '', tool_calls: [toolCall('set_perspective', { view: 'AG' }), toolCall('request_solve', {})] };
    const solution = { role: 'assistant' as const, content: '完整解答：略。', tool_calls: undefined };
    const backend = new ScriptBackend([mixed, solution, execTurn(), finalTurn]);
    await new AgentEngine(makeDeps()).run({
      userInput: 'x', history: [],
      config: { max_tool_rounds: 6, thinking_mode: 'auto' }, backend: backend as any,
    });
    expect(backend.calls[1].messages[0].content).toContain('解题阶段');
  });
});
