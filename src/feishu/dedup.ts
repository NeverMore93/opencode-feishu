/**
 * 消息去重 — 飞书 WebSocket 可能重复投递同一事件
 */
import { TtlMap } from "../utils/ttl-map.js"

let dedup = new TtlMap<true>(10 * 60 * 1_000)

/** 初始化去重缓存的过期时间 */
export function initDedup(ttl: number): void {
  dedup = new TtlMap<true>(ttl)
}

/** 判断是否重复（首次出现返回 false，后续返回 true） */
export function isDuplicate(messageId: string | undefined | null): boolean {
  if (!messageId) return false
  if (dedup.has(messageId)) return true
  dedup.set(messageId, true)
  return false
}
