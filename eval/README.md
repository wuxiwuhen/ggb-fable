# Eval

画布生成效果 eval 系统(设计 spec 见 `docs/superpowers/specs/2026-07-26-eval-design.md`)。

## 用法

```bash
pnpm eval -- --version v1 --set-baseline      # 跑 v1 并写入 baseline.json(首次基线)
pnpm eval -- --version v2                      # 跑 v2, 自动 vs baseline 报退化
pnpm eval -- --version v2 --rigorous 3         # 多样本 pass-rate(默认 1)
pnpm eval -- --version v2 --compare v1         # 视觉配对偏好: 同帧配对 vs v1(消 judge 漂移, spec §5.2)
pnpm eval:intake <id>                          # raw/<id>/ → cases/<id>.yaml 草稿 + 核查报告
pnpm eval:manual <id>                          # 打印/复制 case 题目供手动冒烟
pnpm eval:test                                 # 跑 eval 模块单测(*.test.mjs)
```

> 评测类命令(`pnpm eval*`, 除 `eval:test`/`eval:manual`)需要先 `pnpm dev` 起本地 app,
> 且 `.env.local` 里有 GLM/DeepSeek key。

## 标准工作流

按序:

1. **收料**: 往 `eval/raw/<id>/` 放 `problem.txt`(题目) + `source.ggb`(+ 可选 `notes.txt`)。
2. **入库**: `pnpm eval:intake <id>` → 自动生成 `eval/cases/<id>.yaml` 草稿 + 核查报告;
   人工补 `invariant`/`difficulty`/`split` 等字段, 把 `provenance.reviewed` 改成 `true`。
3. **评测(首次基线)**: 先 `pnpm dev`, 再 `pnpm eval -- --version v1 --set-baseline`
   → 产出 `reports/*.{md,png,xml,results.json}` + 写入 `eval/baseline.json`(回归基准, 入库)。
4. **对比版本**: 改 prompt 后跑 `pnpm eval -- --version v2`
   → 自动 vs baseline, 报告退化 case(attribution 归到 guard 规则)。
5. **视觉配对偏好(vs v1)**: `pnpm eval -- --version v2 --compare v1`
   → 同帧配对比较, 消除 judge 漂移(spec §5.2)。
6. **手动冒烟**: `pnpm eval:manual <id>` 打印/复制题面, 人工核对画布。
7. **跑单测**: `pnpm eval:test` 确认 parse-ggb/case-loader/selector/deterministic/
   vision-judge/aggregate/attribution/report/baseline 全绿。

## 产物说明

- `eval/baseline.json`: 回归基准, **入库**。
- `eval/reports/*.md` / `*.png` / `*.xml` / `*.results.json`: 单次 run 产物, **不入库**(见 `.gitignore`)。
- `eval/cases/_smoke-parabola.yaml`: 管线自检 case, 非真实评测数据(见文件头注释)。

## 已知限制 (Phase 2)

这些是 Phase 1 的明确权衡, Phase 2 计划改进:

- **I3 — `?eval=1` 是生产可达的 eval 旁路**:
  runner 通过 `app/app/page.tsx` 的 `?eval=1` query 触发 eval 旁路(跳过登录重定向, 让匿名 BYOK 也能进 ChatApp)。
  仅 BYOK 流程, **不暴露任何资源**(无 quota / 无服务端 key / 无 token 发放), 但属 app 改动
  (spec §7.1 原定"零侵入"); 生产构建里这行逻辑始终在。Phase 2 考虑更稳的 eval-mode 信号
  (如构建期注入 `process.env.NEXT_PUBLIC_EVAL_MODE` 或独立 eval 入口路由)。

- **I4 — runner 靠 console log 字符串嗅探 CommandSearch 就绪**:
  `eval/lib/runner.mjs` 监听 `console` 输出 `向量全部缓存` / `跳过预热` 来判断 CommandSearch 初始化完成
  (search_command 依赖, 必须就绪才能让 agent 跑)。若 app 改这些 log 字符串, eval 会静默退化
  (等不到 ready → 20s 超时 → send 时 agentRef 仍 null → toolRounds=0, 全 case "通过"假象)。
  Phase 2 改用明确的 window 标志(如 `window.__ggbAgentReady`), 让"未就绪"显式失败而非静默通过。
