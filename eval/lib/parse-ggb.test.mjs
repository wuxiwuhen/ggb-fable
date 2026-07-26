import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseGeogebraXml } from './parse-ggb.mjs';

const xml = readFileSync(new URL('../fixtures/ggb/sample.xml', import.meta.url), 'utf8');

test('parseGeogebraXml 统计 objectInventory', () => {
  const r = parseGeogebraXml(xml);
  const byType = Object.fromEntries(r.objectInventory.map((x) => [x.type, x.count]));
  assert.equal(byType.point, 1);
  assert.equal(byType.circle, 1);
  assert.equal(byType.numeric, 1);
});

test('parseGeogebraXml 提取 freeVars(slider + 独立点)', () => {
  const r = parseGeogebraXml(xml);
  const slider = r.freeVars.find((v) => v.name === 'k');
  assert.ok(slider, '应有 slider k');
  assert.equal(slider.type, 'slider');
  assert.equal(slider.min, 0);
  assert.equal(slider.max, 10);
  assert.equal(slider.inc, 0.1);
  const pt = r.freeVars.find((v) => v.name === 'A');
  assert.ok(pt && pt.type === 'point', '独立点 A 应入 freeVars');
});

test('parseGeogebraXml 提取 elements(label/type/definition)', () => {
  const r = parseGeogebraXml(xml);
  const c = r.elements.find((e) => e.label === 'c');
  assert.ok(c && c.type === 'circle');
  const b = r.elements.find((e) => e.label === 'B');
  assert.ok(b && b.definition.includes('Midpoint'), 'B 的 definition 含 Midpoint');
});
