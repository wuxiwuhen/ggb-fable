# 新手引导（Onboarding Tour）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 `/app` 画布页加一个分步高亮式新手引导：首次自动触发基础教程（6 步核心闭环），顶栏常驻「教程」入口随时重看，可选进阶教程（3 步）。

**Architecture:** 自研 `<OnboardingTour>` 引擎组件（遮罩挖空 + 气泡 + 步骤状态机 + `preEnter/waitFor/postExit` 时序契约），步骤数据由工厂函数 `buildBasicSteps/buildAdvancedSteps` 生成并闭包引用 `ChatApp` 的 state setter；持久化用 `localStorage`；零新依赖。

**Tech Stack:** Next.js 15 App Router + React 19 + TypeScript 5.7，纯原生 CSS（`app/globals.css`，indigo `#4f46e5`），zustand，pnpm。

## Global Constraints

- **不引入任何新依赖**（不引入 driver.js / react-joyride / 测试框架）。spec 第 10、12 节。
- **项目无测试框架**：每个任务的验证周期 = `pnpm typecheck` + 关键节点 `pnpm build` + 手动浏览器验证清单（不写自动化测试）。
- **路径别名** `@/*` → 项目根（`tsconfig.json`）。hook 放 `hooks/`（与现有 `hooks/useGeogebra.ts` 一致），lib 放 `lib/`，组件放 `components/`。
- **UI 语言全中文**；视觉沿用现有色板：indigo `#4f46e5` / 浅 `#eef2ff` `#c7d2fe` `#a5b4fc` / 灰 `#e5e7eb` `#f7f8fa` `#555` `#888` `#9aa0a6`；圆角风格；CSS 注释分节 `/* ── xxx ── */`。
- **不动现有业务逻辑**：只给现有元素加 `data-tour` 属性、新增教程按钮、接入引导组件。
- **锚点操纵契约**：`CommandBar` 的 `<details>` 折叠与 tab 切换是内部 state（外部无 props 暴露），引导通过 DOM 辅助操控（设 `details.open` + 派发 `.cmd-tab` 点击）；`SessionSidebar` 默认 `if (!open) return null` 不渲染 DOM，引导前必须 `setSidebarOpen(true)`。
- 提交规范：中文 commit message，`feat:` / `fix:` / `style:` 前缀，结尾附 `Co-Authored-By: Claude <noreply@anthropic.com>`。每个任务结束提交一次。

---

## File Structure

| 文件 | 责任 | 动作 |
|---|---|---|
| `lib/onboarding-steps.ts` | `TourStep`/`TourCtx` 类型、`DEMO_EXAMPLE` 常量、DOM 操纵 helper（`openCmdBar`/`switchCmdTab`）、`buildBasicSteps(ctx)`/`buildAdvancedSteps(ctx)` 工厂 | 新建 |
| `hooks/useOnboarding.ts` | `localStorage` 读写、`active` state、`autoStartIfDue`/`start`/`markSeen` | 新建 |
| `components/OnboardingTour.tsx` | 引擎：遮罩挖空 + 气泡 + 步骤状态机 + 键盘 + `preEnter/waitFor/postExit` + resize 重算 | 新建 |
| `app/globals.css` | 追加引导遮罩/气泡/教程下拉样式 | 修改（追加） |
| `components/ChatApp.tsx` | 补 `data-tour` 锚点、顶栏新增「📖 教程」按钮+下拉、接入 `useOnboarding`、渲染 `<OnboardingTour>` | 修改 |
| `components/SessionSidebar.tsx` | 补 `data-tour="session-list"` | 修改 |
| `components/CommandBar.tsx` | 补 `data-tour="command-history"`（summary）、`data-tour="recipe-tab"` | 修改 |

**跨任务接口契约（所有任务遵循这些名字/签名）：**

```ts
// lib/onboarding-steps.ts —— 类型与工厂
export type TourSide = 'top' | 'bottom' | 'left' | 'right';
export interface TourCtx {
  setSidebarOpen: (v: boolean) => void;
  setExportOpen: (v: boolean) => void;
  setInput: (v: string) => void;
  getInput: () => string;
}
export interface TourStep {
  anchor?: string;            // CSS 选择器；缺省 = 屏幕居中卡片
  title: string;
  body: string;
  side?: TourSide;            // 默认 'bottom'，空间不足自动翻转
  preEnter?: () => void;
  postExit?: () => void;
  waitFor?: () => boolean;    // 轮询条件，DOM 渲染后才定位
  cta?: string;
  choices?: { label: string; action: 'finish' | 'advanced' }[]; // 仅结束卡用
}
export function buildBasicSteps(ctx: TourCtx): TourStep[];
export function buildAdvancedSteps(ctx: TourCtx): TourStep[];

// hooks/useOnboarding.ts —— 返回值
export type TourKind = 'basic' | 'advanced';
useOnboarding(): {
  active: TourKind | null;
  setActive: (v: TourKind | null) => void;
  autoStartIfDue: () => void;
  start: (kind: TourKind) => void;
  markSeen: (kind: TourKind) => void;
}

// components/OnboardingTour.tsx —— Props
interface OnboardingTourProps {
  steps: TourStep[];
  onFinish: (completed: boolean) => void;       // completed: 是否走完全部（false=中途跳过）
  onContinueAdvanced?: () => void;               // 结束卡点「继续进阶」
}
```

---

## Task 1: 实测选优预填示例（确认 DEMO_EXAMPLE 值）

**目标**：在真实 agent 上验证主选动画示例能稳定出图，决定 `DEMO_EXAMPLE` 用主选还是备选。

**前置条件**：`.env.local` 已配 Supabase + DeepSeek/GLM key，`pnpm dev` 能起来，Magic Link/密码能登录进 `/app`，画布能加载（`ggbReady`）。

- [ ] **Step 1: 启动 dev server**

Run: `pnpm dev`
预期：`http://localhost:3000` 可访问，无编译错误。

- [ ] **Step 2: 登录进入画布页**

浏览器打开 `http://localhost:3000/login`，登录，进入 `/app`，确认画布显示「正在加载 GeoGebra 画布…」后变为空白画布（`ggbReady=true`）。

- [ ] **Step 3: 实测主选示例**

在输入框粘贴主选 prompt 并发送：

```
画一个单位圆，圆上动点 P 随角度 t 旋转（t 做成动画滑块），在右侧坐标系画出点 (t, sin t) 的轨迹，动态展示正弦曲线如何随 P 的转动被一步步"画"出来
```

观察：① agent 是否成功执行（执行历史无 ✗）② 画布上是否有单位圆 + 转动的动点 P + 正弦曲线轨迹 ③ 动画是否自动播放（P 在转）。连测 2 次。

- [ ] **Step 4: 判定与（必要时）实测备选**

- 若主选 2 次都稳定出图 → **DEMO_EXAMPLE = 主选 prompt**（Step 3 的文本），Task 3 用它。
- 若主选有任何一次失败/缺动画 → 实测备选 prompt：

```
用动画滑块 a 控制抛物线 y = a*(x-1)^2 - 4 的开口大小，展示 a 从负到正变化时抛物线如何翻转与缩放
```

连测 2 次稳定 → **DEMO_EXAMPLE = 备选 prompt**。

- [ ] **Step 5: 记录结论**

把确认的 DEMO_EXAMPLE 文本记下，Task 3 写入 `lib/onboarding-steps.ts`。若环境未就绪无法实测，先用主选 prompt 继续，Task 7 统一验证。

**本任务不产生代码提交**（纯验证，结论供 Task 3 使用）。

---

## Task 2: 补 data-tour 锚点（3 文件，纯加属性）

**Files:**
- Modify: `components/ChatApp.tsx`（顶栏与输入区元素）
- Modify: `components/SessionSidebar.tsx:33`
- Modify: `components/CommandBar.tsx:58,65`

**Interfaces:**
- Produces: 以下 `data-tour` 锚点存在于 DOM，供 Task 3 步骤数据的选择器引用：`composer`、`mode-switch`、`usage-badge`、`export`、`sessions-toggle`、`session-list`、`command-history`、`recipe-tab`。

- [ ] **Step 1: ChatApp.tsx —— 输入区锚点 `composer`**

在 `components/ChatApp.tsx` 找到 `<div className="input-box">`（约 584 行），改为：

```tsx
<div className="input-box" data-tour="composer">
```

- [ ] **Step 2: ChatApp.tsx —— 模式切换锚点 `mode-switch`**

找到 `<div className="mode-switch">`（约 498 行），改为：

```tsx
<div className="mode-switch" data-tour="mode-switch">
```

- [ ] **Step 3: ChatApp.tsx —— 额度徽章锚点 `usage-badge`**

找到两个 `<span className={`usage-badge ...`}`（普通用户约 503 行、管理员约 507 行），各加属性。普通用户那处改为：

```tsx
<span className={`usage-badge ${remaining === 0 ? 'exhausted' : ''}`} title="剩余试用次数" data-tour="usage-badge">
```

管理员那处改为：

```tsx
<span className="usage-badge" title="管理员不限次数" data-tour="usage-badge">
```

- [ ] **Step 4: ChatApp.tsx —— 导出按钮锚点 `export`**

找到导出区的触发按钮 `<button className="btn ghost" onClick={() => setExportOpen((v) => !v)}>`（约 518 行），改为：

```tsx
<button className="btn ghost" data-tour="export" onClick={() => setExportOpen((v) => !v)}>
```

- [ ] **Step 5: ChatApp.tsx —— 对话列表入口锚点 `sessions-toggle`**

找到顶栏 `<button className="btn ghost" title="对话列表" onClick={() => setSidebarOpen(true)}>☰</button>`（约 493 行），改为：

```tsx
<button className="btn ghost" title="对话列表" data-tour="sessions-toggle" onClick={() => setSidebarOpen(true)}>☰</button>
```

- [ ] **Step 6: SessionSidebar.tsx —— 列表锚点 `session-list`**

`components/SessionSidebar.tsx` 第 33 行 `<div className="sidebar-list">` 改为：

```tsx
<div className="sidebar-list" data-tour="session-list">
```

- [ ] **Step 7: CommandBar.tsx —— 执行历史 summary 锚点 `command-history`**

`components/CommandBar.tsx` 第 58 行 `<summary>` 改为：

```tsx
<summary data-tour="command-history">
```

- [ ] **Step 8: CommandBar.tsx —— 重建脚本 tab 锚点 `recipe-tab`**

`components/CommandBar.tsx` 第 65 行「重建脚本」tab 按钮（`mode === 'recipe'` 那个）改为：

```tsx
<button className={`cmd-tab ${mode === 'recipe' ? 'active' : ''}`} data-tour="recipe-tab" onClick={() => setMode('recipe')}>重建脚本</button>
```

- [ ] **Step 9: 验证 typecheck + build**

Run: `pnpm typecheck`
预期：无错误。
Run: `pnpm build`
预期：构建成功。

- [ ] **Step 10: 提交**

```bash
git add components/ChatApp.tsx components/SessionSidebar.tsx components/CommandBar.tsx
git commit -m "feat: 为新手引导补 data-tour 锚点(composer/mode-switch/usage/export/sessions/sidebar/cmd-bar)

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 3: 步骤数据 `lib/onboarding-steps.ts`

**Files:**
- Create: `lib/onboarding-steps.ts`

**Interfaces:**
- Produces: `TourSide`、`TourCtx`、`TourStep`、`DEMO_EXAMPLE`、`openCmdBar()`、`switchCmdTab()`、`buildBasicSteps(ctx)`、`buildAdvancedSteps(ctx)`（签名见 File Structure 契约）。
- Consumes: Task 2 的 `data-tour` 锚点；`ChatApp` 的 setter（由 Task 6 通过 `TourCtx` 传入）。

- [ ] **Step 1: 新建文件，写入类型 + 常量 + DOM helper**

创建 `lib/onboarding-steps.ts`：

```ts
// 新手引导步骤数据: 类型 + 预填示例 + DOM 操纵 helper + 基础/进阶步骤工厂
// 引擎组件 OnboardingTour 消费 TourStep[]; 工厂闭包引用 ChatApp 的 setter (TourCtx)。

export type TourSide = 'top' | 'bottom' | 'left' | 'right';

export interface TourCtx {
  setSidebarOpen: (v: boolean) => void;
  setExportOpen: (v: boolean) => void;
  setInput: (v: string) => void;
  getInput: () => string;
}

export interface TourStep {
  anchor?: string;            // CSS 选择器; 缺省 = 屏幕居中卡片
  title: string;
  body: string;
  side?: TourSide;            // 默认 'bottom', 空间不足引擎自动翻转
  preEnter?: () => void;
  postExit?: () => void;
  waitFor?: () => boolean;    // 轮询条件(50ms 间隔, 最多 1s), 成立后才定位高亮
  cta?: string;
  choices?: { label: string; action: 'finish' | 'advanced' }[]; // 仅结束卡用
}

// 预填示例: Task 1 实测选优确认。默认主选(单位圆正弦曲线动画); 若 Task 1 判定不稳则替换为备选。
export const DEMO_EXAMPLE =
  '画一个单位圆，圆上动点 P 随角度 t 旋转（t 做成动画滑块），在右侧坐标系画出点 (t, sin t) 的轨迹，动态展示正弦曲线如何随 P 的转动被一步步"画"出来';
// 备选(仅当主选不稳时替换上方常量):
//   '用动画滑块 a 控制抛物线 y = a*(x-1)^2 - 4 的开口大小，展示 a 从负到正变化时抛物线如何翻转与缩放'

// ── DOM 操纵 helper(操控 CommandBar 内部 state, 因其 details/tab 不受外部 props 控制) ──

// 展开"执行历史/重建脚本"折叠面板(<details> 非受控, 直接设 open 安全)
export function openCmdBar(): void {
  const details = document.querySelector('details.cmd-bar') as HTMLDetailsElement | null;
  if (details) details.open = true;
}

// 切换 CommandBar 的 tab: 派发对应 .cmd-tab 的 click 触发其 React onClick -> setMode
export function switchCmdTab(tab: 'history' | 'recipe'): void {
  const tabs = document.querySelectorAll<HTMLButtonElement>('.cmd-toggle .cmd-tab');
  const target = tab === 'history' ? tabs[0] : tabs[1];
  target?.click();
}

// ── 基础教程: 6 步核心闭环 ──
export function buildBasicSteps(ctx: TourCtx): TourStep[] {
  return [
    {
      // 1. 欢迎卡(无锚点 = 居中)
      title: '欢迎使用 GGB Fable',
      body: '用一句话画出可探究的数学图形。30 秒带你上手核心玩法——画图、识别、导出。',
    },
    {
      // 2. 对话框(预填示例)
      anchor: '[data-tour="composer"]',
      side: 'top',
      title: '在这里用自然语言画图',
      body: '描述你想画的图形，可连续追加指令（如「再画它的切线」）。Cmd/Ctrl+Enter 发送。',
      cta: '示例已填好——点发送，你会看到画布动起来（计 1 次试用）',
      preEnter: () => ctx.setInput(DEMO_EXAMPLE),
      postExit: () => {
        // 用户没发送(示例还在原样)则清空; 已发送(input 已空)或被编辑则保留
        if (ctx.getInput() === DEMO_EXAMPLE) ctx.setInput('');
      },
    },
    {
      // 3. 画布
      anchor: '#ggb-container',
      side: 'left',
      title: '画布',
      body: 'AI 会读你的话、调用 GeoGebra 命令把图形画在这里，图形可拖动、缩放、探究。',
    },
    {
      // 4. 图片识别 OCR
      anchor: '[aria-label="上传图片"]',
      side: 'top',
      title: '图片识别',
      body: '拍一道题或截个图，OCR 自动识别成数学表达式再画出来——不占试用次数。',
    },
    {
      // 5. 额度与模式
      anchor: '[data-tour="mode-switch"]',
      side: 'bottom',
      title: '额度与模式',
      body: '点这里在「免费试用」和「自带 Key」之间切换。免费试用送 5 次额度（旁边徽章显示剩余），用完切到「自带 Key」并在设置页填自己的 API Key 即可无限使用。',
    },
    {
      // 6. 导出(展开下拉)
      anchor: '[data-tour="export"]',
      side: 'bottom',
      title: '导出',
      body: '画布上的动画可录制成 🎬 MP4/WebM 视频；也可导出 🖼️ PNG 静态图。',
      preEnter: () => ctx.setExportOpen(true),
      waitFor: () => !!document.querySelector('.export-menu'),
      postExit: () => ctx.setExportOpen(false),
    },
    {
      // 结束卡(无锚点 = 居中) + choices
      title: '基础就这些 ✨',
      body: '你已能画图并导出。还想看看进阶功能（历史对话、执行历史、重建脚本）吗？',
      choices: [
        { label: '继续看进阶', action: 'advanced' },
        { label: '不了，开始用', action: 'finish' },
      ],
    },
  ];
}

// ── 进阶教程: 3 步 ──
export function buildAdvancedSteps(ctx: TourCtx): TourStep[] {
  return [
    {
      // 7. 对话与历史(打开侧边栏)
      anchor: '[data-tour="session-list"]',
      side: 'right',
      title: '对话与历史',
      body: '这里是你的对话列表，可新建、切换、回看历史。每个对话的画布和指令都独立保存。',
      preEnter: () => ctx.setSidebarOpen(true),
      waitFor: () => !!document.querySelector('[data-tour="session-list"]'),
    },
    {
      // 8. 执行历史(展开 CommandBar + history tab)
      anchor: '[data-tour="command-history"]',
      side: 'bottom',
      title: '执行历史',
      body: '每次画图实际执行的 GeoGebra 命令都在这，✓/✗ 标明成功与否，方便排查为什么没画出来。',
      preEnter: () => { openCmdBar(); switchCmdTab('history'); },
      waitFor: () => !!(document.querySelector('details.cmd-bar') as HTMLDetailsElement | null)?.open,
    },
    {
      // 9. 重建脚本(切到 recipe tab)
      anchor: '[data-tour="recipe-tab"]',
      side: 'bottom',
      title: '重建脚本',
      body: '可把命令脚本精简、编辑（比如改个参数），再 ▶ 重放重新画——改图重画不用从头对话。',
      preEnter: () => { openCmdBar(); switchCmdTab('recipe'); },
      waitFor: () => {
        const recipe = document.querySelectorAll<HTMLButtonElement>('.cmd-toggle .cmd-tab')[1];
        return !!recipe && recipe.classList.contains('active');
      },
    },
  ];
}
```

- [ ] **Step 2: 验证 typecheck**

Run: `pnpm typecheck`
预期：无错误（注意：`buildBasicSteps`/`buildAdvancedSteps` 此时未被引用，但 TS 不会因未使用导出报错）。

- [ ] **Step 3: 提交**

```bash
git add lib/onboarding-steps.ts
git commit -m "feat: 新手引导步骤数据(类型+预填示例+基础6步/进阶3步工厂)

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 4: 持久化 hook `hooks/useOnboarding.ts`

**Files:**
- Create: `hooks/useOnboarding.ts`

**Interfaces:**
- Produces: `TourKind`、`useOnboarding()`（返回 `{ active, setActive, autoStartIfDue, start, markSeen }`，签名见 File Structure 契约）。
- Consumes: 浏览器 `localStorage`。

- [ ] **Step 1: 新建文件**

创建 `hooks/useOnboarding.ts`：

```ts
'use client';

// 新手引导触发与持久化: localStorage 记忆是否看过; 提供 active 状态与启动/标记接口。
import { useCallback, useState } from 'react';

export type TourKind = 'basic' | 'advanced';

const STORAGE_KEY = 'ggb-fable-onboarding';

interface OnboardingState {
  v: number;
  basicSeen: boolean;
  advancedSeen: boolean;
}

function readState(): OnboardingState {
  if (typeof window === 'undefined') return { v: 1, basicSeen: false, advancedSeen: false };
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    return {
      v: 1,
      basicSeen: !!parsed.basicSeen,
      advancedSeen: !!parsed.advancedSeen,
    };
  } catch {
    return { v: 1, basicSeen: false, advancedSeen: false };
  }
}

function writeState(s: OnboardingState): void {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(s)); } catch { /* 隐私模式/禁用 */ }
}

export function useOnboarding() {
  const [active, setActive] = useState<TourKind | null>(null);

  // 首次自动: 未看过基础教程 -> 启动基础。由 ChatApp 在 ggbReady 后调用。
  const autoStartIfDue = useCallback(() => {
    if (!readState().basicSeen) setActive('basic');
  }, []);

  const start = useCallback((kind: TourKind) => setActive(kind), []);

  // 标记某段已看过(完成或中途退出都标记, 尊重用户不再自动弹)
  const markSeen = useCallback((kind: TourKind) => {
    const s = readState();
    if (kind === 'basic') writeState({ ...s, basicSeen: true });
    else writeState({ ...s, advancedSeen: true });
  }, []);

  return { active, setActive, autoStartIfDue, start, markSeen };
}
```

- [ ] **Step 2: 验证 typecheck**

Run: `pnpm typecheck`
预期：无错误。

- [ ] **Step 3: 提交**

```bash
git add hooks/useOnboarding.ts
git commit -m "feat: useOnboarding hook(localStorage 持久化 + 首次自动触发)

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 5: 引擎组件 `components/OnboardingTour.tsx` + CSS

**Files:**
- Create: `components/OnboardingTour.tsx`
- Modify: `app/globals.css`（末尾追加引导样式段）

**Interfaces:**
- Consumes: `TourStep`（来自 `lib/onboarding-steps`）。
- Produces: 默认导出 `OnboardingTour`，Props `{ steps, onFinish, onContinueAdvanced }`（见 File Structure 契约）。被 Task 6 的 `ChatApp` 渲染。

- [ ] **Step 1: 新建引擎组件**

创建 `components/OnboardingTour.tsx`：

```tsx
'use client';

// 新手引导引擎: 遮罩挖空 + 气泡 + 步骤状态机。
// 时序: 进入步骤 -> preEnter(操纵UI) -> waitFor(轮询DOM就绪) -> 定位高亮; 离开 -> postExit(还原)。
import { useEffect, useState, useCallback } from 'react';
import type { TourStep, TourSide } from '@/lib/onboarding-steps';

interface Props {
  steps: TourStep[];
  onFinish: (completed: boolean) => void;
  onContinueAdvanced?: () => void;
}

const SIDE_GAP = 12;     // 气泡与锚点的间距
const VIEWPORT_GAP = 12; // 气泡离视口边缘的安全距离

// 计算气泡位置: 优先用 side, 空间不足自动翻转; 都不够则贴边。
function computePlacement(rect: DOMRect, side: TourSide, bubbleW: number, bubbleH: number) {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const choices: TourSide[] = [side, ...(['top', 'bottom', 'left', 'right'] as TourSide[]).filter((s) => s !== side)];
  for (const s of choices) {
    let top = 0, left = 0;
    if (s === 'top') { top = rect.top - bubbleH - SIDE_GAP; left = rect.left + rect.width / 2 - bubbleW / 2; }
    else if (s === 'bottom') { top = rect.bottom + SIDE_GAP; left = rect.left + rect.width / 2 - bubbleW / 2; }
    else if (s === 'left') { top = rect.top + rect.height / 2 - bubbleH / 2; left = rect.left - bubbleW - SIDE_GAP; }
    else { top = rect.top + rect.height / 2 - bubbleH / 2; left = rect.right + SIDE_GAP; }
    // 贴边修正
    left = Math.max(VIEWPORT_GAP, Math.min(left, vw - bubbleW - VIEWPORT_GAP));
    top = Math.max(VIEWPORT_GAP, Math.min(top, vh - bubbleH - VIEWPORT_GAP));
    // 该方向放得下(翻转判定): top 要求锚点上方够; bottom 要求下方够
    if (s === 'top' && rect.top - bubbleH - SIDE_GAP >= VIEWPORT_GAP) return { top, left, side: s };
    if (s === 'bottom' && rect.bottom + bubbleH + SIDE_GAP <= vh - VIEWPORT_GAP) return { top, left, side: s };
    if (s === 'left' && rect.left - bubbleW - SIDE_GAP >= VIEWPORT_GAP) return { top, left, side: s };
    if (s === 'right' && rect.right + bubbleW + SIDE_GAP <= vw - VIEWPORT_GAP) return { top, left, side: s };
    // 都放不下 -> 用第一个(贴边后的)兜底
    if (s === choices[choices.length - 1]) return { top, left, side: s };
  }
  return { top: VIEWPORT_GAP, left: VIEWPORT_GAP, side };
}

export default function OnboardingTour({ steps, onFinish, onContinueAdvanced }: Props) {
  const [index, setIndex] = useState(0);
  const [rect, setRect] = useState<DOMRect | null>(null);   // null = 居中卡片(无锚点/找不到/降级)
  const [ready, setReady] = useState(false);
  const [side, setSide] = useState<TourSide>('bottom');

  const step = steps[index];
  const isLast = index === steps.length - 1;
  const isCenter = !step.anchor;

  // 进入/离开步骤: preEnter -> waitFor -> 定位
  useEffect(() => {
    let cancelled = false;
    setReady(false);

    step.preEnter?.();

    (async () => {
      // waitFor 轮询(最多 1s)
      if (step.waitFor) {
        const deadline = Date.now() + 1000;
        while (Date.now() < deadline && !step.waitFor()) {
          await new Promise((r) => setTimeout(r, 50));
        }
      }
      if (cancelled) return;

      if (!step.anchor) { setRect(null); setReady(true); return; }
      const el = document.querySelector(step.anchor) as HTMLElement | null;
      if (!el) { setRect(null); setReady(true); return; }  // 找不到 -> 降级居中
      el.scrollIntoView({ block: 'center', behavior: 'smooth' });
      await new Promise((r) => setTimeout(r, 220));          // 等滚动
      if (cancelled) return;
      const r = (document.querySelector(step.anchor) as HTMLElement).getBoundingClientRect();
      setRect(r);
      setSide(step.side || 'bottom');
      setReady(true);
    })();

    return () => { cancelled = true; step.postExit?.(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index]);

  // resize/scroll 重算高亮位置(防抖 rAF)
  useEffect(() => {
    if (!step.anchor) return;
    let raf = 0;
    const recompute = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const el = document.querySelector(step.anchor) as HTMLElement | null;
        if (el) setRect(el.getBoundingClientRect());
      });
    };
    window.addEventListener('resize', recompute);
    window.addEventListener('scroll', recompute, true);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', recompute);
      window.removeEventListener('scroll', recompute, true);
    };
  }, [step.anchor]);

  // 键盘: ESC 跳过, → 下一步, ← 上一步
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { onFinish(false); }
      else if (e.key === 'ArrowRight') {
        if (isLast) onFinish(true);
        else setIndex((i) => i + 1);
      } else if (e.key === 'ArrowLeft') {
        setIndex((i) => Math.max(0, i - 1));
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [index, isLast, onFinish]);

  const next = useCallback(() => {
    if (isLast) onFinish(true);
    else setIndex((i) => i + 1);
  }, [isLast, onFinish]);
  const prev = useCallback(() => setIndex((i) => Math.max(0, i - 1)), []);

  // 气泡定位(锚点步骤时)
  let bubbleStyle: React.CSSProperties | undefined;
  if (!isCenter && rect && ready) {
    // 先用预估尺寸计算(气泡宽度固定 320, 高度按内容估; computePlacement 会贴边兜底)
    const placement = computePlacement(rect, side, 320, 150);
    bubbleStyle = { position: 'fixed', top: placement.top, left: placement.left, width: 320 };
  }

  const progress = steps.length;

  return (
    <div className="tour-root" role="dialog" aria-label="新手引导">
      {/* 遮罩: 有 rect 时用 4 块挖洞, 否则整屏 */}
      {rect && ready ? (
        <>
          <div className="tour-mask" style={{ left: 0, top: 0, width: '100%', height: rect.top }} />
          <div className="tour-mask" style={{ left: 0, top: rect.bottom, width: '100%', height: `calc(100vh - ${rect.bottom}px)` }} />
          <div className="tour-mask" style={{ left: 0, top: rect.top, width: rect.left, height: rect.height }} />
          <div className="tour-mask" style={{ left: rect.right, top: rect.top, width: `calc(100vw - ${rect.right}px)`, height: rect.height }} />
          {/* 高亮描边框 */}
          <div className="tour-highlight" style={{ left: rect.left, top: rect.top, width: rect.width, height: rect.height }} />
        </>
      ) : (
        <div className="tour-mask tour-mask-full" />
      )}

      {/* 气泡 */}
      <div className={`tour-bubble ${isCenter ? 'center' : ''}`} style={isCenter ? undefined : bubbleStyle}>
        <div className="tour-head">
          <span className="tour-counter">{index + 1}/{progress}</span>
          <button className="tour-close" aria-label="关闭引导" onClick={() => onFinish(false)}>✕</button>
        </div>
        <h3 className="tour-title">{step.title}</h3>
        <p className="tour-body">{step.body}</p>
        {step.cta && <p className="tour-cta">{step.cta}</p>}

        <div className="tour-actions">
          {step.choices ? (
            // 结束卡: 渲染 choices
            step.choices.map((c) => (
              <button
                key={c.action}
                className={`btn ${c.action === 'advanced' ? 'primary' : 'ghost'}`}
                onClick={() => (c.action === 'advanced' ? onContinueAdvanced?.() : onFinish(true))}
              >
                {c.label}
              </button>
            ))
          ) : (
            <>
              <button className="btn ghost sm tour-skip" onClick={() => onFinish(false)}>跳过</button>
              <div className="tour-actions-right">
                {index > 0 && <button className="btn ghost sm" onClick={prev}>上一步</button>}
                <button className="btn primary" onClick={next}>{isLast ? '完成' : '下一步'}</button>
              </div>
            </>
          )}
        </div>
        {/* 圆点进度 */}
        {!step.choices && (
          <div className="tour-dots">
            {steps.map((_, i) => (
              <span key={i} className={`tour-dot ${i === index ? 'active' : ''}`} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: 追加 CSS 到 `app/globals.css` 末尾**

在 `app/globals.css` 末尾追加：

```css

/* ── 新手引导(遮罩 + 气泡) ── */
.tour-root { position: fixed; inset: 0; z-index: 100; }
.tour-mask { position: fixed; background: rgba(15, 23, 42, 0.55); }
.tour-mask-full { inset: 0; width: 100%; height: 100%; }
.tour-highlight {
  position: fixed; border-radius: 6px;
  box-shadow: 0 0 0 2px #4f46e5, 0 0 0 6px rgba(79, 70, 229, 0.18);
  pointer-events: none; transition: all 0.18s ease;
}
.tour-bubble {
  background: #fff; border-radius: 12px; padding: 16px 18px 14px;
  box-shadow: 0 10px 32px rgba(0, 0, 0, 0.18); max-width: 360px;
  animation: tour-pop 0.18s ease both;
}
.tour-bubble.center {
  position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%); width: 380px; max-width: calc(100vw - 32px);
}
@keyframes tour-pop { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: translateY(0); } }
.tour-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px; }
.tour-counter { font-size: 11px; color: #9aa0a6; font-weight: 600; }
.tour-close { border: none; background: transparent; color: #9aa0a6; font-size: 15px; padding: 2px 6px; border-radius: 6px; }
.tour-close:hover { background: #f3f4f6; color: #555; }
.tour-title { margin: 0 0 6px; font-size: 15px; font-weight: 700; color: #1a1a1a; }
.tour-body { margin: 0; font-size: 13px; line-height: 1.65; color: #555; }
.tour-cta { margin: 8px 0 0; font-size: 12px; color: #4f46e5; background: #eef2ff; padding: 7px 10px; border-radius: 8px; line-height: 1.5; }
.tour-actions { display: flex; align-items: center; justify-content: space-between; margin-top: 14px; gap: 8px; }
.tour-actions-right { display: flex; gap: 8px; }
.tour-skip { color: #9aa0a6; }
.tour-dots { display: flex; gap: 5px; margin-top: 12px; justify-content: center; }
.tour-dot { width: 6px; height: 6px; border-radius: 50%; background: #e5e7eb; }
.tour-dot.active { background: #4f46e5; width: 16px; border-radius: 3px; }

/* ── 顶栏「教程」下拉(复用 export-menu 风格) ── */
.tutorial-wrap { position: relative; }
.tutorial-menu {
  position: absolute; top: calc(100% + 6px); right: 0; z-index: 50;
  min-width: 180px; background: #fff; border: 1px solid #e5e7eb;
  border-radius: 10px; box-shadow: 0 8px 28px rgba(0, 0, 0, 0.14);
  padding: 6px; overflow: hidden;
}
.tutorial-menu .export-item { padding: 8px 10px; }
```

- [ ] **Step 3: 验证 typecheck**

Run: `pnpm typecheck`
预期：无错误。

- [ ] **Step 4: 验证 build**

Run: `pnpm build`
预期：构建成功。

- [ ] **Step 5: 手动冒烟（临时挂载，确认遮罩/气泡能渲染）**

临时验证引擎本身能渲染（不接 ChatApp）：在 `app/app/page.tsx` 的 `return <ChatApp />;` 上方临时插入一段测试代码不现实（会破坏页面），因此改为 Task 6 接入后统一验证。本步只确认 typecheck + build 通过即可。

- [ ] **Step 6: 提交**

```bash
git add components/OnboardingTour.tsx app/globals.css
git commit -m "feat: OnboardingTour 引擎组件 + 引导/教程下拉样式

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 6: 接入 ChatApp（教程按钮 + useOnboarding + 渲染引导）

**Files:**
- Modify: `components/ChatApp.tsx`

**Interfaces:**
- Consumes: Task 3 的 `buildBasicSteps`/`buildAdvancedSteps`/`TourCtx`、Task 4 的 `useOnboarding`、Task 5 的 `OnboardingTour`。
- Produces: 首次进入 `/app` 自动触发基础教程；顶栏「📖 教程」下拉可重看基础/进阶。

- [ ] **Step 1: 新增 import**

在 `components/ChatApp.tsx` 顶部 import 区（`import SessionSidebar from './SessionSidebar';` 附近）追加：

```ts
import OnboardingTour from './OnboardingTour';
import { useOnboarding } from '@/hooks/useOnboarding';
import { buildBasicSteps, buildAdvancedSteps, type TourCtx } from '@/lib/onboarding-steps';
```

- [ ] **Step 2: 接入 useOnboarding + ggbReady 自动触发**

在 `ChatApp` 函数体顶部（`const [sidebarOpen, setSidebarOpen] = useState(false);` 附近，约 71 行）追加：

```ts
  const { active, setActive, autoStartIfDue, start, markSeen } = useOnboarding();
```

找到画布就绪后加载会话列表的 `useEffect`（约 243 行 `useEffect(() => { if (!ggbReady) return; ...`），在该 effect 的 `(async () => { ... })();` 之前追加一行触发引导：

```ts
  useEffect(() => {
    if (!ggbReady) return;
    autoStartIfDue();   // 首次进入: 未看过基础教程则启动
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/sessions', { cache: 'no-store' });
```

（即 `autoStartIfDue();` 紧跟 `if (!ggbReady) return;` 之后，`let cancelled = false;` 之前。）

- [ ] **Step 3: 构造 TourCtx（input 用 ref 避免闭包陈旧）**

在 `input` state 声明（`const [input, setInput] = useState('');` 约 103 行）下方追加 ref：

```ts
  const inputRef = useRef(input);
  inputRef.current = input;
```

在导出菜单状态区（`const exportMenuRef = useRef<HTMLDivElement>(null);` 约 118 行）下方追加教程下拉状态：

```ts
  const [tutorialOpen, setTutorialOpen] = useState(false);
  const tutorialMenuRef = useRef<HTMLDivElement>(null);

  const tourCtx: TourCtx = {
    setSidebarOpen,
    setExportOpen,
    setInput,
    getInput: () => inputRef.current,
  };
```

注意：`tourCtx` 在每次渲染重建（闭包捕获最新 setter），传给 `buildBasicSteps(tourCtx)` 时拿到的总是当前渲染的 setter，符合预期。

- [ ] **Step 4: 教程下拉「点外部关闭」**

找到导出菜单点外部关闭的 `useEffect`（约 144 行 `useEffect(() => { if (!exportOpen) return; ...`），在其后新增一个并列 effect：

```ts
  useEffect(() => {
    if (!tutorialOpen) return;
    const onDown = (e: MouseEvent) => {
      if (tutorialMenuRef.current && !tutorialMenuRef.current.contains(e.target as Node)) setTutorialOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [tutorialOpen]);
```

- [ ] **Step 5: 顶栏新增「📖 教程」按钮 + 下拉**

在 `components/ChatApp.tsx` 的顶栏 `.top-actions` 内，找到「⚙ 设置」链接（`<Link className="btn ghost" href="/settings">⚙ 设置</Link>` 约 511 行），在其**前方**插入教程按钮：

```tsx
          <div className="tutorial-wrap" ref={tutorialMenuRef}>
            <button className="btn ghost" data-tour="tutorial" onClick={() => setTutorialOpen((v) => !v)}>
              📖 教程
            </button>
            {tutorialOpen && (
              <div className="tutorial-menu">
                <button className="export-item" onClick={() => { start('basic'); setTutorialOpen(false); }}>
                  <span className="export-text"><span className="export-title">📖 基础教程</span><span className="export-desc">画图、识别、导出</span></span>
                </button>
                <button className="export-item" onClick={() => { start('advanced'); setTutorialOpen(false); }}>
                  <span className="export-text"><span className="export-title">🧱 进阶教程</span><span className="export-desc">历史、执行记录、重建脚本</span></span>
                </button>
              </div>
            )}
          </div>
```

- [ ] **Step 6: 渲染 `<OnboardingTour>`**

在 `ChatApp` 的 return JSX 最末尾、`</div>`（根 `.app` 容器闭合，约 639 行）**之前**插入：

```tsx
      {active && (
        <OnboardingTour
          key={active}
          steps={active === 'basic' ? buildBasicSteps(tourCtx) : buildAdvancedSteps(tourCtx)}
          onFinish={(completed) => {
            markSeen(active);
            setActive(null);
            // completed 仅用于日志语义; 基础的"继续进阶"由 onContinueAdvanced 处理
            void completed;
          }}
          onContinueAdvanced={() => {
            markSeen('basic');
            setActive('advanced');
          }}
        />
      )}
```

（`key={active}` 保证 basic→advanced 切换时引擎重新 mount、步骤归零。）

- [ ] **Step 7: 验证 typecheck + build**

Run: `pnpm typecheck`
预期：无错误。
Run: `pnpm build`
预期：构建成功。

- [ ] **Step 8: 手动验证 —— 首次自动触发基础教程**

1. 浏览器 DevTools → Application → Local Storage → 删除 `ggb-fable-onboarding`（确保首次状态）。
2. 刷新 `/app`，等画布加载完。
3. 预期：自动弹出欢迎卡（居中）。点「下一步」→ 高亮输入区（顶部气泡），输入框被预填示例文本。继续：画布高亮（左侧气泡）→ OCR 按钮高亮 → mode-switch 高亮 → 导出区高亮且下拉自动展开 → 结束卡。
4. 点结束卡「不了，开始用」→ 引导消失，`localStorage.ggb-fable-onboarding` 含 `basicSeen:true`。再刷新不再自动弹。

- [ ] **Step 9: 手动验证 —— 常驻入口 + 进阶衔接**

1. 点顶栏「📖 教程」→ 下拉出现两项。点外部关闭生效。
2. 点「🧱 进阶教程」→ 第 1 步自动打开侧边栏并高亮列表 → 第 2 步展开 CommandBar + 执行历史 tab → 第 3 步切到重建脚本 tab。点「完成」消失。
3. 再次「📖 教程」→「📖 基础教程」→ 走到结束卡点「继续看进阶」→ 无缝衔接到进阶第 1 步（侧边栏打开）。

- [ ] **Step 10: 提交**

```bash
git add components/ChatApp.tsx
git commit -m "feat: 接入新手引导(首次自动触发 + 顶栏教程入口 + 基础/进阶切换)

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 7: 全链路验证 + 边界修正

**目标**：按 spec 第 9、10 节完整走查 9 步 × 2 触发路径 × 边界场景，修正发现的问题。

**Files:** 视发现的问题而定（可能微调 `OnboardingTour.tsx` / `onboarding-steps.ts` / `ChatApp.tsx`）。

- [ ] **Step 1: 验证 DEMO_EXAMPLE 实测结论**

若 Task 1 未完成实测，现补做：发送 `DEMO_EXAMPLE` 文本，确认稳定出图且有动画。若不稳，编辑 `lib/onboarding-steps.ts` 的 `DEMO_EXAMPLE` 改用备选 prompt（Task 3 注释里已给出），重新验证。

- [ ] **Step 2: 9 步定位准确性走查**

逐步确认每步气泡正确指向锚点元素、不遮挡被高亮内容：
- 基础 1（居中欢迎卡）✓
- 基础 2（composer，气泡在上方，输入框已预填）✓
- 基础 3（#ggb-container，气泡在左侧）✓
- 基础 4（OCR 按钮，气泡在上方）✓
- 基础 5（mode-switch，气泡在下方）✓
- 基础 6（export，下拉已展开，气泡在下方）✓
- 进阶 7（session-list，侧边栏已打开，气泡在右侧）✓
- 进阶 8（command-history，CommandBar 已展开 + history tab）✓
- 进阶 9（recipe-tab，已切到 recipe tab）✓

任一步定位偏移 → 检查 `side` 配置与 `computePlacement` 兜底逻辑，微调。

- [ ] **Step 3: 边界场景验证**

逐一验证并记录：
1. **画布慢加载**：刷新后立刻观察——引导在画布就绪（`ggbReady`）后才触发（因 `autoStartIfDue` 在 ggbReady effect 内）。若画布始终不就绪，引导不触发（可接受，不卡死）。
2. **引导中 resize 窗口**：拖拽浏览器窗口大小，高亮框跟随锚点重定位（rAF 防抖）。
3. **引导中滚动**：滚动页面，高亮跟随。
4. **中途关闭**：ESC / 点 ✕ / 点「跳过」→ 引导消失，`localStorage` 标记当前段 seen。
5. **BYOK 模式启动**：切到「自带 Key」模式后触发教程——第 5 步锚定 `mode-switch`（始终渲染，不依赖 `usage-badge`），不报错。
6. **录制态启动**：开始录制视频（`recording=true`）后点教程——此时导出区被「停止录制」按钮顶替，基础第 6 步锚点 `[data-tour="export"]` 找不到 → 引擎降级为居中卡片讲解（`waitFor` 超时后 `rect=null`）。确认降级生效、不卡死。
7. **键盘**：→ 下一步、← 上一步、ESC 跳过，均生效。

- [ ] **Step 4: 折叠/隐藏「讲完还原」验证**

- 基础 6 走过导出步骤后，下拉应自动收起（`postExit: setExportOpen(false)`）。
- 进阶 7 走过后侧边栏状态：spec 要求「还原到原值」。当前实现 `postExit` 未还原侧边栏（步骤定义里没写 postExit）——若希望讲完自动收起侧边栏，在 `lib/onboarding-steps.ts` 进阶第 7 步补 `postExit: () => ctx.setSidebarOpen(false)`。确认产品意图后决定（保留打开也算合理，因用户接下来可能就用历史）。**默认保持现状（不还原侧边栏），若 Step 3 验证觉得突兀则补还原。**
- 进阶 8/9 走过后 CommandBar 保持展开（合理，不强制折叠）。

- [ ] **Step 5: 跨浏览器抽验**

- Chrome（主）完整跑通。
- Safari 打开 `/app` 触发教程，确认遮罩挖洞、气泡定位正常（Safari 对 `scrollIntoView` + 固定定位一致）。
- Firefox 抽验基础前 3 步。

任一浏览器异常 → 修正 CSS/定位逻辑。

- [ ] **Step 6: 修正提交**

若 Step 1–5 发现需修改，逐项修正后：

Run: `pnpm typecheck && pnpm build`
预期：均通过。

```bash
git add -A
git commit -m "fix: 新手引导全链路验证修正(定位/边界/跨浏览器)

Co-Authored-By: Claude <noreply@anthropic.com>"
```

若无修改，本任务无需提交。

---

## Self-Review（计划完成后自查）

**1. Spec 覆盖**：
- 触发 D（首次自动 + 常驻入口）→ Task 4 `autoStartIfDue` + Task 6 顶栏按钮 ✓
- 分段 B（基础 6 + 进阶 3）→ Task 3 `buildBasicSteps`(6步+结束卡) / `buildAdvancedSteps`(3步) ✓
- 交互 C（预填示例不强制发送）→ Task 3 基础第 2 步 `preEnter setInput` + `postExit` 条件清空 ✓
- 自研引擎 → Task 5 ✓
- 动画示例 → Task 1 实测 + Task 3 `DEMO_EXAMPLE` ✓
- 视觉（遮罩挖空 + 气泡 + indigo）→ Task 5 CSS ✓
- 锚点清单 → Task 2 ✓
- 折叠/隐藏陷阱（preEnter/waitFor/postExit）→ Task 3 + Task 5 时序契约 ✓
- 边界处理 → Task 7 Step 3 ✓

**2. 类型一致性**：`TourStep`（含 `choices`）、`TourCtx`（`getInput`）、`useOnboarding` 返回五元组、`OnboardingTourProps`（`onContinueAdvanced`）跨任务命名一致 ✓。`DEMO_EXAMPLE` 在 Task 3 定义、Task 7 引用 ✓。

**3. 与 spec 的有意偏离（已记录）**：教程下拉由 spec 的三项简化为两项（「重新完整体验」与「基础教程」+ 结束卡点「继续进阶」等价，YAGNI）；进阶第 7 步侧边栏默认不还原（Task 7 Step 4 留决策）。
