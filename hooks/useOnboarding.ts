'use client';

// 新手引导触发与持久化: localStorage 记忆是否看过; 提供 active 状态与启动/标记接口。
import { useCallback, useState } from 'react';

export type TourKind = 'basic' | 'advanced';

const STORAGE_KEY = 'ggb-fable-onboarding';

interface OnboardingState {
  v: number;
  basicSeen: boolean;
  advancedSeen: boolean;
}

function readState(): OnboardingState {
  if (typeof window === 'undefined') return { v: 1, basicSeen: false, advancedSeen: false };
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    return {
      v: 1,
      basicSeen: !!parsed.basicSeen,
      advancedSeen: !!parsed.advancedSeen,
    };
  } catch {
    return { v: 1, basicSeen: false, advancedSeen: false };
  }
}

function writeState(s: OnboardingState): void {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(s)); } catch { /* 隐私模式/禁用 */ }
}

export function useOnboarding() {
  const [active, setActive] = useState<TourKind | null>(null);

  // 首次自动: 未看过基础教程 -> 启动基础。由 ChatApp 在 ggbReady 后调用。
  const autoStartIfDue = useCallback(() => {
    if (!readState().basicSeen) setActive('basic');
  }, []);

  const start = useCallback((kind: TourKind) => setActive(kind), []);

  // 标记某段已看过(完成或中途退出都标记, 尊重用户不再自动弹)
  const markSeen = useCallback((kind: TourKind) => {
    const s = readState();
    if (kind === 'basic') writeState({ ...s, basicSeen: true });
    else writeState({ ...s, advancedSeen: true });
  }, []);

  return { active, setActive, autoStartIfDue, start, markSeen };
}
