/**
 * 飞书用户名解析模块 — open_id → 真实用户名
 *
 * 飞书消息事件中只携带 open_id（如 ou_xxxxxxxxxx），
 * 本模块通过飞书通讯录 API 将 open_id 解析为用户真实姓名，
 * 并使用 24 小时 TTL 缓存避免重复请求。
 *
 * 用途：在发送给 OpenCode 的上下文中显示友好的用户名，
 * 而非难以辨识的 open_id。
 */
import type * as Lark from "@larksuiteoapi/node-sdk"
import type { LogFn } from "../types.js"
import { TtlMap } from "../utils/ttl-map.js"

/**
 * 用户名缓存
 * key: 飞书 open_id
 * value: 用户真实姓名
 * TTL: 24 小时（86,400,000 毫秒）— 用户名变更频率极低，长缓存合理
 */
const nameCache = new TtlMap<string>(24 * 60 * 60 * 1_000) // 24h TTL

/**
 * 将飞书 open_id 解析为用户真实姓名
 *
 * 解析流程：
 * 1. 优先从本地缓存读取（24h TTL）
 * 2. 缓存未命中时调用飞书通讯录 API（contact.user.get）
 * 3. 解析成功则写入缓存并返回姓名
 * 4. 解析失败（API 错误或无权限）时回退返回原始 open_id
 *
 * @param client 飞书 SDK Client 实例（自动处理 token 认证）
 * @param openId 飞书用户的 open_id
 * @param log 日志函数，用于记录解析失败的 error 日志
 * @returns 用户真实姓名；解析失败时回退返回 open_id 本身
 */
export async function resolveUserName(
  client: InstanceType<typeof Lark.Client>,
  openId: string,
  log: LogFn,
): Promise<string> {
  // 优先从缓存读取，避免重复调用飞书 API
  const cached = nameCache.get(openId)
  if (cached) return cached

  try {
    // 调用飞书通讯录 API 获取用户信息
    const res = await client.contact.user.get({
      path: { user_id: openId },
      params: { user_id_type: "open_id" },
    })
    // 提取用户姓名（SDK 类型定义不完整，需类型断言）
    const name = (res?.data?.user as { name?: string })?.name
    if (name) {
      // 写入缓存，后续 24 小时内直接使用缓存
      nameCache.set(openId, name)
      return name
    }
  } catch (err) {
    // API 调用失败（如网络异常、权限不足）时记录 error 日志，不阻断主流程
    log("error", "用户名解析失败", {
      openId,
      error: err instanceof Error ? err.message : String(err),
    })
  }
  // 兜底：解析失败时返回原始 open_id，确保上下文中至少有标识信息
  return openId // fallback to open_id
}
