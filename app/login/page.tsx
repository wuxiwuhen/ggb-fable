'use client';

// 登录/注册页 —— Magic Link(邮箱收链接登录, 无密码)
// 注册与登录同一入口: 输入邮箱 → 发登录链接 → 收件箱点击 → 自动回首页

import { useState } from 'react';
import { useAuth } from '@/lib/auth';

export default function LoginPage() {
  const { signInWithEmail } = useAuth();
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      await signInWithEmail(email.trim());
      setSent(true);
    } catch (err: any) {
      setError(err.message || '发送失败');
    } finally {
      setLoading(false);
    }
  }

  return (
    <main style={styles.wrap}>
      <div style={styles.card}>
        <h1 style={styles.title}>📐 GGB Fable</h1>
        <p style={styles.subtitle}>K12 GeoGebra AI 画布助手</p>

        {!sent ? (
          <form onSubmit={onSubmit} style={styles.form}>
            <p style={styles.hint}>输入邮箱获取登录链接。注册即登录, 无需密码。</p>
            <input
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
              style={styles.input}
              autoFocus
            />
            <button type="submit" disabled={loading} style={styles.button}>
              {loading ? '发送中…' : '发送登录链接'}
            </button>
            {error && <p style={styles.error}>{error}</p>}
          </form>
        ) : (
          <div style={styles.sent}>
            <p>✉️ 登录链接已发送到 <strong>{email}</strong></p>
            <p style={styles.hint}>请到邮箱点击链接完成登录(可能需检查垃圾邮件)。</p>
          </div>
        )}

        <div style={styles.footer}>
          <span>免费试用 5 次 · 也可配置自己的 API Key 无限使用</span>
          <div style={{ marginTop: 10 }}><a href="/" style={{ color: '#4f46e5', fontSize: 13 }}>← 返回首页</a></div>
        </div>
      </div>
    </main>
  );
}

const styles: Record<string, React.CSSProperties> = {
  wrap: { minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'linear-gradient(135deg,#f0f4ff,#fef6f0)', padding: 20 },
  card: { background: '#fff', borderRadius: 16, padding: 40, maxWidth: 420, width: '100%', boxShadow: '0 8px 32px rgba(0,0,0,0.08)' },
  title: { margin: 0, fontSize: 28, textAlign: 'center' },
  subtitle: { margin: '4px 0 24px', textAlign: 'center', color: '#888', fontSize: 14 },
  form: { display: 'flex', flexDirection: 'column', gap: 12 },
  hint: { color: '#888', fontSize: 13, lineHeight: 1.5 },
  input: { padding: '12px 14px', border: '1px solid #ddd', borderRadius: 8, fontSize: 15, outline: 'none' },
  button: { padding: '12px', background: '#4f46e5', color: '#fff', border: 'none', borderRadius: 8, fontSize: 15, fontWeight: 600, cursor: 'pointer' },
  error: { color: '#dc2626', fontSize: 13, margin: 0 },
  sent: { textAlign: 'center', lineHeight: 1.8, padding: '12px 0' },
  footer: { marginTop: 24, textAlign: 'center', color: '#aaa', fontSize: 12 },
};
