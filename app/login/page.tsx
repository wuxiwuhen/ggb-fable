'use client';

// 登录/注册页 —— 邮箱 + 密码(注册需邮箱确认一次, 之后密码登录无需邮件)
import { useState } from 'react';
import Link from 'next/link';
import { useAuth } from '@/lib/auth';

type Mode = 'login' | 'register' | 'reset';

// Supabase 英文错误 → 中文
function translateError(msg: string): string {
  const m = msg.toLowerCase();
  if (m.includes('invalid login credentials')) return '邮箱或密码错误';
  if (m.includes('already registered')) return '该邮箱已注册, 请直接登录';
  if (m.includes('email not confirmed')) return '邮箱未确认, 请先去邮箱点确认链接';
  if (m.includes('password') && (m.includes('at least') || m.includes('characters'))) return '密码至少 6 位';
  if (m.includes('user not found')) return '账号不存在, 请先注册';
  if (m.includes('rate limit') || m.includes('too many')) return '操作太频繁, 请稍后再试';
  return msg;
}

export default function LoginPage() {
  const { signInWithPassword, signUpWithPassword, resetPassword } = useAuth();
  const [mode, setMode] = useState<Mode>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');
  const [loading, setLoading] = useState(false);

  function switchMode(m: Mode) { setMode(m); setError(''); setInfo(''); }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(''); setInfo('');
    setLoading(true);
    try {
      if (mode === 'login') {
        await signInWithPassword(email.trim(), password);
        window.location.href = '/app'; // 登录成功 → 工作台
      } else if (mode === 'register') {
        const data = await signUpWithPassword(email.trim(), password);
        if (data?.session) {
          // 未开启邮箱确认 → 已直接登录, 进工作台
          window.location.href = '/app';
        } else {
          setInfo('注册成功! 请到邮箱点击确认链接完成激活, 然后回来登录。');
        }
      } else {
        await resetPassword(email.trim());
        setInfo('重置邮件已发送, 请到邮箱查收(点链接后会进入设置页改新密码)。');
      }
    } catch (err: any) {
      setError(translateError(err.message || '操作失败'));
    } finally {
      setLoading(false);
    }
  }

  const titles = { login: '欢迎回来', register: '创建账号', reset: '找回密码' };
  const submitText = { login: '登 录', register: '注 册', reset: '发送重置邮件' };

  return (
    <main style={styles.wrap}>
      <div style={styles.card}>
        <h1 style={styles.title}>📐 GGB Fable</h1>
        <p style={styles.subtitle}>K12 GeoGebra AI 画布助手</p>

        {/* Tab: 登录 / 注册 (reset 是子模式, 有返回入口) */}
        {mode !== 'reset' && (
          <div style={styles.tabs}>
            <button type="button" style={mode === 'login' ? styles.tabActive : styles.tab} onClick={() => switchMode('login')}>登录</button>
            <button type="button" style={mode === 'register' ? styles.tabActive : styles.tab} onClick={() => switchMode('register')}>注册</button>
          </div>
        )}

        <form onSubmit={onSubmit} style={styles.form}>
          <h2 style={styles.modeTitle}>{titles[mode]}</h2>
          <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="邮箱" style={styles.input} autoFocus />
          {mode !== 'reset' && (
            <input type="password" required minLength={6} value={password} onChange={(e) => setPassword(e.target.value)} placeholder="密码(至少 6 位)" style={styles.input} />
          )}
          <button type="submit" disabled={loading} style={styles.button}>{loading ? '处理中…' : submitText[mode]}</button>
          {error && <p style={styles.error}>{error}</p>}
          {info && <p style={styles.info}>{info}</p>}
        </form>

        {/* 切换入口 */}
        <div style={styles.links}>
          {mode === 'login' && <a style={styles.link} onClick={() => switchMode('reset')}>忘记密码?</a>}
          {mode === 'reset' && <a style={styles.link} onClick={() => switchMode('login')}>← 返回登录</a>}
        </div>

        <div style={styles.footer}>
          <span>免费试用 5 次 · 也可配置自己的 API Key 无限使用</span>
          <div style={{ marginTop: 10 }}><Link href="/" style={{ color: '#4f46e5', fontSize: 13 }}>← 返回首页</Link></div>
        </div>
      </div>
    </main>
  );
}

const styles: Record<string, React.CSSProperties> = {
  wrap: { minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'linear-gradient(135deg,#f0f4ff,#fef6f0)', padding: 20 },
  card: { background: '#fff', borderRadius: 16, padding: 40, maxWidth: 420, width: '100%', boxShadow: '0 8px 32px rgba(0,0,0,0.08)' },
  title: { margin: 0, fontSize: 28, textAlign: 'center' },
  subtitle: { margin: '4px 0 20px', textAlign: 'center', color: '#888', fontSize: 14 },
  tabs: { display: 'flex', gap: 8, marginBottom: 20 },
  tab: { flex: 1, padding: 10, border: '1px solid #ddd', borderRadius: 8, background: '#fff', cursor: 'pointer', fontSize: 14, color: '#666' },
  tabActive: { flex: 1, padding: 10, border: '2px solid #4f46e5', borderRadius: 8, background: '#eef2ff', cursor: 'pointer', fontSize: 14, fontWeight: 600, color: '#4f46e5' },
  modeTitle: { margin: '0 0 14px', fontSize: 16, color: '#333' },
  form: { display: 'flex', flexDirection: 'column', gap: 12 },
  input: { padding: '12px 14px', border: '1px solid #ddd', borderRadius: 8, fontSize: 15, outline: 'none' },
  button: { padding: 12, background: '#4f46e5', color: '#fff', border: 'none', borderRadius: 8, fontSize: 15, fontWeight: 600, cursor: 'pointer' },
  error: { color: '#dc2626', fontSize: 13, margin: 0 },
  info: { color: '#16a34a', fontSize: 13, margin: 0, lineHeight: 1.6 },
  links: { marginTop: 14, textAlign: 'center' },
  link: { color: '#4f46e5', fontSize: 13, cursor: 'pointer' },
  footer: { marginTop: 24, textAlign: 'center', color: '#aaa', fontSize: 12 },
};
