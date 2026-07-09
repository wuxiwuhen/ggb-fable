// Embedding 函数工厂(command-search 向量检索用)
// trial: 走 /api/trial/embeddings(用我的 GLM key, 后端代理)
// byok:  前端直连用户 GLM embedding 端点(仅当用户 profile 是 GLM 兼容端点; 否则返回 null 降级为关键词)

import type { EmbedFunction } from './command-search';
import type { ByokProfile } from './config-store';

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

export function makeByokEmbed(profile: ByokProfile | null): EmbedFunction | null {
  if (!profile || !profile.api_key) return null;
  // 仅 GLM 兼容端点支持 embedding-3; 其他厂商(OpenAI 等)暂不支持向量检索 → 降级关键词
  if (!profile.base_url.includes('bigmodel.cn')) return null;
  const base = profile.base_url.replace(/\/+$/, '');
  return async (texts) => {
    try {
      const resp = await fetch(`${base}/embeddings`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${profile.api_key}`,
        },
        body: JSON.stringify({ model: 'embedding-3', input: texts, dimensions: 1024 }),
      });
      if (!resp.ok) return null;
      const data = await resp.json();
      return (data.data || []).map((d: any) => d.embedding);
    } catch {
      return null;
    }
  };
}
