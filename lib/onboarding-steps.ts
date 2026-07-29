// 新手引导步骤数据 v3：三种绘制方式 → 共享画布 → 周边功能
// 引擎组件 OnboardingTour 消费 TourStep[]；工厂闭包引用 ChatApp 的 setter (TourCtx)。

export type TourSide = 'top' | 'bottom' | 'left' | 'right';

export interface TourCtx {
  setSidebarOpen: (v: boolean) => void;
  setExportOpen: (v: boolean) => void;
  setCommandPanelOpen: (v: boolean) => void;
  setChatCollapsed: (v: boolean) => void;
  setInput: (v: string) => void;
  getInput: () => string;
  prefillDemo: (text: string) => void;   // 仅首次调用生效（用于第2步预填示例，不重填）
}

export interface TourStep {
  anchor?: string;            // CSS 选择器；缺省 = 屏幕居中卡片
  title: string;
  body: string;
  side?: TourSide;            // 默认 'bottom'，空间不足引擎自动翻转
  preEnter?: () => void;
  postExit?: () => void;
  waitFor?: () => boolean;    // 轮询条件（50ms 间隔，最多 1s），成立后才定位高亮
  cta?: string;
  choices?: { label: string; action: 'finish' | 'advanced' }[]; // 仅结束卡用
}

// 预填示例：单位圆动点生成正弦曲线（经典动画，视觉冲击强、出图稳定）
export const DEMO_EXAMPLE =
  '画一个单位圆，圆上动点 P 随角度 t 旋转（t 做成动画滑块），在右侧坐标系画出点 (t, sin t) 的轨迹，动态展示正弦曲线如何随 P 的转动被一步步"画"出来';

// ── v3 教程：AI 先行 → 画布微调 → 命令精修 → 共享画布点题 → 周边功能 ──
export function buildTourSteps(ctx: TourCtx): TourStep[] {
  return [
    {
      // 1. 欢迎卡 —— 点明三种方式
      title: '欢迎使用 GGB Fable',
      body: 'AI 对话、画布交互、GGB 命令 —— 三种绘制方式，共享同一张画布。60 秒带你体验完整工作流。',
    },
    {
      // 2. 🤖 AI 辅助绘制（预填示例）
      anchor: '[data-tour="composer"]',
      side: 'top',
      title: '🤖 AI 辅助绘制',
      body: '在对话框用自然语言描述你想画的图形，AI 自动调用 GeoGebra 命令画出来。支持连续追加指令（如「再画它的切线」），也可以上传图片通过 OCR 识别题目后绘制。\n\nCmd/Ctrl+Enter 发送。',
      cta: '示例已填好 —— 点发送，看 AI 如何一句话出图（计 1 次试用）',
      preEnter: () => ctx.prefillDemo(DEMO_EXAMPLE),
      // 从步骤 3 回退时，postExit 还原 chatCollapsed 后 DOM 尚未更新，轮询等待 composer 出现
      waitFor: () => !!document.querySelector('[data-tour="composer"]'),
    },
    {
      // 3. 🖱️ 画布交互操作
      anchor: '[data-tour="collapse-chat"]',
      side: 'bottom',
      title: '🖱️ 画布交互操作',
      body: 'AI 画好的图形可以直接在画布上拖动、缩放。点这里收起对话框、展开全屏画布，还能使用 GeoGebra 原生工具栏（点、线、圆…）手动添加和编辑元素。',
      cta: '画布已展开 —— 试试拖动图形、用工具栏画个点',
      preEnter: () => ctx.setChatCollapsed(true),
      postExit: () => ctx.setChatCollapsed(false),
    },
    {
      // 4. ⌨️ GGB 命令操作
      anchor: '[data-tour="command-panel"]',
      side: 'bottom',
      title: '⌨️ GGB 命令操作',
      body: '熟悉 GeoGebra 命令？点这里打开命令面板，直接输入 GGB 指令（如 Circle((0,0), 3)），精确控制每个图形元素的参数。',
      cta: '已为你打开命令面板 —— 看看都能做什么',
      preEnter: () => ctx.setCommandPanelOpen(true),
      postExit: () => ctx.setCommandPanelOpen(false),
    },
    {
      // 5. 核心洞察：三种方式共享同一张画布
      title: '🔄 核心洞察：三种方式共享画布',
      body: 'AI 一句话绘制核心内容 → 画布交互拖动微调位置和样式 → 命令精确修改参数。三种方式操作的是同一份画布数据，随时切换、交叉使用，确保最终呈现效果完美。',
    },
    {
      // 6. 对话管理
      anchor: '[data-tour="session-list"]',
      side: 'right',
      title: '💬 对话管理',
      body: '每个对话独立保存画布内容和指令历史。不同的作图任务用不同对话，可随时新建、切换、回看，互不干扰。',
      preEnter: () => ctx.setSidebarOpen(true),
      waitFor: () => !!document.querySelector('[data-tour="session-list"]'),
      postExit: () => ctx.setSidebarOpen(false),
    },
    {
      // 7. 导出
      anchor: '[data-tour="export"]',
      side: 'bottom',
      title: '📤 导出图像/视频',
      body: '画布可导出为 🖼️ PNG 静态图或 🎬 MP4/WebM 视频。录制视频时会自动播放画布上的动画，适合制作教学素材。',
    },
    {
      // 8. 分享
      anchor: '[data-tour="share-btn"]',
      side: 'bottom',
      title: '🔗 分享会话',
      body: '生成分享链接，把当前画布和对话发给对方。对方可以在浏览器中交互式查看、探究你的图形 —— 无需登录、不消耗试用次数。',
    },
    {
      // 9. 额度与设置
      anchor: '[data-tour="settings-link"]',
      side: 'bottom',
      title: '⚙️ 额度与设置',
      body: '免费试用送 5 次画布生成额度。用完点击这里进入设置页，配置自己的 API Key，然后切换到「自带 Key」模式即可继续无限使用。',
    },
    {
      // 10. 结束卡
      title: '开始创作吧 ✨',
      body: 'AI 出图 → 画布微调 → 命令精修。三种方式，无限可能。去创造令人惊叹的数学可视化作品！',
    },
  ];
}
