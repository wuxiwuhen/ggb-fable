// 产品落地页(公开): 介绍 GGB Fable + 引导登录/进入工作台
'use client';

import { useAuth } from '@/lib/auth';

const FEATURES = [
  { ico: '🎨', title: 'AI 一句话画图', desc: '用自然语言描述图形，AI 自动构造可拖动、可探究的 GeoGebra 动态画布。' },
  { ico: '🆓', title: '免费试用 5 次', desc: '邮箱注册即享 5 次免费画布，无需信用卡，开箱即用。' },
  { ico: '🔑', title: '自带 Key 无限用', desc: '配置你自己的 API Key，无限次生成；Key 仅存浏览器，永不上传服务器。' },
  { ico: '🔍', title: '命令智能检索', desc: '内置 GeoGebra 命令知识库 + 混合检索，精准调用数百条命令与别名。' },
  { ico: '✅', title: '数值关系校验', desc: 'AI 主动验证垂直、共线、定值等几何约束是否成立，确保构造正确可推敲。' },
  { ico: '👁️', title: '视觉渲染检查', desc: '截图交视觉模型检查标签遮挡、辅助线型、角弧方向，闭合"画得满不满意"最后一环。' },
];

export default function LandingPage() {
  const { user, isAdmin } = useAuth();
  // 已登录进工作台, 未登录去登录页(注册即享 5 次试用)
  const ctaHref = user ? '/app' : '/login';
  const ctaLabel = user ? '进入工作台' : '立即体验';

  return (
    <div className="landing">
      {/* 背景渐变 blob */}
      <div className="blob" style={{ width: 460, height: 460, background: '#c7d2fe', top: -120, left: -100 }} />
      <div className="blob" style={{ width: 520, height: 520, background: '#fed7aa', bottom: -160, right: -120 }} />
      <div className="blob" style={{ width: 360, height: 360, background: '#f5d0fe', top: '38%', left: '52%' }} />

      {/* 浮动几何装饰(呼应 GeoGebra 几何主题) */}
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
          {isAdmin && <a className="btn ghost" href="/admin" style={{ fontSize: 15, padding: '8px 16px' }}>管理后台</a>}
          <a className={user ? 'btn ghost' : 'btn primary'} href={ctaHref} style={{ fontSize: 15, padding: '8px 18px' }}>{user ? '工作台' : '登录'}</a>
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
          <a className="btn primary lg" href={ctaHref} style={{ padding: '14px 40px', fontSize: 17 }}>{ctaLabel} →</a>
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
    </div>
  );
}
