'use client';

// GeoGebra applet 生命周期 hook
// 职责: 动态加载 deployggb.js → 创建 GGB 实例 → init 到容器 → ResizeObserver 自适应
// 返回: { containerRef, ggb, ready, error }
//
// 关键(迁移陷阱): applet 是命令式外部实例, 只在客户端 mount 后 init;
// StrictMode 下 useEffect 跑两次, 用 initialized ref 防重入。

import { useEffect, useRef, useState } from 'react';
import { GGB } from '@/lib/ggb';
import type { Logger } from '@/lib/logger';

const DEPLOY_SRC = 'https://www.geogebra.org/apps/deployggb.js';

let scriptPromise: Promise<void> | null = null;
function loadDeployScript(): Promise<void> {
  if (typeof window === 'undefined') return Promise.reject(new Error('SSR'));
  if ((window as any).GGBApplet) return Promise.resolve();
  if (scriptPromise) return scriptPromise;
  scriptPromise = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = DEPLOY_SRC;
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error('deployggb.js 加载失败, 请检查网络'));
    document.head.appendChild(s);
  });
  return scriptPromise;
}

export function useGeogebra(logger: Logger | null) {
  const containerRef = useRef<HTMLDivElement>(null);
  const ggbRef = useRef<GGB | null>(null);
  const initialized = useRef(false);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (initialized.current) return;       // StrictMode 防重入
    initialized.current = true;
    let cancelled = false;

    (async () => {
      try {
        await loadDeployScript();
        if (cancelled || !containerRef.current) return;
        const ggb = new GGB(logger || undefined);
        ggbRef.current = ggb;
        await ggb.init('ggb-container', {});
        if (!cancelled) setReady(true);
      } catch (e: any) {
        if (!cancelled) setError(e.message || String(e));
      }
    })();

    // ResizeObserver: 容器尺寸变化时同步 applet
    const ro = new ResizeObserver(() => {
      const api = ggbRef.current?.getAPI() as any;
      if (api && api.setSize && containerRef.current) {
        try { api.setSize(containerRef.current.clientWidth, containerRef.current.clientHeight); } catch {}
      }
    });
    if (containerRef.current) ro.observe(containerRef.current);

    return () => {
      cancelled = true;
      ro.disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { containerRef, ggb: ggbRef, ready, error };
}
