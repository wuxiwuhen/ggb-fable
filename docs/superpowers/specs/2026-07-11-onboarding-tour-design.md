# GGB Fable Web — 新手引导（Onboarding Tour）设计

> 日期：2026-07-11  
> 状态：设计已确认，待实现  
> 适用范围：仅画布工作台页 `/app`（登录后），单页内完成全部引导

## 1. 背景与目标

产品是 K12 GeoGebra AI 画布助手：用户用自然语言描述数学图形，AI agent 调用 GeoGebra 命令在画布上画出来，可图片识别、连续追指令、查看执行历史、编辑重建脚本重画、导出 PNG/视频。

第一次使用的用户不清楚「能做什么、怎么做」。本设计提供一个**分步高亮式新手引导**，按一次完整交互 + 内容导出的顺序，带新用户走通核心闭环，并可选地了解进阶能力。

## 2. 核心决策（已与用户确认）

| 维度 | 决策 |
|---|---|
| 触发时机 | **D**：首次进入 `/app` 自动触发基础教程一次（localStorage 记忆）+ 顶栏常驻「📖 教程」入口随时重看 |
| 深度分段 | **B**：基础教程（6 步核心闭环，首次自动）+ 进阶教程（3 步，可选） |
| 交互形态 | **C**：讲解为主 + 在「对话框输入」步骤预填经典动画示例、不强制发送 |
| 引擎选型 | **自研** `<OnboardingTour>` 组件 + 一段 CSS，零新依赖（不引入 driver.js 等） |

## 3. 组件架构

### 3.1 新增文件

```
components/OnboardingTour.tsx   引擎：步骤状态机 + 高亮遮罩 + 气泡 + 键盘交互 + preEnter/waitFor/postExit
lib/onboarding-steps.ts         步骤数据：basicSteps[]（6 步）、advancedSteps[]（3 步）
lib/useOnboarding.ts            触发与持久化 hook：首次检测 + ggbReady 等待 + 启动/重看入口
```

### 3.2 需改动文件（只补锚点 + 接入，不动业务逻辑）

- `components/ChatApp.tsx`：补 `data-tour` 属性、顶栏新增「📖 教程」按钮、接入 `useOnboarding`
- `components/SessionSidebar.tsx`：补 `data-tour="session-list"`
- `components/CommandBar.tsx`：补 `data-tour="command-history"`、`data-tour="recipe-tab"`
- `app/globals.css`：新增引导遮罩/气泡样式（沿用现有 indigo `#4f46e5` + `#f7f8fa` 语言）

### 3.3 引擎数据结构

```ts
type TourStep = {
  anchor?: string;            // CSS 选择器；缺省 = 屏幕居中卡片（不锚定，用于欢迎/结束）
  title: string;
  body: string;               // 纯文本（关键词用「」或加粗强调）
  side?: 'top' | 'bottom' | 'left' | 'right';  // 气泡相对锚点位置，默认 bottom，空间不足自动翻转
  preEnter?: () => void;      // 进入本步前同步操纵 UI 状态（打开侧边栏 / 展开面板等）
  postExit?: () => void;      // 离开本步后还原 UI 状态
  waitFor?: () => boolean;    // 可选：轮询条件，DOM 渲染/状态生效后才计算高亮位置（绕开折叠/隐藏陷阱）
  cta?: string;               // 可选行动提示（如「点发送即可看到画布动起来」）
};
```

**时序契约**（绕开三个折叠/隐藏陷阱的核心）：
1. 进入步骤 → 执行 `preEnter()`（setState 打开/展开目标）
2. 若有 `waitFor` → 轮询（间隔 50ms，最多 1s）直到条件成立或超时
3. 重新读取 `anchor` 元素的 `getBoundingClientRect()`，定位遮罩挖空区与气泡
4. 离开步骤 → 执行 `postExit()` 还原

## 4. 完整步骤脚本

### 4.1 基础教程 `basicSteps`（首次自动触发，6 步）

| # | anchor | preEnter | 标题 / 文案要点 | postExit |
|---|---|---|---|---|
| 1 | （无，居中卡片） | — | **欢迎使用 GGB Fable** ——「用一句话画出可探究的数学图形。30 秒带你上手核心玩法。」 | — |
| 2 | `[data-tour="composer"]` | **预填动画示例**到 textarea | **对话框** ——「在这里用自然语言描述图形，可连续追加指令（如『再画它的切线』）。`Cmd/Ctrl+Enter` 发送。示例已填好——点发送，你会看到画布**动起来**（计 1 次试用）。」 | 若用户未发送则清空预填 |
| 3 | `#ggb-container` | — | **画布** ——「AI 会读你的话、调用 GeoGebra 命令把图形画在这里，图形可拖动、缩放、探究。」 | — |
| 4 | `[aria-label="上传图片"]` | — | **图片识别** ——「拍一道题或截个图，OCR 自动识别成数学表达式再画出来——不占试用次数。」 | — |
| 5 | `[data-tour="mode-switch"]`（始终渲染，比仅 trial 模式可见的 usage-badge 更稳） | — | **额度与模式** ——「点这里在『免费试用』和『自带 Key』之间切换。免费试用送 5 次额度（旁边徽章显示剩余），用完切到『自带 Key』并在设置页填自己的 API Key 即可无限使用。」 | — |
| 6 | `[data-tour="export"]` | **setExportOpen(true)** 展开下拉 | **导出** ——「画布上的**动画**可录制成 🎬 MP4/WebM 视频；也可导出 🖼️ PNG 静态图。」 | **setExportOpen(false)** |
| 结束 | （无，居中卡片） | — | 「基础就这些 ✨ 你已能画图并导出。还想看看进阶功能（历史对话、执行历史、重建脚本）吗？」 `[继续进阶]` `[不了，开始用]` | — |

### 4.2 进阶教程 `advancedSteps`（可选，3 步）

| # | anchor | preEnter | 标题 / 文案要点 | postExit |
|---|---|---|---|---|
| 7 | `[data-tour="session-list"]` | **setSidebarOpen(true)**，记录原值 | **对话与历史** ——「这里是你的对话列表，可新建、切换、回看历史。每个对话的画布和指令都独立保存。」 | 还原侧边栏开合状态到原值 |
| 8 | `[data-tour="command-history"]` | 展开 `<details>` + 切到「执行历史」Tab | **执行历史** ——「每次画图实际执行的 GeoGebra 命令都在这，✓/✗ 标明成功与否，方便排查为什么没画出来。」 | 还原折叠/Tab |
| 9 | `[data-tour="recipe-tab"]` | 切到「重建脚本」Tab | **重建脚本** ——「可把命令脚本精简、编辑（比如改个参数），再 ▶ 重放重新画——改图重画不用从头对话。」 | 还原 Tab |

## 5. 预填示例（经典动画）

**主选：「单位圆动点生成正弦曲线」**

> 画一个单位圆，圆上动点 P 随角度 t 旋转（t 做成动画滑块），在右侧坐标系画出点 (t, sin t) 的轨迹，动态展示正弦曲线如何随 P 的转动被一步步「画」出来。

选它的理由：
- 数学教学里最经典的动画，视觉冲击强（圆上点转动 + 波浪线实时生长）
- 命中 agent 的「选动画变量」决策指导（t 是动画主体）与「动点轨迹」验收项，稳定性有保障
- 与第 6 步视频导出形成闭环：`lib/export-media.ts:81-84` 录制时会自动 `api.startAnimation()`，动画示例 → 画布动起来 → 导出视频录到真动画

**备选（若主选实测不稳）：「抛物线 y = a(x-h)² + k 参数动画」**

> 用动画滑块 a 控制抛物线 y = a(x-h)²+k 的开口大小，展示 a 变化时图像如何缩放。

函数图像由滑块表达式直接驱动，几乎不会失败，作为兜底。

**实测选优机制（实现时执行）**：把主选与备选各跑一遍 agent，选成功率最高、出图最稳的写死为预填内容。

## 6. 视觉风格

- **遮罩**：全屏半透明深色 `rgba(15,23,42,0.55)`，高亮元素处「挖空」（4 块固定定位 div 拼出洞口），高亮元素叠 2px `#4f46e5` 描边 + `box-shadow` 柔光
- **气泡卡片**：白底、圆角 12px、轻投影、indigo `#4f46e5` 标题、深灰正文；底部 `跳过 / 上一步 / 下一步` + 步骤计数（如 `2/6`）+ 圆点进度条
- **定位**：默认锚点下方，空间不足自动翻转到上/侧；顶栏元素（额度/导出）气泡朝下，输入框气泡朝上，画布气泡朝左
- **欢迎/结束卡**：无锚点，屏幕居中
- **交互**：ESC / 点遮罩 = 跳过当前段；`→` 下一步、`←` 上一步（键盘可达）

## 7. 触发与持久化

- **localStorage** `ggb-fable-onboarding` = `{ v: 1, basicSeen: boolean, advancedSeen: boolean }`（`v` 便于以后改版重新触发）
- **首次自动**：`ChatApp` mount → 等 `ggbReady === true`（画布就绪才能定位 `#ggb-container`）→ 若 `!basicSeen` → 启动基础教程
- **常驻入口**：顶栏 brand 区右侧新增「📖 教程」按钮（`data-tour="tutorial"`），点击弹下拉：`从基础开始` / `只看进阶` / `重新完整体验`（基础+进阶连播）—— 三条均不检查 localStorage，随时可看
- **完成回调**：基础走完 → `basicSeen=true` + 弹结束卡询问是否进阶；进阶走完 → `advancedSeen=true`
- **中途退出**（X / ESC / 点遮罩）：标记当前段 seen，尊重用户不再自动弹

## 8. 锚点补全清单

| 文件 | 补 `data-tour` | 备注 |
|---|---|---|
| `ChatApp.tsx` | `composer`、`mode-switch`、`usage-badge`、`export`、`sessions-toggle`、`tutorial`（新增按钮） | OCR 已有 `[aria-label="上传图片"]`、画布已有 `#ggb-container`，无需补 |
| `SessionSidebar.tsx` | `session-list` | |
| `CommandBar.tsx` | `command-history`（summary）、`recipe-tab` | |

## 9. 边界与错误处理

- **元素找不到**：`preEnter` + `waitFor` 轮询 ≤1s 仍缺 → 跳过该步并记 warning，不卡死，继续下一步
- **画布加载慢**：等 `ggbReady` ≤15s，超时则第 3 步降级为居中卡片讲解（不强依赖 `#ggb-container`）
- **引导中禁用底层交互**：遮罩拦截所有点击，只放行气泡按钮——防止用户误触发扣额度 / 清空画布 / 乱开面板
- **resize/scroll**：监听重算高亮位置（防抖 50ms）
- **录制态冲突**：启动引导前若 `recording===true`，先提示停止录制（否则第 6 步导出菜单会被「停止录制」按钮顶替）
- **发送/停止互斥**：第 2 步只锚定输入区容器，不锚定发送按钮（按钮态会变）
- **卸载清理**：路由切换 / 登出时清定时器 + 执行未完成的 `postExit` 还原 UI

## 10. 测试策略

项目无测试框架，不引入。验证方式：

1. **手动走查**：9 步 × 2 触发路径（首次自动 / 常驻入口）× 边界场景（画布慢加载、引导中 resize、中途关闭、BYOK 模式启动、录制态启动）
2. **重点验证**：① 每步高亮定位准 ② 折叠/隐藏步骤能自动展开→讲完→还原 ③ 预填示例稳定出图（实测选优）④ localStorage 持久化与常驻入口正确 ⑤ 动画示例 + 视频导出闭环成立
3. 至少 Chrome 跑通；Safari/Firefox 抽验定位与遮罩

## 11. 待验证项（实现时落实）

- [ ] 预填动画示例实测选优（主选「单位圆正弦曲线」vs 备选「抛物线参数动画」）
- [ ] `waitFor` 机制在三个折叠/隐藏步骤（侧边栏 / CommandBar / 导出菜单）上时序稳定
- [ ] `ggbReady` 等待 + 超时降级路径有效

## 12. 不做的事（YAGNI）

- 不引入 driver.js / react-joyride 等引导库（自研足够，且需与 React state 深度联动）
- 不做引导进度服务端持久化（localStorage 足够，匿名/低频功能）
- 不做 BYOK 配置的深度引导（基础教程只点到「去设置页配 Key」，保持单页体验）
- 不做 TracePanel（Agent 工具轨迹）的引导——它仅管理员可见，非普通用户目标
- 不做暗色模式适配（项目无暗色模式）
- 不做多语言（项目全中文）
