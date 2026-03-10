/**
 * 共享会话管理：查找或创建 OpenCode 会话
 */
import type { OpencodeClient } from "@opencode-ai/sdk"

const SESSION_KEY_PREFIX = "feishu"
const TITLE_PREFIX = "Feishu"

/** 内存会话缓存：sessionKey → { id, title } */
const sessionCache = new Map<string, { id: string; title?: string }>()

function setCachedSession(sessionKey: string, session: { id: string; title?: string }): void {
  sessionCache.set(sessionKey, session)
}

/**
 * 构建会话键
 */
export function buildSessionKey(chatType: "p2p" | "group", id: string): string {
  return `${SESSION_KEY_PREFIX}-${chatType}-${id}`
}

/**
 * 生成带时间戳的会话标题
 */
function generateSessionTitle(sessionKey: string): string {
  return `${TITLE_PREFIX}-${sessionKey}-${Date.now()}`
}

/**
 * 查找或创建 OpenCode 会话（按标题前缀匹配）
 */
export async function getOrCreateSession(
  client: OpencodeClient,
  sessionKey: string,
  directory?: string,
): Promise<{ id: string; title?: string }> {
  // 先查缓存
  const cached = sessionCache.get(sessionKey)
  if (cached) return cached

  const titlePrefix = `${TITLE_PREFIX}-${sessionKey}-`

  const query = directory ? { directory } : undefined
  const { data: sessions } = await client.session.list({ query })
  if (Array.isArray(sessions)) {
    const candidates = sessions.filter(
      (s) => s.title && s.title.startsWith(titlePrefix),
    )
    if (candidates.length > 0) {
      candidates.sort((a, b) => {
        const ca = a.time?.created ?? 0
        const cb = b.time?.created ?? 0
        return cb - ca
      })
      const best = candidates[0]
      if (best?.id) {
        const session = { id: best.id, title: best.title }
        setCachedSession(sessionKey, session)
        return session
      }
    }
  }

  const title = generateSessionTitle(sessionKey)
  const createResp = await client.session.create({ query, body: { title } })
  if (!createResp?.data?.id) {
    const err = (createResp as unknown as { error?: unknown })?.error
    throw new Error(
      `创建 OpenCode 会话失败: ${err ? JSON.stringify(err) : "unknown"}`,
    )
  }
  const session = { id: createResp.data.id, title: createResp.data.title }
  setCachedSession(sessionKey, session)
  return session
}

