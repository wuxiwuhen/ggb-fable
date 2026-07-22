// 提示词加载器(客户端): 调 /api/config/prompt-text 拿生效版本的文本, 注入 AgentEngine。
// 提示词内容只存服务端(prompts/*.md → lib/server-prompts), 客户端经此 endpoint 拿文本,
// 拿不到"文件"。endpoint 失败/未登录 → EMERGENCY_PROMPT 兜底, agent 永远有 prompt。
import { EMERGENCY_PROMPT } from './prompt-constants';

// 供 ChatApp 兜底 import(向后兼容)
export { EMERGENCY_PROMPT };

export interface EffectivePrompt {
  version: string;
  text: string;
  source: 'global' | 'preview' | 'fallback';   // 保留供诊断(当前 ChatApp 仅用 text)
}

export async function getEffectivePrompt(): Promise<EffectivePrompt> {
  try {
    const resp = await fetch('/api/config/prompt-text');
    if (resp.ok) {
      const data = await resp.json();
      if (data?.text) {
        return {
          version: String(data.version || 'v1'),
          text: String(data.text),
          source: data.source === 'preview' ? 'preview' : 'global',
        };
      }
    }
  } catch {
    /* 落到 EMERGENCY */
  }
  return { version: 'v1', text: EMERGENCY_PROMPT, source: 'fallback' };
}
