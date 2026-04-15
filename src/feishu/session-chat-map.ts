/**
 * sessionId → chatInfo 映射模块
 *
 * 在 OpenCode 中，tool execute 回调只能拿到 sessionID，
 * 但发送飞书消息需要知道 chatId 和 chatType。
 * 本模块维护 sessionId → { chatId, chatType } 的映射关系，
 * 供 feishu_send_card tool 和最小运行时 prompt 注入判定使用。
 *
 * 使用 TtlMap 自动清理过期条目，避免长时间运行后内存增长。
 * 条目数量受限于唯一聊天数（通常很少），TTL 仅作为额外安全保障。
 */
import { TtlMap } from "../utils/ttl-map.js"

/** 聊天信息结构：包含飞书 chatId 和聊天类型 */
export interface ChatInfo {
  /** 飞书会话 ID */
  chatId: string
  /** 聊天类型：p2p（单聊）或 group（群聊） */
  chatType: "p2p" | "group"
}

/**
 * sessionId → ChatInfo 的映射存储
 * TTL 24 小时 — 条目在每次 registerSessionChat 调用时刷新
 */
const sessionToChat = new TtlMap<ChatInfo>(24 * 60 * 60 * 1_000)

/**
 * 注册 sessionId 与飞书聊天的映射关系
 *
 * 在 handleChat() 创建或恢复 OpenCode 会话时调用，
 * 使后续的 tool execute 能通过 sessionID 找到对应的飞书聊天。
 * 重复注册同一 sessionId 会刷新 TTL。
 *
 * @param sessionId OpenCode 会话 ID
 * @param chatId 飞书会话 ID
 * @param chatType 聊天类型（p2p 单聊 / group 群聊）
 */
export function registerSessionChat(sessionId: string, chatId: string, chatType: "p2p" | "group"): void {
  sessionToChat.set(sessionId, { chatId, chatType })
}

/**
 * 通过 sessionId 查询对应的飞书 chatId
 *
 * @param sessionId OpenCode 会话 ID
 * @returns 飞书 chatId，未找到返回 undefined
 */
export function getChatIdBySession(sessionId: string): string | undefined {
  return sessionToChat.get(sessionId)?.chatId
}

/**
 * 通过 sessionId 查询完整的聊天信息（chatId + chatType）
 *
 * 相比 getChatIdBySession，额外返回 chatType，
 * 供 buildCardFromDSL 等需要区分聊天类型的场景使用。
 *
 * @param sessionId OpenCode 会话 ID
 * @returns ChatInfo 对象，未找到返回 undefined
 */
export function getChatInfoBySession(sessionId: string): ChatInfo | undefined {
  return sessionToChat.get(sessionId)
}
