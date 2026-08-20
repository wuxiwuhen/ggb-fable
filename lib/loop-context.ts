// 工具循环的上下文管理: 输入 token 粗估 + 循环内历史压缩
// 背景: agent 循环每轮把全部 messages 重发给模型, 输入随轮数二次膨胀——
// 轻则浪费预算, 重则触发 trial 路由 100K 累计上限("本次请求上下文过大")或
// deepseek 64K 单轮窗口 400。
// 策略(经典套路, 不做 LLM compact——它吃自己的预算, 且膨胀来自重复重发而非新信息):
//   头部保留: system + 跨轮历史 + 当前用户目标, 一字不动;
//   尾部保留: 最近 keepRounds 个工具轮块(assistant+tool)原样;
//   中间轮:   工具结果换按工具名的占位符, assistant 决策与结构字段保留。

// trial 路由 MAX_TOKENS(默认 100K)的 80%: 累计输入逼近预算时, agent 循环
// 注入收敛指令让模型停止探索、用画布现状收尾, 抢在路由 429 之前。
export const BUDGET_HINT_TOKENS = 80000;

// 硬顶(90K < 生产 100K, 留单轮余量): 收敛指令不奏效时引擎主动收手, 干净结束并落
// turn_end, 不让路由 429 在循环中途炸掉整个 turn(报错路径会丢最后一条消息)。
export const LOOP_STOP_TOKENS = 90000;
export const LOOP_STOP_NOTICE =
  '（已接近上下文预算上限，停止调用工具。画布保留全部已执行结果，可基于现状继续微调，或开启新会话。）';

export const BUDGET_HINT_SUFFIX =
  '【上下文预算提示】本意图累计输入已接近上限。立即停止新的探索与重试，基于画布现状完成收尾，尽快输出最终回复。';

// 粗估输入 token: 消息内容 + tool_calls + 工具定义, 每 4 字符约 1 token。
// trial 路由与 agent 循环共用同一把尺子, 保证 80% 提示先于路由 429 触发。
export function estimateInputTokens(body: { messages?: any[]; tools?: any[] } | any): number {
  let chars = 0;
  for (const m of body?.messages || []) {
    const c = typeof m.content === 'string' ? m.content : JSON.stringify(m.content || '');
    chars += c.length;
    if (m.tool_calls) chars += JSON.stringify(m.tool_calls).length;
  }
  if (body?.tools) chars += JSON.stringify(body.tools).length;
  return Math.ceil(chars / 4);
}

// 占位符按工具名定制: 提示模型"旧结果没了, 要就重新查", 而不是干瘪的省略号
const PLACEHOLDER: Record<string, string> = {
  get_canvas_context: '（历史画布快照已省略，最新画布状态可重新调用获取）',
  search_command: '（历史命令检索结果已省略；需要时请重新检索）',
};
const placeholderFor = (toolName?: string) =>
  (toolName && PLACEHOLDER[toolName]) || '（历史工具结果已省略）';

// 把 messages 中"头部之后、最近 keepRounds 个工具轮块之前"的中间轮瘦身:
//   工具结果 → 按工具名占位符; assistant 叙述 → 短占位符(长叙述是输入膨胀主力)。
// 轮块 = 1 条 assistant(带 tool_calls) + 其后连续的 tool 消息。头部 = 首个带
// tool_calls 的 assistant 之前的所有消息(system/跨轮历史/当前目标)。
// assistant 的 tool_calls / reasoning_content 原样保留(前者配对 tool_call_id 必需,
// 后者涉及端点对思考回传的要求); 只动 content。
// 纯函数: 返回新数组, 不改入参; 幂等: 已是占位符的内容不再处理。
export function compactLoopHistory(messages: any[], opts: { keepRounds?: number } = {}): any[] {
  const keepRounds = opts.keepRounds ?? 3;

  // 轮块起点索引: 每条带 tool_calls 的 assistant 开一个新块
  const blockStarts: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    if (messages[i]?.role === 'assistant' && messages[i].tool_calls?.length) blockStarts.push(i);
  }
  // 块数不足(含无工具调用的短历史) → 无可压缩
  if (blockStarts.length <= keepRounds) return messages;

  const headEnd = blockStarts[0];                       // 头部不动
  const keepFrom = blockStarts[blockStarts.length - keepRounds]; // 尾部 keepRounds 块不动

  return messages.map((m, i) => {
    if (i < headEnd || i >= keepFrom) return m;
    if (m?.role === 'tool') {
      if (typeof m.content === 'string' && m.content.includes('已省略')) return m; // 幂等
      return { ...m, content: placeholderFor(m._toolName) };
    }
    if (m?.role === 'assistant') {
      if (typeof m.content !== 'string' || !m.content || m.content.includes('已省略')) return m;
      return { ...m, content: '（中间轮叙述已省略，决策见工具调用记录）' };
    }
    return m;
  });
}
