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
 * 标记 initDedup 是否已被调用过。
 *
 * OpenCode server-proxy multi-instance bootstrapping 下，FeishuPlugin 工厂可能
 * 在同一进程内被多次调用（不同 directory 各触发一次 init）。如果每次都重建
 * dedup map，已记录的 messageId 会被丢失，飞书 ack 重投机制下同消息会被处理两次。
 *
 * @see specs/028-lifecycle-invariants/spec.md FR-002
 */
let dedupInitialized = false

/**
 * 初始化去重缓存的过期时间。
 *
 * **幂等**：仅第一次调用生效，后续调用直接返回。
 * 配置变更（dedupTtl）需重启 process 生效（daemon 标准行为）。
 *
 * @param ttl 去重窗口时长（毫秒）
 */
export function initDedup(ttl: number): void {
  if (dedupInitialized) return
  dedup = new TtlMap<true>(ttl)
  dedupInitialized = true
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
