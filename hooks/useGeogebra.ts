'use client';

// GeoGebra applet 生命周期 hook
// 职责: 动态加载 deployggb.js → 创建 GGB 实例 → init 到容器 → 尺寸自适应 + zoom 重建
// 返回: { containerRef, ggb, ready, error }
//
// 关键设计:
//   1. applet 只 inject 一次(initialized ref 防重入), 但 resize 监听放在【独立 useEffect(依赖 ready)】,
//      否则 StrictMode(dev 下 mount→cleanup→mount) 会把监听 cleanup 后不重建 → 缩放/窗口/横竖屏全失效。
//   2. 普通尺寸变化(窗口拖拽/横竖屏, DPR 不变) → setSize 即可撑满。
//   3. 浏览器 zoom(Cmd+/Cmd-, DPR 变化) → setSize 无法缩小 applet 根(GeoGebra 已知行为),
//      必须 re-inject 用当前 DPR 重建 applet, 否则画布缩在左上角。监听 DPR 变化 → debounce re-inject,
//      期间保存/恢复画布 XML。

import { useCallback, useEffect, useRef, useState } from 'react';
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

  // setSize: 读容器尺寸 → api.setSize(强制 applet ≡ 容器, 不保持比例)。用于 DPR 不变的普通 resize
  const rafRef = useRef(0);
  const applySize = useCallback(() => {
    rafRef.current = 0;
    const api = ggbRef.current?.getAPI() as any;
    const el = containerRef.current;
    if (api && api.setSize && el) {
      const w = el.clientWidth;
      const h = el.clientHeight;
      if (w > 0 && h > 0) { try { api.setSize(w, h); } catch {} }
    }
  }, []);
  const scheduleResize = useCallback(() => {
    if (rafRef.current) return;
    rafRef.current = requestAnimationFrame(applySize);
  }, [applySize]);

  // re-inject: DPR 变化(浏览器 zoom)后用当前 DPR 重建 applet, 保存/恢复画布 XML
  const reinjectingRef = useRef(false);
  const reinjectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reinject = useCallback(async () => {
    if (reinjectingRef.current || !ggbRef.current) return;
    reinjectingRef.current = true;
    setReady(false);
    try {
      await ggbRef.current.reinit('ggb-container', {});
      setReady(true);
      applySize();
    } catch (e: any) {
      setError('画布重新加载失败: ' + (e.message || String(e)));
      setReady(true);
    } finally {
      reinjectingRef.current = false;
    }
  }, [applySize]);
  const scheduleReinject = useCallback(() => {
    if (reinjectTimerRef.current) clearTimeout(reinjectTimerRef.current);
    reinjectTimerRef.current = setTimeout(reinject, 500);   // debounce: 用户连续 Cmd+/- 只重建一次
  }, [reinject]);

  // ① init: 只 inject 一次(StrictMode 防重入)。完成后 setReady 触发监听 effect
  useEffect(() => {
    if (initialized.current) return;
    initialized.current = true;
    (async () => {
      try {
        await loadDeployScript();
        if (!containerRef.current) return;
        const ggb = new GGB(logger || undefined);
        ggbRef.current = ggb;
        await ggb.init('ggb-container', {});
        setReady(true);
        applySize();
      } catch (e: any) {
        setError(e.message || String(e));
      }
    })();
  }, [applySize, logger]);

  // ② 监听: 依赖 ready, applet 就绪后建立, StrictMode 下 cleanup/重建幂等安全
  useEffect(() => {
    if (!ready) return;
    const el = containerRef.current;
    if (!el) return;

    // 初始: applet 刚就绪时内部布局(canvas 填满 applet 根)可能仍在异步进行, 立即的 setSize
    // 偶尔没完全生效 → 刷新后画布右/下边留几 px 空白。延迟补设两次确保撑满(re-inject 后无此问题)
    const t1 = setTimeout(applySize, 200);
    const t2 = setTimeout(applySize, 600);

    // 普通尺寸变化(flex 重排/窗口拖拽, DPR 不变) → setSize(轻量, 无闪烁)
    const ro = new ResizeObserver(scheduleResize);
    ro.observe(el);
    window.addEventListener('resize', scheduleResize);
    // 横竖屏(尺寸变化, DPR 不变): CSS 已强制 scaler transform:none, setSize 可靠撑满, 用 setSize 即可(避免 re-inject 闪烁)
    const onOrient = () => setTimeout(scheduleResize, 300);
    window.addEventListener('orientationchange', onOrient);
    const vv = window.visualViewport;
    if (vv) {
      vv.addEventListener('resize', scheduleResize);
      vv.addEventListener('scroll', scheduleResize);
    }

    // DPR 变化(浏览器 zoom) → setSize 失效, debounce re-inject 用新 DPR 重建
    // 用 matchMedia resolution 监听: DPR 一变就触发, 触发后重新绑定到新 DPR 值
    let mql: MediaQueryList | null = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
    const onDpr = () => {
      mql?.removeEventListener('change', onDpr);
      mql = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
      mql.addEventListener('change', onDpr);
      // CSS transform:none 修复 scaler 后, setSize 即可撑满; GeoGebra 会按当前 DPR 重算 canvas, 无需 re-inject
      scheduleResize();
    };
    mql.addEventListener('change', onDpr);

    return () => {
      clearTimeout(t1); clearTimeout(t2);
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      ro.disconnect();
      window.removeEventListener('resize', scheduleResize);
      window.removeEventListener('orientationchange', onOrient);
      if (vv) {
        vv.removeEventListener('resize', scheduleResize);
        vv.removeEventListener('scroll', scheduleResize);
      }
      mql?.removeEventListener('change', onDpr);
      if (reinjectTimerRef.current) clearTimeout(reinjectTimerRef.current);
    };
  }, [ready, scheduleResize, scheduleReinject, applySize]);

  return { containerRef, ggb: ggbRef, ready, error };
}
