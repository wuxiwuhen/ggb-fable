// Playwright 页面装配。所有对 app 的外部干预集中在此:
//   1) addInitScript 注入 BYOK localStorage(zustand persist key 'ggb-fable-config', 与 lib/config-store.ts 对齐)
//   2) 拦截 /api/config/prompt-text → 强制 prompt 版本(匿名 401 也不影响)
//   3) 拦截 /api/sessions → 隔离服务端 + 收集轨迹事件(action:'append' 的 body.events, 与 lib/logger.ts 对齐)
//   4) 喂题(textarea + button.send-btn), 等完成(button.send-btn.stop 消失)
import { setTimeout as sleep } from 'node:timers/promises';

// 注入的 localStorage 形状 = zustand persist({state, version}); mode='byok' 绕开 trial 配额与登录
export function buildByokPayload({ variant, temperature, maxToolRounds }) {
  return { state: {
    mode: 'byok',
    byokProfiles: [{
      name: 'eval', api_key: variant.llm.api_key, base_url: variant.llm.base_url,
      model_name: variant.llm.model_name, temperature,
      thinking_mode: variant.thinking_mode || 'auto',
    }],
    activeProfileName: 'eval',
    vision: { api_key: variant.vision.api_key, base_url: variant.vision.base_url, model_name: variant.vision.model_name },
    embedding: { api_key: variant.embedding.api_key, base_url: variant.embedding.base_url, model_name: variant.embedding.model_name, dimensions: 1024 },
    maxToolRounds,
  }, version: 0 };
}

export async function openPage(browser, { baseUrl, promptVersion, promptText, variant, temperature, maxToolRounds }) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const events = [];

  await page.route('**/api/config/prompt-text', (route) => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ version: promptVersion, text: promptText, source: 'preview' }),
  }));

  await page.route('**/api/sessions', async (route) => {
    const req = route.request();
    try {
      if (req.method() === 'POST') {
        const body = JSON.parse(req.postData() || '{}');
        if (Array.isArray(body.events)) events.push(...body.events);   // logger.flush 的轨迹(含 tool_call/ggb_exec/turn_end/error)
      }
    } catch {}
    const body = req.method() === 'GET' && !req.url().includes('?id=')
      ? JSON.stringify({ sessions: [] })       // 会话列表(侧栏): 空列表, loadState ready
      : '{}';
    await route.fulfill({ status: 200, contentType: 'application/json', body });
  });

  await page.addInitScript(
    (payload) => { try { localStorage.setItem('ggb-fable-config', JSON.stringify(payload)); } catch {} },
    buildByokPayload({ variant, temperature, maxToolRounds }),
  );

  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#ggb-container', { timeout: 60000 });
  await page.waitForFunction(() => !!(window.ggbApplet && window.ggbApplet.getXML), null, { timeout: 60000 });
  return { page, events };
}

export async function feedAndWait(page, prompt, { timeoutMs = 180000 } = {}) {
  await page.fill('textarea', prompt);
  await page.click('button.send-btn:not(.stop)');
  // 先等回合真正开始(停止键挂载)再轮询结束——首条消息的 setSending(true) 在 await newSession() 之后,
  // 不等的话 t≈0 首轮轮询会把"未开始"误判为"已结束"而瞬间返回 done(空轨迹)。
  // 静默早退的 send 等不到停止键: catch 后落回原失败模式(空事件), 不掩盖问题。
  await page.waitForSelector('button.send-btn.stop', { timeout: 15000 }).catch(() => {});
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const done = await page.evaluate(() => !document.querySelector('button.send-btn.stop'));
    if (done) return 'done';   // stop 消失=send() 收尾; turn_end 排水职责在 drainEvents
    await sleep(500);
  }
  return 'timeout';
}

export async function drainEvents(page, events, { waitMs = 5000 } = {}) {
  // 等 events 里出现 turn_end(或超时)——消化 flush 与 DOM 完成信号之间的竞态
  const start = Date.now();
  while (Date.now() - start < waitMs) {
    if (events.some((e) => e.type === 'turn_end')) return;
    await sleep(300);
  }
}

export async function captureCanvas(page) {
  return page.evaluate(() => window.ggbApplet.getXML());
}

// 临时对象求值: ggbTmpEval = (expr) → 读值 → 删。布尔返回 value 'true'/'false'; 数值返回 numeric。
export function makeAppletEval(page) {
  return async (expr) => page.evaluate(async (e) => {
    const a = window.ggbApplet;
    const tmp = 'ggbTmpEval';
    try { if (a.exists(tmp)) a.deleteObject(tmp); } catch {}
    let labels = '';
    try {
      labels = typeof a.evalCommandGetLabels === 'function'
        ? a.evalCommandGetLabels(`${tmp} = (${e})`)
        : await a.asyncEvalCommandGetLabels(`${tmp} = (${e})`);
    } catch {}
    if (!labels || !String(labels).trim()) return { ok: false, value: '?' };
    const value = a.getValueString(tmp);
    const numeric = a.getValue(tmp);
    try { a.deleteObject(tmp); } catch {}
    if (!value || value === '?' || value === 'NaN' || value === 'undefined') return { ok: false, value: value || '?' };
    return { ok: true, value, numeric };
  }, expr);
}
