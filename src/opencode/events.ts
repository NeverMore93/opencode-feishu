/**
 * OpenCode SSE 事件流：实时转发 message.part.updated、session.status、session.error，断线重连
 */
import * as sender from "../feishu/sender.js";
import type * as Lark from "@larksuiteoapi/node-sdk";
import type { OpenCodeClient } from "./client.js";

const RECONNECT_DELAY_MS = 5000;

export interface PendingReplyPayload {
  chatId: string;
  placeholderId: string;
  feishuClient: InstanceType<typeof Lark.Client>;
  /** 当前已汇总的回复文本（用于流式更新） */
  textBuffer: string;
}

const pendingBySession = new Map<string, PendingReplyPayload>();

export function registerPending(sessionId: string, payload: Omit<PendingReplyPayload, "textBuffer">): void {
  pendingBySession.set(sessionId, { ...payload, textBuffer: "" });
}

export function unregisterPending(sessionId: string): void {
  pendingBySession.delete(sessionId);
}

export function getPending(sessionId: string): PendingReplyPayload | undefined {
  return pendingBySession.get(sessionId);
}

function extractSessionId(event: { type?: string; properties?: Record<string, unknown> }): string | undefined {
  const p = event.properties ?? {};
  return (p.sessionID as string) ?? (p.info as Record<string, unknown>)?.session_id as string ?? (p.info as Record<string, unknown>)?.sessionId as string;
}

function appendPartText(payload: PendingReplyPayload, part: Record<string, unknown>, showReasoning: boolean): string {
  const type = part.type as string;
  const text = (part.text as string) ?? "";
  if (type === "text") return text;
  if (type === "reasoning" && showReasoning && text) return `🤔 思考: ${text}\n\n`;
  return "";
}

/**
 * 启动 SSE 事件循环：订阅 OpenCode 事件，更新飞书占位消息，断线自动重连
 */
export function startEventStream(
  client: OpenCodeClient,
  options: {
    showReasoning?: boolean;
    log: (level: "info" | "warn" | "error", message: string, extra?: Record<string, unknown>) => void;
  }
): { stop: () => void } {
  const { showReasoning = true, log } = options;
  let stopped = false;

  const run = async (): Promise<void> => {
    while (!stopped) {
      try {
        log("info", "OpenCode 事件流连接中…");
        const stream = await client.subscribeEvents();

        for await (const event of stream) {
          if (stopped) break;
          const ev = event as { type?: string; properties?: Record<string, unknown>; path?: Record<string, unknown> };
          const sessionId = extractSessionId(ev);

          switch (ev.type) {
            case "message.part.updated": {
              const part = (ev.properties?.part ?? ev.properties) as Record<string, unknown> | undefined;
              if (!part || !sessionId) break;
              const payload = pendingBySession.get(sessionId);
              if (!payload) break;
              const added = appendPartText(payload, part, showReasoning);
              if (added) {
                payload.textBuffer += added;
                try {
                  await sender.updateMessage(payload.feishuClient, payload.placeholderId, payload.textBuffer.trim());
                } catch {
                  // best-effort
                }
              }
              break;
            }
            case "session.status": {
              const status = (ev.properties?.status as Record<string, unknown>)?.type ?? ev.properties?.type;
              if (status === "idle" && sessionId) {
                // 可选：在此处做最终收尾，当前由 chat 轮询收尾
              }
              break;
            }
            case "session.error": {
              if (sessionId) {
                const payload = pendingBySession.get(sessionId);
                const errMsg = (ev.properties?.error as Record<string, unknown>)?.message ?? String(ev.properties?.error);
                if (payload) {
                  try {
                    await sender.updateMessage(payload.feishuClient, payload.placeholderId, `❌ 会话错误: ${errMsg}`);
                  } catch {
                    await sender.sendTextMessage(payload.feishuClient, payload.chatId, `❌ 会话错误: ${errMsg}`);
                  }
                }
              }
              break;
            }
            default:
              break;
          }
        }
      } catch (err) {
        if (!stopped) {
          log("warn", "OpenCode 事件流断开，稍后重连", {
            error: err instanceof Error ? err.message : String(err),
          });
          await new Promise((r) => setTimeout(r, RECONNECT_DELAY_MS));
        }
      }
    }
    log("info", "OpenCode 事件流已停止");
  };

  run();

  return {
    stop: () => {
      stopped = true;
    },
  };
}
