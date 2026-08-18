// 用例类型与校验。类型约定见计划 File Structure 的 JSDoc; 本模块导出运行时校验 + 加载器。
import { readdirSync, readFileSync } from 'node:fs';

export const CATEGORIES = ['basics', 'functions', 'dynamic', 'multi', 'traps'];

export const ASSERTION_KINDS = [
  'object_exists', 'measure_eq', 'measure_range', 'relation_bool', 'slider_exists',
  'parametric_ref', 'visual_inspect_ok', 'label_visible', 'process_no_error', 'process_budget',
];

// 每种 kind 的必填字段(除 kind 外)
const REQUIRED = {
  object_exists: ['type'],
  measure_eq: ['select', 'expr', 'expect'],
  measure_range: ['select', 'expr', 'min', 'max'],
  relation_bool: ['select', 'expr'],
  slider_exists: [],
  parametric_ref: [],
  visual_inspect_ok: [],
  label_visible: ['type'],
  process_no_error: [],
  process_budget: [],
};

function checkSelect(select, errors) {
  if (!select || typeof select !== 'object' || Array.isArray(select)) { errors.push('select 必须是对象'); return; }
  for (const [alias, spec] of Object.entries(select)) {
    if (!/^[a-zA-Z_]\w*$/.test(alias)) errors.push(`别名 ${alias} 不合法(须是标识符, expr 里以 %alias% 引用)`);
    if (!spec || typeof spec.type !== 'string') errors.push(`select.${alias} 缺 type`);
  }
}

export function validateCase(c) {
  const errors = [];
  if (!c || typeof c !== 'object') return { ok: false, errors: ['用例必须是对象'] };
  if (typeof c.id !== 'string' || !c.id.trim()) errors.push('缺 id');
  if (typeof c.prompt !== 'string' || !c.prompt.trim()) errors.push('缺 prompt');
  if (!CATEGORIES.includes(c.category)) errors.push(`category 必须是 ${CATEGORIES.join('/')} 之一`);
  if (!Array.isArray(c.assertions) || !c.assertions.length) { errors.push('assertions 必须是非空数组'); return { ok: false, errors }; }
  for (const [i, a] of c.assertions.entries()) {
    if (!ASSERTION_KINDS.includes(a?.kind)) { errors.push(`assertions[${i}].kind 必须是 ${ASSERTION_KINDS.join('/')} 之一`); continue; }
    for (const f of REQUIRED[a.kind]) {
      if (a[f] === undefined || a[f] === null) errors.push(`assertions[${i}] (${a.kind}) 缺 ${f}`);
    }
    if (a.kind === 'measure_eq' && typeof a.expect !== 'number') errors.push(`assertions[${i}] expect 必须是数字`);
    if (a.select) checkSelect(a.select, errors);
  }
  return { ok: errors.length === 0, errors };
}

const DEFAULT_DIR = new URL('../cases/', import.meta.url).pathname;

export function loadCases({ casesDir = DEFAULT_DIR, id } = {}) {
  let files = [];
  try {
    // 文件名级过滤在前: 默认跳过 _ 前缀(冒烟/草稿用例, 如 _selftest)——官方跑只含裁决过的用例;
    // 显式指定 id 时不做文件名排除, 加载后按 id 过滤(顺序照旧), 保证 --case _selftest 仍可用。
    files = readdirSync(casesDir)
      .filter((f) => f.endsWith('.json'))
      .filter((f) => id || !f.startsWith('_'))
      .sort();
  } catch { return []; }
  let cases = files.map((f) => JSON.parse(readFileSync(`${casesDir}/${f}`, 'utf8')));
  if (id) cases = cases.filter((c) => c.id === id);
  return cases;
}
