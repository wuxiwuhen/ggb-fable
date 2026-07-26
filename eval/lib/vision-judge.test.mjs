import { test } from 'node:test';
import assert from 'node:assert/strict';
import { judgeSingle, judgePaired, DEFAULT_RUBRIC } from './vision-judge.mjs';

const glm = { api_key: 'k', base_url: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4.6v' };
const ctx = { problem: '过圆外一点作切线', key_insight: '切线⊥半径' };

function mockFetch(respText) {
  global.fetch = async () => ({
    ok: true,
    json: async () => ({ choices: [{ message: { content: respText } }] }),
  });
}

test('judgeSingle 解析"验收通过/无问题"为全 ok', async () => {
  mockFetch('验收通过');
  const r = await judgeSingle({ png: 'data:image/png;base64,AAA', rubric: DEFAULT_RUBRIC, ctx, glm });
  assert.ok(r.items.every((i) => i.ok));
  assert.equal(r.issues.length, 0);
});

test('judgeSingle 解析"问题:" 行为 issue + 对应项 false', async () => {
  mockFetch('问题: 辅助线该虚线却实线\n问题: 角弧>180°');
  const r = await judgeSingle({ png: 'data:image/png;base64,AAA', rubric: DEFAULT_RUBRIC, ctx, glm });
  assert.ok(r.issues.length === 2);
  assert.ok(r.items.some((i) => !i.ok));
});

test('judgePaired 解析偏好 A/B/tie', async () => {
  mockFetch('偏好: A\n问题A: 标签遮挡');
  const r = await judgePaired({ pngA: 'data:image/png;base64,A', pngB: 'data:image/png;base64,B', rubric: DEFAULT_RUBRIC, ctx, glm });
  assert.equal(r.preference, 'A');
});

test('callGlmVision 请求体含 image_url content 数组', async () => {
  let captured;
  global.fetch = async (_url, init) => { captured = JSON.parse(init.body); return { ok: true, json: async () => ({ choices: [{ message: { content: '验收通过' } }] }) }; };
  await judgeSingle({ png: 'data:image/png;base64,AAA', rubric: DEFAULT_RUBRIC, ctx, glm });
  const content = captured.messages[0].content;
  assert.ok(content.some((c) => c.type === 'image_url'));
  assert.ok(content.some((c) => c.type === 'text'));
  assert.equal(captured.model, 'glm-4.6v');
});
