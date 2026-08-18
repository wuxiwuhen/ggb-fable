# Eval 报告 · deepseek-v2

- 日期: 2026-08-18 ｜ model: **deepseek-v4-flash** ｜ prompt_version: **v2**
- temperature: **0.2** ｜ max_tool_rounds: 30 ｜ 每条采样: 3 次(多数决)
- 总成功率: **80%**（8/10 条）

## 分桶成功率

| 桶 | 用例数 | 通过 | 成功率 |
|---|---|---|---|
| basics 基础构造 | 2 | 2 | 100% |
| functions 函数图像 | 2 | 2 | 100% |
| dynamic 动态可拖动 | 2 | 2 | 100% |
| multi 多步组合 | 2 | 2 | 100% |
| traps 陷阱与预算边界 | 2 | 0 | 0% |

## 断言级统计（全部采样全量记录）

| 断言原语 | 通过/总数 |
|---|---|
| object_exists | 46/50 |
| measure_eq | 43/45 |
| slider_exists | 6/6 |
| measure_range | 6/6 |
| parametric_ref | 6/6 |
| visual_inspect_ok | 3/3 |
| process_no_error | 2/5 |
| process_budget | 5/5 |

## 失败分类分布

- **object_missing**: 4
- **process_error**: 3
- **selector_unmatched**: 2
- **run_error**: 1

## 边界信号（3 次中有 1–2 次通过：不稳定而非全坏）

- `trap-hallucinated-command`: 1/3

## 失败明细

### trap-budget-unit-circle（陷阱与预算边界, 0/3）
- s0: ✗ process_no_error process_no_error [process_error] 被中止; error 事件 ×1
- s1: ✗ object_exists segment [object_missing] segment×0 < 3
- s1: ✗ process_no_error process_no_error [process_error] 被中止; error 事件 ×1
- s2: ✗ object_exists segment [object_missing] segment×1 < 3
- s2: ✗ process_no_error process_no_error [process_error] 被中止; error 事件 ×1

### trap-hallucinated-command（陷阱与预算边界, 1/3）
- s0: RUN_ERROR page.waitForFunction: Timeout 60000ms exceeded.
- s1: ✗ object_exists polygon [object_missing] polygon×0 < 1

## 覆盖边界声明

- 本报告只证明：这 10 条用例（每桶 2 条）在该 variant 配置下的多数决成功率与失败分类。
- 不证明：全体 K12 题型覆盖、视觉美观度（视觉仅采信被评系统自报的 inspect_render 结论）、跨模型一般性。
- 桶级数字只做方向性结论（规格 §3.1⑤），不做显著性声明；扩到 30 条后结论边界同步更新。

## 结论与归因

最弱桶 traps（0%），余四桶 100%。失败集中于 process_error（3 次，皆 budget 用例：多步构造中途 error 即中止，垂线段仅成 0–1/3）与 object_missing（4 次，3 次在 traps：垂线段缺×2、幻觉命令未回退×1）。攻击点：① 错误恢复：重试或降级勿中止；② 幻觉命令回退重画；③ s0 超时属时序，查 settleReady。

## 已知度量口径说明

failureDist 里 `selector_unmatched` 是 `object_missing` 的影子失败：一个对象缺失会连带 N 条依赖该对象的选择器断言失败（本次 basics-circle-tangent s1 缺 1 条切线 → 连带 2 条 Distance 断言 selector_unmatched；该用例 2/3 多数通过，s1 的失败明细按多数决规则不单列）。读数时以 case 级 majorityPassed 与 `object_missing` 为主，不要把 `selector_unmatched` 计为独立失败原因。

## 已知限制

dyn 桶两条用例断言偏弱（用户审核门裁决③，接受为已知限制）：dyn-slider-circle-radius 未断言滑动条初始值 = 2（measure_range 只验 Radius ∈ [1,5]）；dyn-slider-line-slope 的 k 区间断言（measure_range %f%(1) ∈ [-3,3]）对产出的常见斜率恒过、不验证直线与滑动条的实际绑定。dyn 桶 100% 的读数因此偏乐观。
