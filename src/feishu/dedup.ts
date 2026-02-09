/**
 * 消息去重 — 飞书 WebSocket 可能重复投递同一事件
 */
const SEEN_TTL_MS = 10 * 60 * 1000; // 10 分钟

const seen = new Map<string, number>();

/** 清理过期条目并判断是否重复 */
export function isDuplicate(messageId: string | undefined | null): boolean {
  const now = Date.now();

  for (const [k, ts] of seen) {
    if (now - ts > SEEN_TTL_MS) seen.delete(k);
  }

  if (!messageId) return false;
  if (seen.has(messageId)) return true;
  seen.set(messageId, now);
  return false;
}

/** 清空去重状态（测试用） */
export function clearDedup(): void {
  seen.clear();
}
