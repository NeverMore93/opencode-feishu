/**
 * 飞书消息发送模块
 *
 * 封装飞书 IM API 的消息操作，提供统一的错误处理和结果格式。
 * 支持：发送文本消息、更新已有消息、删除消息、发送交互式卡片、发送 CardKit 2.0 卡片。
 * 所有发送函数返回 FeishuSendResult 统一结构，便于调用方处理成功/失败。
 */
import type * as Lark from "@larksuiteoapi/node-sdk";
import type { LogFn } from "../types.js"

/**
 * 飞书消息发送操作的统一返回结构
 */
export interface FeishuSendResult {
  /** 操作是否成功 */
  ok: boolean
  /** 成功时返回飞书消息 ID（可用于后续更新/删除） */
  messageId?: string
  /** 失败时返回错误描述（包含飞书 API 的 code/msg/logId 信息） */
  error?: string
}

/**
 * 通用的飞书 API 调用包装器
 *
 * 将任意飞书 SDK 调用封装为统一的 FeishuSendResult 格式，
 * 自动提取 Lark SDK 错误中的 code、msg、logId 等诊断信息。
 *
 * @template T 飞书 API 返回值类型
 * @param fn 待执行的飞书 API 调用（惰性执行，传入无参函数）
 * @param idExtractor 从 API 响应中提取 message_id 的函数，默认从 data.message_id 提取
 * @returns 统一的发送结果，包含 ok/messageId/error 字段
 */
async function wrapSendCall<T>(
  fn: () => Promise<T>,
  log: LogFn | undefined,
  action: string,
  idExtractor: (res: T) => string = (res) => (res as { data?: { message_id?: string } })?.data?.message_id ?? "",
): Promise<FeishuSendResult> {
  try {
    // 惰性执行具体 SDK 调用，便于不同发送函数共用统一包装逻辑。
    const res = await fn()
    return { ok: true, messageId: idExtractor(res) }
  } catch (err) {
    // 提取 Lark SDK 错误对象中的诊断字段（code/msg/logId）
    const larkErr = (err != null && typeof err === "object") ? err as Record<string, unknown> : {}
    // 拼接 Lark 特有的错误信息片段，便于排查问题
    const parts = [
      larkErr.code !== undefined ? `code=${larkErr.code}` : null,
      typeof larkErr.msg === "string" ? `msg=${larkErr.msg}` : null,
      typeof larkErr.logId === "string" ? `logId=${larkErr.logId}` : null,
    ].filter(Boolean).join(", ")
    // 基础错误消息：优先使用 Error.message，否则转为字符串
    const message = err instanceof Error ? err.message : String(err)
    // sender 层直接记 error 日志，避免调用方只消费返回值时丢失异常现场。
    log?.("error", `飞书消息操作失败: ${action}`, {
      error: message,
      ...(parts ? { diagnostics: parts } : {}),
    })
    // 如果有 Lark 诊断信息，附加在括号中
    return { ok: false, error: parts ? `${message} (${parts})` : message }
  }
}

/**
 * 统一走 `im.message.create` 的发送路径。
 *
 * 这里把 `chatId` 校验、`receive_id` 组装和 SDK 调用收敛到一处，
 * 避免文本、交互卡片和 CardKit 卡片各自复制一遍相同模板。
 */
function createChatMessage(
  client: InstanceType<typeof Lark.Client>,
  chatId: string,
  msgType: "text" | "interactive",
  content: string,
  log?: LogFn,
): Promise<FeishuSendResult> {
  const receiveId = chatId.trim()
  if (!receiveId) {
    log?.("error", "飞书消息发送失败: 缺少 chat_id", { msgType })
    return Promise.resolve({ ok: false, error: "No chat_id provided" })
  }
  return wrapSendCall(() =>
    client.im.message.create({
      params: { receive_id_type: "chat_id" },
      data: {
        receive_id: receiveId,
        msg_type: msgType,
        content,
      },
    }),
    log,
    `create:${msgType}`,
  )
}

/**
 * 发送纯文本消息到飞书会话
 *
 * @param client 飞书 SDK Client 实例（自动处理 token 认证）
 * @param chatId 目标会话 ID（飞书 chat_id）
 * @param text 消息文本内容
 * @returns 发送结果，成功时包含 messageId
 */
export async function sendTextMessage(
  client: InstanceType<typeof Lark.Client>,
  chatId: string,
  text: string,
  log?: LogFn,
): Promise<FeishuSendResult> {
  return createChatMessage(client, chatId, "text", JSON.stringify({ text }), log)
}

/**
 * 更新已有消息的文本内容
 *
 * 典型场景：替换「正在思考...」占位消息为最终 AI 回复。
 * 使用飞书 im.message.update API，通过 message_id 定位要更新的消息。
 *
 * @param client 飞书 SDK Client 实例
 * @param messageId 要更新的消息 ID
 * @param text 新的文本内容
 * @returns 发送结果（messageId 固定为传入的 messageId）
 */
export async function updateMessage(
  client: InstanceType<typeof Lark.Client>,
  messageId: string,
  text: string,
  log?: LogFn,
): Promise<FeishuSendResult> {
  return wrapSendCall(
    () => client.im.message.update({
      path: { message_id: messageId },
      data: {
        msg_type: "text",
        content: JSON.stringify({ text }),
      },
    }),
    log,
    "update",
    // update API 不返回 message_id，因此直接回填调用方传入的 messageId。
    () => messageId,
  )
}

/**
 * 删除指定消息
 *
 * 典型场景：abort 中断时删除占位消息（StreamingCard.destroy）。
 * 采用"尽力而为"策略 — 删除失败时记录 error 日志，但不阻断主流程。
 *
 * @param client 飞书 SDK Client 实例
 * @param messageId 要删除的消息 ID
 */
export async function deleteMessage(
  client: InstanceType<typeof Lark.Client>,
  messageId: string,
  log?: LogFn,
): Promise<void> {
  try {
    await client.im.message.delete({ path: { message_id: messageId } })
  } catch (err) {
    // 即便是 best-effort 删除，也要保留 error 级日志，便于排查残留占位消息。
    log?.("error", "删除飞书消息失败", {
      messageId,
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

/**
 * 发送交互式卡片消息（msg_type: interactive）
 *
 * 用于权限审批卡片、问答卡片等需要用户点击按钮交互的场景。
 * 卡片内容为 Card 2.0 JSON 对象，由 buildCardFromDSL 构建。
 *
 * @param client 飞书 SDK Client 实例
 * @param chatId 目标会话 ID
 * @param card 卡片 JSON 对象（Card 2.0 schema）
 * @returns 发送结果，成功时包含 messageId
 */
export async function sendInteractiveCard(
  client: InstanceType<typeof Lark.Client>,
  chatId: string,
  card: object,
  log?: LogFn,
): Promise<FeishuSendResult> {
  // 飞书 interactive 消息要求 content 是序列化后的卡片 JSON。
  return createChatMessage(client, chatId, "interactive", JSON.stringify(card), log)
}

/**
 * 发送 CardKit 2.0 流式卡片消息
 *
 * CardKit 2.0 卡片通过 cardId 引用（卡片实体由 CardKitClient 预先创建），
 * 消息发送时只需传递 cardId，飞书服务端自动关联卡片内容。
 * 后续可通过 CardKitClient.updateElement 实时更新卡片内容（流式效果）。
 *
 * @param client 飞书 SDK Client 实例
 * @param chatId 目标会话 ID
 * @param cardId CardKit 2.0 卡片 ID（由 CardKitClient.createCard 返回）
 * @returns 发送结果，成功时包含 messageId
 */
export async function sendCardMessage(
  client: InstanceType<typeof Lark.Client>,
  chatId: string,
  cardId: string,
  log?: LogFn,
): Promise<FeishuSendResult> {
  // CardKit 2.0 引用格式：type=card + data.card_id。
  return createChatMessage(
    client,
    chatId,
    "interactive",
    JSON.stringify({ type: "card", data: { card_id: cardId } }),
    log,
  )
}
