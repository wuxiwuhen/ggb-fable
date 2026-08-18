import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseCanvasXml } from './parse-canvas.mjs';

const xml = readFileSync(new URL('../fixtures/sample.xml', import.meta.url), 'utf8');

describe('parseCanvasXml', () => {
  const r = parseCanvasXml(xml);

  it('elements 带 label/type/visible/definition', () => {
    const c = r.elements.find((e) => e.label === 'c');
    expect(c?.type).toBe('conic');
    expect(c?.definition).toContain('Circle');
    expect(r.elements.find((e) => e.label === 'A')?.visible).toBe(true);
    expect(r.elements.find((e) => e.label === 'P')?.visible).toBe(false);
  });

  it('freeVars: slider r + 独立点 A', () => {
    expect(r.freeVars.find((v) => v.name === 'r')?.type).toBe('slider');
    expect(r.freeVars.find((v) => v.name === 'A')?.type).toBe('point');
    expect(r.freeVars.find((v) => v.name === 'P')).toBeUndefined();   // showObject=false 的非独立点不在此例, 独立性才是判据
  });

  it('corpus 含 expression 与 command 输入, 可检出对自由变量 r 的引用', () => {
    expect(r.corpus).toContain('Circle((0, 0), r)');
    expect(/\br\b/.test(r.corpus)).toBe(true);
  });

  it('空/坏 xml 不抛异常', () => {
    expect(() => parseCanvasXml('')).not.toThrow();
    expect(parseCanvasXml('').elements).toEqual([]);
  });
});
