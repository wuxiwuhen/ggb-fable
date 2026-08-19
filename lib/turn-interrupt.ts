// 会话中断轮的补记策略: ChatApp catch 的每个退出路径都必须收尾本轮日志,
// 否则 user_input 行存在而 turn_end 行缺失, 切换会话后只剩用户气泡(无 assistant 行)。

export type TurnInterruptKind = 'user_stop' | 'trial_exhausted' | 'turn_error';

export interface TurnInterruptLogger {
  errorEvent(where: string, err: any): void;
  turnEnd(meta: Record<string, any>): void;
}

/**
 * 中断(主动停止/额度耗尽/真错误)后补记 errorEvent + turn_end(stopped)。
 * - 真错误与额度耗尽: 流式无文本时兜底 '（出错）', 与 ChatApp live 气泡
 *   `content: m.content || '（出错）'` 文案一致, 保证落库行非空、重建后气泡可见。
 * - 用户主动停止: 允许空文本(live 侧会移除空气泡, 重建时空行被过滤, 行为一致)。
 */
export function logTurnInterrupt(
  logger: TurnInterruptLogger,
  kind: TurnInterruptKind,
  err: any,
  opts: { finalText: string; toolCount: number },
): void {
  logger.errorEvent(kind, err);
  const finalText = kind === 'user_stop' ? opts.finalText : (opts.finalText || '（出错）');
  logger.turnEnd({ finalText, toolCount: opts.toolCount, stopped: true });
}
