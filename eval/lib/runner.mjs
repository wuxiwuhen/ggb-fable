// 单 case 编排: 每采样一页(干净会话/画布), 跑完抓画布 + 断言评分, 组装 SampleResult。
import { setTimeout as sleep } from 'node:timers/promises';
import { openPage, feedAndWait, drainEvents, captureCanvas, makeAppletEval } from './browser.mjs';
import { parseCanvasXml } from './parse-canvas.mjs';
import { evaluateAll } from './templates.mjs';
import { buildCaseResult } from './aggregate.mjs';

// 就绪门(冒烟首跑实证两处阻断, 均属页面编排层, 非登录门):
//  1) 新手引导遮罩(.tour-mask-full)在 app 挂载数秒后拦截 send 点击 → 等引导挂载后 ESC 跳过 + 写 seen 标记;
//  2) send 点击早于 AgentEngine 建成时 send() 静默落"画布未就绪"(空轨迹, feedAndWait 的已知失败签名)——
//     引导由 ChatApp 在 ggbReady 时自动启动, 其挂载即证 ggbReady 已触发, 再留 1.5s 给引擎建成(prompt 请求已被路由即时满足)。
async function settleReady(page) {
  // 已看过引导(键名/形状与 hooks/useOnboarding.ts 一致)则引导不挂载——直接跳过等待,
  // 否则共享 context 的第 2..N 个采样每个都会白等满 20s 超时。
  const seen = await page.evaluate(() => {
    try { return !!JSON.parse(localStorage.getItem('ggb-fable-onboarding-v3') || 'null')?.seen; } catch { return false; }
  });
  if (!seen) {
    const tour = await page.waitForSelector('.tour-root', { timeout: 20000 }).catch(() => null);
    if (tour) {
      // 先点跳过(限时 2s); 点不到再 ESC(window keydown → onFinish(false) 卸载引导)。
      // 顺序不能反: ESC 成功后 .tour-skip 已卸载, click 默认 30s actionability 等待纯白等。
      await page.click('.tour-skip', { timeout: 2000 }).catch(async () => {
        await page.keyboard.press('Escape').catch(() => {});
      });
      await page.evaluate(() => { try { localStorage.setItem('ggb-fable-onboarding-v3', JSON.stringify({ v: 3, seen: true })); } catch {} });
      await page.waitForSelector('.tour-root', { state: 'detached', timeout: 5000 }).catch(() => {});
    }
  }
  await sleep(1500);
}

function statsFromEvents(events) {
  const calls = events.filter((e) => e.type === 'tool_call' && e.name);
  const turnEnd = events.filter((e) => e.type === 'turn_end').pop();
  const insp = calls.filter((e) => e.name === 'inspect_render' && e.result?.ok).pop();
  return {
    rounds: new Set(calls.map((e) => e.round)).size,
    verifyCount: calls.filter((e) => e.name === 'verify_geometry').length,
    renderCount: calls.filter((e) => e.name === 'inspect_render').length,
    failCmds: events.filter((e) => e.type === 'ggb_exec' && e.ok === false).length,
    stopped: !!turnEnd?.stopped,
    errorCount: events.filter((e) => e.type === 'error').length,
    inspectPassed: insp ? insp.result.passed === true : null,
    finalText: String(turnEnd?.finalText || '').slice(0, 200),
  };
}

async function runSample(browser, case_, opts) {
  const { page, events } = await openPage(browser, opts);
  try {
    await settleReady(page);
    const t0 = Date.now();   // 端到端延迟: 发送 → 回合收尾(含 drain), spec §3.4 durationMs
    const feed = await feedAndWait(page, case_.prompt, { timeoutMs: opts.timeoutMs });
    if (feed === 'timeout') {
      await page.click('button.send-btn.stop').catch(() => {});
      await drainEvents(page, events, { waitMs: 2000 });
    } else {
      await drainEvents(page, events);
    }
    const durationMs = Date.now() - t0;
    const stats = statsFromEvents(events);
    // feedAndWait 瞬回 done 或超时卡死且 0 轮无 finalText = 引擎未就绪(send 静默早退的已知签名)——
    // 编排层故障归 run_error, 不进断言评分(否则记成模型失败, 污染失败归因分布)。
    if (stats.rounds === 0 && !stats.finalText) {
      return { ok: false, error: 'engine_not_ready: 0 tool rounds and no finalText', assertions: [], stats };
    }
    const xml = await captureCanvas(page);
    const canvas = parseCanvasXml(xml);
    // timedOut 入上下文: 超时采样的过程断言改记 timeout_incomplete, 不再误判 process_error
    const assertions = await evaluateAll(case_.assertions, { canvas, events, appletEval: makeAppletEval(page), timedOut: feed === 'timeout' });
    return { ok: true, timedOut: feed === 'timeout', durationMs, assertions, stats };
  } finally {
    await page.close();
  }
}

export async function runOneCase(browser, case_, opts) {
  // 采样并行(各开独立 page/context, Playwright newPage 每页独立 context)——campaign 墙钟约 ÷runs。
  // opts.serial=true 退回串行(spec §6: 上游 429 限流时的降级开关, CLI --serial 传入)。
  // 逐采样兜底为 run_error, 单采样崩溃不拖垮整条用例(与原串行语义一致)。
  const one = async () => {
    try {
      return await runSample(browser, case_, opts);
    } catch (e) {
      return { ok: false, error: String(e?.message || e), assertions: [], stats: null };
    }
  };
  const samples = [];
  if (opts.serial) {
    for (let i = 0; i < opts.runs; i++) samples.push(await one());
  } else {
    samples.push(...await Promise.all(Array.from({ length: opts.runs }, one)));
  }
  return buildCaseResult(case_, samples);
}
