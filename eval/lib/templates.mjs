// 10 个确定性断言原语(规格 §3.1②)。求值三源: canvas(结构) / events(过程轨迹) / appletEval(数值)。
// 评判零 LLM: appletEval 是在画布内核上临时建对象求值, 不是模型。
import { bindSelectors, interpolate } from './selector.mjs';

function result(a, passed, failureClass, detail) {
  return { kind: a.kind, name: a.expr || a.type || a.kind, passed, failureClass: passed ? null : failureClass, detail };
}

function num(v) {
  // NaN 与 ±Infinity 都不是有效度量(NaN 本身是 number 类型; 1/0、垂直斜率等产生 Infinity)——一律 undefined → eval_error
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
  if (typeof v === 'string' && v.trim() !== '') { const n = Number(v); return Number.isFinite(n) ? n : undefined; }
  return undefined;
}

// events 助手: 过滤/计数
const toolCalls = (events) => (events || []).filter((e) => e.type === 'tool_call' && e.name);
const byName = (events, name) => toolCalls(events).filter((e) => e.name === name);

export async function evaluateAssertion(a, ctx) {
  const { canvas, events, appletEval } = ctx;

  switch (a.kind) {
    case 'object_exists': {
      const cnt = canvas.elements.filter((e) => e.type === a.type).length;
      const min = a.min ?? 1;
      const passed = cnt >= min;
      return result(a, passed, 'object_missing', `${a.type}×${cnt} < ${min}`);
    }

    case 'label_visible': {
      const cnt = canvas.elements.filter((e) => e.type === a.type && e.visible).length;
      const min = a.min_visible ?? 1;
      const passed = cnt >= min;
      return result(a, passed, 'label_hidden', `可见 ${a.type}×${cnt} < ${min}`);
    }

    case 'slider_exists': {
      const cnt = canvas.freeVars.filter((v) => v.type === 'slider').length;
      const passed = cnt >= (a.min ?? 1);
      return result(a, passed, 'slider_missing', `slider×${cnt}`);
    }

    case 'parametric_ref': {
      // 自由变量被派生对象的定义/命令输入引用(corpus) → 画布是"参数化"的而非静态硬编码
      const free = canvas.freeVars.map((v) => v.name);
      const hit = free.filter((n) => new RegExp(`\\b${n}\\b`).test(canvas.corpus));
      const passed = free.length > 0 && hit.length > 0;
      return result(a, passed, 'parametric_fail', `自由变量 [${free.join(',')}] 引用: [${hit.join(',')}]`);
    }

    case 'measure_eq':
    case 'measure_range':
    case 'relation_bool': {
      const binding = bindSelectors(canvas.elements, a.select);
      if (!binding) return result(a, false, 'selector_unmatched', `select 无候选: ${JSON.stringify(a.select)}`);
      const expr = interpolate(a.expr, binding);
      // appletEval 返回 {ok:false} = 几何求值失败(eval_error); 抛异常 = 基础设施故障, 上抛给 evaluateAll 兜底为 run_error
      const v = await appletEval(expr);
      if (!v?.ok) return result(a, false, 'eval_error', `${expr} → ${v?.value ?? '?'}`);

      if (a.kind === 'relation_bool') {
        const want = a.expect ?? true;
        const got = v.value === 'true' ? true : v.value === 'false' ? false : num(v.numeric) === 1;
        const passed = got === want;
        return result(a, passed, 'relation_false', `${expr} → ${v.value}`);
      }
      const x = num(v.numeric ?? v.value);
      if (x === undefined) return result(a, false, 'eval_error', `${expr} → 非数值 ${v.value}`);
      if (a.kind === 'measure_eq') {
        const tol = a.tol ?? 0.01;
        const passed = Math.abs(x - a.expect) <= tol;
        return result(a, passed, 'measure_mismatch', `${expr} → ${x}, 期望 ${a.expect}±${tol}`);
      }
      const passed = x >= a.min && x <= a.max;
      return result(a, passed, 'measure_mismatch', `${expr} → ${x}, 区间 [${a.min}, ${a.max}]`);
    }

    case 'visual_inspect_ok': {
      // 最后一次 inspect_render 的结论(结构化 issues 空即通过)——被评系统自己的视觉工具, 非外部 LLM judge
      const insp = byName(events, 'inspect_render').filter((e) => e.result?.ok).pop();
      if (!insp) return result(a, false, 'visual_fail', 'inspect_render 未被调用或未成功');
      const passed = insp.result.passed === true;
      return result(a, passed, 'visual_fail', passed ? 'issues 空' : `issues: ${(insp.result.issues || []).join('; ').slice(0, 120)}`);
    }

    case 'process_no_error': {
      // runner 超时强停: 轨迹必然不完整(turn_end 缺失/强停注入 error), 不足以判"过程出错"——
      // 记 timeout_incomplete 边界信号, 与真实 process_error 分离(spec §3.4)
      if (ctx.timedOut) return result(a, false, 'timeout_incomplete', 'runner 超时强停, 过程轨迹不完整');
      const turnEnd = (events || []).filter((e) => e.type === 'turn_end').pop();
      const errors = (events || []).filter((e) => e.type === 'error').length;
      const reasons = [];
      if (!turnEnd) reasons.push('无 turn_end(未正常完成)');
      if (turnEnd?.stopped) reasons.push('被中止');
      if (errors > 0) reasons.push(`error 事件 ×${errors}`);
      const passed = reasons.length === 0;
      return result(a, passed, 'process_error', reasons.join('; ') || '正常完成');
    }

    case 'process_budget': {
      const v = byName(events, 'verify_geometry').length;
      const r = byName(events, 'inspect_render').length;
      const vm = a.verify_max ?? 3, rm = a.render_max ?? 2;
      const over = [];
      if (v > vm) over.push(`verify ${v}>${vm}`);
      if (r > rm) over.push(`render ${r}>${rm}`);
      const passed = over.length === 0;
      return result(a, passed, 'budget_exceeded', `verify=${v}/${vm} render=${r}/${rm}${over.length ? ' 超限: ' + over.join(',') : ''}`);
    }

    default:
      return result(a, false, 'run_error', `未知 kind: ${a.kind}`);
  }
}

export async function evaluateAll(assertions, ctx) {
  const out = [];
  for (const a of assertions || []) {
    try { out.push(await evaluateAssertion(a, ctx)); }
    catch (e) { out.push({ kind: a?.kind || '?', name: a?.expr || '?', passed: false, failureClass: 'run_error', detail: String(e?.message || e) }); }
  }
  return out;
}
