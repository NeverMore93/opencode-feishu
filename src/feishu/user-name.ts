/**
 * 飞书用户名解析：open_id → 真实用户名（24h 缓存）
 */
import type * as Lark from "@larksuiteoapi/node-sdk"
import type { LogFn } from "../types.js"
import { TtlMap } from "../utils/ttl-map.js"

const nameCache = new TtlMap<string>(24 * 60 * 60 * 1_000) // 24h TTL

export async function resolveUserName(
  client: InstanceType<typeof Lark.Client>,
  openId: string,
  log: LogFn,
): Promise<string> {
  const cached = nameCache.get(openId)
  if (cached) return cached

  try {
    const res = await client.contact.user.get({
      path: { user_id: openId },
      params: { user_id_type: "open_id" },
    })
    const name = (res?.data?.user as { name?: string })?.name
    if (name) {
      nameCache.set(openId, name)
      return name
    }
  } catch (err) {
    log("warn", "用户名解析失败", {
      openId,
      error: err instanceof Error ? err.message : String(err),
    })
  }
  return openId // fallback to open_id
}
