/**
 * OpenCode SDK 封装：会话、消息、健康检查
 */
import type { OpenCodeConfig } from "../types.js";

const OPENCODE_BASE_URL = "http://localhost:4096";

export interface Session {
  id: string;
  title?: string;
  model?: string;
  createdAt?: string;
  [key: string]: unknown;
}

export interface Message {
  info?: { id?: string; role?: string; [key: string]: unknown };
  parts?: Array<{ type?: string; text?: string; [key: string]: unknown }>;
  [key: string]: unknown;
}

export interface HealthInfo {
  healthy?: boolean;
  version?: string;
  [key: string]: unknown;
}

let mainClient: unknown = null;
let healthClient: unknown = null;
let initPromise: Promise<{ main: unknown; health: unknown }> | null = null;

async function ensureClients(baseUrl: string): Promise<{ main: unknown; health: unknown }> {
  if (initPromise) return initPromise;
  initPromise = (async () => {
    const { createOpencodeClient: createV1 } = await import("@opencode-ai/sdk/client");
    const { createOpencodeClient: createV2 } = await import("@opencode-ai/sdk/v2/client");
    const main = createV1({ baseUrl });
    const health = createV2({ baseUrl });
    mainClient = main;
    healthClient = health;
    return { main, health };
  })();
  return initPromise;
}

/**
 * OpenCode 客户端：封装会话、提示、健康检查
 */
export class OpenCodeClient {
  constructor(private config: OpenCodeConfig) {}

  private async getClient(): Promise<{
    session: {
      list: (opts?: unknown) => Promise<{ data: Session[] }>;
      get: (opts: { path: { id: string } }) => Promise<{ data: Session }>;
      create: (opts: { body: { title: string }; query?: { directory?: string } }) => Promise<{ data: Session }>;
      delete: (opts: { path: { id: string } }) => Promise<void>;
      prompt: (opts: {
        path: { id: string };
        body: { parts: Array<{ type: string; text?: string }>; noReply?: boolean };
      }) => Promise<{ info?: { id?: string }; [key: string]: unknown }>;
      messages: (opts: { path: { id: string } }) => Promise<{ data: Message[] }>;
    };
    event: { subscribe: () => Promise<{ stream: AsyncIterable<unknown> }> };
  }> {
    const { main } = await ensureClients(OPENCODE_BASE_URL);
    return main as never;
  }

  private async getHealthClient(): Promise<{ global: { health: () => Promise<{ data: HealthInfo }> } }> {
    const { health } = await ensureClients(OPENCODE_BASE_URL);
    return health as never;
  }

  async listSessions(): Promise<Session[]> {
    const client = await this.getClient();
    const { data } = await client.session.list();
    return Array.isArray(data) ? data : [];
  }

  async createSession(title: string): Promise<Session> {
    const client = await this.getClient();
    const { data } = await client.session.create({ body: { title } });
    if (!data?.id) throw new Error("创建会话失败");
    return data;
  }

  async getSession(id: string): Promise<Session> {
    const client = await this.getClient();
    const { data } = await client.session.get({ path: { id } });
    return data;
  }

  async deleteSession(id: string): Promise<void> {
    const client = await this.getClient();
    await client.session.delete({ path: { id } });
  }

  async sendPrompt(
    sessionId: string,
    content: string,
    options?: { noReply?: boolean }
  ): Promise<{ messageId?: string }> {
    const client = await this.getClient();
    const body: {
      parts: Array<{ type: string; text?: string }>;
      noReply?: boolean;
    } = {
      parts: [{ type: "text", text: content }],
    };
    if (options?.noReply) body.noReply = true;
    const result = await client.session.prompt({
      path: { id: sessionId },
      body,
    });
    return { messageId: result.info?.id };
  }

  async getMessages(sessionId: string): Promise<Message[]> {
    const client = await this.getClient();
    const { data } = await client.session.messages({ path: { id: sessionId } });
    return Array.isArray(data) ? data : [];
  }

  async health(): Promise<boolean> {
    try {
      const hc = await this.getHealthClient();
      const { data } = await hc.global.health();
      return data?.healthy === true;
    } catch {
      return false;
    }
  }

  /** 事件流（供 events.ts 订阅，阶段6 使用） */
  async subscribeEvents(): Promise<AsyncIterable<unknown>> {
    const client = await this.getClient();
    const { stream } = await client.event.subscribe();
    return stream;
  }
}

export function createOpenCodeClient(config: OpenCodeConfig): OpenCodeClient {
  return new OpenCodeClient(config);
}
