'use client';

// 新手引导触发与持久化：localStorage 记忆是否看过；提供 active 布尔状态与启动/标记接口。
import { useCallback, useState } from 'react';

const STORAGE_KEY = 'ggb-fable-onboarding-v3';

interface OnboardingState {
  v: number;
  seen: boolean;
}

function readState(): OnboardingState {
  if (typeof window === 'undefined') return { v: 3, seen: false };
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { v: 3, seen: false };
    const parsed = JSON.parse(raw);
    return { v: 3, seen: !!parsed.seen };
  } catch {
    return { v: 3, seen: false };
  }
}

function writeState(s: OnboardingState): void {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(s)); } catch { /* 隐私模式/禁用 */ }
}

export function useOnboarding() {
  const [active, setActive] = useState(false);

  // 首次自动：未看过教程则启动。由 ChatApp 在 ggbReady 后调用。
  const autoStartIfDue = useCallback(() => {
    if (!readState().seen) setActive(true);
  }, []);

  const start = useCallback(() => setActive(true), []);

  // 标记已看过（完成或中途退出都标记，尊重用户不再自动弹）
  const markSeen = useCallback(() => {
    writeState({ v: readState().v, seen: true });
  }, []);

  return { active, setActive, autoStartIfDue, start, markSeen };
}
