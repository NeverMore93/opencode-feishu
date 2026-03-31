/**
 * StreamingCard: 流式卡片会话管理器
 * 管理单个 AI 回复的飞书流式卡片生命周期
 */
import type { CardKitClient, CardKitSchema } from "./cardkit.js"
import type { LogFn } from "../types.js"
import { cleanMarkdown, truncateMarkdown } from "./markdown.js"
import * as sender from "./sender.js"
import type * as Lark from "@larksuiteoapi/node-sdk"

interface ToolState {
  tool: string
  state: "running" | "completed" | "error"
  title?: string
}

export interface StreamingCardMeta {
  sessionId?: string
  directory?: string
  model?: string
}

export class StreamingCard {
  private cardId?: string
  private messageId?: string
  private seq = 0
  private queue: Promise<void> = Promise.resolve()
  private textBuffer = ""
  private toolStates = new Map<string, ToolState>()
  private closed = false
  private toolsElementAdded = false

  constructor(
    private readonly cardkit: CardKitClient,
    private readonly feishuClient: InstanceType<typeof Lark.Client>,
    private readonly chatId: string,
    private readonly log: LogFn,
    private readonly meta?: StreamingCardMeta,
  ) {}

  /**
   * 创建卡片 + 发送 interactive 消息 → messageId
   */
  async start(): Promise<string> {
    const footer = [this.meta?.sessionId, this.meta?.directory, this.meta?.model].filter(Boolean).join(" | ")

    const schema: CardKitSchema = {
      data: {
        schema: "2.0",
        config: { streaming_mode: true },
        header: {
          title: { tag: "plain_text", content: "AI 回复" },
          template: "blue",
        },
        body: {
          elements: [
            { tag: "markdown", element_id: "content", content: "正在思考..." },
            ...(footer ? [{ tag: "div", text: { tag: "plain_text", content: footer } }] : []),
          ],
        },
      },
    }

    this.cardId = await this.cardkit.createCard(schema)

    const res = await sender.sendCardMessage(this.feishuClient, this.chatId, this.cardId)
    if (!res.ok || !res.messageId) {
      throw new Error(`发送卡片消息失败: ${res.error ?? "unknown"}`)
    }

    this.messageId = res.messageId
    return this.messageId
  }

  /**
   * 追加文本到 content 元素
   */
  async updateText(delta: string): Promise<void> {
    if (this.closed || !this.cardId) return
    this.textBuffer += delta
    this.enqueue(() => this.doUpdateContent())
  }

  /**
   * 替换整个文本内容（用于 snapshot-style 事件）
   */
  async replaceText(fullText: string): Promise<void> {
    if (this.closed || !this.cardId) return
    this.textBuffer = fullText
    this.enqueue(() => this.doUpdateContent())
  }

  /**
   * 更新工具状态到 tools 元素
   */
  async setToolStatus(callID: string, tool: string, state: "running" | "completed" | "error"): Promise<void> {
    if (this.closed || !this.cardId) return
    this.toolStates.set(callID, { tool, state })
    this.enqueue(() => this.doUpdateTools())
  }

  /**
   * 关闭流式模式，写入最终内容
   */
  async close(finalMarkdown?: string): Promise<void> {
    if (this.closed) return
    this.closed = true
    if (!this.cardId) return

    if (finalMarkdown) {
      this.textBuffer = finalMarkdown
    }

    // 最终内容经过 markdown 清理和截断
    this.textBuffer = truncateMarkdown(cleanMarkdown(this.textBuffer))

    await this.drain()
    await this.doUpdateContent()
    await this.cardkit.closeStreaming(this.cardId, ++this.seq)
  }

  /**
   * 删除消息（abort 场景）
   */
  async destroy(): Promise<void> {
    this.closed = true
    if (this.messageId) {
      await sender.deleteMessage(this.feishuClient, this.messageId)
    }
  }

  get currentMessageId(): string | undefined {
    return this.messageId
  }

  private enqueue(fn: () => Promise<void>): void {
    this.queue = this.queue.then(fn).catch((err) => {
      this.log("warn", "StreamingCard queue 操作失败", {
        error: err instanceof Error ? err.message : String(err),
      })
    })
  }

  private async drain(): Promise<void> {
    await this.queue
  }

  private async doUpdateContent(): Promise<void> {
    if (!this.cardId) return
    await this.cardkit.updateElement(
      this.cardId,
      "content",
      this.textBuffer || "正在思考...",
      ++this.seq,
    )
  }

  private async doUpdateTools(): Promise<void> {
    if (!this.cardId) return
    const lines: string[] = []
    for (const [, ts] of this.toolStates) {
      const icon = ts.state === "completed" ? "✅" : ts.state === "error" ? "❌" : "🔄"
      lines.push(`${icon} ${ts.tool}`)
    }
    const content = lines.join("\n")

    if (!this.toolsElementAdded) {
      await this.cardkit.addElement(
        this.cardId,
        [{ tag: "markdown", element_id: "tools", content }],
        ++this.seq,
      )
      this.toolsElementAdded = true
    } else {
      await this.cardkit.updateElement(
        this.cardId,
        "tools",
        content,
        ++this.seq,
      )
    }
  }
}
