// llm thinking 透传 + SSE reasoning_content 捕获(不发真实请求, fetch 全部打桩)
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { chatByok, chatTrial, thinkingFromBody, reasoningEffortFromBody } from './llm';

const fetchMock = vi.fn();
beforeEach(() => { fetchMock.mockReset(); vi.stubGlobal('fetch', fetchMock); });

// SSE 响应: chunks 为 delta 对象数组, 逐个包成 data: 行
const sseResp = (deltas: any[], status = 200) => {
  const body = deltas.map((d) => `data: ${JSON.stringify({ choices: [{ delta: d }] })}`).join('\n\n')
    + '\n\ndata: [DONE]\n\n';
  return new Response(body, { status });
};
const cfg = { api_key: 'test-key', base_url: 'https://api.example.com/v1', model_name: 'test-model' };
const bodyOf = (call: number) => JSON.parse(fetchMock.mock.calls[call][1].body);

describe('chatByok — thinking 字段', () => {
  it('显式传 thinking → 请求体携带 {type}; 未传 → 不携带(厂商默认, 兼容非 deepseek 端点)', async () => {
    fetchMock.mockResolvedValue(sseResp([{ content: 'ok' }]));
    await chatByok({ messages: [{ role: 'user', content: 'hi' }], config: cfg, thinking: 'disabled' });
    expect(bodyOf(0).thinking).toEqual({ type: 'disabled' });

    fetchMock.mockReset();
    fetchMock.mockResolvedValue(sseResp([{ content: 'ok' }]));
    await chatByok({ messages: [{ role: 'user', content: 'hi' }], config: cfg });
    expect(bodyOf(0).thinking).toBeUndefined();
  });

  it('端点 400 且带了 thinking → 去掉该字段重试一次', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response('unknown field: thinking', { status: 400 }))
      .mockResolvedValueOnce(sseResp([{ content: 'ok' }]));
    const r = await chatByok({ messages: [{ role: 'user', content: 'hi' }], config: cfg, thinking: 'disabled' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(bodyOf(0).thinking).toEqual({ type: 'disabled' });
    expect(bodyOf(1).thinking).toBeUndefined();
    expect(r.content).toBe('ok');
  });
});

describe('parseSSE — reasoning_content 捕获(经 chatByok 驱动)', () => {
  it('思考增量既流给 onThinking 又累积到返回值.reasoning_content, 不混入 content', async () => {
    fetchMock.mockResolvedValue(sseResp([
      { reasoning_content: '先想' }, { reasoning_content: '清楚' }, { content: '答案' },
    ]));
    const thoughts: string[] = [];
    const r = await chatByok({
      messages: [{ role: 'user', content: 'hi' }], config: cfg,
      onThinking: (d) => thoughts.push(d),
    });
    expect(thoughts.join('')).toBe('先想清楚');
    expect(r.content).toBe('答案');          // reasoning 不进 content
    expect(r.reasoning_content).toBe('先想清楚');   // 但保留在返回消息上(供历史回传)
  });

  it('无思考增量时返回值不带 reasoning_content 键', async () => {
    fetchMock.mockResolvedValue(sseResp([{ content: 'y' }]));
    const r = await chatByok({ messages: [{ role: 'user', content: 'hi' }], config: cfg });
    expect(r.content).toBe('y');
    expect(r.reasoning_content).toBeUndefined();
  });

  it('历史 assistant.reasoning_content 恒回传(Step 0 探针: disabled/enabled 均接受, 不过滤)', async () => {
    fetchMock.mockResolvedValue(sseResp([{ content: 'ok' }]));
    const histMsgs = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: '', reasoning_content: '上一轮思考', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'execute_command', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'c1', content: '{"ok":true}' },
    ];
    await chatByok({ messages: histMsgs, config: cfg, thinking: 'disabled' });
    expect(bodyOf(0).messages[1].reasoning_content).toBe('上一轮思考');
    // 兜底重试(400-strip)后的请求体: 历史消息照旧(仍含 reasoning_content)
    fetchMock.mockReset();
    fetchMock
      .mockResolvedValueOnce(new Response('unknown field: thinking', { status: 400 }))
      .mockResolvedValueOnce(sseResp([{ content: 'ok' }]));
    await chatByok({ messages: histMsgs, config: cfg, thinking: 'disabled' });
    expect(bodyOf(1).messages[1].reasoning_content).toBe('上一轮思考');
  });
});

describe('chatByok — reasoningEffort 透传', () => {
  it('显式传 → 请求体携带 reasoning_effort; 未传 → 不携带', async () => {
    fetchMock.mockResolvedValue(sseResp([{ content: 'ok' }]));
    await chatByok({ messages: [{ role: 'user', content: 'hi' }], config: cfg, thinking: 'enabled', reasoningEffort: 'low' });
    expect(bodyOf(0).reasoning_effort).toBe('low');

    fetchMock.mockReset();
    fetchMock.mockResolvedValue(sseResp([{ content: 'ok' }]));
    await chatByok({ messages: [{ role: 'user', content: 'hi' }], config: cfg, thinking: 'enabled' });
    expect(bodyOf(0).reasoning_effort).toBeUndefined();
  });

  it('端点 400 → 兜底重试一并剥离 thinking 与 reasoning_effort', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response('unknown field', { status: 400 }))
      .mockResolvedValueOnce(sseResp([{ content: 'ok' }]));
    const r = await chatByok({
      messages: [{ role: 'user', content: 'hi' }], config: cfg,
      thinking: 'enabled', reasoningEffort: 'low',
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(bodyOf(0).thinking).toEqual({ type: 'enabled' });
    expect(bodyOf(0).reasoning_effort).toBe('low');
    expect(bodyOf(1).thinking).toBeUndefined();
    expect(bodyOf(1).reasoning_effort).toBeUndefined();
    expect(r.content).toBe('ok');
  });
});

describe('chatTrial — thinking 透传到代理请求体', () => {
  // trial 响应体须是合法 SSE(空 body 会让 parseSSE 拿不到终止信号); token 头按真实路由回传
  const trialResp = () => new Response('data: [DONE]\n\n', { status: 200, headers: { 'x-trial-token': 't1' } });
  it('携带 {type} 与 trial_token; 未传则无 thinking 键', async () => {
    fetchMock.mockResolvedValue(trialResp());
    await chatTrial({
      messages: [{ role: 'user', content: 'hi' }],
      trialCtx: { token: null, setToken: () => {} },
      thinking: 'enabled',
    });
    expect(bodyOf(0).thinking).toEqual({ type: 'enabled' });
    expect(bodyOf(0).trial_token).toBeNull();

    fetchMock.mockReset();
    fetchMock.mockResolvedValue(trialResp());
    await chatTrial({ messages: [{ role: 'user', content: 'hi' }], trialCtx: { token: 't0', setToken: () => {} } });
    expect(bodyOf(0).thinking).toBeUndefined();
  });

  it('reasoningEffort 同模式透传; 未传不携带', async () => {
    fetchMock.mockResolvedValue(trialResp());
    await chatTrial({
      messages: [{ role: 'user', content: 'hi' }],
      trialCtx: { token: null, setToken: () => {} },
      thinking: 'enabled', reasoningEffort: 'low',
    });
    expect(bodyOf(0).reasoning_effort).toBe('low');

    fetchMock.mockReset();
    fetchMock.mockResolvedValue(trialResp());
    await chatTrial({ messages: [{ role: 'user', content: 'hi' }], trialCtx: { token: null, setToken: () => {} } });
    expect(bodyOf(0).reasoning_effort).toBeUndefined();
  });

  it('max_tokens 按思考分档: 开思考 32768(推理不吃正文池), 关思考 8192(trial/byok 同)', async () => {
    fetchMock.mockResolvedValue(trialResp());
    await chatTrial({
      messages: [{ role: 'user', content: 'hi' }], trialCtx: { token: null, setToken: () => {} },
      thinking: 'enabled',
    });
    expect(bodyOf(0).max_tokens).toBe(32768);

    fetchMock.mockReset();
    fetchMock.mockResolvedValue(trialResp());
    await chatTrial({
      messages: [{ role: 'user', content: 'hi' }], trialCtx: { token: null, setToken: () => {} },
      thinking: 'disabled',
    });
    expect(bodyOf(0).max_tokens).toBe(8192);

    fetchMock.mockReset();
    fetchMock.mockResolvedValue(sseResp([{ content: 'ok' }]));
    await chatByok({ messages: [{ role: 'user', content: 'hi' }], config: cfg, thinking: 'enabled' });
    expect(bodyOf(0).max_tokens).toBe(32768);

    fetchMock.mockReset();
    fetchMock.mockResolvedValue(sseResp([{ content: 'ok' }]));
    await chatByok({ messages: [{ role: 'user', content: 'hi' }], config: cfg });
    expect(bodyOf(0).max_tokens).toBe(8192);
  });

  it('byok 400 兜底重试: 除剥离 thinking/effort 外, max_tokens 同步降回 8192(兼容上限低的厂商)', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response('max_tokens too large', { status: 400 }))
      .mockResolvedValueOnce(sseResp([{ content: 'ok' }]));
    await chatByok({ messages: [{ role: 'user', content: 'hi' }], config: cfg, thinking: 'enabled' });
    expect(bodyOf(0).max_tokens).toBe(32768);
    expect(bodyOf(1).max_tokens).toBe(8192);
  });
});

describe('withRcPlaceholders — 零思考轮占位回传(trial 400 根因修复)', () => {
  // 复现: 低 effort 轮偶发零思考 → parseSSE 不落 rc → 下一轮 enabled 请求被 deepseek 400
  const trialResp = () => new Response('data: [DONE]\n\n', { status: 200, headers: { 'x-trial-token': 't1' } });
  const tcMsg = (rc?: string) => ({
    role: 'assistant', content: '', ...(rc ? { reasoning_content: rc } : {}),
    tool_calls: [{ id: 'c1', type: 'function', function: { name: 'execute_command', arguments: '{}' } }],
  });

  it('tool_calls 无 rc → 请求体合成占位符(byok/trial 同逻辑); 已有 rc 不覆盖; 纯文本无 tool_calls 不动', async () => {
    const msgs = [
      { role: 'user', content: 'hi' },
      tcMsg(),                       // 零思考轮
      tcMsg('真思考内容'),             // 正常轮
      { role: 'tool', tool_call_id: 'c1', content: '{"ok":true}' },
      { role: 'assistant', content: '上一轮最终文本' },  // 纯文本(探针: 无 rc 亦 200)
    ];
    fetchMock.mockResolvedValue(sseResp([{ content: 'ok' }]));
    await chatByok({ messages: msgs, config: cfg, thinking: 'enabled' });
    expect(bodyOf(0).messages[1].reasoning_content).toBe('(no reasoning)');
    expect(bodyOf(0).messages[2].reasoning_content).toBe('真思考内容');
    expect(bodyOf(0).messages[4].reasoning_content).toBeUndefined();

    fetchMock.mockReset();
    fetchMock.mockResolvedValue(trialResp());
    await chatTrial({ messages: msgs, trialCtx: { token: null, setToken: () => {} }, thinking: 'enabled', reasoningEffort: 'low' });
    expect(bodyOf(0).messages[1].reasoning_content).toBe('(no reasoning)');
  });

  it('thinking disabled 请求同样带占位符(恒回传策略, 端点均接受)', async () => {
    fetchMock.mockResolvedValue(sseResp([{ content: 'ok' }]));
    await chatByok({ messages: [{ role: 'user', content: 'hi' }, tcMsg()], config: cfg, thinking: 'disabled' });
    expect(bodyOf(0).messages[1].reasoning_content).toBe('(no reasoning)');
  });
});

describe('thinkingFromBody — 路由侧白名单', () => {
  it('仅 enabled/disabled 放行, 其余丢弃', () => {
    expect(thinkingFromBody({ thinking: { type: 'enabled' } })).toEqual({ type: 'enabled' });
    expect(thinkingFromBody({ thinking: { type: 'disabled' } })).toEqual({ type: 'disabled' });
    expect(thinkingFromBody({ thinking: { type: 'fast' } })).toBeNull();
    expect(thinkingFromBody({})).toBeNull();
    expect(thinkingFromBody(null)).toBeNull();
  });
});

describe('reasoningEffortFromBody — 路由侧白名单', () => {
  it('仅 low/medium/high 放行, 其余丢弃', () => {
    expect(reasoningEffortFromBody({ reasoning_effort: 'low' })).toBe('low');
    expect(reasoningEffortFromBody({ reasoning_effort: 'medium' })).toBe('medium');
    expect(reasoningEffortFromBody({ reasoning_effort: 'high' })).toBe('high');
    expect(reasoningEffortFromBody({ reasoning_effort: 'minimal' })).toBeNull();
    expect(reasoningEffortFromBody({})).toBeNull();
    expect(reasoningEffortFromBody(null)).toBeNull();
  });
});
