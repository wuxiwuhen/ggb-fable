// 配置 + 模式管理(zustand, 持久化 localStorage)
// - mode: 'trial'(用我的 key, 后端代理+限额) | 'byok'(用户自带 key, 前端直连)
// - byok profiles: 用户自填的模型配置(存 localStorage, 永不上传后端)
// - vision: BYOK 模式下的视觉模型配置
//
// 试用模式不需要 key(后端处理), 只需 mode='trial'。

import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { LLMConfig } from './llm';
import type { ThinkingMode } from './thinking';

export type AppMode = 'trial' | 'byok';

export interface ByokProfile extends LLMConfig {
  name: string;
  // 缺省 auto(三段式); autolow=三段式但 EXECUTE 轻思考(reasoning_effort:low); eval 注入用
  // UI 全局开关在设置页「高级」(thinkingMode), 全局开关优先于 profile 字段
  thinking_mode?: ThinkingMode;
}

interface ConfigState {
  mode: AppMode;
  byokProfiles: ByokProfile[];
  activeProfileName: string;
  vision: Partial<LLMConfig>;          // BYOK 视觉模型(可选)
  embedding: Partial<LLMConfig>;       // BYOK 嵌入模型(可选)
  maxToolRounds: number;
  // 全局思考模式覆盖(设置页「高级」, 试用/BYOK 均生效); 未选(undefined)=跟随 profile/引擎默认 auto
  thinkingMode?: ThinkingMode;
  // 视觉核验(inspect_render)开关(设置页「高级」): 未选/auto=模型自行判断; off=移除工具, 省视觉 API 花费+延迟
  visionVerify?: 'auto' | 'off';

  setMode: (m: AppMode) => void;
  addOrUpdateProfile: (p: ByokProfile) => void;
  removeProfile: (name: string) => void;
  setActiveProfileName: (name: string) => void;
  setVision: (v: Partial<LLMConfig>) => void;
  setEmbedding: (v: Partial<LLMConfig>) => void;
  setMaxToolRounds: (n: number) => void;
  setThinkingMode: (m: ThinkingMode | undefined) => void;
  setVisionVerify: (v: 'auto' | 'off' | undefined) => void;

  // 当前激活的 BYOK 配置
  getActiveByok: () => ByokProfile | null;
  isByokValid: () => boolean;
  isVisionValid: () => boolean;
  isEmbeddingValid: () => boolean;

  // 获取当前嵌入模型配置: 优先 embedding 字段, 否则 LLM 是 GLM 时降级复用; 否则 null
  getEmbeddingConfig: () => LLMConfig | null;
}

// 常用接口预设(只填 base_url + model_name, key 用户自填)
export const PRESETS: Array<{ label: string; base_url: string; model_name: string }> = [
  { label: 'OpenAI gpt-4o', base_url: 'https://api.openai.com/v1', model_name: 'gpt-4o' },
  { label: 'DeepSeek', base_url: 'https://api.deepseek.com/v1', model_name: 'deepseek-chat' },
  { label: '智谱 GLM', base_url: 'https://open.bigmodel.cn/api/paas/v4', model_name: 'glm-4.6' },
  { label: '通义千问', base_url: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model_name: 'qwen-plus' },
];

export const useConfigStore = create<ConfigState>()(
  persist(
    (set, get) => ({
      mode: 'trial',
      byokProfiles: [],
      activeProfileName: '',
      vision: {},
      embedding: {},
      maxToolRounds: 50,
      thinkingMode: undefined,
      visionVerify: undefined,

      setMode: (m) => set({ mode: m }),
      addOrUpdateProfile: (p) => set((s) => {
        const idx = s.byokProfiles.findIndex((x) => x.name === p.name);
        const list = [...s.byokProfiles];
        if (idx >= 0) list[idx] = p; else list.push(p);
        return { byokProfiles: list, activeProfileName: s.activeProfileName || p.name };
      }),
      removeProfile: (name) => set((s) => {
        const list = s.byokProfiles.filter((x) => x.name !== name);
        const active = s.activeProfileName === name ? (list[0]?.name || '') : s.activeProfileName;
        return { byokProfiles: list, activeProfileName: active };
      }),
      setActiveProfileName: (name) => set({ activeProfileName: name }),
      setVision: (v) => set((s) => ({ vision: { ...s.vision, ...v } })),
      setEmbedding: (v) => set((s) => ({ embedding: { ...s.embedding, ...v } })),
      setMaxToolRounds: (n) => set({ maxToolRounds: n }),
      setThinkingMode: (m) => set({ thinkingMode: m }),
      setVisionVerify: (v) => set({ visionVerify: v }),

      getActiveByok: () => {
        const { byokProfiles, activeProfileName } = get();
        return byokProfiles.find((p) => p.name === activeProfileName) || byokProfiles[0] || null;
      },
      isByokValid: () => {
        const p = get().getActiveByok();
        return !!(p && p.api_key && p.base_url && p.model_name);
      },
      isVisionValid: () => {
        const v = get().vision;
        return !!(v.api_key && v.base_url && v.model_name);
      },
      isEmbeddingValid: () => {
        const e = get().embedding;
        return !!(e.api_key && e.base_url && e.model_name);
      },
      getEmbeddingConfig: () => {
        const { embedding } = get();
        if (embedding.api_key && embedding.base_url && embedding.model_name) return embedding as LLMConfig;
        // 未填独立 embedding 配置: GLM LLM profile 向后兼容复用
        const p = get().getActiveByok();
        if (p && p.base_url.includes('bigmodel.cn')) {
          return { api_key: p.api_key, base_url: p.base_url, model_name: 'embedding-3' };
        }
        return null;
      },
    }),
    { name: 'ggb-fable-config' },
  ),
);
