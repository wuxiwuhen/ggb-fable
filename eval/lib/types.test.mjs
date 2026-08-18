import { describe, it, expect } from 'vitest';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { CATEGORIES, ASSERTION_KINDS, validateCase, loadCases } from './types.mjs';

const dir = new URL('../cases/__tmp__/', import.meta.url);

describe('validateCase', () => {
  const base = {
    id: 'a', prompt: '画一个圆', category: 'basics',
    assertions: [
      { kind: 'object_exists', type: 'conic' },
      { kind: 'measure_eq', select: { c: { type: 'conic' } }, expr: 'Radius(%c%)', expect: 3 },
    ],
  };

  it('合法用例通过', () => {
    expect(validateCase(base)).toEqual({ ok: true, errors: [] });
  });

  it('缺字段 / 坏分类 / 坏断言 kind 报错', () => {
    expect(validateCase({ ...base, prompt: '' }).ok).toBe(false);
    expect(validateCase({ ...base, category: 'nope' }).ok).toBe(false);
    expect(validateCase({ ...base, assertions: [{ kind: 'nope' }] }).ok).toBe(false);
    expect(validateCase({ ...base, assertions: [{ kind: 'measure_eq', expr: 'x' }] }).ok).toBe(false);
  });

  it('measure_eq 缺 select/expr/expect 报错; object_exists 缺 type 报错', () => {
    expect(validateCase({ ...base, assertions: [{ kind: 'measure_eq', expect: 1 }] }).ok).toBe(false);
    expect(validateCase({ ...base, assertions: [{ kind: 'object_exists' }] }).ok).toBe(false);
  });

  it('恰 5 桶 10 原语', () => {
    expect(CATEGORIES).toEqual(['basics', 'functions', 'dynamic', 'multi', 'traps']);
    expect(ASSERTION_KINDS).toHaveLength(10);
  });
});

describe('loadCases', () => {
  it('读 json 按文件名排序 + id 筛选', () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(new URL('b.json', dir), JSON.stringify({ ...base2('b'), id: 'b' }));
    writeFileSync(new URL('a.json', dir), JSON.stringify({ ...base2('a'), id: 'a' }));
    const all = loadCases({ casesDir: dir.pathname });
    expect(all.map((c) => c.id)).toEqual(['a', 'b']);
    expect(loadCases({ casesDir: dir.pathname, id: 'b' }).map((c) => c.id)).toEqual(['b']);
    rmSync(dir, { recursive: true, force: true });
  });
});

function base2(id) {
  return { id, prompt: 'p', category: 'basics', assertions: [{ kind: 'process_no_error' }] };
}
