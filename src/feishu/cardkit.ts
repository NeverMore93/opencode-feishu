/**
 * CardKit 2.0 thin wrapper：委托 Lark SDK client.cardkit.v1.* 方法
 * 保留 3-method 接口，解耦 StreamingCard 与 SDK 细节
 */
import type * as Lark from "@larksuiteoapi/node-sdk"
import type { LogFn } from "../types.js"

export interface CardKitSchema {
  type: "card_kit"
  data: {
    schema: "2.0"
    config?: Record<string, unknown>
    header?: Record<string, unknown>
    body: {
      elements: Array<Record<string, unknown>>
    }
  }
}

export class CardKitClient {
  constructor(
    private readonly larkClient: InstanceType<typeof Lark.Client>,
    private readonly log?: LogFn,
  ) {}

  /**
   * 创建 CardKit 2.0 卡片 → cardId
   */
  async createCard(schema: CardKitSchema): Promise<string> {
    const res = await this.larkClient.cardkit.v1.card.create({
      data: {
        type: "card_kit",
        data: JSON.stringify(schema.data),
      },
    })

    const cardId = res?.data?.card_id
    if (!cardId) {
      throw new Error(`CardKit createCard 失败: ${res?.msg ?? "unknown"} (code: ${res?.code})`)
    }

    return cardId
  }

  /**
   * 更新卡片中指定元素的内容（best-effort，失败只 log）
   */
  async updateElement(
    cardId: string,
    elementId: string,
    content: string,
    sequence: number,
  ): Promise<void> {
    try {
      const res = await this.larkClient.cardkit.v1.cardElement.content({
        data: {
          content: JSON.stringify({ tag: "markdown", content }),
          sequence,
        },
        path: {
          card_id: cardId,
          element_id: elementId,
        },
      })

      if (res?.code !== 0) {
        this.log?.("warn", "CardKit updateElement 失败", {
          cardId,
          elementId,
          code: res?.code,
          msg: res?.msg,
        })
      }
    } catch (err) {
      this.log?.("warn", "CardKit updateElement 异常", {
        cardId,
        elementId,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  /**
   * 关闭卡片流式模式
   */
  async closeStreaming(cardId: string, sequence: number): Promise<void> {
    try {
      await this.larkClient.cardkit.v1.card.settings({
        data: {
          settings: JSON.stringify({ config: { streaming_mode: false } }),
          sequence,
        },
        path: {
          card_id: cardId,
        },
      })
    } catch (err) {
      this.log?.("warn", "CardKit closeStreaming 异常", {
        cardId,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }
}
