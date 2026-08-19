// llm thinking 透传 + SSE reasoning_content 捕获(不发真实请求, fetch 全部打桩)
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { chatByok, chatTrial, thinkingFromBody } from './llm';

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
  it('思考增量走 onThinking, 不混入 content', async () => {
    fetchMock.mockResolvedValue(sseResp([
      { reasoning_content: '先想' }, { reasoning_content: '清楚' }, { content: '答案' },
    ]));
    const thoughts: string[] = [];
    const r = await chatByok({
      messages: [{ role: 'user', content: 'hi' }], config: cfg,
      onThinking: (d) => thoughts.push(d),
    });
    expect(thoughts.join('')).toBe('先想清楚');
    expect(r.content).toBe('答案');          // reasoning 不进 content/历史
  });

  it('无 onThinking 回调时 reasoning_content 被安全丢弃', async () => {
    fetchMock.mockResolvedValue(sseResp([{ reasoning_content: 'x' }, { content: 'y' }]));
    const r = await chatByok({ messages: [{ role: 'user', content: 'hi' }], config: cfg });
    expect(r.content).toBe('y');
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
