/**
 * 消息去重 — 飞书 WebSocket 可能重复投递同一事件
 */
let seenTtlMs = 10 * 60 * 1000; // 默认 10 分钟

const seen = new Map<string, number>();

/** 初始化去重缓存的过期时间 */
export function initDedup(ttl: number): void {
  seenTtlMs = ttl;
}

/** 清理过期条目并判断是否重复 */
export function isDuplicate(messageId: string | undefined | null): boolean {
  const now = Date.now();

  for (const [k, ts] of seen) {
    if (now - ts > seenTtlMs) seen.delete(k);
  }

  if (!messageId) return false;
  if (seen.has(messageId)) return true;
  seen.set(messageId, now);
  return false;
}

