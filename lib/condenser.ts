// 命令精简子 agent(从 js/condenser.js 迁移, 逻辑不变)
// 输入执行历史(成功+失败), 用一次 LLM 调用产出最小可重放脚本
// 精简规则: 删失败; 删临时测量; 同对象多次定义取最后; 被 Delete 的对象相关命令全删;
//           同对象多次设样式取最后; 保持依赖序; 不改写只剔除
//
// chatFn 由调用方注入(trial=chatTrial / byok=chatByok), Condenser 与模式无关

import type { CommandLogEntry } from './ggb';
import type { AssistantMessage, ToolDef } from './llm';

const SYS = [
  '你是 GeoGebra 命令精简器。输入是按顺序执行过的命令清单, 每条带 [OK]、[FAIL: 原因] 或 [TEMP: 验证测量]。',
  '任务: 输出一个最小命令序列, 使清空画布后逐条执行能精确复现当前画布。',
  '',
  '精简规则:',
  '1. 删除所有 [FAIL] 的命令。',
  '2. 删除所有 [TEMP: 验证测量] 的命令。',
  '3. 同一对象被多次创建/定义, 只保留最后一条。',
  '4. 若某对象被 Delete(对象) 删除, 则与该对象相关的所有命令全部移除。',
  '5. 同一对象的样式命令多次出现只保留最后一条; 对象被删则其样式也删。',
  '6. 保持原有依赖顺序: 先建对象, 再建依赖它的对象, 最后才是样式/测量。',
  '7. 不要改写命令内容, 只做剔除与去重; 不要新增、不要合并成新命令。',
  '',
  '只输出精简后的命令, 每条一行, 放在 geo 代码块里, 不要任何解释、编号或前后缀。',
].join('\n');

// chatFn: 简化签名, condenser 不用 tools/流式
type ChatFn = (p: { messages: any[]; tools?: ToolDef[]; onToken?: (d: string) => void }) => Promise<AssistantMessage>;

export const Condenser = {
  async run(
    commandLog: CommandLogEntry[],
    chatFn: ChatFn,
    { signal }: { signal?: AbortSignal } = {},
  ): Promise<{ commands: string[]; note: string }> {
    if (!commandLog || !commandLog.length) return { commands: [], note: '执行历史为空' };

    const numbered = commandLog.map((e, i) => {
      let tag: string;
      if (e.ephemeral) tag = '[TEMP: 验证测量]';
      else if (e.ok) tag = '[OK]';
      else tag = `[FAIL: ${(e.error || '').slice(0, 80)}]`;
      return `${i + 1}. ${tag} ${e.cmd}`;
    }).join('\n');

    const messages = [
      { role: 'system', content: SYS },
      { role: 'user', content: '执行历史(按序):\n\n' + numbered + '\n\n请输出精简后的最小重放脚本。' },
    ];

    const resp = await chatFn({ messages, signal } as any);
    const commands = parseCommands(resp.content || '');
    return { commands, note: commands.length ? '' : '未能从输出解析出命令' };
  },
};

// 从模型输出提取命令行: 优先 geo 代码块, 否则按行启发式过滤
function parseCommands(raw: string): string[] {
  const fence = raw.match(/```(?:geo|geogebra)?\s*\n([\s\S]*?)\n?```/);
  const body = fence ? fence[1] : raw;
  return body.split('\n')
    .map((s) => s.trim())
    .map((s) => s.replace(/^[0-9]+[.)]\s*/, ''))
    .filter((s) => s && !/^```/.test(s))
    .filter((s) => /[=(]/.test(s) || /^(Delete|Show|Set|Zoom|Pan|Center|Update|Start|Stop|Rename|If|Execute)/.test(s));
}
