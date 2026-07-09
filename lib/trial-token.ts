// trial_token: 无状态签名令牌(类 JWT, Web Crypto HMAC-SHA256)
// 用途: 一次用户发送(Agent 多轮工具循环)内, 首次扣 1 次额度并签发 token,
//       后续多轮带 token 验签免扣, 直到 exp 超时(默认 15min)该意图结束。
//
// 载荷: { uid, iid, exp, r(已消费轮数) }
// 签名密钥: TRIAL_TOKEN_SECRET(未配则用 SUPABASE_SERVICE_ROLE_KEY 兜底)
// 无状态: 不依赖 DB, 验签即可信; 客户端篡改 → 签名失效。

const enc = new TextEncoder();
const dec = new TextDecoder();

function b64url(input: string | Uint8Array): string {
  const bytes = typeof input === 'string' ? enc.encode(input) : input;
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(s: string): string {
  const pad = '='.repeat((4 - (s.length % 4)) % 4);
  const b64 = (s + pad).replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64);
  return dec.decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

async function getKey(): Promise<CryptoKey> {
  const secret = process.env.TRIAL_TOKEN_SECRET || process.env.SUPABASE_SERVICE_ROLE_KEY || 'fallback-dev-secret';
  return crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

export interface TrialPayload {
  uid: string;      // 用户 id(防跨用户复用)
  iid: string;      // 意图 id(同一发送内一致)
  exp: number;      // 过期时间戳(ms)
  r: number;        // 已消费轮数(累计)
  t: number;        // 已消费输入 token(累计, 粗估)
}

export async function signToken(payload: TrialPayload): Promise<string> {
  const body = b64url(JSON.stringify(payload));
  const key = await getKey();
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(body)));
  return body + '.' + b64url(sig);
}

export async function verifyToken(token: string, expectedUid: string): Promise<TrialPayload | null> {
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [body, sigB64] = parts;
  try {
    const key = await getKey();
    const sigBytes = Uint8Array.from(b64urlDecode(sigB64), (c) => c.charCodeAt(0));
    const ok = await crypto.subtle.verify('HMAC', key, sigBytes, enc.encode(body));
    if (!ok) return null;
    const payload = JSON.parse(b64urlDecode(body)) as TrialPayload;
    if (payload.uid !== expectedUid) return null;   // 跨用户复用 → 拒
    if (Date.now() > payload.exp) return null;       // 超时 → 拒(当作新意图)
    return payload;
  } catch {
    return null;
  }
}

// 生成意图 id(随机, 同一发送内固定)
export function newIntentId(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return b64url(bytes);
}
