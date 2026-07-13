// 一次性预计算命令知识库 embedding 为静态文件, 避免每会话重复调用 API。
// 运行: node scripts/precompute-embeddings.mjs
// 产出: public/knowledge/commandEmbeddings.json (约 4MB)
// 依赖环境变量: GLM_BASE_URL, GLM_API_KEY, GLM_EMBEDDING_MODEL
//   若 .env.local 存在则自动读取; 否则用 process.env

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

// 简易 .env.local 解析(不依赖第三方包)
function loadEnv() {
  const envPath = resolve(ROOT, '.env.local');
  try {
    const lines = readFileSync(envPath, 'utf-8').split('\n');
    for (const line of lines) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const eq = t.indexOf('=');
      if (eq < 0) continue;
      const k = t.slice(0, eq).trim();
      const v = t.slice(eq + 1).trim();
      if (!process.env[k]) process.env[k] = v;
    }
  } catch { console.warn('[env] .env.local 未找到, 用已有环境变量'); }
}

loadEnv();

const BASE_URL = process.env.GLM_BASE_URL || 'https://open.bigmodel.cn/api/paas/v4';
const API_KEY = process.env.GLM_API_KEY;
const MODEL = process.env.GLM_EMBEDDING_MODEL || 'embedding-3';

if (!API_KEY) {
  console.error('❌ 缺少 GLM_API_KEY (请设置环境变量或在 .env.local 中配置)');
  process.exit(1);
}

const BATCH = 20;
const DIM = 1024;
const MODEL_KEY = `glm::${MODEL}::${DIM}`;

function joinUrl(base, path) {
  const b = base.replace(/\/+$/, '');
  return /\/v\d+$/.test(b) ? b + path : b + '/v1' + path;
}

async function embed(texts) {
  const resp = await fetch(joinUrl(BASE_URL, '/embeddings'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${API_KEY}` },
    body: JSON.stringify({ model: MODEL, input: texts, dimensions: DIM }),
  });
  if (!resp.ok) {
    const txt = await resp.text().catch(() => '');
    throw new Error(`HTTP ${resp.status}: ${txt.slice(0, 200)}`);
  }
  const data = await resp.json();
  return (data.data || []).map((d) => d.embedding);
}

async function main() {
  const sigPath = resolve(ROOT, 'public/knowledge/commandSignatures.json');
  const signatures = JSON.parse(readFileSync(sigPath, 'utf-8'));

  // 取所有 distinct commandBase
  const commands = [...new Set(signatures.map((s) => s.commandBase))];
  console.log(`[precompute] ${commands.length} 个命令, 模型 ${MODEL} (${DIM} 维), batch≤${BATCH}`);

  const vectors = {};
  let done = 0;
  for (let i = 0; i < commands.length; i += BATCH) {
    const batch = commands.slice(i, i + BATCH);
    process.stdout.write(`  [${done + 1}..${Math.min(done + BATCH, commands.length)}/${commands.length}] `);
    try {
      const vecs = await embed(batch);
      batch.forEach((cmd, idx) => { vectors[cmd] = vecs[idx]; });
      process.stdout.write('✓\n');
    } catch (e) {
      console.error(`✗ ${e.message}`);
      process.exit(1);
    }
    done += batch.length;
  }

  const outPath = resolve(ROOT, 'public/knowledge/commandEmbeddings.json');
  const out = { model: MODEL_KEY, vectors };
  writeFileSync(outPath, JSON.stringify(out));
  const mb = (Buffer.byteLength(JSON.stringify(out)) / 1024 / 1024).toFixed(2);
  console.log(`[precompute] 完成: ${Object.keys(vectors).length} 条, ${mb}MB → ${outPath}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
