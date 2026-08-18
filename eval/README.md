# Eval

画布生成效果 eval（规格: docs/superpowers/specs/2026-08-18-quality-first-design.md §3/§3.1）。
判分零 LLM：全部断言为确定性代码。

## 用法
- `pnpm eval:unit`                          # eval 模块单测（vitest）
- `pnpm eval -- --list`                     # 列出用例与断言（不跑浏览器）
- `pnpm eval -- --case _selftest --runs 1`  # 单用例冒烟（需先起 dev；`_` 前缀用例只在显式 `--case` 时可见）
- `pnpm eval -- --variant eval/variants/deepseek-v2.json --out docs/eval-report-v1.md`  # 基线（10 条 × 3 次）
- `pnpm eval -- --variant ... --compare eval/reports/<旧>.results.json`  # 对比旧 results 出矩阵

## 标准工作流
1. `pnpm eval -- --list` 查用例（默认跳过 `_` 前缀文件，官方跑只含裁决过的用例）
2. `pnpm dev` 起本地服务（eval 需要前端旁路时内联 `NEXT_PUBLIC_EVAL_BYPASS_AUTH=1`，勿写入 .env.local）
3. `pnpm eval -- --variant eval/variants/deepseek-v2.json --out docs/eval-report-v1.md` 跑基线
4. 改 prompt/工具后重跑，`--compare eval/reports/<基线>.results.json` 出 variant×category 矩阵
5. 扩用例：往 eval/cases/ 加 json（过 validateCase），断言用 10 原语填表

## 约束
- key 从 `.env.local` 经 `node --env-file` 读，variant JSON 只存环境变量名
- 产物在 `eval/reports/`（gitignore）；正式报告落 `docs/eval-report-v1.md`
