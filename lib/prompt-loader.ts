// 提示词版本加载器: 按"生效版本"拉对应 .md 注入 AgentEngine
// 生效版本由服务端 /api/config/prompt-version 解析(全局 active; admin 预览覆盖)
// 回退链: endpoint 挂 → DEFAULT_VERSION; 文件 404 → DEFAULT 文件; 再失败 → EMERGENCY_PROMPT

export const DEFAULT_VERSION = 'v1';

// 静态托管全崩时的最后兜底(极小, 保证 agent 仍能跑)
export const EMERGENCY_PROMPT =
  '你是 GeoGebra 画布构造助手, 服务于 K12 数学教学场景。通过工具操作画布, ' +
  '将数学关系转化为动态课件。改画布前先 get_canvas_context 读真实状态; 命令用英文; ' +
  '拖动自由变量时依赖对象自动联动(用 Midpoint/Intersect 等约束命令, 不硬编码坐标)。';

const MANIFEST_URL = '/knowledge/prompts/manifest.json';
const promptUrl = (v: string) => `/knowledge/prompts/${v}.md`;

export interface PromptVersionInfo {
  id: string;
  label: string;
  description?: string;
}
interface Manifest { versions: PromptVersionInfo[] }

const textCache = new Map<string, string>();
let manifestCache: Manifest | null = null;

async function fetchText(url: string): Promise<string | null> {
  try {
    const resp = await fetch(url);
    if (!resp.ok) return null;
    return await resp.text();
  } catch {
    return null;
  }
}

export async function fetchManifest(): Promise<Manifest> {
  if (manifestCache) return manifestCache;
  const raw = await fetchText(MANIFEST_URL);
  manifestCache = raw ? (JSON.parse(raw) as Manifest) : { versions: [] };
  return manifestCache;
}

export async function loadPromptText(version: string): Promise<string | null> {
  if (textCache.has(version)) return textCache.get(version)!;
  const text = await fetchText(promptUrl(version));
  if (text != null) textCache.set(version, text);
  return text;
}

// 纯函数: 给定候选版本 + 已拉取文本(可能 null), 决策最终结果(便于离线断言)
export interface ResolvedPrompt {
  version: string;
  text: string;
  usedFallback: boolean;
}
export function resolvePrompt(
  candidateVersion: string,
  candidateText: string | null,
  defaultText: string | null,
): ResolvedPrompt {
  if (candidateText != null) {
    return { version: candidateVersion, text: candidateText, usedFallback: false };
  }
  if (defaultText != null) {
    return { version: DEFAULT_VERSION, text: defaultText, usedFallback: true };
  }
  return { version: DEFAULT_VERSION, text: EMERGENCY_PROMPT, usedFallback: true };
}

export interface EffectivePrompt {
  version: string;
  text: string;
  source: 'global' | 'preview' | 'fallback';
}

// 主入口: 服务端解析生效版本 → 拉文件 → 回退链
export async function getEffectivePrompt(): Promise<EffectivePrompt> {
  // 1. 服务端解析生效版本
  let version = DEFAULT_VERSION;
  let source: EffectivePrompt['source'] = 'global';
  try {
    const resp = await fetch('/api/config/prompt-version');
    if (resp.ok) {
      const data = await resp.json();
      if (data?.version) {
        version = String(data.version);
        source = data.source === 'preview' ? 'preview' : 'global';
      }
    }
  } catch {
    /* endpoint 挂 → 保持 DEFAULT_VERSION */
  }

  // 2. 拉文件, 回退链
  const candidateText = await loadPromptText(version);
  const resolved =
    version === DEFAULT_VERSION
      ? resolvePrompt(version, candidateText, null) // 候选即默认, 不二次回退
      : resolvePrompt(version, candidateText, await loadPromptText(DEFAULT_VERSION));

  if (resolved.usedFallback) {
    // 文件层回退发生: 若 endpoint 给的是 preview/global, 降级标记
    source = 'fallback';
  }
  return { version: resolved.version, text: resolved.text, source };
}
