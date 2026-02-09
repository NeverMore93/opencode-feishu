/**
 * 飞书用户 <-> OpenCode 会话映射：自动创建/恢复、缓存、手动切换
 */
import type { OpenCodeConfig } from "../types.js";
import type { OpenCodeClient, Session } from "../opencode/client.js";

const SESSION_KEY_PREFIX = "feishu";
const TITLE_PREFIX = "Feishu";
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 小时

function buildSessionKey(chatType: "p2p" | "group", userId: string, chatId: string): string {
  const id = chatType === "p2p" ? userId : chatId;
  return `${SESSION_KEY_PREFIX}-${chatType}-${id}`;
}

function buildTitlePrefix(sessionKey: string): string {
  return `${TITLE_PREFIX}-${sessionKey}-`;
}

export interface SessionManagerOptions {
  client: OpenCodeClient;
  directory?: string;
}

interface CacheEntry {
  sessionId: string;
  lastActivity: number;
}

/**
 * 会话管理器：按会话键缓存 OpenCode 会话 ID，支持自动创建/按标题恢复
 */
export class SessionManager {
  private cache = new Map<string, CacheEntry>();
  private directory?: string;

  constructor(private client: OpenCodeClient, options: SessionManagerOptions) {
    this.directory = options.directory;
  }

  /** 获取当前会话键对应的 OpenCode 会话（不存在则创建或恢复） */
  async getOrCreate(
    chatType: "p2p" | "group",
    feishuUserId: string,
    feishuChatId: string
  ): Promise<Session> {
    const sessionKey = buildSessionKey(chatType, feishuUserId, feishuChatId);
    const now = Date.now();

    // 1. 缓存命中且有效
    const cached = this.cache.get(sessionKey);
    if (cached) {
      try {
        const session = await this.client.getSession(cached.sessionId);
        if (session?.id) {
          this.cache.set(sessionKey, { sessionId: session.id, lastActivity: now });
          return session;
        }
      } catch {
        // 会话可能已被删除
      }
      this.cache.delete(sessionKey);
    }

    // 2. 按标题前缀查找已有会话（取最新）
    const titlePrefix = buildTitlePrefix(sessionKey);
    const sessions = await this.client.listSessions();
    const candidates = sessions.filter(
      (s) => s.title && s.title.startsWith(titlePrefix)
    );
    if (candidates.length > 0) {
      candidates.sort((a, b) => {
        const tsA = parseInt(a.title?.split("-").pop() ?? "0", 10);
        const tsB = parseInt(b.title?.split("-").pop() ?? "0", 10);
        if (tsA && tsB) return tsB - tsA;
        const ca = a.createdAt ? new Date(a.createdAt).getTime() : 0;
        const cb = b.createdAt ? new Date(b.createdAt).getTime() : 0;
        return cb - ca;
      });
      const best = candidates[0];
      if (best?.id) {
        this.cache.set(sessionKey, { sessionId: best.id, lastActivity: now });
        return best;
      }
    }

    // 3. 新建会话
    const title = `${titlePrefix}${Date.now()}`;
    const session = await this.client.createSession(title, this.directory);
    this.cache.set(sessionKey, { sessionId: session.id, lastActivity: now });
    return session;
  }

  /** 切换到指定会话 ID（需存在） */
  async switchSession(
    chatType: "p2p" | "group",
    feishuUserId: string,
    feishuChatId: string,
    sessionId: string
  ): Promise<Session> {
    const session = await this.client.getSession(sessionId);
    if (!session?.id) throw new Error(`会话不存在: ${sessionId}`);
    const sessionKey = buildSessionKey(chatType, feishuUserId, feishuChatId);
    this.cache.set(sessionKey, { sessionId: session.id, lastActivity: Date.now() });
    return session;
  }

  /** 删除指定 OpenCode 会话并从缓存移除 */
  async deleteSession(sessionId: string): Promise<void> {
    await this.client.deleteSession(sessionId);
    for (const [key, entry] of this.cache) {
      if (entry.sessionId === sessionId) {
        this.cache.delete(key);
        break;
      }
    }
  }

  /** 获取当前会话 ID（仅从缓存，不创建） */
  getCurrentSessionId(
    chatType: "p2p" | "group",
    feishuUserId: string,
    feishuChatId: string
  ): string | undefined {
    const sessionKey = buildSessionKey(chatType, feishuUserId, feishuChatId);
    return this.cache.get(sessionKey)?.sessionId;
  }

  /** 列出 OpenCode 所有会话（直接转发） */
  async listSessions(): Promise<Session[]> {
    return this.client.listSessions();
  }

  /** 清理过期缓存条目 */
  cleanupExpired(): void {
    const now = Date.now();
    for (const [key, entry] of this.cache) {
      if (now - entry.lastActivity > CACHE_TTL_MS) this.cache.delete(key);
    }
  }
}

export function createSessionManager(options: SessionManagerOptions): SessionManager {
  return new SessionManager(options.client, options);
}
