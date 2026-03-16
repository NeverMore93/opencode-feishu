/**
 * sessionId → chatInfo 映射：tool execute 时通过 sessionID 查找飞书 chatId 和 chatType
 */

interface ChatInfo {
  chatId: string
  chatType: "p2p" | "group"
}

const sessionToChat = new Map<string, ChatInfo>()

export function registerSessionChat(sessionId: string, chatId: string, chatType: "p2p" | "group"): void {
  sessionToChat.set(sessionId, { chatId, chatType })
}

export function getChatIdBySession(sessionId: string): string | undefined {
  return sessionToChat.get(sessionId)?.chatId
}

export function getChatInfoBySession(sessionId: string): ChatInfo | undefined {
  return sessionToChat.get(sessionId)
}

export function unregisterSessionChat(sessionId: string): void {
  sessionToChat.delete(sessionId)
}
