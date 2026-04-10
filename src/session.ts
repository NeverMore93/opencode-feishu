/**
 * 共享会话管理：把飞书聊天稳定映射到 OpenCode session。
 *
 * 目标是既保留上下文连续性，又避免每条消息都去远端扫描 session 列表。
 */
import type { OpencodeClient } from "@opencode-ai/sdk"
import { TtlMap } from "./utils/ttl-map.js"

/** 逻辑会话键的固定前缀，避免与其他渠道混淆。 */
const SESSION_KEY_PREFIX = "feishu"
/** OpenCode session 标题前缀；用于后续标题反查。 */
const TITLE_PREFIX = "Feishu"
/** 本地缓存 TTL：1 小时。 */
const SESSION_CACHE_TTL = 60 * 60 * 1_000

/** 内存会话缓存：sessionKey → { id, title }，1 小时 TTL 自动清理 */
const sessionCache = new TtlMap<{ id: string; title?: string }>(SESSION_CACHE_TTL)
/**
 * 强制新建 session 标记。
 *
 * 当上层检测到“历史中毒”后，下一次同一 `sessionKey` 必须跳过标题前缀复用，
 * 否则可能立刻把刚刚判定为坏的远端 session 又捡回来。
 */
const forceCreateSession = new TtlMap<true>(SESSION_CACHE_TTL)

/**
 * 写入本地 session 缓存并刷新 TTL。
 */
function setCachedSession(sessionKey: string, session: { id: string; title?: string }): void {
  sessionCache.set(sessionKey, session)
}

/**
 * 构建逻辑会话键。
 *
 * - 单聊：`feishu-p2p-<userId>`
 * - 群聊：`feishu-group-<chatId>`
 */
export function buildSessionKey(chatType: "p2p" | "group", id: string): string {
  return `${SESSION_KEY_PREFIX}-${chatType}-${id}`
}

/**
 * 生成带时间戳的 OpenCode session 标题。
 *
 * 时间戳可以保证同一逻辑聊天在必要时仍能创建多条不同标题的 session。
 */
function generateSessionTitle(sessionKey: string): string {
  return `${TITLE_PREFIX}-${sessionKey}-${Date.now()}`
}

/**
 * 主动使指定逻辑会话失效。
 *
 * 下次 `getOrCreateSession()` 会跳过远端标题复用并直接创建一条新 session，
 * 避免“历史中毒”场景下马上复用回同一条坏会话。
 */
export function invalidateSession(sessionKey: string): void {
  sessionCache.delete(sessionKey)
  forceCreateSession.set(sessionKey, true)
}

/**
 * 查找或创建 OpenCode 会话。
 *
 * 查找顺序：
 * 1. 先查本地 TTL 缓存
 * 2. 缓存未命中时按标题前缀从远端 session 列表中找最新的一条
 * 3. 仍找不到才真正创建新 session
 */
export async function getOrCreateSession(
  client: OpencodeClient,
  sessionKey: string,
  directory?: string,
): Promise<{ id: string; title?: string }> {
  // 如果该逻辑会话刚被判定为“必须新建”，则本轮禁止命中任何旧 session。
  const mustCreateFresh = forceCreateSession.has(sessionKey)
  // 第一层：本地缓存命中时直接返回，避免频繁 list session。
  const cached = sessionCache.get(sessionKey)
  if (cached && !mustCreateFresh) return cached

  // 第二层：按标题前缀在远端已有 session 中反查。
  const titlePrefix = `${TITLE_PREFIX}-${sessionKey}-`

  const query = directory ? { directory } : undefined
  if (!mustCreateFresh) {
    try {
      const { data: sessions } = await client.session.list({ query })
      if (Array.isArray(sessions)) {
        // 只保留属于当前逻辑聊天的候选 session。
        const candidates = sessions.filter(
          (s) => s.title && s.title.startsWith(titlePrefix),
        )
        if (candidates.length > 0) {
          // 多个候选时，优先复用最近创建的一条，尽量延续最新上下文。
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
    } catch {
      // list 失败时退回创建新 session，优先保证当前消息链路继续推进。
    }
  }

  // 第三层：完全找不到时，创建新 session。
  const title = generateSessionTitle(sessionKey)
  const createResp = await client.session.create({ query, body: { title } })
  if (!createResp?.data?.id) {
    const err = (createResp as unknown as { error?: unknown })?.error
    throw new Error(
      `创建 OpenCode 会话失败: ${err instanceof Error ? err.message : String(err ?? "unknown")}`,
    )
  }
  const session = { id: createResp.data.id, title: createResp.data.title }
  // 一旦成功创建新会话，就清除“强制新建”标记，后续继续允许正常复用最新 session。
  forceCreateSession.delete(sessionKey)
  setCachedSession(sessionKey, session)
  return session
}
