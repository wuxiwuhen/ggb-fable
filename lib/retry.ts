// fetch 超时 + 递增超时重试 + 退避 + 外部取消。
// 纯逻辑,无 React 依赖;fetch 可注入,便于测试。

export const DEFAULT_TIMEOUTS = [8000, 16000, 30000] as const;
export const DEFAULT_BACKOFF_MS = [1500, 3000] as const;

export interface RetryOptions {
  /** 每次尝试的超时曲线(末项为最后一次)。默认 [8000,16000,30000] */
  timeouts?: readonly number[];
  /** 相邻两次尝试间的退避(第 i 项 = 第 i→i+1 次间隔)。默认 [1500,3000] */
  backoffMs?: readonly number[];
  /** 外部取消信号(unmount / 重试覆盖)。abort 时立刻中断「正在 fetch」和「正在 sleep」 */
  signal?: AbortSignal;
  /** 注入 fetch(测试用),默认全局 fetch */
  fetchImpl?: typeof fetch;
}

/** 所有尝试用尽(自然失败,非外部取消)时抛出 */
export class RetryError extends Error {
  constructor(
    message: string,
    public readonly attempts: number,
    public readonly lastError: unknown,
  ) {
    super(message);
    this.name = 'RetryError';
  }
}

/**
 * 单次 fetch + 超时 + 外部 signal 联动。
 * - 外部已 aborted → 直接抛 AbortError,不进 fetch。
 * - 超时 OR 外部 abort → abort 内部 controller → fetch reject AbortError。
 *
 * 用手动 setTimeout + addEventListener(而非 AbortSignal.timeout/.any):
 *   ① 兼容性好;② 与 vitest useFakeTimers 完美配合(AbortSignal.timeout 用内部真实定时器,假时钟拦不住)。
 */
export async function fetchWithTimeout(
  url: string,
  ms: number,
  externalSignal?: AbortSignal,
  fetchImpl: typeof fetch = fetch,
): Promise<Response> {
  if (externalSignal?.aborted) {
    throw new DOMException('Aborted', 'AbortError');
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  const onExternalAbort = () => controller.abort();
  externalSignal?.addEventListener('abort', onExternalAbort, { once: true });
  try {
    return await fetchImpl(url, { cache: 'no-store', signal: controller.signal });
  } finally {
    clearTimeout(timer);
    externalSignal?.removeEventListener('abort', onExternalAbort);
  }
}

/** 可被外部 signal 中断的 sleep。无 signal 时退化为普通 setTimeout。 */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new DOMException('Aborted', 'AbortError'));
    const onAbort = () => {
      clearTimeout(t);
      reject(new DOMException('Aborted', 'AbortError'));
    };
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort); // 正常 resolve → 清监听,防泄漏
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * 递增超时 + 退避重试。
 * 重试条件:网络错误(TypeError)/ 超时(AbortError)/ HTTP 5xx。
 * 不重试:4xx(含 401/404 —— 重试只会徒增退避延迟)。
 *
 * 取消语义:外部 signal 与内部超时用不同 controller ——
 *   内部超时只 abort fetchWithTimeout 内部 controller(不碰 ext)→ 进退避;
 *   外部 abort(ext.aborted)→ 立刻终止整条链,抛原始 AbortError。
 *
 * @returns 成功的 Response(2xx 或 4xx,由调用方判断)
 * @throws RetryError 全部尝试用尽;DOMException(AbortError) 外部取消
 */
export async function fetchWithRetry(url: string, opts: RetryOptions = {}): Promise<Response> {
  const timeouts = opts.timeouts ?? DEFAULT_TIMEOUTS;
  const backoffMs = opts.backoffMs ?? DEFAULT_BACKOFF_MS;
  const ext = opts.signal;
  const fetchImpl = opts.fetchImpl ?? fetch;

  let lastError: unknown;
  for (let attempt = 0; attempt < timeouts.length; attempt++) {
    if (ext?.aborted) throw new DOMException('Aborted', 'AbortError'); // 进循环前再核一次

    try {
      const res = await fetchWithTimeout(url, timeouts[attempt], ext, fetchImpl);
      // 5xx 且非末次 → 消费 body 防连接泄漏,记错误,进退避重试
      if (res.status >= 500 && res.status < 600 && attempt < timeouts.length - 1) {
        try { await res.text(); } catch { /* ignore */ }
        lastError = new Error(`HTTP ${res.status}`);
      } else {
        return res; // 2xx / 4xx / 末次 5xx → 交给调用方
      }
    } catch (e) {
      lastError = e;
      if (ext?.aborted) throw e; // 外部取消 → 立刻抛原始 AbortError,不包 RetryError
      // 否则(超时/网络错误)→ 进退避
    }

    // 退避(末次不 sleep)。ext abort 时 sleep 立刻 reject → 抛出,不会落到下一轮
    if (attempt < timeouts.length - 1) {
      const gap = backoffMs[attempt] ?? backoffMs[backoffMs.length - 1];
      await sleep(gap, ext);
    }
  }
  throw new RetryError(`All ${timeouts.length} attempts failed`, timeouts.length, lastError);
}
