'use client';

// 新手引导引擎: 遮罩挖空 + 气泡 + 步骤状态机。
// 时序: 进入步骤 -> preEnter(操纵UI) -> waitFor(轮询DOM就绪) -> 定位高亮; 离开 -> postExit(还原)。
import { useEffect, useState, useCallback, useLayoutEffect, useRef } from 'react';
import type { TourStep, TourSide } from '@/lib/onboarding-steps';

interface Props {
  steps: TourStep[];
  onFinish: (completed: boolean) => void;
  onContinueAdvanced?: () => void;
}

const SIDE_GAP = 12;     // 气泡与锚点的间距
const VIEWPORT_GAP = 12; // 气泡离视口边缘的安全距离

// 计算气泡位置: 优先用 side, 空间不足自动翻转; 都不够则贴边。
function computePlacement(rect: DOMRect, side: TourSide, bubbleW: number, bubbleH: number) {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const choices: TourSide[] = [side, ...(['top', 'bottom', 'left', 'right'] as TourSide[]).filter((s) => s !== side)];
  for (const s of choices) {
    let top = 0, left = 0;
    if (s === 'top') { top = rect.top - bubbleH - SIDE_GAP; left = rect.left + rect.width / 2 - bubbleW / 2; }
    else if (s === 'bottom') { top = rect.bottom + SIDE_GAP; left = rect.left + rect.width / 2 - bubbleW / 2; }
    else if (s === 'left') { top = rect.top + rect.height / 2 - bubbleH / 2; left = rect.left - bubbleW - SIDE_GAP; }
    else { top = rect.top + rect.height / 2 - bubbleH / 2; left = rect.right + SIDE_GAP; }
    // 贴边修正
    left = Math.max(VIEWPORT_GAP, Math.min(left, vw - bubbleW - VIEWPORT_GAP));
    top = Math.max(VIEWPORT_GAP, Math.min(top, vh - bubbleH - VIEWPORT_GAP));
    // 该方向放得下(翻转判定): top 要求锚点上方够; bottom 要求下方够
    if (s === 'top' && rect.top - bubbleH - SIDE_GAP >= VIEWPORT_GAP) return { top, left, side: s };
    if (s === 'bottom' && rect.bottom + bubbleH + SIDE_GAP <= vh - VIEWPORT_GAP) return { top, left, side: s };
    if (s === 'left' && rect.left - bubbleW - SIDE_GAP >= VIEWPORT_GAP) return { top, left, side: s };
    if (s === 'right' && rect.right + bubbleW + SIDE_GAP <= vw - VIEWPORT_GAP) return { top, left, side: s };
    // 都放不下 -> 用第一个(贴边后的)兜底
    if (s === choices[choices.length - 1]) return { top, left, side: s };
  }
  return { top: VIEWPORT_GAP, left: VIEWPORT_GAP, side };
}

export default function OnboardingTour({ steps, onFinish, onContinueAdvanced }: Props) {
  const [index, setIndex] = useState(0);
  const [rect, setRect] = useState<DOMRect | null>(null);   // null = 居中卡片(无锚点/找不到/降级)
  const [ready, setReady] = useState(false);
  const [side, setSide] = useState<TourSide>('bottom');
  const bubbleRef = useRef<HTMLDivElement>(null);
  const [bubbleSize, setBubbleSize] = useState({ w: 320, h: 150 });

  const step = steps[index];
  const isLast = index === steps.length - 1;
  const isCenter = !step.anchor;

  // 进入/离开步骤: preEnter -> waitFor -> 定位
  useEffect(() => {
    let cancelled = false;
    setReady(false);

    step.preEnter?.();

    (async () => {
      // waitFor 轮询(最多 1s)
      if (step.waitFor) {
        const deadline = Date.now() + 1000;
        while (Date.now() < deadline && !step.waitFor()) {
          await new Promise((r) => setTimeout(r, 50));
        }
      }
      if (cancelled) return;

      if (!step.anchor) { setRect(null); setReady(true); return; }
      const anchor = step.anchor;  // 捕获到局部 const(避免 await 后 TS 丢失窄化)
      const el = document.querySelector(anchor) as HTMLElement | null;
      if (!el) { setRect(null); setReady(true); return; }  // 找不到 -> 降级居中
      // 元素已在视口内则不滚动: scrollIntoView 对画布等大元素有副作用(平滑滚动期间测到中间态, 高亮框只框部分)
      const r0 = el.getBoundingClientRect();
      const inView =
        r0.top >= 0 && r0.bottom <= window.innerHeight &&
        r0.left >= 0 && r0.right <= window.innerWidth;
      if (!inView) {
        el.scrollIntoView({ block: 'center', behavior: 'auto' }); // instant: 同步完成, 不测中间态
        await new Promise((r) => setTimeout(r, 60));               // 让布局稳定
      }
      if (cancelled) return;
      const el2 = document.querySelector(anchor);
      if (!el2) { setRect(null); setReady(true); return; }
      const r = (el2 as HTMLElement).getBoundingClientRect();
      setRect(r);
      setSide(step.side || 'bottom');
      setReady(true);
    })();

    return () => { cancelled = true; step.postExit?.(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index]);

  // resize/scroll 重算高亮位置(防抖 rAF)
  useEffect(() => {
    if (!step.anchor) return;
    const anchor = step.anchor;  // 捕获到局部 const(避免闭包内 TS 丢失窄化)
    let raf = 0;
    const recompute = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const el = document.querySelector(anchor) as HTMLElement | null;
        if (el) setRect(el.getBoundingClientRect());
      });
    };
    window.addEventListener('resize', recompute);
    window.addEventListener('scroll', recompute, true);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', recompute);
      window.removeEventListener('scroll', recompute, true);
    };
  }, [step.anchor]);

  // 键盘: ESC 跳过, → 下一步, ← 上一步
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // 输入框聚焦时不拦截方向键/ESC(避免光标移动同时触发引导)
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'TEXTAREA' || t.tagName === 'INPUT' || t.isContentEditable)) return;
      if (e.key === 'Escape') { onFinish(false); }
      else if (e.key === 'ArrowRight') {
        if (isLast) onFinish(true);
        else setIndex((i) => i + 1);
      } else if (e.key === 'ArrowLeft') {
        setIndex((i) => Math.max(0, i - 1));
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [index, isLast, onFinish]);

  // 实测气泡尺寸(用于精确定位): useLayoutEffect 在 DOM 变更后、paint 前同步执行,
  // 因此首次渲染(用 150 估算)与 setBubbleSize(真实 ~220)后的重渲染都在同一帧内完成, 用户只看到修正后的位置(无闪烁)。
  useLayoutEffect(() => {
    if (isCenter) return;
    const el = bubbleRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    if (r.height > 0) setBubbleSize({ w: r.width || 320, h: r.height });
  }, [index, isCenter, step.title, step.body, step.cta, ready]);

  const next = useCallback(() => {
    if (isLast) onFinish(true);
    else setIndex((i) => i + 1);
  }, [isLast, onFinish]);
  const prev = useCallback(() => setIndex((i) => Math.max(0, i - 1)), []);

  // 气泡定位(锚点步骤时): 用实测尺寸计算, 消除高度估算偏差导致的遮挡
  let bubbleStyle: React.CSSProperties | undefined;
  if (!isCenter && rect && ready) {
    const placement = computePlacement(rect, side, bubbleSize.w, bubbleSize.h);
    bubbleStyle = { position: 'fixed', top: placement.top, left: placement.left, width: 320 };
  }

  const progress = steps.length;

  return (
    <div className="tour-root" role="dialog" aria-label="新手引导">
      {/* 遮罩: 有 rect 时用 4 块挖洞, 否则整屏 */}
      {rect && ready ? (
        <>
          <div className="tour-mask" style={{ left: 0, top: 0, width: '100%', height: rect.top }} onClick={() => onFinish(false)} />
          <div className="tour-mask" style={{ left: 0, top: rect.bottom, width: '100%', height: `calc(100vh - ${rect.bottom}px)` }} onClick={() => onFinish(false)} />
          <div className="tour-mask" style={{ left: 0, top: rect.top, width: rect.left, height: rect.height }} onClick={() => onFinish(false)} />
          <div className="tour-mask" style={{ left: rect.right, top: rect.top, width: `calc(100vw - ${rect.right}px)`, height: rect.height }} onClick={() => onFinish(false)} />
          {/* 高亮描边框 */}
          <div className="tour-highlight" style={{ left: rect.left, top: rect.top, width: rect.width, height: rect.height }} />
        </>
      ) : (
        <div className="tour-mask tour-mask-full" onClick={() => onFinish(false)} />
      )}

      {/* 气泡(锚点步骤在定位就绪前不渲染, 避免左上角闪现; ref 供 useLayoutEffect 实测尺寸) */}
      {(isCenter || ready) && (
      <div ref={bubbleRef} className={`tour-bubble ${isCenter ? 'center' : ''}`} style={isCenter ? undefined : bubbleStyle}>
        <div className="tour-head">
          <span className="tour-counter">{index + 1}/{progress}</span>
          <button className="tour-close" aria-label="关闭引导" onClick={() => onFinish(false)}>✕</button>
        </div>
        <h3 className="tour-title">{step.title}</h3>
        <p className="tour-body">{step.body}</p>
        {step.cta && <p className="tour-cta">{step.cta}</p>}

        <div className="tour-actions">
          {step.choices ? (
            // 结束卡: 渲染 choices
            step.choices.map((c) => (
              <button
                key={c.action}
                className={`btn ${c.action === 'advanced' ? 'primary' : 'ghost'}`}
                onClick={() => (c.action === 'advanced' ? onContinueAdvanced?.() : onFinish(true))}
              >
                {c.label}
              </button>
            ))
          ) : (
            <>
              <button className="btn ghost sm tour-skip" onClick={() => onFinish(false)}>跳过</button>
              <div className="tour-actions-right">
                {index > 0 && <button className="btn ghost sm" onClick={prev}>上一步</button>}
                <button className="btn primary" onClick={next}>{isLast ? '完成' : '下一步'}</button>
              </div>
            </>
          )}
        </div>
        {/* 圆点进度 */}
        {!step.choices && (
          <div className="tour-dots">
            {steps.map((_, i) => (
              <span key={i} className={`tour-dot ${i === index ? 'active' : ''}`} />
            ))}
          </div>
        )}
      </div>
      )}
    </div>
  );
}
