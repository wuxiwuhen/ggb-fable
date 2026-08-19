// AgentBackend 工厂: 根据 mode + 配置构建 trial 或 byok 的 AgentBackend
// trial: chat=chatTrial / vision=visionTrial (后端代理, 用我的 key + 限额)
// byok:  chat=chatByok / vision=visionByok (前端直连, 用用户 key)

import { chatByok, chatTrial, visionByok, visionTrial, type LLMConfig, type TrialContext } from './llm';
import type { AgentBackend } from './agent';
import type { ByokProfile } from './config-store';

// 构建试用模式 backend
export function makeTrialBackend(trialCtx: TrialContext, model?: string): AgentBackend {
  return {
    chat: ({ messages, tools, onToken, onThinking, thinking, reasoningEffort, signal }) =>
      chatTrial({ messages, tools, trialCtx, model, onToken, onThinking, thinking, reasoningEffort, signal }),
    vision: (image, prompt, signal) =>
      visionTrial({ image, prompt, trialCtx, model: model === 'deepseek' ? 'glm-4.6v' : 'glm-4.6v', signal }),
    visionReady: () => true,   // 试用模式视觉走后端, 永远就绪
  };
}

// 构建 BYOK 模式 backend
export function makeByokBackend(profile: ByokProfile, visionCfg: Partial<LLMConfig>): AgentBackend {
  const config: LLMConfig = {
    api_key: profile.api_key,
    base_url: profile.base_url,
    model_name: profile.model_name,
    temperature: profile.temperature,
  };
  const visionReady = !!(visionCfg.api_key && visionCfg.base_url && visionCfg.model_name);
  const visionConfig: LLMConfig = {
    api_key: visionCfg.api_key!,
    base_url: visionCfg.base_url!,
    model_name: visionCfg.model_name!,
  };
  return {
    chat: ({ messages, tools, onToken, onThinking, thinking, reasoningEffort, signal }) =>
      chatByok({ messages, tools, config, onToken, onThinking, thinking, reasoningEffort, signal }),
    vision: (image, prompt, signal) =>
      visionReady ? visionByok(visionConfig, { image, prompt, signal }) : Promise.reject(new Error('视觉模型未配置')),
    visionReady: () => visionReady,
  };
}
