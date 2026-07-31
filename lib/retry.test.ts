import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fetchWithRetry, fetchWithTimeout, RetryError } from './retry';

function makeRes(status = 200, body: any = { sessions: [] }) {
  return new Response(JSON.stringify(body), {
    status, headers: { 'Content-Type': 'application/json' },
  });
}

// 模拟"卡住直到 signal 被 abort 才 reject"的 fetch(真实 fetch 在 signal abort 时即 reject AbortError)。
// 底层 promise 由 fetchWithTimeout 的 await 接住;外层返回 promise 的 reject 由测试侧「先挂 assertion handler
// 再触发 abort」保护,避免 vitest fake-timer 微任务边界把 reject 误判为 unhandled。
function hang(signal: AbortSignal): Promise<Response> {
  return new Promise<Response>((_, reject) => {
    const onAbort = () => reject(new DOMException('Aborted', 'AbortError'));
    if (signal.aborted) return onAbort();
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

describe('fetchWithRetry', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('首次成功 → 仅 1 次 fetch,不退避', async () => {
    const f = vi.fn().mockResolvedValue(makeRes(200));
    const p = fetchWithRetry('/api/sessions', { fetchImpl: f, timeouts: [1000], backoffMs: [500] });
    await vi.advanceTimersByTimeAsync(0);
    const res = await p;
    expect(f).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(200);
  });

  it('超时 1 次后第 2 次成功 → 2 次 fetch,中间退避', async () => {
    const f = vi.fn()
      .mockImplementationOnce((_url: RequestInfo | URL, init: any) => hang(init.signal))  // 第 1 次:卡住→超时 abort
      .mockResolvedValueOnce(makeRes(200));                                   // 第 2 次:成功
    const p = fetchWithRetry('/api/sessions', { fetchImpl: f, timeouts: [1000, 2000], backoffMs: [500] });
    await vi.advanceTimersByTimeAsync(1000);   // 触发首次超时 abort
    await vi.advanceTimersByTimeAsync(500);    // 越过退避
    const res = await p;
    expect(f).toHaveBeenCalledTimes(2);
    expect(res.status).toBe(200);
  });

  it('全部用尽 → 抛 RetryError,3 次 fetch', async () => {
    const f = vi.fn((_url: RequestInfo | URL, init: any) => hang(init.signal));
    const p = fetchWithRetry('/api/sessions', { fetchImpl: f, timeouts: [1000, 2000, 3000], backoffMs: [500, 1000] });
    const assertion = expect(p).rejects.toBeInstanceOf(RetryError);   // 先挂 handler
    await vi.advanceTimersByTimeAsync(1000 + 500 + 2000 + 1000 + 3000);
    await assertion;
    expect(f).toHaveBeenCalledTimes(3);
  });

  it('外部 signal abort 中断 fetch → 抛 AbortError,不重试', async () => {
    const ext = new AbortController();
    const f = vi.fn((_url: RequestInfo | URL, init: any) => hang(init.signal));
    const p = fetchWithRetry('/api/sessions', { fetchImpl: f, signal: ext.signal, timeouts: [10000], backoffMs: [500] });
    const assertion = expect(p).rejects.toThrow(/Aborted/);   // 先挂 handler
    ext.abort();
    await vi.advanceTimersByTimeAsync(0);
    await assertion;
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('外部 signal abort 中断退避 sleep → 抛 AbortError,不再 fetch', async () => {
    const ext = new AbortController();
    const f = vi.fn((_url: RequestInfo | URL, init: any) => hang(init.signal));
    const p = fetchWithRetry('/api/sessions', { fetchImpl: f, signal: ext.signal, timeouts: [1000, 2000], backoffMs: [500] });
    await vi.advanceTimersByTimeAsync(1000);     // 首次超时
    const assertion = expect(p).rejects.toThrow(/Aborted/);   // 先挂 handler
    ext.abort();                                 // 退避期间取消
    await vi.advanceTimersByTimeAsync(0);
    await assertion;
    expect(f).toHaveBeenCalledTimes(1);          // 关键:第 2 次没发
  });

  it('5xx → 重试到末次原样返回;401 → 不重试直接返回', async () => {
    const f5 = vi.fn().mockResolvedValue(makeRes(503));
    const p5 = fetchWithRetry('/u', { fetchImpl: f5, timeouts: [1000, 1000], backoffMs: [500] });
    await vi.advanceTimersByTimeAsync(1500);
    const res5 = await p5;
    expect(f5).toHaveBeenCalledTimes(2);          // 5xx 触发了重试
    expect(res5.status).toBe(503);                // 末次 5xx 原样返回(交调用方处理)

    const f4 = vi.fn().mockResolvedValue(makeRes(401, { error: '未登录' }));
    const p4 = fetchWithRetry('/u', { fetchImpl: f4, timeouts: [1000, 1000], backoffMs: [500] });
    await vi.advanceTimersByTimeAsync(0);
    const res = await p4;
    expect(f4).toHaveBeenCalledTimes(1);          // 401 不重试
    expect(res.status).toBe(401);
  });
});

describe('fetchWithTimeout', () => {
  it('超时 → abort fetch → AbortError', async () => {
    const f = vi.fn((_url: RequestInfo | URL, init: any) => hang(init.signal));
    vi.useFakeTimers();
    const p = fetchWithTimeout('/u', 1000, undefined, f);
    const assertion = expect(p).rejects.toThrow(/Aborted/);   // 先挂 handler
    await vi.advanceTimersByTimeAsync(1000);
    await assertion;
    vi.useRealTimers();
  });
});
