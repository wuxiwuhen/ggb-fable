// 服务端提示词源 —— 版本元数据 + 内容的唯一事实源。
// 仅被 API route import(/api/config/prompt-text, /api/admin/prompt-version*),
// 绝不被客户端组件 import —— 否则提示词会进前端 bundle(等于泄漏)。
//
// .md 通过 next.config 的 asset/source 规则以原始字符串 import。
// 添加新版本: 1) prompts/vN.md  2) 下面 PROMPT_VERSIONS 加一条  3) (可选)admin 发布

import v1 from '../prompts/v1.md';
import v2 from '../prompts/v2.md';

export interface PromptVersionMeta {
  id: string;
  label: string;
  description: string;
}

const PROMPT_VERSIONS: Array<PromptVersionMeta & { content: string }> = [
  { id: 'v1', label: '当前线上版', description: '从 agent.ts 迁移, 行为零变化', content: v1 },
  { id: 'v2', label: '测试版', description: '带 v2-TEST-MARKER 标记, 验证切换链路用, 验完删除', content: v2 },
];

export function getPromptContent(id: string): string | null {
  const v = PROMPT_VERSIONS.find((x) => x.id === id);
  return v ? v.content : null;
}

export function getPromptManifest(): { versions: PromptVersionMeta[] } {
  return {
    versions: PROMPT_VERSIONS.map(({ id, label, description }) => ({ id, label, description })),
  };
}

export function isKnownVersion(id: string): boolean {
  return PROMPT_VERSIONS.some((x) => x.id === id);
}
