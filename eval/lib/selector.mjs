// 断言与画布标签解耦: select 按 type 把别名绑到真实 label, expr 里以 %alias% 引用。
// 定界符 %..% 是对旧方案 replaceAll(alias, label) 的修正——后者会把 'l' 替换进 'Radius' 里。
export function bindSelectors(elements, select) {
  const binding = {};
  const used = new Set();
  for (const [alias, spec] of Object.entries(select || {})) {
    const cand = elements.find((e) => e.type === spec.type && !used.has(e.label));
    if (!cand) return null;
    binding[alias] = cand.label;
    used.add(cand.label);
  }
  return binding;
}

export function interpolate(expr, binding) {
  return String(expr).replace(/%([a-zA-Z_]\w*)%/g, (whole, alias) =>
    Object.prototype.hasOwnProperty.call(binding, alias) ? binding[alias] : whole);
}
