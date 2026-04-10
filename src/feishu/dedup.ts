/**
 * 消息去重模块 — 防止飞书 WebSocket 重复投递同一事件
 *
 * 飞书 WebSocket 长连接在网络抖动或重连时可能重复投递同一条消息事件。
 * 本模块使用 TtlMap 记录已处理的 messageId，在 TTL 窗口内自动去重。
 * 默认窗口 10 分钟，可通过 initDedup() 自定义。
 */
import { TtlMap } from "../utils/ttl-map.js"

/**
 * 去重缓存实例
 * key: 飞书消息 messageId
 * value: true（仅作为存在标记，值无实际含义）
 * 默认 TTL: 10 分钟（600,000 毫秒）
 */
let dedup = new TtlMap<true>(10 * 60 * 1_000)

/**
 * 初始化（或重置）去重缓存的过期时间
 *
 * 在插件启动时调用，允许通过配置文件自定义去重窗口。
 * 调用后会创建全新的 TtlMap 实例，旧缓存被丢弃。
 *
 * @param ttl 去重窗口时长（毫秒）
 */
export function initDedup(ttl: number): void {
  dedup = new TtlMap<true>(ttl)
}

/**
 * 判断指定 messageId 是否为重复消息
 *
 * - 首次出现：记录到缓存并返回 false（非重复，应该处理）
 * - 再次出现（TTL 窗口内）：返回 true（重复，应该跳过）
 * - messageId 为空/undefined/null：返回 false（无法去重，放行处理）
 *
 * @param messageId 飞书消息的唯一标识
 * @returns true 表示重复消息（应跳过），false 表示首次出现（应处理）
 */
export function isDuplicate(messageId: string | undefined | null): boolean {
  // 空 messageId 无法去重，直接放行
  if (!messageId) return false
  // 缓存中已存在，说明是重复投递
  if (dedup.has(messageId)) return true
  // 首次出现，记录到缓存并放行
  dedup.set(messageId, true)
  return false
}
