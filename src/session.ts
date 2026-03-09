/**
 * 共享会话管理：查找或创建 OpenCode 会话
 */
import type { OpencodeClient } from "@opencode-ai/sdk"

const SESSION_KEY_PREFIX = "feishu"
const TITLE_PREFIX = "Feishu"

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
      if (best?.id) return { id: best.id, title: best.title }
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
  return { id: createResp.data.id, title: createResp.data.title }
}

/**
 * Fork 旧会话并更新标题，用于模型不兼容时的自动恢复
 */
export async function forkSession(
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
