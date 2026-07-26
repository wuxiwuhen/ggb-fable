// 确定性断言器: object_exists / invariant / parametric。
// invariant/parametric 的"求值"靠注入的 appletEval(page.evaluate 在 agent 真实画布上跑), 单测 mock。
import { matchSelectors } from './selector.mjs';

// Fix 1: 别名替换用 \b 词边界 + 正则转义, 避免 replaceAll 的子串误伤
// (如单字符别名 l 绑定到 t1 时把 Line(...) 误替换成 t1ine(...); 别名 A 误伤 ArePerpendicular)。
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function substAliases(expr, binding) {
  for (const [alias, label] of Object.entries(binding)) {
    expr = expr.replace(new RegExp('\\b' + escapeRe(alias) + '\\b', 'g'), label);
  }
  return expr;
}

export async function runAssertions(canvasCtx, assertions, appletEval) {
  const { elements, freeVars } = canvasCtx;
  const out = [];
  for (const a of assertions) {
    if (a.kind === 'object_exists') {
      const cnt = elements.filter((e) => e.type === a.find.type).length;
      const passed = cnt >= (a.find.min ?? 1);
      out.push({
        kind: a.kind, name: null, passed,
        failureClass: passed ? null : 'object_missing',
        guards: a.guards || [],
        detail: `${a.find.type}×${cnt}<${a.find.min ?? 1}`,
      });
    } else if (a.kind === 'invariant') {
      const binding = matchSelectors(elements, a.select);
      if (!binding) {
        out.push({
          kind: a.kind, name: a.name, passed: false,
          failureClass: 'object_missing', guards: a.guards || [], detail: '选择器无候选',
        });
        continue;
      }
      const expr = substAliases(a.expr, binding);
      const val = await appletEval(expr);
      const passed = !!val.ok && (a.expect === true
        ? (val.numeric !== 0)
        : String(val.value) === String(a.expect));
      out.push({
        kind: a.kind, name: a.name, passed,
        failureClass: passed ? null : 'invariant_violated',
        guards: a.guards || [],
        detail: `${expr} → ${val.value ?? val.numeric}`,
      });
    } else if (a.kind === 'parametric') {
      // v1 静态: 至少一个自由变量, 且至少一个派生 definition 引用了某自由变量名(词边界)
      const freeNames = new Set(freeVars.map((v) => v.name));
      const hasRef = elements.some((e) => e.definition && [...freeNames].some(
        (n) => new RegExp(`\\b${escapeRe(n)}\\b`).test(e.definition),
      ));
      const passed = freeNames.size > 0 && hasRef;
      out.push({
        kind: a.kind, name: a.message, passed,
        failureClass: passed ? null : 'parametric_fail',
        guards: a.guards || [],
      });
    }
  }
  return out;
}
