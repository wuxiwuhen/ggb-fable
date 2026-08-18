import { describe, it, expect } from 'vitest';
import { bindSelectors, interpolate } from './selector.mjs';

const els = [
  { label: 'A', type: 'point', visible: true, definition: '' },
  { label: 'B', type: 'point', visible: true, definition: '' },
  { label: 'c', type: 'conic', visible: true, definition: '' },
  { label: 'l1', type: 'line', visible: true, definition: '' },
  { label: 'l2', type: 'line', visible: true, definition: '' },
];

describe('bindSelectors', () => {
  it('按 type 顺序绑定且不重复占用', () => {
    expect(bindSelectors(els, { P: { type: 'point' }, Q: { type: 'point' } })).toEqual({ P: 'A', Q: 'B' });
    expect(bindSelectors(els, { L: { type: 'line' } })).toEqual({ L: 'l1' });
  });

  it('缺候选返回 null; 空 select 返回 {}', () => {
    expect(bindSelectors(els, { X: { type: 'polygon' } })).toBeNull();
    expect(bindSelectors(els, {})).toEqual({});
  });
});

describe('interpolate', () => {
  it('%alias% 定界替换(不影响同名子串)', () => {
    expect(interpolate('Radius(%c%) + %l1%', { c: 'c1', l1: 't1' })).toBe('Radius(c1) + t1');
    expect(interpolate('ArePerpendicular(%l%, Line(O, A))', { l: 'l9' })).toBe('ArePerpendicular(l9, Line(O, A))');
  });

  it('未声明的 %x% 原样保留(将触发 eval_error 而非静默)', () => {
    expect(interpolate('x(%P%)', {})).toBe('x(%P%)');
  });
});
