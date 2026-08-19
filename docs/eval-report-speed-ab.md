# 速度优化 A/B 报告 · 三臂 thinking_mode

- 日期: 2026-08-19 ｜ model: deepseek-v4-flash ｜ prompt_version: v2 ｜ 判据: spec §4
- 跑法: 每臂 10 用例 × 3 采样（多数决），eval 经真实 app（localhost:3000）驱动；三臂串行，均无 429（未触发 `--serial` 降级）。
- 数字来源: `eval/reports/20260819-deepseek-v2{,-auto,-fast}.results.json`（gitignored，不入库）。
- durationMs 口径含 drain 固定等待（约 5s），三臂一致，不影响 A/B 比较。

## 三臂总览

| 臂 | thinking_mode | 总成功率 | 四正桶 | traps | budget P50 | basics P50 | 超时采样数 | 墙钟 |
|---|---|---|---|---|---|---|---|---|
| deepseek-v2 | always | 90% (9/10) | 4/4（basics/functions/dynamic/multi 各 2/2） | 1/2 | 247.7s | 67.2s | 0 | 18m05s |
| deepseek-v2-auto | auto | 80% (8/10) | 3/4（multi 1/2，其余各 2/2） | 1/2 | 148.8s | 40.6s | 0 | 13m40s |
| deepseek-v2-fast | never | 80% (8/10) | 3/4（multi 1/2，其余各 2/2） | 1/2 | 86.2s | 27.3s | 0 | 8m57s |

- budget P50 = `trap-budget-unit-circle` 单用例 ok 采样 durationMs 中位数（各臂 3 采样全部 ok，无 run_error）：always [201.4, 247.7, 278.9]s；auto [101.6, 148.8, 199.3]s；fast [80.1, 86.2, 94.4]s。
- basics P50 = buckets.basics.p50Ms（ok 采样）换算为秒。
- 墙钟为整臂串行耗时（含启动/报告落盘），三臂合计 40m42s（13:11:16–13:51:58 本地）。
- 分桶对比矩阵（auto vs always / fast vs auto，stdout `--compare` 输出，与 results.json 同源）：basics/functions/dynamic 三臂均 100%；multi：always 100% → auto 50%（−50pp）→ fast 50%（0pp）；traps 三臂均 50%。

## 判定（逐条对照 spec §4）

1. auto 双达标: **否** ——（质量: 总成功率 80% 达标，但 multi 桶 1/2，不满足「basics/func/dyn/multi 各 2/2」；延迟: budget P50 148.8s > 60s、basics P50 40.6s > 15s，两项均超）
2. fast 双达标且总分 ≥ auto: **否** ——（质量: 总 80% 与 auto 持平，但 multi 桶 1/2 不满足「各 2/2」；延迟: budget P50 86.2s > 60s、basics P50 27.3s > 15s，两项均超）
3. 超时干净度: **通过** ——（三臂 timedOut 采样均为 0，timeout_incomplete 未出现系因无超时发生而非分类失效；auto failureDist 中 process_error×2 为真实「无 turn_end」样本（199.3s/101.6s 自然结束，未触 420s 上限强停），process_error 不含超时强停样本。对照：auto budget 用例 s1/s2 无 turn_end；fast budget 用例 s0/s2 为 budget_exceeded（render 3>2 超限），非强停。）

## 决策

- **已停止, 待用户裁决回退链**（auto 质量门与延迟门均不达标，触发决策门 STOP）。
- 待裁决选项：
  1. **reasoning_effort 探针**: 以 `reasoning_effort: low` 重跑三臂（或仅 auto 臂），观察 multi 桶与延迟是否同时改善；
  2. **默认回 always**: 维持现状基线（90%、四正桶 4/4），接受 67.2s basics P50 / 18m 墙钟，速度优化专项以「thinking 管道 + 状态机 + 度量已就绪」收尾，默认档不改;
  3. （可选讨论）**门线校准**: 三臂端到端 P50 均远超 60s/15s 门线（含 ~5s drain 固定等待与真实浏览器渲染），若门线按「模型侧纯思考时长」口径重定义，auto/fast 的相对收益（basics P50 −40%/−59%）仍成立，需用户定夺口径。
- 本次运行不改任何引擎默认值与 variants。

## 归因与观察

- **multi-triangle-incenter 是两实验臂的共同失分点**（always 3/3 PASS 63–99s → auto 0/3 FAIL、fast 1/3 FAIL）。失败模式一致：polygon 从未创建（object_missing: polygon×0）→ 面积测量 selector 无候选（selector_unmatched）。即内切圆多步构造中「先建三角形多边形」这一步在低/无思考下系统性缺失；非偶发（auto 0/3）。
- **trap-hallucinated-command 反向劣化于 always 臂**: always 0/3 FAIL（polygon 未建）、auto/fast 各 3/3 PASS——always thinking 并非全维度更优，两实验臂在该用例上反而干净利落地通过（auto 用时 7–16s）。
- **trap-budget-unit-circle 三臂都不稳**: always 2/3（201–279s，12/7/11 轮）、auto 1/3（2 采样「无 turn_end」提前收束）、fast 1/3（2 采样 render 3>2 超限）。fast 关思考后以更多轮数补偿（budget 用例 16/8/15 轮、全臂 max 16、均值 6.0 vs auto 4.7 vs always 5.4），轮数涨但单轮变快，端到端仍最省。
- **延迟单调改善但无一达标**: basics P50 67.2 → 40.6 → 27.3s，总墙钟 18:05 → 13:40 → 08:57（auto 较 always 省 24%，fast 省 51%）；方向与预期一致，幅度不足以过门线。
- **auto 档 PLAN 轮耗时分布**: results.json 仅落盘 rounds 计数（auto 全臂 rounds 2–9、均值 4.7），未落盘逐轮/分阶段时间戳，无法从产物直接给出 PLAN 轮耗时分布；如需该归因，需后续在 runner stats 中补 stage 级时间落盘。
- **EXECUTE 轮新增失败模式**: auto 出现「无 turn_end」类 process_error×2（always/fast 无此类），为 auto 臂特有信号（回合收束异常，非超时强停）；fast 出现 budget_exceeded×2（render 超限），always 该用例仅 1 次 budget_exceeded。
- 429 退串行未发生（三臂 log 中 429 计数均为 0）。
- 冒烟（Step 1）: 三臂 `_selftest` 各 3/3 通过、exit 0、thinking 字段被端点接受、durationMs 正常落盘（always 37.3/133.8/39.6s；auto 43.9/35.5/49.7s；fast 18.8/22.2/21.7s）。
