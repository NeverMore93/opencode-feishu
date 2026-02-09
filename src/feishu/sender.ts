/**
 * 飞书消息发送：文本、更新、删除
 */
import type * as Lark from "@larksuiteoapi/node-sdk";

export interface FeishuSendResult {
  ok: boolean;
  messageId?: string;
  error?: string;
}

/**
 * 发送文本消息到飞书会话
 */
export async function sendTextMessage(
  client: InstanceType<typeof Lark.Client>,
  chatId: string,
  text: string,
  _replyToId?: string
): Promise<FeishuSendResult> {
  if (!chatId?.trim()) {
    return { ok: false, error: "No chat_id provided" };
  }
  try {
    const res = await client.im.message.create({
      params: { receive_id_type: "chat_id" },
      data: {
        receive_id: chatId.trim(),
        msg_type: "text",
        content: JSON.stringify({ text }),
      },
    });
    return { ok: true, messageId: res?.data?.message_id ?? "" };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * 更新已有消息（如替换「正在思考…」占位）
 */
export async function updateMessage(
  client: InstanceType<typeof Lark.Client>,
  messageId: string,
  text: string
): Promise<FeishuSendResult> {
  try {
    await client.im.message.update({
      path: { message_id: messageId },
      data: {
        msg_type: "text",
        content: JSON.stringify({ text }),
      },
    });
    return { ok: true, messageId };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
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
