// 从 /api/sessions 返回的 messages 行重建前端运行态的纯函数。
// 不依赖 ChatApp 类型(避免循环依赖), 返回纯数据由调用方包装(id/streaming 等)。

export interface ApiMessage {
  role: string;
  content: string | null;
  tool_name: string | null;
  tool_args: any;
  tool_result: any;
  round: number | null;
}

export interface ChatMsg { role: 'user' | 'assistant'; content: string }
export interface TraceEntry { name: string; args: any; result: any }

// 重建 chat 消息(只取 user/assistant 非空文本)
export function rebuildChatMessages(apiMsgs: ApiMessage[]): ChatMsg[] {
  return apiMsgs
    .filter((m) => (m.role === 'user' || m.role === 'assistant') && m.content != null && m.content !== '')
    .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content as string }));
}

// 重建 history(user/assistant 文本, 截 8 条, 给 agent 上下文)
export function rebuildHistory(apiMsgs: ApiMessage[]): Array<{ role: string; content: string }> {
  return rebuildChatMessages(apiMsgs).slice(-8).map((m) => ({ role: m.role, content: m.content }));
}

// 重建 trace(从 tool 消息)
export function rebuildTrace(apiMsgs: ApiMessage[]): TraceEntry[] {
  return apiMsgs
    .filter((m) => m.role === 'tool' && m.tool_name)
    .map((m) => ({ name: m.tool_name as string, args: m.tool_args, result: m.tool_result }));
}

// recipe 未就绪时的回退: 从 execute_command 的 tool 消息提取所有命令文本
export function extractReplayCommands(apiMsgs: ApiMessage[]): string[] {
  const cmds: string[] = [];
  for (const m of apiMsgs) {
    if (m.role === 'tool' && m.tool_name === 'execute_command' && m.tool_args && m.tool_args.command) {
      cmds.push(m.tool_args.command);
    }
  }
  return cmds;
}
