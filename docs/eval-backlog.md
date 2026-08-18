# eval 迭代清单（v1 收尾后）

来源：2026-08-18 eval 质量轨终评审分诊（Approved with minors）+ Task 11 实施疑虑。逐条判定转录自 `.superpowers/sdd/2026-08-18-eval-quality-rail/` 台账（workspace 已删，本文为唯一存档）。

## 下轮迭代必修 / 优先

- **report 硬编码 /3 与静态文案**：`eval/lib/report.mjs:61-63` 边界信号分母硬编码 3、"这 10 条"文案静态——`runs≠3` 或分批跑时分母错。修法：用 `results.variant.runs_per_case` 参数化两处。
- **writeResults 同日同 variant 重跑静默覆盖**（Task 11 已实际踩到，覆盖了同日冒烟产物）：runId 加时间戳。
- **Task 11 疑虑①**：trap-hallucinated-command s0 是 `waitForFunction` 60s 超时（评测侧时序，非 LLM 能力）——迭代循环优先复核 settleReady/中止语义。
- **Task 11 疑虑②**：trap-budget 的 process_error 仅"error 事件×1"粒度——修复前读轨迹事件定位根因（幻觉命令 vs 工具报错）。

## 扩 30 条时补

- `relation_bool` / `label_visible` 用例覆盖（v1 十条零用例，仅单测）。
- dyn 断言补强：slider 初始值=2 未断言、k 与直线实际绑定未验证——v1 dyn 桶 100% 读数偏乐观（用户审核门裁决③接受为已知限制）。
- `visual_inspect_ok` 取最后一条"成功"而非严格最后一条（宽松方向，与 visual 断言一起改）。
- `relation_bool` 大小写敏感（'True' 落数值分支；GeoGebra 输出小写）。

## 健壮性 / 清理（顺手做）

- 显式 `--case` 时 `_` 前缀坏 JSON 会 parse 崩（`loadCases` 全量加载；修复前既有暴露面，case 文件是仓库受控资产）。
- `loadCases` 吞 `readdirSync` 错误（0 案例守卫已收敛为 exit 1，残余仅文案不精确）。
- aggregate 测试缺口 ×3、null failureClass 折 run_error、未知 category 死代码。
- report 测试正则析取第一支永不匹配；`writeResults` 零测试。
- `--out` 归档的对比报告缺矩阵（设计如此，README 已写明 `--compare` 走 stdout；归档对比时注意）。
- 裸 `textarea`/`.send-btn` 选择器脆弱（UI 改版时 eval 先红，属可接受契约钉）；`drainEvents` 的 page 参数未用；GET `?id=` 返回 `{}` 与 switchSession 期望不符（eval 内不可达）。
- settleReady 1.5s 启发式（rounds=0 守卫已兜底）。
- `buildByokPayload` 死 export（无外部 import，browser 层无单测）。
- 坏 xml 测试仅覆盖空串；interpolate `String()` 强转未测；`parametric_ref` 变量名未转义 RegExp（GeoGebra 标签为标识符，无可命中元字符）。
- runner 采样 `timedOut`/`verifyCount`/`renderCount`/`failCmds`/`inspectPassed` 为 evidence-only 字段（正当用途，备案）。

## 纪律项

- **`NEXT_PUBLIC_EVAL_BYPASS_AUTH` 是 Next 构建期内联**：生产/CI 构建永远禁设（带此 env 的构建客户端门控被永久旁路）。建议 DEPLOY.md 加一句明示。
- 本机裸 `diff` 命令被 DevEco-Studio 工具链劫持（对差异静默返回 0）——一切比对用 `git diff --no-index`。

## 后续计划（不在 v1）

- 扩 30 条用例（分桶 5/5/5/8/7）。
- 裸 LLM 基线对比（规格任务 2：同用例单次调用无工具，四列对比表）。
- 归因→修复→复测迭代（规格任务 3，`--compare` 矩阵出提升曲线；攻击点见 docs/eval-report-v1.md 结论与归因段：错误恢复勿中止、幻觉命令回退重画）。
- 社区 .ggb 断言挖掘（规格 §3.1⑨，v2）。
