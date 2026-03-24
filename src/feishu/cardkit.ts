/**
 * CardKit 2.0 thin wrapper：委托 Lark SDK client.cardkit.v1.* 方法
 * 保留 3-method 接口，解耦 StreamingCard 与 SDK 细节
 */
import type * as Lark from "@larksuiteoapi/node-sdk"
import type { LogFn } from "../types.js"

export interface CardKitSchema {
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
    let res
    try {
      res = await this.larkClient.cardkit.v1.card.create({
        data: {
          type: "card_json",
          data: JSON.stringify(schema.data),
        },
      })
    } catch (err: unknown) {
      let detail = "no response body"
      if (err && typeof err === "object" && "response" in err) {
        const axiosData = (err as { response?: { data?: unknown } }).response
          ?.data
        if (axiosData) {
          try {
            detail = JSON.stringify(axiosData)
          } catch {
            detail = String(axiosData)
          }
        }
      }
      throw new Error(
        `CardKit createCard HTTP 错误: ${err instanceof Error ? err.message : String(err)} | detail: ${detail}`,
      )
    }

    const cardId = res?.data?.card_id
    if (!cardId) {
      throw new Error(
        `CardKit createCard 失败: ${res?.msg ?? "unknown"} (code: ${res?.code})`,
      )
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
   * 在卡片末尾追加新组件（用于流式卡片动态添加元素）
   */
  async addElement(
    cardId: string,
    elements: Array<Record<string, unknown>>,
    sequence: number,
  ): Promise<void> {
    const res = await this.larkClient.cardkit.v1.cardElement.create({
      data: {
        type: "append",
        elements: JSON.stringify(elements),
        sequence,
      },
      path: {
        card_id: cardId,
      },
    })

    if (res?.code !== 0) {
      this.log?.("warn", "CardKit addElement 失败", {
        cardId,
        code: res?.code,
        msg: res?.msg,
      })
      throw new Error(`CardKit addElement 失败: ${res?.msg ?? "unknown"} (code: ${res?.code})`)
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
