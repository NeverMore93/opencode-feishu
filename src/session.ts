/**
 * 共享会话管理：查找或创建 OpenCode 会话
 */
import type { OpencodeClient } from "@opencode-ai/sdk"
import type { LogFn } from "./types.js"

const SESSION_KEY_PREFIX = "feishu"
const TITLE_PREFIX = "Feishu"

/**
 * 内存会话缓存：sessionKey → { id, title }
 * 避免每次 prompt 都查 API；event.ts 中主动 fork 后更新缓存
 */
const sessionCache = new Map<string, { id: string; title?: string }>()
const sessionIdToKeyCache = new Map<string, string>()

export function getCachedSession(sessionKey: string): { id: string; title?: string } | undefined {
  return sessionCache.get(sessionKey)
}

export function setCachedSession(sessionKey: string, session: { id: string; title?: string }): void {
  const oldSession = sessionCache.get(sessionKey)
  if (oldSession && oldSession.id !== session.id) {
    sessionIdToKeyCache.delete(oldSession.id)
  }
  sessionCache.set(sessionKey, session)
  sessionIdToKeyCache.set(session.id, sessionKey)
}

/**
 * 通过 sessionId 反查 sessionKey 并从缓存中删除（O(1)）
 * 返回被删除的 sessionKey（用于后续 fork 时重建缓存）
 */
export function invalidateCachedSession(sessionId: string): string | undefined {
  const sessionKey = sessionIdToKeyCache.get(sessionId)
  if (sessionKey) {
    sessionCache.delete(sessionKey)
    sessionIdToKeyCache.delete(sessionId)
  }
  return sessionKey
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

/**
 * Fork 旧会话并更新标题，用于模型不兼容时的自动恢复
 */
async function forkSession(
  client: OpencodeClient,
  oldSessionId: string,
  sessionKey: string,
  directory?: string,
): Promise<{ id: string; title?: string }> {
  const query = directory ? { directory } : undefined
  const resp = await client.session.fork({
    path: { id: oldSessionId },
    query,
    body: {},
  })
  if (!resp?.data?.id) {
    const err = (resp as unknown as { error?: unknown })?.error
    throw new Error(
      `Fork 会话失败: ${err ? JSON.stringify(err) : "unknown"}`,
    )
  }
  const title = generateSessionTitle(sessionKey)
  const updateResp = await client.session.update({
    path: { id: resp.data.id },
    query,
    body: { title },
  })
  if (!updateResp?.data?.id) {
    const err = (updateResp as unknown as { error?: unknown })?.error
    throw new Error(
      `更新 forked session 标题失败: ${err ? JSON.stringify(err) : "unknown"}`,
    )
  }
  return { id: resp.data.id, title }
}

/**
 * 创建全新会话（fork 失败时的 fallback）
 */
export async function createFreshSession(
  client: OpencodeClient,
  sessionKey: string,
  directory?: string,
): Promise<{ id: string; title?: string }> {
  const query = directory ? { directory } : undefined
  const title = generateSessionTitle(sessionKey)
  const resp = await client.session.create({ query, body: { title } })
  if (!resp?.data?.id) {
    const err = (resp as unknown as { error?: unknown })?.error
    throw new Error(
      `创建新会话失败: ${err ? JSON.stringify(err) : "unknown"}`,
    )
  }
  return { id: resp.data.id, title: resp.data.title }
}

/**
 * 尝试 fork 旧会话，失败时 fallback 到创建全新会话
 */
export async function forkOrCreateSession(
  client: OpencodeClient,
  oldSessionId: string,
  sessionKey: string,
  directory?: string,
  log?: LogFn,
): Promise<{ id: string; title?: string }> {
  try {
    return await forkSession(client, oldSessionId, sessionKey, directory)
  } catch (forkErr) {
    log?.("warn", "Fork 失败，回退到创建新会话", {
      oldSessionId,
      sessionKey,
      error: forkErr instanceof Error ? forkErr.message : String(forkErr),
    })
    return await createFreshSession(client, sessionKey, directory)
  }
}
