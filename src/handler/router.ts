/**
 * 命令路由：解析 /help、/models、/session、/agents、/health 或普通对话
 */
import type { FeishuMessageContext } from "../types.js";

export type Route =
  | { type: "command"; name: string; args: string[] }
  | { type: "chat"; content: string };

const COMMANDS = [
  "help",
  "models",
  "model",
  "session",
  "agents",
  "agent",
  "health",
] as const;

/**
 * 解析用户输入，返回路由结果
 */
export function route(ctx: FeishuMessageContext): Route {
  const raw = (ctx.content ?? "").trim();
  if (!raw) return { type: "chat", content: "" };

  if (raw.startsWith("/")) {
    const rest = raw.slice(1).trim();
    const first = rest.split(/\s+/)[0]?.toLowerCase();
    const args = rest.split(/\s+/).slice(1);

    if (first === "session" && args.length > 0) {
      const sub = args[0]?.toLowerCase();
      return {
        type: "command",
        name: "session",
        args: [sub ?? "", ...args.slice(1)],
      };
    }

    if (first && COMMANDS.includes(first as (typeof COMMANDS)[number])) {
      return { type: "command", name: first, args };
    }
  }

  return { type: "chat", content: raw };
}
