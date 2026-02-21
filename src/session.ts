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
        const tsA = parseInt(a.title?.split("-").pop() ?? "0", 10)
        const tsB = parseInt(b.title?.split("-").pop() ?? "0", 10)
        if (tsA && tsB) return tsB - tsA
        const ca = a.time?.created ?? 0
        const cb = b.time?.created ?? 0
        return cb - ca
      })
      const best = candidates[0]
      if (best?.id) return { id: best.id, title: best.title }
    }
  }

  const title = `${titlePrefix}${Date.now()}`
  const createResp = await client.session.create({ query, body: { title } })
  if (!createResp?.data?.id) {
    const err = (createResp as unknown as { error?: unknown })?.error
    throw new Error(
      `创建 OpenCode 会话失败: ${err ? JSON.stringify(err) : "unknown"}`,
    )
  }
  return { id: createResp.data.id, title: createResp.data.title }
}
