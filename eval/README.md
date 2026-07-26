# Eval

画布生成效果 eval 系统(详见 docs/superpowers/specs/2026-07-26-eval-design.md)。

## 用法
- `pnpm eval -- --version v2`            # 跑 eval(v2 prompt, 单样本); 需先 `pnpm dev`
- `pnpm eval -- --version v2 --rigorous 3`  # 多样本 pass-rate
- `pnpm eval:intake <id>`                # raw/<id>/ → cases/<id>.yaml 草稿 + 核查报告
- `pnpm eval:manual <id>`                # 打印/复制 case 题目供手动冒烟
- `pnpm eval:test`                       # 跑 eval 模块单测

## 资料准备
往 `eval/raw/<id>/` 放: problem.txt(题目) + source.ggb + (可选)notes.txt。
然后 `pnpm eval:intake <id>` 标准化入库。
