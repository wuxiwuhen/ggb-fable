# Eval

画布生成效果 eval（规格: docs/superpowers/specs/2026-08-18-quality-first-design.md §3/§3.1）。
判分零 LLM：全部断言为确定性代码。

## 用法
- `pnpm eval:unit`                          # eval 模块单测（vitest）
- `pnpm eval -- --list`                     # 列出用例与断言（不跑浏览器）
- `pnpm eval -- --case _selftest --runs 1`  # 单用例冒烟（需先 `pnpm dev`）
- `pnpm eval -- --variant eval/variants/deepseek-v2.json`           # 基线（10 条 × 3 次）
- `pnpm eval -- --variant ... --compare eval/reports/<旧>.results.json`  # 对比旧 results 出矩阵

## 约束
- key 从 `.env.local` 经 `node --env-file` 读，variant JSON 只存环境变量名
- 产物在 `eval/reports/`（gitignore）；正式报告落 `docs/eval-report-v1.md`
