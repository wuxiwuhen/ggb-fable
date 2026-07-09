'use client';

// 设置页: BYOK 模型配置(对话 + 视觉)、模式切换、工具轮数
// BYOK 的 key 只存浏览器 localStorage(zustand persist), 永不上传后端

import { useState } from 'react';
import { useConfigStore, PRESETS } from '@/lib/config-store';
import { useAuth } from '@/lib/auth';

export default function SettingsPage() {
  const { user } = useAuth();
  const config = useConfigStore();
  const [name, setName] = useState(config.getActiveByok()?.name || '');
  const [apiKey, setApiKey] = useState(config.getActiveByok()?.api_key || '');
  const [baseUrl, setBaseUrl] = useState(config.getActiveByok()?.base_url || '');
  const [modelName, setModelName] = useState(config.getActiveByok()?.model_name || '');
  const [saved, setSaved] = useState(false);

  function save() {
    if (!name) return;
    config.addOrUpdateProfile({ name, api_key: apiKey, base_url: baseUrl, model_name: modelName });
    config.setActiveProfileName(name);
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  }

  function applyPreset(p: { base_url: string; model_name: string }) {
    setBaseUrl(p.base_url);
    setModelName(p.model_name);
  }

  return (
    <main style={S.wrap}>
      <div style={S.card}>
        <h1 style={S.h1}>⚙ 设置</h1>
        {user && <p style={S.sub}>已登录: {user.email}</p>}

        <section style={S.section}>
          <h2 style={S.h2}>使用模式</h2>
          <div style={S.modeRow}>
            <button style={config.mode === 'trial' ? S.modeActive : S.modeBtn} onClick={() => config.setMode('trial')}>
              免费试用(我的额度, 每用户 5 次)
            </button>
            <button style={config.mode === 'byok' ? S.modeActive : S.modeBtn} onClick={() => config.setMode('byok')}>
              自带 Key(你的 API, 无限次)
            </button>
          </div>
          {config.mode === 'byok' && (
            <p style={S.note}>BYOK 模式下, 你的 API Key 仅存在本浏览器, 永不发送到服务器。</p>
          )}
        </section>

        <section style={S.section}>
          <h2 style={S.h2}>BYOK 模型配置 <span style={S.badge}>{config.mode === 'byok' ? '生效中' : '备用'}</span></h2>

          <label style={S.label}>配置名称
            <input style={S.input} value={name} onChange={(e) => setName(e.target.value)} placeholder="如: 我的 DeepSeek" />
          </label>
          <label style={S.label}>API Key
            <input style={S.input} type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="sk-..." />
          </label>
          <label style={S.label}>Base URL
            <input style={S.input} value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://api.deepseek.com/v1" />
          </label>
          <label style={S.label}>Model Name
            <input style={S.input} value={modelName} onChange={(e) => setModelName(e.target.value)} placeholder="deepseek-chat / glm-4.6 ..." />
          </label>

          <div style={S.presets}>
            <span style={S.presetLabel}>常用预设:</span>
            {PRESETS.map((p) => (
              <button key={p.label} style={S.presetBtn} onClick={() => applyPreset(p)}>{p.label}</button>
            ))}
          </div>

          {config.byokProfiles.length > 0 && (
            <div style={S.profileList}>
              <span style={S.presetLabel}>已有配置:</span>
              {config.byokProfiles.map((p) => (
                <button key={p.name} style={config.activeProfileName === p.name ? S.modeActive : S.presetBtn}
                  onClick={() => { config.setActiveProfileName(p.name); setName(p.name); setApiKey(p.api_key); setBaseUrl(p.base_url); setModelName(p.model_name); }}>
                  {p.name}
                </button>
              ))}
            </div>
          )}

          <div style={{ display: 'flex', gap: 8 }}>
            <button style={S.saveBtn} onClick={save}>保存</button>
            {saved && <span style={S.saved}>✓ 已保存</span>}
          </div>
        </section>

        <section style={S.section}>
          <h2 style={S.h2}>视觉模型(图片 OCR) <span style={S.badge}>可选</span></h2>
          <p style={S.note}>BYOK 模式下识别数学题图片用。留空则禁用图片输入(免费试用模式不受影响, 走后端)。</p>
          <label style={S.label}>API Key
            <input style={S.input} type="password" value={config.vision.api_key || ''} onChange={(e) => config.setVision({ api_key: e.target.value })} />
          </label>
          <label style={S.label}>Base URL
            <input style={S.input} value={config.vision.base_url || ''} onChange={(e) => config.setVision({ base_url: e.target.value })} placeholder="https://open.bigmodel.cn/api/paas/v4" />
          </label>
          <label style={S.label}>Model Name
            <input style={S.input} value={config.vision.model_name || ''} onChange={(e) => config.setVision({ model_name: e.target.value })} placeholder="glm-4.6v" />
          </label>
        </section>

        <section style={S.section}>
          <h2 style={S.h2}>高级</h2>
          <label style={S.label}>最大工具轮数(单次请求, 默认 30)
            <input style={S.input} type="number" min={1} max={100} value={config.maxToolRounds} onChange={(e) => config.setMaxToolRounds(+e.target.value)} />
          </label>
        </section>

        <a href="/" style={S.back}>← 返回应用</a>
      </div>
    </main>
  );
}

const S: Record<string, React.CSSProperties> = {
  wrap: { minHeight: '100vh', background: '#f7f8fa', padding: '40px 20px' },
  card: { maxWidth: 640, margin: '0 auto', background: '#fff', borderRadius: 12, padding: 32, boxShadow: '0 2px 12px rgba(0,0,0,0.06)' },
  h1: { margin: '0 0 4px' },
  sub: { margin: '0 0 20px', color: '#888', fontSize: 13 },
  section: { borderTop: '1px solid #eee', paddingTop: 20, marginTop: 20 },
  h2: { fontSize: 16, margin: '0 0 12px' },
  label: { display: 'block', fontSize: 13, color: '#555', marginBottom: 10 },
  input: { display: 'block', width: '100%', marginTop: 4, padding: '10px 12px', border: '1px solid #ddd', borderRadius: 6, fontSize: 14, boxSizing: 'border-box' },
  modeRow: { display: 'flex', gap: 8, flexWrap: 'wrap' },
  modeBtn: { flex: 1, minWidth: 180, padding: 14, border: '1px solid #ddd', borderRadius: 8, background: '#fff', cursor: 'pointer', fontSize: 14 },
  modeActive: { flex: 1, minWidth: 180, padding: 14, border: '2px solid #4f46e5', borderRadius: 8, background: '#eef2ff', cursor: 'pointer', fontSize: 14, fontWeight: 600, color: '#4f46e5' },
  note: { fontSize: 12, color: '#999', lineHeight: 1.6, margin: '8px 0 0' },
  badge: { fontSize: 11, color: '#888', fontWeight: 400, background: '#f0f0f0', padding: '2px 8px', borderRadius: 10 },
  presets: { display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center', margin: '8px 0 16px' },
  presetLabel: { fontSize: 12, color: '#999' },
  presetBtn: { padding: '6px 10px', border: '1px solid #ddd', borderRadius: 6, background: '#fafafa', cursor: 'pointer', fontSize: 12 },
  profileList: { display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center', margin: '8px 0 16px' },
  saveBtn: { padding: '10px 24px', background: '#4f46e5', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 14, fontWeight: 600 },
  saved: { color: '#16a34a', fontSize: 13, alignSelf: 'center' },
  back: { display: 'inline-block', marginTop: 24, color: '#4f46e5', fontSize: 14 },
};
