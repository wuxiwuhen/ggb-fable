// 提示词常量(客户端/服务端共用, 无副作用, 安全互相 import)
// DEFAULT_VERSION: endpoint 读不到 app_config 时的兜底版本号
// EMERGENCY_PROMPT: loader 取不到任何提示词时的最后兜底(极小, 保证 agent 能跑)

export const DEFAULT_VERSION = 'v1';

export const EMERGENCY_PROMPT =
  '你是 GeoGebra 画布构造助手, 服务于 K12 数学教学场景。通过工具操作画布, ' +
  '将数学关系转化为动态课件。改画布前先 get_canvas_context 读真实状态; 命令用英文; ' +
  '拖动自由变量时依赖对象自动联动(用 Midpoint/Intersect 等约束命令, 不硬编码坐标)。';
