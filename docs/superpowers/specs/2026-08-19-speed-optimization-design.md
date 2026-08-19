# 速度优化专项设计：分段思考策略 + 流式进度 + eval 延迟度量

日期：2026-08-19
前置：eval 质量轨 v1 已交付（`docs/eval-report-v1.md`，基线 80%，10 条×3 次多数决）。

## 1. 背景与问题

### 1.1 实测数据（2026-08-18/19 探针 + eval 官方跑采样分析）

- 主模型 `deepseek-v4-flash`（api.deepseek.com）**默认开启思考模式**：探针同题实测，默认档 7.3s 输出 600 tok **全部是 reasoning、正文 0 字**；`thinking: {"type":"disabled"}` 档 5.8s 写出 1069 字完整方案。生成速度两档一致（77–103 tok/s），**省的是思考 token 本身**。
- 官方跑 30 个采样中 4 个撞 runner 180s 超时被强停（trap-budget 3/3 全超时 + basics-circle-tangent 1/3），强停注入 error 事件被 `process_no_error` 判死——**复杂题测出的 0 分是思考时间累积，不是画图能力**。
- 引擎每轮 `backend.chat` 全价付思考税：复杂题 6–9 轮 × 25–50s ≈ 180–400s。工具层其实已支持批量（`execute_command` 多条换行分隔）与末端视觉验收（`inspect_render` 限构造完成后），**慢的根源是每轮重复规划，不是工具往返**。
- `parseSSE` 直接丢弃 `reasoning_content` 增量——思考内容用户完全看不见，纯黑盒等待。

### 1.2 用户决策（2026-08-19 brainstorming）

1. 验收标准：**分数 + 延迟双硬指标**。
2. 思考策略默认行为：**自动三段式**（无 UI 开关，用户无感知）。
3. UX 流式进度（阶段状态行 + 思考流折叠展示）：**纳入本专项**。

## 2. 目标与非目标

### 目标

1. 复杂题（多对象构造）端到端耗时**中位数 ≤60s**；简单题**中位数 ≤15s**（按 eval 分桶 P50 度量）。
2. 质量不掉：eval 总成功率 ≥80% **且每桶通过数不低于 v1 基线**（四正桶 ≥2/2，traps ≥0/2——traps 基线本身 0，只求不因提速新增失败模式，超时分离后另行解读）。
3. 试用模式（trial 代理）同步获得提速。
4. 用户可看见阶段进展与思考流，消除黑盒等待感。
5. eval 具备延迟度量与干净的超时分类，能验收上述指标。

### 非目标

- 不换模型、不加 UI 档位开关（用户已选无感知自动）。
- prompt v2 文本**冻结不动**（批量构造指令已在工具描述里；若数据显示模型仍欠批量，prompt v3 归后续迭代）。
- 不做 30 条用例扩容、裸 LLM 基线（后续专项）。
- 不做模型输出的画布增量渲染优化（GeoGebra 本身随命令即时更新）。

## 3. 设计

### 3.1 三段式思考策略状态机（lib/agent.ts `run()` 内）

```
用户消息 → [PLAN] --第2轮起--> [EXECUTE] --无 tool_calls--> 最终回复
              ↑                    |  ↑
              └---- [RECOVER] <----+  └--恢复一轮后回 EXECUTE--
```

| 阶段 | thinking | 范围 | 说明 |
|------|----------|------|------|
| PLAN | enabled | 每个用户消息的第 1 轮 | v2 prompt 本就要求先出构造规划；思考量随题目复杂度自缩放（简单题预计 2–5s，A/B 验证） |
| EXECUTE | disabled | 第 2 轮起直至无 tool_calls | 照规划批量执行；阶段指令由引擎注入 system 后缀（如"按既定规划继续执行，勿重新规划"），**prompt v2 本体不动** |
| RECOVER | enabled | 触发式，每 turn 最多 2 次 | 恢复一轮（带失败上下文重规划/修复）后回 EXECUTE；达到上限后按现状 best-effort 收尾 |

**升级触发条件**（信号全部来自现有工具结果，不需要新检测机制）：

1. 连续 2 轮 `execute_command` 批次含 failures；
2. `verify_geometry` 结果不达预期（求值失败或与 expect 明显不符）；
3. 因 `inspect_render` issues 修正后再次 inspect 仍有 issues；
4. 连续 2 轮调用了 `execute_command` 但 `createdLabels` 均为空（零新对象的空转）。

**已知张力与兜底**：简单题 ≤15s 目标依赖"思考量自缩放"假设；若 A/B 显示规划轮对简单题过度思考，兜底为规划轮改发 `reasoning_effort: low`（若 API 支持，探针先行验证；不支持则接受该张力并记录）。

**配置**：`thinking_mode: 'auto' | 'always' | 'never'`，**默认 auto**。`always` = 现状（全程思考，A/B 基线臂）；`never` = 全程关（fast 臂）。字段落在 LLM 请求配置里（BYOK profile 可选字段 + eval variant + trial 请求体），无 UI。

### 3.2 请求层与配置管道

- `AgentBackend.chat` 签名加可选 `thinking?: 'enabled' | 'disabled'`（引擎按状态机逐轮下发；`thinking_mode: always/never` 时无视状态下发固定值）。
- `chatByok`：`body.thinking = { type }`（仅显式传入时携带，缺省不带=厂商默认，兼容非 deepseek 端点）。
- `chatTrial` / `/api/trial/llm` 路由：请求体透传 `thinking` 字段，服务端拼上游请求时原样携带。
- `parseSSE` 补收 `delta.reasoning_content`：累积后经新回调 `onThinking(delta)` 透出；**不写入 messages 历史、不回传 API**（与现状一致；deepseek 文档要求思考模式下回传 reasoning_content，当前不回传实测可用——列为风险观察项，若上游开始 400 则在规划轮剥离/回传，属实现层微调不改变设计）。

### 3.3 UX 流式进度（components/ChatApp + parseSSE 回调）

- **思考流**：`onThinking` → 聊天流中渲染可折叠"思考中…"块，实时流式；回合结束自动折叠为"已思考 Ns"摘要行。
- **阶段状态行**：复用现有 `hooks.onRound` / `onToolStart` → 状态条显示「规划中 / 执行第 N 步 / 视觉验收中 / 恢复中」，工具名到文案的映射在 UI 层。
- 引擎侧只透出数据（回调已有，补 onThinking），UI 改动集中在 ChatApp 一处。

### 3.4 eval 配套

1. **延迟度量**：`runSample` 记录 `durationMs`；aggregate 增加分桶 P50（复杂桶=budget 类多对象用例，简单桶=basics）；report 增"延迟分布"段。
2. **超时独立分类**：`timedOut` 采样不再把强停注入的 error 事件计入 `process_no_error` 失败——超时采样标记 `timedOut` 后，过程断言按"未完成"记边界信号，不判 process_error。
3. **每用例超时**：case schema 加可选 `timeoutMs`（默认 180000；trap-budget-unit-circle 设 420000）。
4. **采样并行**：`runOneCase` 的 3 个采样并行跑（各开独立 page/context），campaign 时间约 ÷3。
5. **A/B 三臂 variants**：`deepseek-v2.json` 补 `thinking_mode: 'always'`（锁定基线语义）；新增 `deepseek-v2-auto.json`、`deepseek-v2-fast.json`；`buildByokPayload` 透传该字段。`--compare` 出三臂矩阵。

## 4. 验收标准（硬指标）

| 指标 | 判据 | 度量来源 |
|------|------|---------|
| 质量 | 总成功率 ≥80% 且 basics/func/dyn/multi 各 ≥2/2 | eval 三臂 A/B |
| 延迟-复杂 | trap-budget-unit-circle（420s 上限内完成）P50 ≤60s | durationMs 分桶 P50 |
| 延迟-简单 | basics 桶 P50 ≤15s | 同上 |
| 超时干净度 | 强停采样不再出现在 process_error 分布里 | failureDist + 边界信号 |

**A/B 判据（决策规则，写死）**：

1. `auto` 档双达标（质量+延迟）→ 设为默认（即引擎默认已 auto，确认保留）；
2. `fast` 档双达标**且**总分 ≥ auto 档 → 可讨论替代默认；否则 fast 仅留作 variant 不默认；
3. `auto` 档任一不达标 → 回退方案：规划轮 `reasoning_effort: low` 重跑一次 A/B；再不达标则默认改 `always`（现状），专项以 UX+eval 成果部分交付并归因记录。

## 5. 测试策略

- **单测（vitest，全部先行 TDD）**：状态机转移（PLAN→EXECUTE、四种触发各入 RECOVER、恢复上限 2、always/never 覆盖状态下发）；chatByok/chatTrial 请求体 thinking 有/无/透传；parseSSE reasoning_content 捕获与丢弃兼容；eval durationMs 记录与 P50 聚合；timedOut 分类不进 process_error；case timeoutMs schema 校验。
- **真实 LLM 冒烟**：`_selftest` 以 `always`/`auto`/`never` 三模式各跑 1 次通过。
- **A/B 实测**：三臂各跑官方 10×3，按 §4 判据决策，结果落 `docs/eval-report-speed-ab.md`。

## 6. 风险与缓解

| 风险 | 缓解 |
|------|------|
| 显式规划质量低于隐藏 CoT（复杂题掉分） | RECOVER 升级兜底；A/B 分数门槛硬卡；不达标走 §4 回退链 |
| 简单题规划轮过度思考（>15s） | reasoning_effort: low 兜底（API 支持性先探针）；仍不达标接受并记录 |
| deepseek 要求回传 reasoning_content 而当前不回传 | 现状已实测可用；若上游策略变化出现 400，规划轮补剥离逻辑（实现层微调） |
| 非 deepseek 端点不认 thinking 字段 | 仅显式传入时携带；thinking_mode 缺省（auto）下规划轮传 enabled 需容忍 4xx——失败重试一次不带该字段（chat 层兜底） |
| 采样并行触发上游限流 | 并发=3（同 key 顺序 3 采样→并行 3），deepseek 限流余量内；429 时退串行重试 |

## 7. 交付物

- 代码：agent.ts 状态机、llm.ts/trial 路由 thinking 透传、ChatApp 进度 UI、eval 延迟/超时/并行/variants。
- 文档：本 spec、`docs/eval-report-speed-ab.md`（A/B 报告与默认档决策记录）。
- 不 push 线上，未经用户许可不部署（Vercel 关联 main，见 memory）。
