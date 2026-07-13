// Embedding 函数工厂(command-search 向量检索用)
// trial: 走 /api/trial/embeddings(用服务端 GLM key, 后端代理)
// byok:  前端直连用户自配的 embedding 端点(通用 OpenAI 兼容; 不再限制 GLM)

import type { EmbedFunction } from './command-search';
import type { LLMConfig } from './llm';

export function makeTrialEmbed(): EmbedFunction {
  return async (texts) => {
    const resp = await fetch('/api/trial/embeddings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: texts, dimensions: 1024 }),
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    return data.vectors || null;
  };
}

export function makeByokEmbed(embedConfig: LLMConfig): EmbedFunction {
  const { base_url, api_key, model_name, dimensions } = embedConfig;
  const dim = dimensions || 1024;
  const base = base_url.replace(/\/+$/, '');
  return async (texts) => {
    try {
      const resp = await fetch(`${base}/embeddings`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${api_key}`,
        },
        body: JSON.stringify({ model: model_name, input: texts, dimensions: dim }),
      });
      if (!resp.ok) return null;
      const data = await resp.json();
      return (data.data || []).map((d: any) => d.embedding);
    } catch {
      return null;
    }
  };
}
