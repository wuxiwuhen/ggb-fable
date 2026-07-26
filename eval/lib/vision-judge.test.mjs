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

test('judgeSingle items 带 guards(I1), 失败项带 failureClass', async () => {
  mockFetch('问题: 辅助线该虚线却实线');
  const r = await judgeSingle({ png: 'data:image/png;base64,AAA', rubric: DEFAULT_RUBRIC, ctx, glm });
  // 每项都有 guards 数组(spec §9 强制必填, 喂 L1 归因)
  assert.ok(r.items.every((i) => Array.isArray(i.guards) && i.guards.length), '所有 item 带 guards');
  // 失败项带 failureClass, 通过项不带
  const failed = r.items.find((i) => !i.ok);
  assert.ok(failed && failed.failureClass, '失败项带 failureClass');
  const passed = r.items.find((i) => i.ok);
  assert.ok(!('failureClass' in passed), '通过项不带 failureClass');
});

test('judgePaired items 带 guards(I1)', async () => {
  mockFetch('偏好: A\n问题B: 辅助线该虚线却实线');
  const r = await judgePaired({ pngA: 'data:image/png;base64,A', pngB: 'data:image/png;base64,B', rubric: DEFAULT_RUBRIC, ctx, glm });
  assert.ok(r.items.every((i) => Array.isArray(i.guards) && i.guards.length), '所有 item 带 guards');
});

test('judgeSingle 兼容字符串 rubric(自定义 visual_rubric)', async () => {
  mockFetch('验收通过');
  const r = await judgeSingle({ png: 'data:image/png;base64,AAA', rubric: ['自定义项是否 ok'], ctx, glm });
  assert.equal(r.items.length, 1);
  assert.deepEqual(r.items[0].guards, ['视觉规范']);
});

test('judgePaired 解析偏好 A/B/tie', async () => {
  mockFetch('偏好: A\n问题A: 标签遮挡');
  const r = await judgePaired({ pngA: 'data:image/png;base64,A', pngB: 'data:image/png;base64,B', rubric: DEFAULT_RUBRIC, ctx, glm });
  assert.equal(r.preference, 'A');
});

test('judgePaired per-item a_ok/b_ok 随 问题A/问题B 变化(不再恒 true)', async () => {
  // 回归: 旧实现 parseIssues 正则不匹配 "问题B:", 导致 b_ok 恒 true; 现应随 issue 变化。
  mockFetch('偏好: A\n问题B: 辅助线该虚线却实线');
  const r = await judgePaired({ pngA: 'data:image/png;base64,A', pngB: 'data:image/png;base64,B', rubric: DEFAULT_RUBRIC, ctx, glm });
  const aux = r.items.find((i) => i.name.includes('辅助线'));
  assert.equal(r.preference, 'A');
  assert.equal(aux.a_ok, true, '无 问题A → a_ok true');
  assert.equal(aux.b_ok, false, '有 问题B 辅助线 → b_ok false');
  // 未被点名的项双方均 ok
  const other = r.items.find((i) => i.name.includes('角弧'));
  assert.equal(other.a_ok, true, '无 issue 的项 A 侧 ok');
  assert.equal(other.b_ok, true, '无 issue 的项 B 侧 ok');
  assert.ok(r.issues.some((i) => i.startsWith('B:')), 'flat issues 含 B 侧标记');
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
