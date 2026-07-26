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
