/**
 * 普通对话处理：占位消息、prompt 发送、轮询等待、最终回复
 */
import type { FeishuMessageContext } from "../types.js";
import type { Config } from "../types.js";
import type { OpenCodeClient } from "../opencode/client.js";
import type { SessionManager } from "../session/manager.js";
import * as sender from "../feishu/sender.js";
import type * as Lark from "@larksuiteoapi/node-sdk";

const POLL_INTERVAL_MS = 1500;
const MAX_WAIT_MS = 120_000;

export interface ChatDeps {
  config: Config;
  opencodeClient: OpenCodeClient;
  sessionManager: SessionManager;
  feishuClient: InstanceType<typeof Lark.Client>;
  getModel: (ctx: FeishuMessageContext) => string | undefined;
  getAgent?: (ctx: FeishuMessageContext) => string | undefined;
  log: (level: "info" | "warn" | "error", message: string, extra?: Record<string, unknown>) => void;
  /** 可选：注册/注销 SSE 流式更新（阶段6） */
  registerPending?: (sessionId: string, payload: { chatId: string; placeholderId: string; feishuClient: InstanceType<typeof Lark.Client> }) => void;
  unregisterPending?: (sessionId: string) => void;
}

export async function handleChat(ctx: FeishuMessageContext, deps: ChatDeps): Promise<void> {
  const { content, chatId, chatType, senderId, shouldReply } = ctx;
  if (!content.trim()) return;

  const { config, opencodeClient, sessionManager, feishuClient, getModel, getAgent, log, registerPending: regPending, unregisterPending: unregPending } = deps;

  const session = await sessionManager.getOrCreate(chatType, senderId, chatId);
  const model = getModel(ctx) ?? config.opencode.model;
  const agent = getAgent?.(ctx) ?? config.opencode.agent;

  // Build prompt content with sender identity for group chats
  let promptContent = content;
  if (chatType === "group" && senderId) {
    promptContent = `[${senderId}]: ${content}`;
  }

  // 静默监听模式：消息发给 OpenCode 作为上下文，但不触发 AI 回复、不在飞书回复
  if (!shouldReply) {
    try {
      await opencodeClient.sendPrompt(session.id, promptContent, { model, agent, noReply: true });
    } catch (err) {
      log("warn", "静默转发失败", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return;
  }

  const timeout = config.opencode.timeout ?? MAX_WAIT_MS;
  const thinkingDelay = config.bot.thinkingDelay ?? 2500;

  let placeholderId = "";
  let sessionIdForCleanup: string | null = null;
  let done = false;
  const timer =
    thinkingDelay > 0
      ? setTimeout(async () => {
          if (done) return;
          try {
            const res = await sender.sendTextMessage(feishuClient, chatId, "正在思考…");
            if (res.ok && res.messageId) placeholderId = res.messageId;
          } catch {
            // ignore
          }
        }, thinkingDelay)
      : null;

  try {

    await opencodeClient.sendPrompt(session.id, promptContent, { model, agent });
    sessionIdForCleanup = session.id;
    if (placeholderId && regPending) {
      regPending(session.id, { chatId, placeholderId, feishuClient });
    }

    const start = Date.now();
    let lastText = "";
    let sameCount = 0;
    const STABLE_POLLS = 2;

    while (Date.now() - start < timeout) {
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
      const messages = await opencodeClient.getMessages(session.id);
      const text = extractLastAssistantText(messages);

      if (text && text !== lastText) {
        lastText = text;
        sameCount = 0;
        if (placeholderId) {
          try {
            await sender.updateMessage(feishuClient, placeholderId, text);
          } catch {
            // best-effort
          }
        }
      } else if (text && text.length > 0) {
        sameCount++;
        if (sameCount >= STABLE_POLLS) break;
      }
    }

    const messages = await opencodeClient.getMessages(session.id);
    const finalText = extractLastAssistantText(messages) || lastText || (Date.now() - start >= timeout ? "⚠️ 响应超时" : "[无回复]");
    if (placeholderId) {
      try {
        await sender.updateMessage(feishuClient, placeholderId, finalText);
      } catch {
        await sender.sendTextMessage(feishuClient, chatId, finalText);
      }
      try {
        await sender.deleteMessage(feishuClient, placeholderId);
      } catch {
        // ignore
      }
    } else {
      await sender.sendTextMessage(feishuClient, chatId, finalText);
    }
  } catch (err) {
    log("error", "对话处理失败", {
      error: err instanceof Error ? err.message : String(err),
    });
    const msg = "❌ " + (err instanceof Error ? err.message : String(err));
    if (placeholderId) {
      try {
        await sender.updateMessage(feishuClient, placeholderId, msg);
      } catch {
        await sender.sendTextMessage(feishuClient, chatId, msg);
      }
      try {
        await sender.deleteMessage(feishuClient, placeholderId);
      } catch {
        // ignore
      }
    } else {
      await sender.sendTextMessage(feishuClient, chatId, msg);
    }
  } finally {
    done = true;
    if (timer) clearTimeout(timer);
    if (sessionIdForCleanup) unregPending?.(sessionIdForCleanup);
  }
}

function extractLastAssistantText(messages: { info?: { role?: string }; parts?: Array<{ type?: string; text?: string }> }[]): string {
  const assistant = messages.filter((m) => m.info?.role === "assistant").pop();
  const parts = assistant?.parts ?? [];
  return parts
    .filter((p) => p.type === "text")
    .map((p) => p.text ?? "")
    .join("\n")
    .trim();
}

