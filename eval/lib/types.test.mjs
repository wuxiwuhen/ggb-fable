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
    rmSync(dir, { recursive: true, force: true }); // 清残留(断言失败时尾部 rmSync 不执行)
    mkdirSync(dir, { recursive: true });
    writeFileSync(new URL('b.json', dir), JSON.stringify({ ...base2('b'), id: 'b' }));
    writeFileSync(new URL('a.json', dir), JSON.stringify({ ...base2('a'), id: 'a' }));
    const all = loadCases({ casesDir: dir.pathname });
    expect(all.map((c) => c.id)).toEqual(['a', 'b']);
    expect(loadCases({ casesDir: dir.pathname, id: 'b' }).map((c) => c.id)).toEqual(['b']);
    rmSync(dir, { recursive: true, force: true });
  });

  it('默认跳过 _ 前缀文件(冒烟/草稿不进官方跑); 显式指定其 id 时仍可选中', () => {
    rmSync(dir, { recursive: true, force: true }); // 清残留(断言失败时尾部 rmSync 不执行)
    mkdirSync(dir, { recursive: true });
    writeFileSync(new URL('z.json', dir), JSON.stringify(base2('z')));
    writeFileSync(new URL('_smoke.json', dir), JSON.stringify(base2('_smoke')));
    // 无 id: 文件名级过滤, _smoke 不加载
    expect(loadCases({ casesDir: dir.pathname }).map((c) => c.id)).toEqual(['z']);
    // 有 id: 加载后按 id 过滤(顺序照旧), --case _smoke 仍可用
    expect(loadCases({ casesDir: dir.pathname, id: '_smoke' }).map((c) => c.id)).toEqual(['_smoke']);
    expect(loadCases({ casesDir: dir.pathname, id: 'z' }).map((c) => c.id)).toEqual(['z']);
    rmSync(dir, { recursive: true, force: true });
  });
});

function base2(id) {
  return { id, prompt: 'p', category: 'basics', assertions: [{ kind: 'process_no_error' }] };
}

describe('timeoutMs 校验', () => {
  const base = { id: 'a', prompt: 'p', category: 'basics', assertions: [{ kind: 'process_no_error' }] };
  it('可选; 传了必须是正数(毫秒)', () => {
    expect(validateCase(base).ok).toBe(true);
    expect(validateCase({ ...base, timeoutMs: 420000 }).ok).toBe(true);
    expect(validateCase({ ...base, timeoutMs: '420000' }).errors).toContain('timeoutMs 必须是正数(毫秒)');
    expect(validateCase({ ...base, timeoutMs: 0 }).errors).toContain('timeoutMs 必须是正数(毫秒)');
  });
});
