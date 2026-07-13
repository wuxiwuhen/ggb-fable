// IndexedDB 持久化命令 embedding 向量缓存
// 避免 BYOK 用户每次会话都用自己的 key 重算 505 条命令向量。
// 模型切换时自动重算; 同一 provider+model+dim 只算一次, 后续会话直接读 IndexedDB。

const DB_NAME = 'ggb-embedding-cache';
const DB_VERSION = 1;
const STORE_NAME = 'embeddings';

function openDB(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(STORE_NAME)) {
          req.result.createObjectStore(STORE_NAME);
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);  // 隐私模式 IndexedDB 不可用
    }
  });
}

// 读缓存: modelKey 匹配 → 返回全量向量, 否则 null
export async function loadEmbeddingsFromIDB(modelKey: string): Promise<Record<string, number[]> | null> {
  const db = await openDB();
  if (!db) return null;
  try {
    return new Promise((resolve) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const req = tx.objectStore(STORE_NAME).get(modelKey);
      req.onsuccess = () => resolve(req.result?.vectors ?? null);
      req.onerror = () => resolve(null);
    });
  } catch {
    return null;
  } finally {
    try { db.close(); } catch { /* noop */ }
  }
}

// 写缓存: 存全量向量(覆盖同 modelKey 旧数据)
export async function saveEmbeddingsToIDB(modelKey: string, vectors: Record<string, number[]>): Promise<void> {
  const db = await openDB();
  if (!db) return;
  try {
    return new Promise((resolve) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const req = tx.objectStore(STORE_NAME).put({ vectors }, modelKey);
      req.onsuccess = () => resolve();
      req.onerror = () => resolve();
    });
  } catch {
    // 静默
  } finally {
    try { db.close(); } catch { /* noop */ }
  }
}
