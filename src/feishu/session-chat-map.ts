/**
 * sessionId → chatInfo 映射：tool execute 时通过 sessionID 查找飞书 chatId 和 chatType
 *
 * 使用 TtlMap 自动清理过期条目，避免长时间运行后内存增长。
 * 条目数量受限于唯一聊天数（通常很少），TTL 仅作为额外安全保障。
 */
import { TtlMap } from "../utils/ttl-map.js"

interface ChatInfo {
  chatId: string
  chatType: "p2p" | "group"
}

/** 24 小时 TTL — 条目在每次 registerSessionChat 时刷新 */
const sessionToChat = new TtlMap<ChatInfo>(24 * 60 * 60 * 1_000)

export function registerSessionChat(sessionId: string, chatId: string, chatType: "p2p" | "group"): void {
  sessionToChat.set(sessionId, { chatId, chatType })
}

export function getChatIdBySession(sessionId: string): string | undefined {
  return sessionToChat.get(sessionId)?.chatId
}

export function getChatInfoBySession(sessionId: string): ChatInfo | undefined {
  return sessionToChat.get(sessionId)
}
