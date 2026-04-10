/**
 * StreamingCard：单次 AI 回复对应的一张流式卡片。
 *
 * 它负责管理卡片从创建到关闭的整个生命周期，并保证多次更新串行落盘：
 * - 文本增量更新
 * - 工具状态更新
 * - 最终收尾关闭
 * - 中断时删除消息
 */
import type { CardKitClient, CardKitSchema } from "./cardkit.js"
import type { LogFn } from "../types.js"
import { cleanMarkdown, truncateMarkdown } from "./markdown.js"
import * as sender from "./sender.js"
import type * as Lark from "@larksuiteoapi/node-sdk"

/** 单个工具调用在卡片上的展示状态。 */
interface ToolState {
  tool: string
  state: "running" | "completed" | "error"
}

/** 卡片底部可选附带的调试/上下文信息。 */
export interface StreamingCardMeta {
  sessionId?: string
  directory?: string
  model?: string
}

export class StreamingCard {
  /** CardKit 卡片实体 ID。 */
  private cardId?: string
  /** 飞书聊天里的消息 ID。 */
  private messageId?: string
  /** CardKit sequence，每次修改都必须单调递增。 */
  private seq = 0
  /** 串行更新队列，保证多次异步更新按顺序执行。 */
  private queue: Promise<void> = Promise.resolve()
  /** 当前完整文本缓冲。 */
  private textBuffer = ""
  /** callID → 工具状态。 */
  private toolStates = new Map<string, ToolState>()
  /** 卡片是否已关闭/销毁。 */
  private closed = false
  /** tools 元素是否已经动态插入过。 */
  private toolsElementAdded = false

  constructor(
    private readonly cardkit: CardKitClient,
    private readonly feishuClient: InstanceType<typeof Lark.Client>,
    private readonly chatId: string,
    private readonly log: LogFn,
    private readonly meta?: StreamingCardMeta,
  ) {}

  /**
   * 创建卡片实体并发到飞书聊天，返回对应的消息 ID。
   */
  async start(): Promise<string> {
    // 底部元信息仅用于辅助定位上下文，不影响主要展示内容。
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

    const res = await sender.sendCardMessage(this.feishuClient, this.chatId, this.cardId, this.log)
    if (!res.ok || !res.messageId) {
      throw new Error(`发送卡片消息失败: ${res.error ?? "unknown"}`)
    }

    this.messageId = res.messageId
    return this.messageId
  }

  /**
   * 追加一段文本增量到 `content` 区块。
   */
  async updateText(delta: string): Promise<void> {
    if (this.closed || !this.cardId) return
    // 先更新本地 buffer，再把真正的飞书更新操作排进串行队列。
    this.textBuffer += delta
    this.enqueue(() => this.doUpdateContent())
  }

  /**
   * 用完整文本替换当前缓冲区。
   *
   * 用于 snapshot-style 事件，而不是 delta 流。
   */
  async replaceText(fullText: string): Promise<void> {
    if (this.closed || !this.cardId) return
    this.textBuffer = fullText
    this.enqueue(() => this.doUpdateContent())
  }

  /**
   * 更新某个工具调用在卡片中的显示状态。
   */
  async setToolStatus(callID: string, tool: string, state: "running" | "completed" | "error"): Promise<void> {
    if (this.closed || !this.cardId) return
    this.toolStates.set(callID, { tool, state })
    this.enqueue(() => this.doUpdateTools())
  }

  /**
   * 关闭流式模式，并把最终文本写入卡片。
   */
  async close(finalMarkdown?: string): Promise<void> {
    if (this.closed) return
    this.closed = true
    if (!this.cardId) return

    if (finalMarkdown) {
      this.textBuffer = finalMarkdown
    }

    // 最终文本统一做 markdown 清理与截断，避免卡片渲染异常或超限。
    this.textBuffer = truncateMarkdown(cleanMarkdown(this.textBuffer))

    // 先等之前的更新队列跑完，再写最终内容，避免顺序错乱。
    await this.drain()
    await this.doUpdateContent()
    await this.cardkit.closeStreaming(this.cardId, ++this.seq)
  }

  /**
   * 删除整条飞书消息。
   *
   * 主要用于 abort 或早期失败场景，避免用户看到半成品卡片。
   */
  async destroy(): Promise<void> {
    this.closed = true
    if (this.messageId) {
      await sender.deleteMessage(this.feishuClient, this.messageId, this.log)
    }
  }

  /**
   * 把一次异步卡片更新串到内部队列尾部。
   *
   * 这样即使多个 SSE 事件并发到来，也能确保 sequence 严格递增、更新顺序稳定。
   */
  private enqueue(fn: () => Promise<void>): void {
    this.queue = this.queue.then(fn).catch((err) => {
      this.log("error", "StreamingCard queue 操作失败", {
        error: err instanceof Error ? err.message : String(err),
      })
    })
  }

  /** 等待当前所有排队更新执行完毕。 */
  private async drain(): Promise<void> {
    await this.queue
  }

  /** 把当前文本缓冲写回 content 元素。 */
  private async doUpdateContent(): Promise<void> {
    if (!this.cardId) return
    await this.cardkit.updateElement(
      this.cardId,
      "content",
      this.textBuffer || "正在思考...",
      ++this.seq,
    )
  }

  /**
   * 把工具状态区块写回卡片。
   *
   * 首次写入时动态 append 一个 `tools` element；
   * 之后都走 updateElement 增量更新。
   */
  private async doUpdateTools(): Promise<void> {
    if (!this.cardId) return
    const lines: string[] = []
    for (const [, ts] of this.toolStates) {
      // 用图标直接表达状态，用户不需要理解内部枚举值。
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
