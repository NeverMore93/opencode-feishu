/**
 * 飞书消息发送：文本、更新、删除
 */
import type * as Lark from "@larksuiteoapi/node-sdk";

export interface FeishuSendResult {
  ok: boolean;
  messageId?: string;
  error?: string;
}

async function wrapSendCall(
  fn: () => Promise<any>,
  idExtractor: (res: any) => string = (res) => res?.data?.message_id ?? "",
): Promise<FeishuSendResult> {
  try {
    const res = await fn()
    return { ok: true, messageId: idExtractor(res) }
  } catch (err) {
    const larkErr = err as { code?: number; msg?: string; logId?: string }
    const parts = [
      larkErr.code !== undefined ? `code=${larkErr.code}` : null,
      larkErr.msg ? `msg=${larkErr.msg}` : null,
      larkErr.logId ? `logId=${larkErr.logId}` : null,
    ].filter(Boolean).join(", ")
    const message = err instanceof Error ? err.message : String(err)
    return { ok: false, error: parts ? `${message} (${parts})` : message }
  }
}

/**
 * 发送文本消息到飞书会话
 */
export async function sendTextMessage(
  client: InstanceType<typeof Lark.Client>,
  chatId: string,
  text: string,
): Promise<FeishuSendResult> {
  if (!chatId?.trim()) {
    return { ok: false, error: "No chat_id provided" };
  }
  return wrapSendCall(() =>
    client.im.message.create({
      params: { receive_id_type: "chat_id" },
      data: {
        receive_id: chatId.trim(),
        msg_type: "text",
        content: JSON.stringify({ text }),
      },
    }),
  )
}

/**
 * 更新已有消息（如替换「正在思考…」占位）
 */
export async function updateMessage(
  client: InstanceType<typeof Lark.Client>,
  messageId: string,
  text: string
): Promise<FeishuSendResult> {
  return wrapSendCall(
    () => client.im.message.update({
      path: { message_id: messageId },
      data: {
        msg_type: "text",
        content: JSON.stringify({ text }),
      },
    }),
    () => messageId,
  )
}

/**
 * 删除消息（如移除占位消息）
 */
export async function deleteMessage(
  client: InstanceType<typeof Lark.Client>,
  messageId: string
): Promise<void> {
  try {
    await client.im.message.delete({ path: { message_id: messageId } });
  } catch {
    // 尽力清理，忽略失败
  }
}

/**
 * 发送交互式卡片消息（用于权限/问答卡片）
 */
export async function sendInteractiveCard(
  client: InstanceType<typeof Lark.Client>,
  chatId: string,
  card: object,
): Promise<FeishuSendResult> {
  if (!chatId?.trim()) {
    return { ok: false, error: "No chat_id provided" }
  }
  return wrapSendCall(() =>
    client.im.message.create({
      params: { receive_id_type: "chat_id" },
      data: {
        receive_id: chatId.trim(),
        msg_type: "interactive",
        content: JSON.stringify(card),
      },
    }),
  )
}

/**
 * 发送 CardKit 2.0 卡片消息到飞书会话
 */
export async function sendCardMessage(
  client: InstanceType<typeof Lark.Client>,
  chatId: string,
  cardId: string,
): Promise<FeishuSendResult> {
  if (!chatId?.trim()) {
    return { ok: false, error: "No chat_id provided" };
  }
  return wrapSendCall(() =>
    client.im.message.create({
      params: { receive_id_type: "chat_id" },
      data: {
        receive_id: chatId.trim(),
        msg_type: "interactive",
        content: JSON.stringify({ type: "card_kit", data: { card_id: cardId } }),
      },
    }),
  )
}
