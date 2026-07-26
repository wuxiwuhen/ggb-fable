// 选择器匹配: 把断言里的别名(type 声明)绑定到画布真实 label, 让 invariant 断言标签无关。
// v1: 按 type 在 elements 里顺序绑定; role 仅注释。智能角色匹配(如"圆心=被circle引用的点")留 Phase 2。
export function matchSelectors(elements, select) {
  const binding = {};
  for (const [alias, spec] of Object.entries(select || {})) {
    const cand = elements.find((e) => e.type === spec.type && !Object.values(binding).includes(e.label));
    if (!cand) return null;
    binding[alias] = cand.label;
  }
  return binding;
}
