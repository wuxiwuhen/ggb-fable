// 配置 + 模式管理(zustand, 持久化 localStorage)
// - mode: 'trial'(用我的 key, 后端代理+限额) | 'byok'(用户自带 key, 前端直连)
// - byok profiles: 用户自填的模型配置(存 localStorage, 永不上传后端)
// - vision: BYOK 模式下的视觉模型配置
//
// 试用模式不需要 key(后端处理), 只需 mode='trial'。

import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { LLMConfig } from './llm';

export type AppMode = 'trial' | 'byok';

export interface ByokProfile extends LLMConfig {
  name: string;
}

interface ConfigState {
  mode: AppMode;
  byokProfiles: ByokProfile[];
  activeProfileName: string;
  vision: Partial<LLMConfig>;          // BYOK 视觉模型(可选)
  maxToolRounds: number;

  setMode: (m: AppMode) => void;
  addOrUpdateProfile: (p: ByokProfile) => void;
  removeProfile: (name: string) => void;
  setActiveProfileName: (name: string) => void;
  setVision: (v: Partial<LLMConfig>) => void;
  setMaxToolRounds: (n: number) => void;

  // 当前激活的 BYOK 配置
  getActiveByok: () => ByokProfile | null;
  isByokValid: () => boolean;
  isVisionValid: () => boolean;
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
      maxToolRounds: 30,

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
      setMaxToolRounds: (n) => set({ maxToolRounds: n }),

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
    }),
    { name: 'ggb-fable-config' },
  ),
);
