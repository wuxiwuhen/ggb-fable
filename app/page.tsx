// 产品落地页(公开): 介绍 GGB Fable + 引导登录/进入工作台 + 案例展示弹窗
'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import Link from 'next/link';
import { useAuth } from '@/lib/auth';

const FEATURES = [
  { ico: '🎨', title: 'AI 一句话画图', desc: '用自然语言描述图形，AI 自动构造可拖动、可探究的 GeoGebra 动态画布。' },
  { ico: '🆓', title: '免费试用 5 次', desc: '邮箱注册即享 5 次免费画布，无需信用卡，开箱即用。' },
  { ico: '🔑', title: '自带 Key 无限用', desc: '配置你自己的 API Key，无限次生成；Key 仅存浏览器，永不上传服务器。' },
  { ico: '🔍', title: '命令智能检索', desc: '内置 GeoGebra 命令知识库 + 混合检索，精准调用数百条命令与别名。' },
  { ico: '✅', title: '数值关系校验', desc: 'AI 主动验证垂直、共线、定值等几何约束是否成立，确保构造正确可推敲。' },
  { ico: '👁️', title: '视觉渲染检查', desc: '截图交视觉模型检查标签遮挡、辅助线型、角弧方向，闭合"画得满不满意"最后一环。' },
];

const DEMOS = [
  {
    title: '正六边形',
    desc: '圆的内接正六边形，尺规作图经典构造',
    type: 'image' as const,
    src: '/demos/hexagon.png',
  },
  {
    title: '二次函数图像',
    desc: '自动求顶点、对称轴与 x 轴交点',
    type: 'image' as const,
    src: '/demos/quadratic.png',
  },
  {
    title: '圆的周长',
    desc: '圆沿 x 轴滚动一周，验证周长公式 C=2πr',
    type: 'video' as const,
    src: '/demos/rolling-circle.mp4',
  },
  {
    title: '圆锥螺线',
    desc: '3D 空间 · 动点沿圆锥表面螺旋上升',
    type: 'video' as const,
    src: '/demos/helix-cone.mp4',
  },
];

// ── 案例展示弹窗：自动轮播 4 个案例 ──
// 图片: 8s 后自动切; 视频: 播完自动切; 手动切重置计时器
function DemoModal({ onClose }: { onClose: () => void }) {
  const [idx, setIdx] = useState(0);
  const current = DEMOS[idx];
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const nextRef = useRef<() => void>(() => {});

  const next = useCallback(() => {
    setIdx((i) => (i + 1) % DEMOS.length);
  }, []);

  // 手动切换: 清计时器, 切到目标, 由 effect 重新调度
  const goTo = useCallback((i: number) => {
    if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null; }
    setIdx(i);
  }, []);

  const prev = useCallback(() => goTo((idx - 1 + DEMOS.length) % DEMOS.length), [idx, goTo]);

  // 根据当前项类型调度下次切换
  useEffect(() => {
    if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null; }
    if (current.type === 'image') {
      timerRef.current = setTimeout(next, 8000);
    }
    // 视频: 不设定时器, 靠 onEnded 回调切
    return () => { if (timerRef.current) clearTimeout(timerRef.current); };
  }, [idx, current.type, next]);

  // 保持 nextRef 最新, 供视频 onEnded 使用
  nextRef.current = next;

  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="demo-modal" onClick={(e) => e.stopPropagation()}>
        <button className="xhs-modal-close" onClick={onClose}>✕</button>

        <div className="demo-stage">
          <button className="demo-arrow demo-arrow-left" onClick={prev}>‹</button>
          {current.type === 'video' ? (
            <video key={current.src} src={current.src} autoPlay muted playsInline className="demo-media"
              onEnded={() => nextRef.current()} />
          ) : (
            <img key={current.src} src={current.src} alt={current.title} className="demo-media" />
          )}
          <button className="demo-arrow demo-arrow-right" onClick={next}>›</button>
        </div>

        <h2 className="demo-title">{current.title}</h2>
        <p className="demo-desc">{current.desc}</p>

        <div className="demo-dots">
          {DEMOS.map((_, i) => (
            <button key={i} className={`demo-dot${i === idx ? ' active' : ''}`} onClick={() => goTo(i)} />
          ))}
        </div>
      </div>
    </div>
  );
}

export default function LandingPage() {
  const { user, isAdmin, loading, adminLoading } = useAuth();
  const authReady = !loading;
  const adminReady = !loading && !adminLoading;
  const ctaHref = user ? '/app' : '/login';
  const ctaLabel = user ? '进入工作台' : '立即体验';
  const [xhsOpen, setXhsOpen] = useState(false);
  const [demoOpen, setDemoOpen] = useState(false);

  return (
    <div className="landing">
      {/* 背景渐变 blob */}
      <div className="blob" style={{ width: 460, height: 460, background: '#c7d2fe', top: -120, left: -100 }} />
      <div className="blob" style={{ width: 520, height: 520, background: '#fed7aa', bottom: -160, right: -120 }} />
      <div className="blob" style={{ width: 360, height: 360, background: '#f5d0fe', top: '38%', left: '52%' }} />

      {/* 浮动几何装饰 */}
      <div className="shape" style={{ top: '16%', left: '7%', animation: 'float 7s ease-in-out infinite' }}>
        <div style={{ width: 0, height: 0, borderLeft: '26px solid transparent', borderRight: '26px solid transparent', borderBottom: '44px solid rgba(79,70,229,0.25)' }} />
      </div>
      <div className="shape" style={{ top: '28%', right: '9%', animation: 'floatSlow 9s ease-in-out infinite' }}>
        <div style={{ width: 40, height: 40, borderRadius: '50%', background: 'rgba(16,185,129,0.22)' }} />
      </div>
      <div className="shape" style={{ bottom: '24%', left: '13%', animation: 'float 8s ease-in-out infinite' }}>
        <div style={{ width: 38, height: 38, background: 'rgba(244,114,182,0.2)', borderRadius: 8, transform: 'rotate(20deg)' }} />
      </div>
      <div className="shape" style={{ bottom: '18%', right: '15%', animation: 'floatSlow 10s ease-in-out infinite' }}>
        <div style={{ width: 0, height: 0, borderLeft: '20px solid transparent', borderRight: '20px solid transparent', borderBottom: '34px solid rgba(245,158,11,0.25)' }} />
      </div>

      {/* 顶部导航 */}
      <nav className="landing-nav">
        <div className="brand" style={{ fontSize: 20 }}>
          <span className="logo" style={{ fontSize: 28 }}>📐</span>
          <span className="title" style={{ fontSize: 22 }}>GGB Fable</span>
        </div>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          <button className="btn xhs-btn" onClick={() => setXhsOpen(true)}>🎁 获取额度</button>
          {adminReady && isAdmin && <Link className="btn ghost" href="/admin" style={{ fontSize: 15, padding: '8px 16px' }}>管理后台</Link>}
          {authReady ? (
            <Link className={user ? 'btn ghost' : 'btn primary'} href={ctaHref} style={{ fontSize: 15, padding: '8px 18px' }}>{user ? '工作台' : '登录'}</Link>
          ) : (
            <span className="btn ghost" style={{ fontSize: 15, padding: '8px 18px', opacity: 0.6, cursor: 'default' }}>···</span>
          )}
        </div>
      </nav>

      {/* Hero */}
      <section className="landing-hero">
        <div className="fade-up" style={{ fontSize: 44, lineHeight: 1 }}>📐</div>
        <h1 className="landing-title fade-up d1">用一句话，画出可探究的数学图形</h1>
        <p className="landing-sub fade-up d2">
          GGB Fable 是面向 K12 的 GeoGebra AI 画布助手 —— 描述即生成，可拖动、可探究。
        </p>
        <div className="landing-cta fade-up d3">
          {authReady ? (
            <>
              <Link className="btn primary lg" href={ctaHref} style={{ padding: '14px 40px', fontSize: 17 }}>{ctaLabel} →</Link>
              <button className="btn primary lg" onClick={() => setDemoOpen(true)} style={{ padding: '14px 40px', fontSize: 17, background: '#fff', color: '#4f46e5', border: '2px solid #c7d2fe' }}>案例展示</button>
            </>
          ) : (
            <span className="btn primary lg" style={{ padding: '14px 40px', fontSize: 17, opacity: 0.7, cursor: 'default' }}>···</span>
          )}
        </div>
        <p className="fade-up d3" style={{ marginTop: 18, color: '#999', fontSize: 13 }}>
          免费试用 5 次 · 也可配置自己的 API Key 无限使用
        </p>
      </section>

      {/* 功能卡片 */}
      <section id="features" className="landing-features">
        {FEATURES.map((f) => (
          <div key={f.title} className="feature-card">
            <div className="ico">{f.ico}</div>
            <h3>{f.title}</h3>
            <p>{f.desc}</p>
          </div>
        ))}
      </section>

      <footer className="landing-footer">
        © GGB Fable · 让每个孩子都能玩转数学图形
      </footer>

      {/* 获取额度弹窗 */}
      {xhsOpen && (
        <div className="modal-mask" onClick={() => setXhsOpen(false)}>
          <div className="xhs-modal" onClick={(e) => e.stopPropagation()}>
            <button className="xhs-modal-close" onClick={() => setXhsOpen(false)}>✕</button>
            <div className="xhs-modal-icon">📕</div>
            <h2 className="xhs-modal-title">关注小红书 · 领额外 10 次额度</h2>
            <p className="xhs-modal-desc">打开小红书，搜索下方账号或小红书号，关注后私信发送 <strong>"GGB"</strong> 即可领取。人工回复，稍等片刻 ✨</p>
            <div className="xhs-modal-account">
              <div className="xhs-modal-field">
                <span className="xhs-modal-label">账号</span>
                <span className="xhs-modal-value">@DolaEmw</span>
              </div>
              <div className="xhs-modal-field">
                <span className="xhs-modal-label">小红书号</span>
                <span className="xhs-modal-value mono">2327679345</span>
              </div>
            </div>
            <button className="btn primary xhs-modal-btn" onClick={() => setXhsOpen(false)}>知道了</button>
          </div>
        </div>
      )}

      {/* 案例展示弹窗 */}
      {demoOpen && <DemoModal onClose={() => setDemoOpen(false)} />}
    </div>
  );
}
