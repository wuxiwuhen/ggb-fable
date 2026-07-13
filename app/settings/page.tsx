'use client';

// 设置页: 左侧 Tab 导航 + 右侧内容区
// BYOK 的 key 只存浏览器 localStorage(zustand persist), 永不上传后端

import { useState } from 'react';
import Link from 'next/link';
import { useConfigStore, PRESETS } from '@/lib/config-store';
import { useAuth } from '@/lib/auth';
import { getSupabaseBrowser } from '@/lib/supabase';

const TABS = ['基础模型', '视觉模型', '嵌入模型', '修改密码', '高级'] as const;
type Tab = (typeof TABS)[number];

export default function SettingsPage() {
  const { user } = useAuth();
  const config = useConfigStore();
  const [tab, setTab] = useState<Tab>('基础模型');

  // ── 模型配置表单 ──
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

  // ── 密码表单 ──
  const [newPassword, setNewPassword] = useState('');
  const [pwMsg, setPwMsg] = useState<{ ok: boolean; text: string } | null>(null);

  async function changePassword() {
    if (newPassword.length < 6) { setPwMsg({ ok: false, text: '密码至少 6 位' }); return; }
    setPwMsg(null);
    const { error } = await getSupabaseBrowser().auth.updateUser({ password: newPassword });
    if (error) { setPwMsg({ ok: false, text: error.message }); return; }
    setNewPassword('');
    setPwMsg({ ok: true, text: '密码已更新' });
    setTimeout(() => setPwMsg(null), 2000);
  }

  return (
    <main style={S.wrap}>
      <div style={S.card}>
        {/* 顶栏 */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
          <div>
            <h1 style={S.h1}>⚙ 设置</h1>
            {user && <p style={S.sub}>已登录: {user.email}</p>}
          </div>
          <Link href="/app" style={S.backBtn}>← 返回工作台</Link>
        </div>

        {/* 主体: 左侧 Tab + 右侧内容 */}
        <div style={{ display: 'flex', gap: 28 }}>
          {/* 左侧 Tab 导航 */}
          <nav style={S.tabs}>
            {TABS.map((t) => (
              <button key={t} style={tab === t ? S.tabActive : S.tabBtn} onClick={() => setTab(t)}>
                {t}
              </button>
            ))}
          </nav>

          {/* 右侧内容 */}
          <div style={{ flex: 1, minWidth: 0 }}>
            {tab === '基础模型' && (
              <>
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
                  <input style={S.input} value={modelName} onChange={(e) => setModelName(e.target.value)} placeholder="deepseek-chat" />
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

                <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 8 }}>
                  <button style={S.saveBtn} onClick={save}>保存</button>
                  {saved && <span style={S.saved}>✓ 已保存</span>}
                </div>
              </>
            )}

            {tab === '视觉模型' && (
              <>
                <h2 style={S.h2}>视觉模型(图片 OCR) <span style={S.badge}>可选</span></h2>
                <p style={S.note}>BYOK 模式下识别数学题图片用。留空则禁用图片输入(免费试用模式不受影响)。</p>
                <label style={S.label}>API Key
                  <input style={S.input} type="password" value={config.vision.api_key || ''} onChange={(e) => config.setVision({ api_key: e.target.value })} />
                </label>
                <label style={S.label}>Base URL
                  <input style={S.input} value={config.vision.base_url || ''} onChange={(e) => config.setVision({ base_url: e.target.value })} placeholder="https://open.bigmodel.cn/api/paas/v4" />
                </label>
                <label style={S.label}>Model Name
                  <input style={S.input} value={config.vision.model_name || ''} onChange={(e) => config.setVision({ model_name: e.target.value })} placeholder="glm-4.6v" />
                </label>
                <p style={S.note}>视觉模型配置实时生效(无需保存按钮)</p>
              </>
            )}

            {tab === '嵌入模型' && (
              <>
                <h2 style={S.h2}>嵌入模型(命令检索) <span style={S.badge}>可选</span></h2>
                <p style={S.note}>BYOK 模式下命令知识库向量检索用。留空则复用 LLM 配置（仅 GLM 端点向后兼容），不存在兼容端点则降级为纯关键词匹配（仍然可用，只是语义排序不如向量检索精确）。</p>
                <label style={S.label}>API Key
                  <input style={S.input} type="password" value={config.embedding.api_key || ''} onChange={(e) => config.setEmbedding({ api_key: e.target.value })} />
                </label>
                <label style={S.label}>Base URL
                  <input style={S.input} value={config.embedding.base_url || ''} onChange={(e) => config.setEmbedding({ base_url: e.target.value })} placeholder="https://api.openai.com/v1" />
                </label>
                <label style={S.label}>Model Name
                  <input style={S.input} value={config.embedding.model_name || ''} onChange={(e) => config.setEmbedding({ model_name: e.target.value })} placeholder="text-embedding-3-small" />
                </label>
                <label style={S.label}>Dimensions(维度)
                  <input style={S.input} type="number" min={64} max={4096} value={config.embedding.dimensions || 1024} onChange={(e) => config.setEmbedding({ dimensions: +e.target.value || 1024 })} placeholder="1024" />
                </label>
                <p style={S.note}>嵌入模型配置实时生效。首次使用新模型时会调用一次 API 批量计算向量并 IndexedDB 缓存，后续会话直接复用（零调用）。</p>
              </>
            )}

            {tab === '修改密码' && (
              <>
                <h2 style={S.h2}>修改密码</h2>
                <label style={S.label}>新密码(至少 6 位)
                  <input style={S.input} type="password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} placeholder="设置新密码" />
                </label>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <button style={S.saveBtn} onClick={changePassword}>更新密码</button>
                  {pwMsg && <span style={{ color: pwMsg.ok ? '#16a34a' : '#dc2626', fontSize: 13 }}>{pwMsg.text}</span>}
                </div>
              </>
            )}

            {tab === '高级' && (
              <>
                <h2 style={S.h2}>高级</h2>
                <label style={S.label}>最大工具轮数(单次请求)
                  <input style={S.input} type="number" min={1} max={100} value={config.maxToolRounds} onChange={(e) => config.setMaxToolRounds(+e.target.value)} />
                </label>
                <p style={S.note}>一次发送中 Agent 最多执行多少轮工具调用。改完即生效。</p>
              </>
            )}
          </div>
        </div>
      </div>
    </main>
  );
}

const S: Record<string, React.CSSProperties> = {
  wrap: { minHeight: '100vh', background: '#f7f8fa', padding: '40px 20px' },
  card: { maxWidth: 820, margin: '0 auto', background: '#fff', borderRadius: 12, padding: 32, boxShadow: '0 2px 12px rgba(0,0,0,0.06)' },
  h1: { margin: 0 },
  sub: { margin: '4px 0 0', color: '#888', fontSize: 13 },
  backBtn: { color: '#4f46e5', fontSize: 14, alignSelf: 'flex-start' },
  h2: { fontSize: 16, margin: '0 0 12px' },
  label: { display: 'block', fontSize: 13, color: '#555', marginBottom: 10 },
  input: { display: 'block', width: '100%', marginTop: 4, padding: '10px 12px', border: '1px solid #ddd', borderRadius: 6, fontSize: 14, boxSizing: 'border-box' },
  modeBtn: { flex: 1, padding: '10px 16px', border: '1px solid #ddd', borderRadius: 8, background: '#fff', cursor: 'pointer', fontSize: 14 },
  modeActive: { flex: 1, padding: '10px 16px', border: '2px solid #4f46e5', borderRadius: 8, background: '#eef2ff', cursor: 'pointer', fontSize: 14, fontWeight: 600, color: '#4f46e5' },
  note: { fontSize: 12, color: '#999', lineHeight: 1.6, margin: '8px 0 0' },
  badge: { fontSize: 11, color: '#888', fontWeight: 400, background: '#f0f0f0', padding: '2px 8px', borderRadius: 10 },
  presets: { display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center', margin: '8px 0 16px' },
  presetLabel: { fontSize: 12, color: '#999' },
  presetBtn: { padding: '6px 10px', border: '1px solid #ddd', borderRadius: 6, background: '#fafafa', cursor: 'pointer', fontSize: 12 },
  profileList: { display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center', margin: '8px 0 16px' },
  saveBtn: { padding: '10px 24px', background: '#4f46e5', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 14, fontWeight: 600 },
  saved: { color: '#16a34a', fontSize: 13 },
  tabs: { display: 'flex', flexDirection: 'column', gap: 4, width: 140, flexShrink: 0 },
  tabBtn: { padding: '10px 14px', border: 'none', borderRadius: 8, background: 'transparent', cursor: 'pointer', fontSize: 14, textAlign: 'left', color: '#666' },
  tabActive: { padding: '10px 14px', border: 'none', borderRadius: 8, background: '#eef2ff', cursor: 'pointer', fontSize: 14, textAlign: 'left', color: '#4f46e5', fontWeight: 600 },
};
