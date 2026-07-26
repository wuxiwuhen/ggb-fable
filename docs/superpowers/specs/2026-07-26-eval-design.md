# 画布生成效果 Eval 系统 Design Spec

> **状态**: 设计已与用户对齐(2026-07-26), 待写实现计划。
> **背景**: 当前画布生成效果完全靠用户主观感觉判断, 成为优化瓶颈。本 spec 设计一套可重复、可比对、可归因的 eval 机制, 让"提示词/ harness 迭代是否变好"从感觉变成数字, 并最终支撑(半)自动化的 prompt 优化闭环。

---

## 1. 目标 / 非目标

### 目标
- **可重复测量**: 给一批标准化的 K12 题目, 跑 agent, 对画布产物按"正确性 / 健壮性 / 视觉"三维度自动评分, 同输入可比对。
- **回归守门**: 每次提示词或 harness 迭代后跑一遍, 客观判断新版 vs 旧版谁更好、好在哪、为什么。
- **诊断归因**: 失败能定位到 prompt 的**具体规则段落**(不止给分数, 给病因)。
- **沉淀资产**: 标准化做一次、固化为可复用 case 资产; 资产同时服务于自动 eval、手动冒烟、回归集。
- **支撑自动化迭代**: 地基(结构化输出、基线、train/holdout、归因)在 v1 就铺对, 为后续半自动治疗闭环(L2)和带保护的全自动迭代(L3)铺路。

### 非目标
- v1 **不做** L2 治疗闭环(prompt patch 自动生成)、不做 L3 全自动采纳——这些是 Phase 2/3。
- v1 **不做** 解释质量(finalText 的数学推导/LaTeX)的深度评分——三维度聚焦画布; LaTeX 仅做"无裸 `\frac`"这类轻量客观项。
- **不追求绝对客观**, 追求"可重复、可比对、可归因"(详见 §6)。
- **不引入** 测试框架(沿用项目惯例: typecheck + build + 端到端验证); eval 是独立的 Node 脚本, 不进 app 运行时。

---

## 2. 核心理念(贯穿全设计)

1. **资产化、两阶段**: 用户给原始料 → Claude 标准化为固化的 case 资产 → eval 只消费资产。标准化做一次, 不重算。
2. **`results.json` 是地基, markdown 是皮肤**: 机器读 JSON 做归因/优化; 人读 markdown 报告。两者由同一份结构化结果渲染。
3. **自动化迭代是个谱系, 不是有无**:
   - **L1 诊断归因**(入 v1): 失败 → 指到 prompt 哪条规则。
   - **L2 治疗建议**(Phase 2): LLM 读归因+prompt → 生成 patch → eval 验证 → 人审。
   - **L3 全自动采纳**(Phase 3, 默认关): AI 改+eval 通过即采纳, 带回归保护。
4. **防 overfit 是头号约束**: eval 集小, 反复优化必过拟合; 用 train/holdout 划分 + 持续加题对抗。

---

## 3. 架构总览

```
                    cases/*.yaml (固化的标准资产, §4)
                           │
              ┌────────────▼────────────┐
              │  runner (Playwright, §7)│  ← BYOK backend(绕过trial) + 拦截prompt-text(force版本)
              └────────────┬────────────┘
                           ▼
              agent 跑完 → 捕获 {XML, PNG, finalText, trajectory}
                           ▼
              scorer (§5) ── 确定性断言(正确性+健壮性) + 视觉judge(视觉)
                           ▼
              results.json (结构化, §8)  ◄── L2/L3 机器消费
                           │
              ┌────────────┼──────────────┐
              ▼            ▼              ▼
         markdown报告   baseline.json   归因聚合(§9)
         (给人看)       (回归基准)     (按prompt规则聚合失败)
```

**关键事实(决定 runner 形态)**: agent + GGB 桥接**只在浏览器跑**(`ggb.ts` 依赖 `document`/`window`/`GGBApplet`)。所以 eval 不能"在 Node 里调 agent", 必须 Playwright 驱动真实 app + 真实 GeoGebra applet(软件 WebGL)。社区 `.ggb` 解压后的 XML 与 applet `getXML()` 同源, agent 产物与参考构造**结构可比**(见 §4.3)。

---

## 4. 资产模型

### 4.1 两阶段目录
```
eval/raw/<id>/              ← 用户给的原始料(标准化后归档, 不被 eval 直接消费)
  problem.txt               # 题目原文(社区页文字 / 或标注"ggb里有Text")
  source.ggb                # 社区源文件
  notes.txt                 # 【可选】"这题重点看什么" / 维度 / 知识点 / 难度

eval/cases/<id>.yaml        ← Claude 标准化后【固化】的资产(eval 真正消费的, 只增不减)
eval/fixtures/ggb/<id>.ggb  ← 从 raw 拷入的源文件(解析 reference 用)
eval/fixtures/reference/<id>.json  ← 从 .ggb 解析出的 gold 结构(生成物, 固化不重算)
```

### 4.2 标准 case schema(`eval/cases/<id>.yaml`)
```yaml
id: tangent-external-point
meta:
  title: 过圆外一点作切线
  problem: |                  # 【标准化题目】从社区页/ggb Text 提取并规范化; 同时供手动冒烟粘贴
    过圆 O 外一点 P 作圆的两条切线
  dimension: 2D               # 2D | 3D (Claude 标, 用户可改)
  topic: [解析几何, 切线, 圆]
  difficulty: 2               # 1-3 (Claude 标)
  key_insight: 切线⊥半径; P 移动时切线随之变化  # Claude 提炼的不变关系/教学重点
  animation: { hasAnimation: true, slider: P_pos, frames: [0, 0.5, 1] }  # 是否含动画+主滑块+代表帧; 静态题 hasAnimation:false
  representativeFrame: { slider: P_pos, value: 0.5 }  # 视觉截图前复位到此(§5.2 视觉捕获协议)
  source: { url, ggb_file, retrieved_at }
reference:                    # 从 .ggb 解析固化(§4.3); 仅当检查清单/诊断依据, 非唯一解
  object_inventory: [{type:circle,min:1},{type:point,min:3},{type:line,min:2}]
  free_vars: [{name:k,type:slider,min:-5,max:5}]   # 暗示"该题应可拖"
assertions:                   # Claude 推导、用户审过; guards 强制必填(§9 归因用)
  - kind: object_exists
    find: { type: circle, min: 1 }
    guards: ["约束闭环"]
  - kind: object_exists
    find: { type: line, min: 2 }
    guards: ["约束闭环"]
  - kind: invariant
    name: 半径⊥切线
    select:                   # 用"选择器+别名", 不写死标签(agent 画法不唯一)
      O: { type: point, role: 圆心 }
      T: { type: point, role: 切点 }
      l: { type: line, role: 切线 }
    expr: "ArePerpendicular(Line(O,T), l)"
    expect: true
    guards: ["约束闭环"]
  - kind: parametric          # 健壮性: 派生量依赖自由变量(非硬编码)
    message: 切线随 P/参数变化, 非硬编码
    guards: ["约束闭环·派生量写成自由变量函数"]
visual_rubric: inherit        # inherit(用默认) 或显式列项
split: train                  # train | holdout (§10 防 overfit)
provenance:                   # 资产溯源
  derived_from: raw/tangent-external-point/
  author: claude+human
  reviewed: true
  version: 1
```

### 4.3 reference 怎么从 .ggb 解析(固化)
`.ggb` 是 zip, 解压得 `geogebra.xml`。解析出(写进 `fixtures/reference/<id>.json`):
- **object_inventory**: 元素类型计数(point/segment/line/circle/polygon/text/...)。
- **free_vars**: `<slider>` 的 min/max/inc + 自由点 `<point>` 无 `<parent>` 的。
- (不做: 不解析具体标签/坐标/颜色——这些不 transfer, §6。)

### 4.4 资产单源多用途
同一份 `cases/*.yaml` 喂三个消费者:
1. **自动 eval**: runner 读 `meta.problem` 喂 agent。
2. **手动冒烟**: `pnpm eval:manual <id>` 把题目打到终端/剪贴板, 直接粘进 web 端人肉测。
3. **回归集 / L2 训练集**: 见 §9/§10。

### 4.5 Case 资产管理(intake & review)模块
eval 数据是这套机制**最重投入、最需保质**的资产——用户持续收集原始料 + 核查 Claude 完善后的标准化结果。设独立模块支撑这个循环:
- **`pnpm eval:intake <id>`**: 读 `raw/<id>/` → 解 ggb(`parse-ggb`) → 推断言/难度/维度/动画/代表帧/split → 生成 `cases/<id>.yaml` 草稿 + **intake 报告**(逐条打印每个标准化决定 + 标"需确认"项: 推断的不变关系、断言验的关系对不对、split 归属、难度、代表帧选得对不对)。
- **核查循环**: 用户看 intake 报告 → 直接改 yaml / `--regenerate` 重生成 → `provenance.reviewed=true` 入库; 改过断言语义 `provenance.version++`。
- **持续收集**: 用户往 `raw/` 不断加料, intake 逐个标准化入库; 资产只增、改语义必 bump version(可追溯)。
- v1 做 **CLI intake + 报告输出**(不做 Web UI, YAGNI); 它也是 Phase 2"`.ggb` 半自动入库"的基础。

---

## 5. 评分模型(三维度)

### 5.1 确定性断言(正确性 + 健壮性)——在 agent 的真实画布上验
runner 跑完 agent 后, 通过 `page.evaluate` 直接调 applet API(`exists`/`getObjectType`/`getValueString`/临时建对象取值再删——复用 `ggb.ts` `measure()` 的成熟套路):
- **`object_exists`**: 遍历对象, 数 `find.type` ≥ `find.min`。
- **`invariant`**: 按 `select` 选择器找对象绑别名 → 临时执行 `expr`(变量替换为别名标签)取值 → 比对 `expect`。**选择器按 type/role 匹配, 标签无关**; 匹配不到 → 该断言判 fail(本身就是有效信号: agent 没画出该有的东西)。
- **`parametric`(v1 静态)**: 解析 agent 画布 definition, 确认关键派生对象引用了自由变量(slider/自由点)而非硬编码坐标。(Phase 2 升级为**拖动后重测不变量**——真正验"约束闭环"。)

### 5.2 视觉 judge(视觉)——细粒度 rubric + 配对偏好
rubric 从 `inspect_render` 清单 + prompt 视觉规范提炼, 每项**接近客观的二值判定**:
- 关键点(顶点/交点/动点)标签是否显示
- 辅助线(高/中线/角平分线/构造垂线平行线)是否虚线
- 标签是否遮挡/重叠
- 图形是否贴边/被坐标轴切
- 角弧是否 >180° 异常
- 颜色是否 ≤4 且语义清晰
- Text 公式是否正常渲染(无裸 `\frac`/`^2`)
- 整体是否"看得懂"

**两招降主观**:
1. **细粒度 rubric**: 拆成上面这些 0/1 项, 而非"打整体好看分"。
2. **配对偏好**: 同一题让 judge 直接比 **v1 产物 vs v2 产物谁更好(A/B/平)** + 逐项差异, 不评绝对分。配对比较消除 judge 的绝对标尺漂移, 是 LLM-judge 可信的标准技巧。
- v1 **单 judge**(用配置的 **GLM vision** 模型, key 来自 `.env.local`; 效果不佳 Phase 2 换更强模型); Phase 2 上**多 judge + 一致性检查**(分歧 case 标"低置信", 不作改 prompt 的强信号)。

**视觉捕获协议(防截图时机误导——重要, 视觉对比的可信前提)**:
用户特别强调: 视觉对比在很多场景比 xml 对比起更关键作用, 但截图时机可能反作用(典型: 动图运行中截图落在瞬时退化帧)。协议:
- **截图前标准化画布状态**: `StopAnimation()` 停所有动画 → 把声明的主滑块 `SetValue` 到 case 的**代表帧**(`meta.representativeFrame`, §4.2) → 等渲染稳定(短 delay) → 截图。
- **动图是头号风险**: 动画运行中截图会落在任意瞬时帧(动点在端点退化姿态 / 轨迹未展开 / 对象瞬间重叠), judge 会把"坏截图"误判成"坏画布"。停动画 + 复位代表帧是 v1 解法。
- **配对比较必须同帧**: v1 vs v2 比较时, 两者都复位到**相同** representativeFrame 再截图, 差异才归因于版本而非帧。
- **静态题不受影响**: `animation.hasAnimation=false` 的题直接截图。
- Phase 2 升级: 动画题**多帧采样**(初值/中段/末段), 取最差帧或聚合, 进一步降"恰好截到好/坏帧"的偶然性。

### 5.3 聚合
每 case → 各断言 pass/fail + 视觉 rubric 各项 + 配对偏好结论; 聚合成 case 分、维度分、规则分(§9)。

---

## 6. 客观性说明(诚实边界)

- **xml diff 不是评分依据, 是诊断工具**: agent 画法不必等同 gold(同切线题, gold 用 `Tangent`, agent 用 `Intersect`+`PerpendicularLine` 都合格)。"像不像 gold"≠"好不好", 把它当目标会 overfit 到特定画法。gold 的用途: ①证存在合格画法 ②给 Claude 推断言提供依据 ③诊断时看差异。
- **正确性/健壮性**: 客观(机器断言), 上限是断言召回(只能验想到的)——靠"Claude 推导+用户审"撑高。
- **视觉**: 半主观, 靠"细粒度 rubric + 配对偏好"压到最低(§5.2)。
- **立场**: 不追求客观真理, 追求**可重复、可比对、可归因**——能可靠回答"v2 比 v1 好吗/好在哪/为什么"。

---

## 7. Runner 架构(Playwright)

### 7.1 侵入性(最坏 1 行)
| 需求 | 方案 | 侵入 |
|---|---|---|
| 绕过 trial quota/auth | eval 走 **BYOK 路径**: Playwright 写 BYOK profile 到 `config-store`(localStorage) + `setMode('byok')`, agent 直连厂商 | 零 |
| force-load 指定 prompt 版本 | Playwright `page.route` **拦截 `/api/config/prompt-text`**, 返回 `{version, text: fs.readFileSync('prompts/<target>.md'), source:'eval'}` | 零 |
| 拿 trajectory + finalText | `page.route` 拦截 logger 的 `/api/sessions` flush, 从请求体提取 `tool_call`/`ggb_exec`/`turn_end` | 零 |
| 拿 XML + PNG | `window.ggbApplet.getXML()`/`getPNGBase64()`(GeoGebra 默认全局挂); 若不可用, `ggb.ts` 加一行 `window.ggbApplet = api` | 0~1 行 |

生产构建若不触发 eval, 这行是死的(applet 全局挂载是 GeoGebra 默认行为, 多数情况已可用)。

### 7.2 运行流程(单 case)
1. 起 headless Chromium(`--enable-unsafe-swiftshader` 软件 WebGL)。
2. `page.route` 装拦截: prompt-text 返回目标版本; `/api/sessions` 旁路抓 trajectory。
3. `page.addInitScript` 注入 BYOK profile(eval key 来自 `.env.local`)到 localStorage, 设 mode=byok。
4. 加载 `localhost:3000`(本地 `pnpm dev` 已起), 等 applet 就绪。
5. 填 `meta.problem` 进输入框 → 点发送 → 等 agent `turn_end`(监听 `/api/sessions` 的 turn_end, 或 wall-clock 超时)。
6. `page.evaluate` 抓 XML + PNG。
7. 交 scorer。
8. **每 case: wall-clock 超时(如 120s) + 失败重试 1 次**(软件 WebGL 偶崩/agent 卡)。

### 7.3 确定性
默认 **1 样本/case**(快, 开发反馈); `--rigorous N`(3-5)跑多遍报 **pass-rate**, 用于版本判决与 L2/L3 验证。厂商若支持 seed 则固定。

### 7.4 入口
`pnpm eval [--version v2] [--rigorous 3] [--split train|holdout|all] [--case <id>] [--baseline <file>]`

---

## 8. 输出: results.json(机器层) + markdown(皮肤)

### 8.1 `eval/reports/<runId>.results.json`(地基, L2/L3 消费)
```jsonc
{
  "runId": "2026-07-26T...-v2",
  "promptVersion": "v2",
  "samples": 3,
  "cases": [
    {
      "id": "tangent-external-point",
      "split": "train",
      "samples": [
        {
          "assertions": [
            { "kind":"object_exists","name":null,"passed":true,"guards":["约束闭环"] },
            { "kind":"invariant","name":"半径⊥切线","passed":true,
              "failureClass":null,"guards":["约束闭环"] }
          ],
          "visual": {
            "pairedPreference": "v2",        // A/B/tie (仅多版本对比时)
            "items": [ {"name":"辅助线虚线","ok":true}, {"name":"角弧<=180","ok":false} ],
            "issues": ["右上角弧成 270°"]
          },
          "process": { "toolRounds":6, "hitCap":false, "failCmds":1, "stopped":false },
          "artifacts": { "xml":"reports/<runId>/<id>.xml", "png":"reports/<runId>/<id>.png" }
        }
        // ... N 样本
      ],
      "passRate": 0.67                         // 该 case 的综合通过率
    }
  ],
  "aggregate": {
    "byDimension": { "correctness":0.9, "robustness":0.8, "visual":0.7 },
    "byRule": { "约束闭环":0.85, "视觉规范·角弧默认不标":0.6, "LaTeX铁律":1.0 }  // §9
  }
}
```

### 8.2 markdown 报告(渲染层, 给人看)
- 总览: 版本×维度 得分矩阵。
- 版本 diff: v1→v2 各 case/各维度升降(标红/绿)。
- **L1 归因段**: "「角弧默认不标」规则在 3/15 题失效" —— 指到 prompt 段落。
- 失败 case 附 PNG + trajectory 摘要(看到为什么挂)。

---

## 9. L1 诊断归因(v1 内)

两条腿:
1. **guards 强制必填**: 每条断言/视觉项标注它守护的 prompt 规则(枚举自 prompt 小节名: `约束闭环`/`操作纪律`/`验证与视觉检查`/`视图`/`视觉规范·线型`/`视觉规范·角弧默认不标`/`视觉规范·标签`/`LaTeX铁律`/`回复规范`/`约束闭环·派生量写成自由变量函数`/...)。
2. **失败分类枚举**(机器聚合用): `object_missing` / `invariant_violated` / `parametric_fail` / `visual_label_missing` / `visual_aux_solid` / `visual_angle_arc` / `visual_clipped` / `latex_garbled` / `hit_cap` / `wrong_dimension`。

聚合: results.json 的 `aggregate.byRule` 直接报"哪条规则在多少题失效" → markdown 归因段指到 prompt 对应段落。xml-diff(agent vs reference)在这步当辅助: 标出 agent 在哪几题缺了/多画了某类对象。

---

## 10. 防 overfit(train/holdout)

- **划分**: case 标 `split: train | holdout`(v1 约 7 train / 3 holdout)。L2 的 patch 只在 train 上"看着升分", **采纳前必须在 holdout 上不退化**。
- **持续加题**: 用户挑题容易 → 定期往 case 集加新题(天然新鲜度注入, 对抗过拟合)。
- v1 先建划分机制, holdout 实际把关在 L2(Phase 2)生效; v1 的版本对比报告也会分别报 train/holdout 分, 让人肉眼察觉"train 涨但 holdout 跌"的过拟合信号。

---

## 11. 优化闭环(L2/L3, 设计先行)

### 11.1 L2 治疗建议(Phase 2)
`pnpm eval:optimize`(编排脚本 `optimize.mjs`):
1. 读最近 `results.json` 的归因(`byRule` + 失败 case 的 trajectory/png)。
2. LLM 读 `{归因报告 + 当前 prompt 全文}` → 输出 **prompt patch**(每处改动 + 理由 + 预期修复哪些失败)。
3. 写成 `prompts/vN-candidate.md`, eval 自动跑该候选版本(`--version` 指向候选)。
4. 判据: train 集**升分** 且 holdout **不退化** → 输出"旧 vs 候选"对比报告 → **人审**采纳(走现有 prompt 版本发布: `lib/server-prompts.ts` 加条目 + admin 发布)。

### 11.2 L3 全自动采纳(Phase 3, 默认关)
L2 流程但跳过人审, eval 通过即自动发布。**强制带回归保护**: `baseline.json`(§12)锁定已知好版本的 per-case 结果, 任一 case 退化超阈值 → 一票否决。CLAUDE.md 明示 prompt/agent 是"几十轮验证资产", 故 L3 默认关闭。

**放开前置条件(三者齐备才逐步放开, 否则维持人审)**: ① eval 数据量足够(用户持续加题至规模可信); ② 流程经验证有效(L2 半自动实测能稳定带来提升); ③ baseline 回归保护实测可靠。

---

## 12. 基线与回归保护

- **`eval/baseline.json`**: 锁定某 prompt 版本(如 v1)的 per-case / per-rule 结果作为回归基准。
- 用途: ① L3 安全网; ② 任何新版本/候选, 与 baseline diff, 标出"哪些题退步"。
- v1 就建立 v1 为 baseline; 后续发版时滚动更新(新 baseline 需人工确认)。

---

## 13. 资料准备 + 分工

**用户准备(每题一个 `raw/<id>/` 文件夹)**:
1. `problem.txt` —— 题目原文(社区页文字, 或标"ggb 里有 Text")。
2. `source.ggb` —— 社区源文件。
3. `notes.txt`(可选) —— "这题重点看什么" / 维度 / 知识点 / 难度。

**Claude 做(标准化, 固化为资产)**:
- 解 `source.ggb` → `reference/<id>.json`(object_inventory + free_vars)。
- 从题 + ggb 提取/规范化 `meta.problem`、标 `dimension/topic/difficulty/key_insight`。
- 推导 `assertions`(含 guards)+ 配 `visual_rubric` + 标 `split`。
- 产出 `cases/<id>.yaml` 草稿 → **用户审**(重点审"断言验的关系对不对")→ 入库。

**用户挑 10 题起**; 后续持续加题。

---

## 14. 与现有代码的关系
- **复用**: `ggb.ts` 的 `getXML`/`getPNGBase64`/`measure`(临时建对象取值, 断言器照搬); `prompts/*.md` + `lib/server-prompts.ts` 版本机制(eval 直读 .md 注入); `inspect_render` 视觉 rubric 思路; logger 的 `tool_call`/`ggb_exec`/`turn_end`(抓 trajectory)。
- **新增**: `eval/` 整目录(runner/scorer/judge/parse-ggb/report/optimize); runner 用 `page.route` 拦截, 不改 app 路由。
- **可能微改 app(最多 1 行)**: `lib/ggb.ts` init 后 `window.ggbApplet = api`(仅当全局未挂; 待实现时验证)。

---

## 15. 分阶段
- **Phase 1(v1, 本计划)**:
  - 资产化(raw→cases 固化, 含 `parse-ggb`) + **case 资产管理模块(`eval:intake` 标准化+核查报告, §4.5)**。
  - runner(Playwright + BYOK + 拦截 prompt-text/`/api/sessions` + window.ggbApplet + 超时重试)。
  - 确定性断言(object_exists/invariant/parametric 静态) + 视觉(细粒度 rubric + 配对偏好, 单 judge)。
  - **结构化 `results.json`** + markdown 渲染 + 版本 diff。
  - **L1 归因**(guards + 失败分类枚举聚合)。
  - **train/holdout 划分** + **baseline.json(v1 为基准)**。
  - 10 题。
- **Phase 2**: `--rigorous` 多样本 pass-rate; `.ggb` 半自动入库; **拖动验证健壮性**; 多 judge 一致性; **L2 治疗闭环**(`optimize.mjs`, train 升/holdout 不退 + 人审)。
- **Phase 3**: **L3 带基线回归保护的全自动采纳**(默认关); 持续加题机制。

---

## 16. 风险与对策
| 风险 | 对策 |
|---|---|
| 软件渲染 WebGL 慢/偶崩 | 每 case 超时 + 重试 1 次; 本地跑, 不依赖 CI |
| 选择器匹配不到对象 | 判 fail(有效信号, 非 bug) |
| vision judge 漂移 | 配对偏好 + 细粒度 rubric; Phase 2 多 judge 一致性 |
| LLM 随机 | `--rigorous` 多样本 pass-rate |
| agent 卡死/触顶 | 轮数上限(已有) + wall-clock 超时 |
| **过拟合 eval 集** | train/holdout 划分 + 持续加题(§10) |
| 断言召回不全 | Claude 推导 + 用户审; 失败 case 反哺新增断言 |
| LLM-judge/优化误改 prompt | L2 强制人审; L3 默认关 + baseline 回归保护 |

---

## 17. 文件清单
**新增**:
- `eval/cases/<id>.yaml`(10 个)、`eval/raw/<id>/`(原始料)、`eval/fixtures/ggb/`、`eval/fixtures/reference/<id>.json`
- `eval/lib/parse-ggb.mjs`(.ggb→xml→结构)、`runner.mjs`、`capture.mjs`、`scorer/{deterministic,vision-judge,aggregate}.mjs`、`report.mjs`、`attribution.mjs`(归因聚合)
- `eval/scripts/run.mjs`(`pnpm eval` 入口)、`manual.mjs`(`pnpm eval:manual`)、`intake.mjs`(`pnpm eval:intake`, §4.5 标准化+核查)
- `eval/reports/`(results.json + markdown + xml/png; 大文件 .gitignore 但保留 results.json 与 markdown)
- `eval/baseline.json`

**可能微改**: `lib/ggb.ts`(1 行, §7.1)。

**Phase 2/3 新增**: `eval/scripts/optimize.mjs`、`eval/lib/patcher.mjs`(LLM 生成 patch)、`eval/lib/paired-judge.mjs`(多 judge)。

---

## 18. 未决 / 后续
- `window.ggbApplet` 是否已全局可用 → 实现时验证, 决定是否需那 1 行。
- 视觉 judge v1 用配置的 GLM vision(已定); 效果不佳时 Phase 2 评估换更强模型。
- holdout 比例(7/3)与"持续加题"节奏, 跑起来后按过拟合信号调。
- L2 patch 的 LLM 是否能稳定产出可用的 prompt diff → Phase 2 实测后再定采纳策略。
