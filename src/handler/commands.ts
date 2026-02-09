/**
 * 命令处理实现：/help, /models, /model, /session, /agents, /health
 */
import type { Config } from "../types.js";
import type { OpenCodeClient } from "../opencode/client.js";
import type { SessionManager } from "../session/manager.js";
import type { FeishuMessageContext } from "../types.js";

export function sessionKeyFromContext(ctx: FeishuMessageContext): string {
  const id = ctx.chatType === "p2p" ? ctx.senderId : ctx.chatId;
  return `feishu-${ctx.chatType}-${id}`;
}

export interface CommandDeps {
  config: Config;
  opencodeClient: OpenCodeClient;
  sessionManager: SessionManager;
  getModel: (ctx: FeishuMessageContext) => string | undefined;
  setModel: (ctx: FeishuMessageContext, model: string) => void;
  getAgent: (ctx: FeishuMessageContext) => string | undefined;
  setAgent: (ctx: FeishuMessageContext, agent: string) => void;
}

export async function runCommand(
  route: { type: "command"; name: string; args: string[] },
  ctx: FeishuMessageContext,
  deps: CommandDeps
): Promise<string> {
  const { name, args } = route;
  switch (name) {
    case "help":
      return cmdHelp();
    case "models":
      return cmdModels(deps.opencodeClient, args[0]);
    case "model":
      return cmdModel(ctx, args, deps);
    case "session":
      return cmdSession(ctx, args, deps);
    case "agents":
      return cmdAgents(deps.opencodeClient);
    case "agent":
      return cmdAgent(ctx, args, deps);
    case "health":
      return cmdHealth(deps.opencodeClient);
    default:
      return `未知命令: /${name}，输入 /help 查看帮助。`;
  }
}

function cmdHelp(): string {
  return [
    "**OpenCode 飞书助手**",
    "",
    "**命令：**",
    "/help — 显示本帮助",
    "/models [关键词] — 列出/搜索可用模型",
    "/model <provider/model> — 设置当前模型",
    "/session list — 列出所有会话",
    "/session new [标题] — 新建会话",
    "/session switch <id> — 切换到指定会话",
    "/session delete <id> — 删除会话",
    "/session info — 当前会话信息",
    "/agents — 列出可用 Agent",
    "/agent [名称] — 查看或设置当前 Agent",
    "/health — 服务健康检查",
    "",
    "直接发送消息即可与 AI 对话。",
  ].join("\n");
}

async function cmdModels(client: OpenCodeClient, keyword?: string): Promise<string> {
  const providers = await client.listProviders();
  const kw = (keyword ?? "").toLowerCase();
  const lines: string[] = [];

  for (const p of providers) {
    const models = Array.isArray(p.models) ? p.models : p.models ? Object.values(p.models) : [];
    const matched = kw
      ? models.filter(
          (m) =>
            (m.name ?? "").toLowerCase().includes(kw) ||
            (m.id ?? "").toLowerCase().includes(kw) ||
            (p.name ?? "").toLowerCase().includes(kw) ||
            (p.id ?? "").toLowerCase().includes(kw)
        )
      : models;
    if (matched.length > 0) {
      lines.push(`📦 [${p.name ?? p.id}]`);
      for (const m of matched) {
        lines.push(`  - ${p.id}/${m.id}: ${m.name ?? m.id}`);
      }
      lines.push("");
    }
  }

  if (lines.length === 0) return keyword ? `未找到包含 "${keyword}" 的模型` : "暂无可用模型";
  return "**可用模型：**\n\n" + lines.join("\n").trim();
}

function cmdModel(
  ctx: FeishuMessageContext,
  args: string[],
  deps: CommandDeps
): string {
  const model = args[0];
  if (!model) return "用法: /model <provider/model>，例如 /model anthropic/claude-3-5-sonnet";
  if (!model.includes("/")) return "模型格式应为 provider/model";
  deps.setModel(ctx, model);
  return `✅ 已设置当前模型: ${model}`;
}

async function cmdSession(
  ctx: FeishuMessageContext,
  args: string[],
  deps: CommandDeps
): Promise<string> {
  const sub = args[0]?.toLowerCase();
  const { sessionManager, opencodeClient } = deps;
  const chatType = ctx.chatType;
  const userId = ctx.senderId;
  const chatId = ctx.chatId;

  switch (sub) {
    case "list": {
      const sessions = await sessionManager.listSessions();
      if (sessions.length === 0) return "暂无会话";
      const list = sessions
        .map((s) => `${s.id}: ${s.title ?? "未命名"} ${s.model ? `(${s.model})` : ""}`)
        .join("\n");
      return "**会话列表：**\n" + list;
    }
    case "new": {
      const session = await sessionManager.getOrCreate(chatType, userId, chatId);
      return `✅ 已创建/恢复会话: ${session.id}\n📝 ${session.title ?? ""}`;
    }
    case "switch": {
      const id = args[1];
      if (!id) return "用法: /session switch <会话id>";
      try {
        const session = await sessionManager.switchSession(chatType, userId, chatId, id);
        return `✅ 已切换到: ${session.id}\n📝 ${session.title ?? ""}`;
      } catch (e) {
        return "❌ " + (e instanceof Error ? e.message : String(e));
      }
    }
    case "delete": {
      const id = args[1];
      if (!id) return "用法: /session delete <会话id>";
      try {
        await sessionManager.deleteSession(id);
        return `✅ 已删除会话: ${id}`;
      } catch (e) {
        return "❌ " + (e instanceof Error ? e.message : String(e));
      }
    }
    case "info": {
      const session = await sessionManager.getOrCreate(chatType, userId, chatId);
      const model = deps.getModel(ctx) ?? session.model ?? "默认";
      return [
        "**当前会话：**",
        `ID: ${session.id}`,
        `标题: ${session.title ?? "未命名"}`,
        `模型: ${model}`,
        session.createdAt ? `创建: ${new Date(session.createdAt).toLocaleString()}` : "",
      ]
        .filter(Boolean)
        .join("\n");
    }
    default:
      return "子命令: list | new | switch <id> | delete <id> | info";
  }
}

async function cmdAgents(client: OpenCodeClient): Promise<string> {
  const agents = await client.listAgents();
  if (agents.length === 0) return "暂无可用 Agent";
  const list = agents
    .map((a) => `🤖 ${a.name ?? a.id ?? "未命名"}${a.description ? `\n   ${a.description}` : ""}`)
    .join("\n\n");
  return "**可用 Agents：**\n\n" + list;
}

async function cmdAgent(
  ctx: FeishuMessageContext,
  args: string[],
  deps: CommandDeps
): Promise<string> {
  const name = args[0]?.trim();
  const current = deps.getAgent(ctx);
  const agents = await deps.opencodeClient.listAgents();
  const allowed = new Set<string>();
  for (const a of agents) {
    if (a.id) allowed.add(a.id.toLowerCase());
    if (a.name) allowed.add(a.name.toLowerCase());
  }

  if (name) {
    if (!allowed.has(name.toLowerCase())) {
      return `未找到 Agent「${name}」。输入 /agents 查看可用列表。`;
    }
    // 使用与 OpenCode 一致的 id（优先 id，否则用户输入）
    const agent = agents.find(
      (a) => (a.id ?? "").toLowerCase() === name.toLowerCase() || (a.name ?? "").toLowerCase() === name.toLowerCase()
    );
    const value = agent?.id ?? agent?.name ?? name;
    deps.setAgent(ctx, value);
    return `✅ 已设置当前 Agent: ${value}`;
  }

  const lines: string[] = [];
  if (current) lines.push(`**当前 Agent：** ${current}`);
  else lines.push("**当前 Agent：** 未设置（使用 OpenCode 默认）");
  if (agents.length > 0) {
    lines.push("");
    lines.push("**可用 Agents：**");
    for (const a of agents) {
      const id = a.id ?? a.name ?? "未命名";
      lines.push(`  - ${id}`);
    }
    lines.push("");
    lines.push("使用 /agent <名称> 切换 Agent。");
  }
  return lines.join("\n");
}

async function cmdHealth(client: OpenCodeClient): Promise<string> {
  const ok = await client.health();
  return ok ? "✅ OpenCode 服务正常" : "❌ OpenCode 服务异常或不可达";
}
