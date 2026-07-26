// Playwright 编排: force prompt 版本(拦截 /api/config/prompt-text) + BYOK(注入 localStorage) +
// 抓 trajectory(拦截 /api/sessions) + 喂题(DOM) + 等 turn_end + capture + score。
//
// 端到端核心: 起 chromium → 拦截 prompt-text/`/api/sessions` → 注入 BYOK → 喂题 → 等 turn_end → capture → score。
// 集成 parse-ggb/deterministic/vision-judge/capture 四个模块。
//
// 注意: 本模块无法单测(依赖真实 app + GeoGebra applet + 浏览器), 仅做"模块可加载"验证,
// 端到端冒烟交给 Task 11(run.mjs 起 pnpm dev + 真实 case)。
import { readFileSync } from 'node:fs';
import { parseGeogebraXml } from './parse-ggb.mjs';
import { runAssertions } from './deterministic.mjs';
import { judgeSingle, judgePaired, DEFAULT_RUBRIC } from './vision-judge.mjs';
import { captureArtifacts, makeAppletEval } from './capture.mjs';

const PROMPTS_DIR = new URL('../../prompts/', import.meta.url).pathname;

function readPromptText(version) {
  try { return readFileSync(`${PROMPTS_DIR}${version}.md`, 'utf8'); }
  catch { throw new Error(`提示词版本 ${version} 不存在(prompts/${version}.md)`); }
}

// 注入 BYOK localStorage, 让 app 走 BYOK 直连 GLM(绕过 trial quota/auth)。
//
// 注: 原 brief 返回一个 *字符串* 箭头函数, 而 page.addInitScript(script, arg) 在 Playwright 1.55 里
// 若 script 是字符串则 arg 必须为 undefined, 否则抛 "Cannot evaluate a string with arguments"
// (见 playwright-core/lib/client/clientHelper.js evaluationScript)。因此这里改为返回真实函数,
// 让 addInitScript 把第二参(cfg)正确序列化后注入。其余 BYOK 字段与 brief 一致(zustand persist 形状)。
function byokInitScript(_glm) {
  return (c) => {
    try {
      localStorage.setItem('ggb-fable-config', JSON.stringify(c));
      // 跳过新手引导: eval 模式无 user 触发 tour, tour-mask 会遮挡发送按钮导致 click 超时
      localStorage.setItem('ggb-fable-onboarding-v2', JSON.stringify({ seen: true }));
    } catch (e) {}
  };
}

async function setupPage(page, promptVersion, glm) {
  const text = readPromptText(promptVersion);
  // force prompt 版本: 拦截 /api/config/prompt-text(绕过登录 + 服务端解析)
  await page.route('**/api/config/prompt-text', (route) => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ version: promptVersion, text, source: 'eval' }),
  }));
  // 抓 trajectory + finalText: 旁路 /api/sessions flush
  const events = [];
  page.__evalEvents = events;
  await page.route('**/api/sessions', async (route) => {
    try {
      const req = route.request();
      if (req.method() === 'POST') {
        const body = JSON.parse(req.postData() || '{}');
        if (body.events) events.push(...body.events);
      }
    } catch {}
    await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });
  // 监听 CommandSearch 就绪(发 send 前等 agent 初始化完成, 见 runSample)
  page.__csReady = false;
  page.on('console', (m) => { if (/向量全部缓存|跳过预热/.test(m.text())) page.__csReady = true; });
  await page.addInitScript(byokInitScript(glm), {
    state: { mode: 'byok', byokProfiles: [{ name: 'eval', api_key: glm.api_key, base_url: glm.base_url, model_name: process.env.GLM_MODEL || 'glm-4.6' }], activeProfileName: 'eval', vision: { api_key: glm.api_key, base_url: glm.base_url, model_name: glm.model }, embedding: {}, maxToolRounds: 30 }, version: 0,
  });
}

// 等 agent turn_end 事件(由 /api/sessions 拦截器写入 page.__evalEvents)。
//
// 注: 原 brief 在此轮询 document.querySelector('button.send-btn:not(.stop)'), 但点击 send 后
// React 还没把 send-btn 换成 stop, 第一次 poll 立即返回 true → 提前退出, agent 根本没开始。
// 改用语义化的 turn_end 事件: 它由 logger ~400ms flush + 拦截器写入, 在 500ms poll 周期内可见。
// eventsBefore 是"点击 send 前"已累积的事件数, 只看之后新增的 turn_end, 防止复用 page 时旧事件误命中。
async function waitForTurnEnd(page, eventsBefore, timeoutMs = 120000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const evs = page.__evalEvents || [];
    if (evs.slice(eventsBefore).some((e) => e.type === 'turn_end')) return true;
    await page.waitForTimeout(500);
  }
  return false;   // 超时
}

async function runSample(browser, case_, promptVersion, glm, comparePng) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  try {
    await setupPage(page, promptVersion, glm);
    // Fix A: 工作台在 /app(非 /), 且 /app 有 auth 门控(app/app/page.tsx 的 useAuth 跳 /login)。
    // ?eval=1 触发 Fix B 的 eval 旁路, 跳过登录重定向, 让匿名 BYOK 也能进 ChatApp。
    await page.goto('http://localhost:3000/app?eval=1', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#ggb-container', { timeout: 60000 });
    await page.waitForFunction(() => !!window.ggbApplet?.getXML, { timeout: 60000 });

    // 等 agent 就绪: CommandSearch 是 search_command 依赖, 其初始化(useEffect 在 ggbReady 后异步跑)
    // 完成意味着 agent 引擎也已构造(getEffectivePrompt.then); 再 grace 确保 agentRef 设值,
    // 否则 ChatApp send 会因 agentRef null 在 "画布未就绪" 处提前 return, agent 根本不跑。
    const csStart = Date.now();
    while (!page.__csReady && Date.now() - csStart < 20000) await page.waitForTimeout(300);
    await page.waitForTimeout(1500);

    await page.fill('textarea:not(.feedback-textarea)', case_.meta.problem);
    // 在点击 send 之前快照事件数, waitForTurnEnd 只看此后新增的事件。
    const eventsBefore = (page.__evalEvents || []).length;
    await page.click('button.send-btn:not(.stop)');
    const ok = await waitForTurnEnd(page, eventsBefore);
    if (!ok) await page.click('button.send-btn.stop').catch(() => {});

    const { xml, png } = await captureArtifacts(page, case_.meta);
    const parsed = parseGeogebraXml(xml);
    const appletEval = makeAppletEval(page);
    // appletEval 抛出的异常会向上传播到 runOneCase 的 try/catch(T7 risk #4 backstop),
    // 失败被记为 {error} 并重试 1 次, 不会让整个 case 崩掉。
    const assertions = await runAssertions({ elements: parsed.elements, freeVars: parsed.freeVars }, case_.assertions, appletEval);

    const rubric = case_.visual_rubric && case_.visual_rubric !== 'inherit' ? case_.visual_rubric : DEFAULT_RUBRIC;
    let visual;
    if (comparePng) {
      visual = await judgePaired({ pngA: comparePng, pngB: png, rubric, ctx: { problem: case_.meta.problem, key_insight: case_.meta.key_insight }, glm });
    } else {
      visual = await judgeSingle({ png, rubric, ctx: { problem: case_.meta.problem, key_insight: case_.meta.key_insight }, glm });
    }

    const evs = page.__evalEvents || [];
    const toolCalls = evs.filter((e) => e.type === 'tool_call');
    const ggbExecs = evs.filter((e) => e.type === 'ggb_exec');
    const turnEnd = evs.filter((e) => e.type === 'turn_end').pop();
    const process = {
      toolRounds: new Set(toolCalls.map((t) => t.round)).size,
      hitCap: !!turnEnd?.stopped,
      failCmds: ggbExecs.filter((g) => !g.ok).length,
      stopped: !!turnEnd?.stopped,
    };
    return { assertions, visual, process, _png: png, _xml: xml };
  } finally {
    await page.close();
  }
}

export async function runOneCase(browser, case_, opts) {
  const { promptVersion, glm, rigorous = 1, comparePng } = opts;
  const samples = [];
  for (let i = 0; i < rigorous; i++) {
    let lastErr;
    for (let attempt = 0; attempt < 2; attempt++) {   // 失败重试 1 次(软件 WebGL 偶崩)
      try { samples.push(await runSample(browser, case_, promptVersion, glm, comparePng)); lastErr = null; break; }
      catch (e) { lastErr = e; }
    }
    if (lastErr) samples.push({ error: String(lastErr.message || lastErr), assertions: [], visual: { items: [], issues: ['RUN_ERROR'] }, process: {} });
  }
  const passRate = samples.filter((s) => !s.error && s.assertions?.length && s.assertions.every((a) => a.passed)).length / samples.length;
  return { id: case_.id, split: case_.split, samples, passRate };
}
