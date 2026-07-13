// 新手引导步骤数据: 类型 + 预填示例 + DOM 操纵 helper + 统一教程工厂
// 引擎组件 OnboardingTour 消费 TourStep[]; 工厂闭包引用 ChatApp 的 setter (TourCtx)。

export type TourSide = 'top' | 'bottom' | 'left' | 'right';

export interface TourCtx {
  setSidebarOpen: (v: boolean) => void;
  setExportOpen: (v: boolean) => void;
  setInput: (v: string) => void;
  getInput: () => string;
  prefillDemo: (text: string) => void;   // 仅首次调用生效(用于第2步预填示例, 不重填)
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

// 预填示例
export const DEMO_EXAMPLE =
  '画一个单位圆，圆上动点 P 随角度 t 旋转（t 做成动画滑块），在右侧坐标系画出点 (t, sin t) 的轨迹，动态展示正弦曲线如何随 P 的转动被一步步"画"出来';

// ── DOM 操纵 helper ──

export function openCmdBar(): void {
  const details = document.querySelector('details.cmd-bar') as HTMLDetailsElement | null;
  if (details) details.open = true;
}

// ── 统一教程(基础+进阶合并, 单次走完) ──
export function buildTourSteps(ctx: TourCtx): TourStep[] {
  return [
    {
      // 1. 欢迎卡
      title: '欢迎使用 GGB Fable',
      body: '用一句话画出可探究的数学图形。30 秒带你上手核心玩法。',
    },
    {
      // 2. 对话框(预填示例)
      anchor: '[data-tour="composer"]',
      side: 'top',
      title: '在这里用自然语言画图',
      body: '描述你想画的图形，可连续追加指令（如「再画它的切线」）。Cmd/Ctrl+Enter 发送。',
      cta: '示例已填好——点发送，你会看到画布动起来（计 1 次试用）',
      preEnter: () => ctx.prefillDemo(DEMO_EXAMPLE),
    },
    {
      // 3. 图片识别 OCR
      anchor: '[aria-label="上传图片"]',
      side: 'top',
      title: '图片识别',
      body: '拍一道题或截个图，OCR 自动识别成数学表达式再画出来。',
    },
    {
      // 4. 画布
      anchor: '#ggb-container',
      side: 'left',
      title: '画布',
      body: 'AI 会读你的话、调用 GeoGebra 命令把图形画在这里，图形可拖动、缩放、探究。',
    },
    {
      // 5. 执行历史(展开 CommandBar)
      anchor: '[data-tour="command-history"]',
      side: 'bottom',
      title: '执行历史',
      body: '每次画图实际执行的 GeoGebra 命令都在这，✓/✗ 标明成功与否，方便排查为什么没画出来。',
      preEnter: () => { openCmdBar(); },
      waitFor: () => !!(document.querySelector('details.cmd-bar') as HTMLDetailsElement | null)?.open,
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
      // 7. 对话与历史(打开侧边栏)
      anchor: '[data-tour="session-list"]',
      side: 'right',
      title: '对话与历史',
      body: '这里是你的对话列表，可新建、切换、回看历史。每个对话的画布和指令都独立保存。',
      preEnter: () => ctx.setSidebarOpen(true),
      waitFor: () => !!document.querySelector('[data-tour="session-list"]'),
      postExit: () => ctx.setSidebarOpen(false),
    },
    {
      // 8. 额度与模式
      anchor: '[data-tour="mode-switch"]',
      side: 'bottom',
      title: '额度与模式',
      body: '点这里在「免费试用」和「自带 Key」之间切换。免费试用送 5 次额度（旁边徽章显示剩余），用完切到「自带 Key」并在设置页填自己的 API Key 即可无限使用。',
    },
    {
      // 9. 结束卡
      title: '开始创作吧 ✨',
      body: '你已掌握全部功能。用自然语言描述图形，AI 会在画布上画出来。',
    },
  ];
}
