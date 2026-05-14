/**
 * CardKit SDK 薄封装。
 *
 * 目的不是重新抽象一套卡片系统，而是把：
 * - SDK 调用路径
 * - JSON 序列化细节
 * - 错误整理
 * 集中到一个地方，供 `StreamingCard` 按“创建 / 更新 / 追加 / 关闭”这组语义使用。
 */
import type * as Lark from "@larksuiteoapi/node-sdk"
import type { LogFn } from "../types.js"

/** 本仓库构造 CardKit 卡片时关心的最小 schema。 */
export interface CardKitSchema {
  data: {
    /** 固定使用 Card 2.0。 */
    schema: "2.0"
    /** 可选配置，例如 streaming_mode。 */
    config?: Record<string, unknown>
    /** 可选卡头。 */
    header?: Record<string, unknown>
    body: {
      /** 卡片正文元素数组。 */
      elements: Array<Record<string, unknown>>
    }
  }
}

export class CardKitClient {
  constructor(
    /** 共享飞书 SDK client；内部已经处理 token 管理。 */
    private readonly larkClient: InstanceType<typeof Lark.Client>,
    /** 可选日志函数；本层以 best-effort 方式记录失败。 */
    private readonly log?: LogFn,
  ) {}

  /**
   * 创建 CardKit 卡片实体并返回 `card_id`。
   *
   * 这一步只是创建“卡片资源”，真正把卡片发到聊天里还要再调用 sender。
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
      // 尽量提取底层 HTTP response body，方便定位飞书接口报错原因。
      let detail = "no response body"
      if (err && typeof err === "object" && "response" in err) {
        const axiosData = (err as { response?: { data?: unknown } }).response
          ?.data
        if (axiosData) {
          try {
            detail = JSON.stringify(axiosData)
          } catch (detailErr) {
            this.log?.("error", "序列化 CardKit 错误响应体失败", {
              error: detailErr instanceof Error ? detailErr.message : String(detailErr),
            })
            detail = String(axiosData)
          }
        }
      }
      this.log?.("error", "CardKit createCard 异常", {
        error: err instanceof Error ? err.message : String(err),
        detail,
      })
      throw new Error(
        `CardKit createCard HTTP 错误: ${err instanceof Error ? err.message : String(err)} | detail: ${detail}`,
      )
    }

    const cardId = res?.data?.card_id
    if (!cardId) {
      this.log?.("error", "CardKit createCard 返回缺少 card_id", {
        code: res?.code,
        msg: res?.msg,
      })
      throw new Error(
        `CardKit createCard 失败: ${res?.msg ?? "unknown"} (code: ${res?.code})`,
      )
    }

    return cardId
  }

  /**
   * 更新指定 element 的 `content` 字段。
   *
   * 这是流式文本更新最常走的接口。
   * 失败会抛错，由上层决定是继续结构化卡还是降级为文本回退。
   */
  async updateElement(
    cardId: string,
    elementId: string,
    content: string,
    sequence: number,
  ): Promise<void> {
    const res = await this.larkClient.cardkit.v1.cardElement.content({
      data: {
        content,
        sequence,
      },
      path: {
        card_id: cardId,
        element_id: elementId,
      },
    })

    if (res?.code !== 0) {
      this.log?.("error", "CardKit updateElement 失败", {
        cardId,
        elementId,
        code: res?.code,
        msg: res?.msg,
      })
      throw new Error(`CardKit updateElement 失败: ${res?.msg ?? "unknown"} (code: ${res?.code})`)
    }
  }

  /**
   * 在卡片末尾追加新元素。
   *
   * 典型场景：首次出现工具状态时动态补一个 `tools` 区块。
   * 与 updateElement 不同，这里失败会抛错，因为调用方通常需要感知“新增元素失败”。
   */
  async addElement(
    cardId: string,
    elements: Array<Record<string, unknown>>,
    sequence: number,
    options?: {
      position?: "append" | "insert_before" | "insert_after"
      targetElementId?: string
    },
  ): Promise<void> {
    const res = await this.larkClient.cardkit.v1.cardElement.create({
      data: {
        type: options?.position ?? "append",
        ...(options?.targetElementId ? { target_element_id: options.targetElementId } : {}),
        elements: JSON.stringify(elements),
        sequence,
      },
      path: {
        card_id: cardId,
      },
    })

    if (res?.code !== 0) {
      this.log?.("error", "CardKit addElement 失败", {
        cardId,
        code: res?.code,
        msg: res?.msg,
      })
      throw new Error(`CardKit addElement 失败: ${res?.msg ?? "unknown"} (code: ${res?.code})`)
    }
  }

  /**
   * 以新组件全量替换指定 element。
   *
   * 对于按钮区、折叠面板这类无法只改 content 的组件，统一走这里。
   */
  async replaceElement(
    cardId: string,
    elementId: string,
    element: Record<string, unknown>,
    sequence: number,
  ): Promise<void> {
    const res = await this.larkClient.cardkit.v1.cardElement.update({
      data: {
        element: JSON.stringify(element),
        sequence,
      },
      path: {
        card_id: cardId,
        element_id: elementId,
      },
    })

    if (res?.code !== 0) {
      this.log?.("error", "CardKit replaceElement 失败", {
        cardId,
        elementId,
        code: res?.code,
        msg: res?.msg,
      })
      throw new Error(`CardKit replaceElement 失败: ${res?.msg ?? "unknown"} (code: ${res?.code})`)
    }
  }

  /**
   * 以 partial_element 覆盖组件配置。
   *
   * 目前主要保留给后续对按钮 disabled/面板展开态的局部 patch。
   */
  async patchElement(
    cardId: string,
    elementId: string,
    partialElement: Record<string, unknown>,
    sequence: number,
  ): Promise<void> {
    const res = await this.larkClient.cardkit.v1.cardElement.patch({
      data: {
        partial_element: JSON.stringify(partialElement),
        sequence,
      },
      path: {
        card_id: cardId,
        element_id: elementId,
      },
    })

    if (res?.code !== 0) {
      this.log?.("error", "CardKit patchElement 失败", {
        cardId,
        elementId,
        code: res?.code,
        msg: res?.msg,
      })
      throw new Error(`CardKit patchElement 失败: ${res?.msg ?? "unknown"} (code: ${res?.code})`)
    }
  }

  /**
   * 删除指定组件。
   */
  async deleteElement(
    cardId: string,
    elementId: string,
    sequence: number,
  ): Promise<void> {
    const res = await this.larkClient.cardkit.v1.cardElement.delete({
      data: {
        sequence,
      },
      path: {
        card_id: cardId,
        element_id: elementId,
      },
    })

    if (res?.code !== 0) {
      this.log?.("error", "CardKit deleteElement 失败", {
        cardId,
        elementId,
        code: res?.code,
        msg: res?.msg,
      })
      throw new Error(`CardKit deleteElement 失败: ${res?.msg ?? "unknown"} (code: ${res?.code})`)
    }
  }

  /**
   * 关闭卡片的流式模式。
   *
   * 这是一个收尾动作；即使失败，用户通常也已经看到最终内容，所以只记 error 日志。
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
      this.log?.("error", "CardKit closeStreaming 异常", {
        cardId,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }
}
