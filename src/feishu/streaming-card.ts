/**
 * StreamingCard：单次 AI 回复对应的一张结构化结果卡。
 *
 * 这张卡不再把主回复当成单一正文流，而是稳定地分成：
 * - 主题
 * - 紧凑状态
 * - 当前结论
 * - 详细步骤（默认折叠）
 * - 底部动作区（处理中可见）
 */
import type { CardKitClient } from "./cardkit.js"
import type { LogFn } from "../types.js"
import * as sender from "./sender.js"
import type * as Lark from "@larksuiteoapi/node-sdk"
import {
  ACTIONS_ELEMENT_ID,
  buildActionsElement,
  buildCompactStatus,
  buildConclusionMarkdown,
  buildDetailsElement,
  buildDetailsMarkdown,
  buildReplyCardSchema,
  buildStatusMarkdown,
  buildTitleMarkdown,
  createReplyCardView,
  type DetailPhaseSnapshot,
  type ReplyCardAction,
} from "./result-card-view.js"
import type { ReplyRunState, ReplyTerminalState } from "../handler/reply-run-registry.js"

/** 单个工具调用在卡片上的展示状态。 */
interface ToolState {
  tool: string
  state: "running" | "completed" | "error"
}

/** 卡片启动时需要的元信息。 */
export interface StreamingCardMeta {
  runId: string
  sessionId: string
  title?: string
  directory?: string
  /** 只展示最终确认过的实际模型；当前不默认暴露。 */
  model?: string
  state?: ReplyRunState
  abortAction?: ReplyCardAction
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
  /** 卡片是否已关闭/销毁。 */
  private closed = false
  /** 当前稳定结论。 */
  private conclusion = ""
  /** 当前运行状态。 */
  private runState: ReplyRunState
  /** 终态标记。 */
  private terminalState?: ReplyTerminalState
  /** callID → 工具状态。 */
  private toolStates = new Map<string, ToolState>()
  /** phaseId → 详细步骤快照。 */
  private detailPhases = new Map<string, DetailPhaseSnapshot>()
  /** actions 元素是否已经存在。 */
  private actionsElementPresent = false
  /** details 元素是否已经存在。 */
  private detailsElementPresent = false
  /** 避免重复写相同内容。 */
  private readonly rendered = {
    title: "",
    status: "",
    conclusion: "",
    details: "",
    actionsSignature: "",
  }
  /** CardKit 中途更新失败后进入 degraded，后续只保留本地快照用于文本回退。 */
  private degraded = false
  private degradedError?: Error
  /** 结论区 debounce 定时器 ID（0 = 无挂起）。 */
  private conclusionTimer: ReturnType<typeof setTimeout> | null = null

  constructor(
    private readonly cardkit: CardKitClient,
    private readonly feishuClient: InstanceType<typeof Lark.Client>,
    private readonly chatId: string,
    private readonly log: LogFn,
    private readonly meta: StreamingCardMeta,
  ) {
    this.runState = meta.state ?? "starting"
  }

  /**
   * 创建卡片实体并发到飞书聊天，返回对应的消息 ID。
   */
  async start(): Promise<string> {
    const schema = buildReplyCardSchema(this.buildView())
    this.cardId = await this.cardkit.createCard(schema)

    const res = await sender.sendCardMessage(this.feishuClient, this.chatId, this.cardId, this.log)
    if (!res.ok || !res.messageId) {
      throw new Error(`发送卡片消息失败: ${res.error ?? "unknown"}`)
    }

    this.actionsElementPresent = !!buildActionsElement(this.buildView().actions)
    this.detailsElementPresent = !!buildDetailsElement(this.buildView().detailsMarkdown)
    this.messageId = res.messageId
    return this.messageId
  }

  /**
   * 兼容旧接口：把 delta 直接追加到结论区。
   *
   * 结构化结果卡的推荐路径是使用 `replaceText()` 做稳定快照刷新。
   */
  async updateText(delta: string): Promise<void> {
    if (this.closed || !this.cardId || this.terminalState) return
    this.conclusion += delta
    if (this.degraded) return
    this.scheduleConclusionRender()
  }

  /**
   * 用完整文本替换当前结论快照。
   */
  async replaceText(fullText: string): Promise<void> {
    if (this.closed || !this.cardId || this.terminalState) return
    this.conclusion = fullText
    if (this.degraded) return
    this.scheduleConclusionRender()
  }

  async setTitle(title: string): Promise<void> {
    if (this.closed || !this.cardId || this.terminalState) return
    this.meta.title = title
    if (this.degraded) return
    this.enqueue(() => this.renderTitle())
  }

  async setRunState(state: ReplyRunState, terminalState?: ReplyTerminalState): Promise<void> {
    if (this.closed || !this.cardId) return
    if (this.terminalState) return
    this.runState = state
    if (terminalState) {
      this.terminalState = terminalState
    }
    if (this.degraded) return
    this.enqueue(() => this.renderStatusAndActions())
  }

  async setDetailPhase(phase: DetailPhaseSnapshot): Promise<void> {
    if (this.closed || !this.cardId || this.terminalState) return
    this.detailPhases.set(phase.phaseId, phase)
    if (this.degraded) return
    this.enqueue(() => this.renderDetails())
  }

  async clearDetailPhase(phaseId: string): Promise<void> {
    if (this.closed || !this.cardId || this.terminalState) return
    if (!this.detailPhases.delete(phaseId)) return
    if (this.degraded) return
    this.enqueue(() => this.renderDetails())
  }

  async setReasoningSnapshot(reasoning: string): Promise<void> {
    if (this.closed || !this.cardId || this.terminalState) return
    const normalized = reasoning.trim()
    if (!normalized) {
      await this.clearDetailPhase("reasoning")
      return
    }

    await this.setDetailPhase({
      phaseId: "reasoning",
      label: "中间思路",
      status: this.terminalState ? "completed" : "running",
      body: normalized,
      updatedAt: new Date().toISOString(),
    })
  }

  /**
   * 更新某个工具调用在卡片中的显示状态。
   */
  async setToolStatus(callID: string, tool: string, state: "running" | "completed" | "error"): Promise<void> {
    if (this.closed || !this.cardId || this.terminalState) return
    this.toolStates.set(callID, { tool, state })
    if (this.degraded) return
    this.enqueue(() => this.renderToolDetails())
  }

  /**
   * 关闭流式模式，并把最终结论写回卡片。
   */
  async close(finalConclusion?: string): Promise<void> {
    if (this.closed) return
    if (!this.cardId) {
      this.closed = true
      return
    }

    if (finalConclusion) {
      this.conclusion = finalConclusion
    }

    // flush 挂起的 debounce 定时器，确保最新结论进入队列
    this.flushConclusionTimer()
    await this.drain()
    if (this.degraded) {
      this.closed = true
      throw this.degradedError ?? new Error("StreamingCard 已降级")
    }

    try {
      await this.renderAll()
    } catch (err) {
      this.markDegraded(err)
      this.closed = true
      throw this.degradedError ?? new Error("StreamingCard 收尾失败")
    }

    // renderAll 成功后内容已完整写入卡片；closeStreaming 失败只影响流式指示器，
    // 不应删除已渲染的结构化内容。降级为日志记录，保留卡片。
    try {
      await this.cardkit.closeStreaming(this.cardId, ++this.seq)
    } catch (err) {
      this.log("error", "closeStreaming 失败（内容已完整渲染）", {
        cardId: this.cardId,
        error: err instanceof Error ? err.message : String(err),
      })
    }
    this.closed = true
  }

  /**
   * 记录最终确认过的实际模型。
   *
   * 当前不默认渲染到结果卡，但保留该接口，避免主链路调用需要大改。
   */
  setResolvedModel(model: string | undefined): void {
    this.meta.model = model
  }

  /**
   * 删除整条飞书消息。
   *
   * 主要用于早期失败场景，避免用户看到半成品卡片。
   */
  async destroy(): Promise<void> {
    this.closed = true
    if (this.conclusionTimer) {
      clearTimeout(this.conclusionTimer)
      this.conclusionTimer = null
    }
    if (this.messageId) {
      await sender.deleteMessage(this.feishuClient, this.messageId, this.log)
    }
  }

  /**
   * Debounce 结论区渲染：200ms 内无新 delta 才真正触发。
   *
   * 流式场景下每秒 30-100 次 delta，直接 enqueue 每次都会发起
   * CardKit HTTP 请求，是导致 degraded 的主要根因。
   * 200ms 窗口可将 CardKit 调用频率降至 ~5次/秒，与 Vercel AI SDK
   * 的 experimental_throttle(50ms) 思路一致，但更宽松以适配服务端 API。
   */
  private scheduleConclusionRender(): void {
    if (this.conclusionTimer) {
      clearTimeout(this.conclusionTimer)
    }
    this.conclusionTimer = setTimeout(() => {
      this.conclusionTimer = null
      this.enqueue(() => this.renderConclusion())
    }, 200)
  }

  /**
   * 立即 flush 挂起的 debounce 定时器（close/drain 前调用）。
   */
  private flushConclusionTimer(): void {
    if (this.conclusionTimer) {
      clearTimeout(this.conclusionTimer)
      this.conclusionTimer = null
      this.enqueue(() => this.renderConclusion())
    }
  }

  /**
   * 把一次异步卡片更新串到内部队列尾部。
   */
  private enqueue(fn: () => Promise<void>): void {
    this.queue = this.queue.then(fn).catch((err) => {
      this.markDegraded(err)
      this.log("error", "StreamingCard queue 操作失败", {
        error: err instanceof Error ? err.message : String(err),
      })
    })
  }

  private markDegraded(err: unknown): void {
    const error = err instanceof Error ? err : new Error(String(err))
    if (this.degraded) return
    this.degraded = true
    this.degradedError = error
  }

  private async drain(): Promise<void> {
    await this.queue
  }

  private async renderAll(): Promise<void> {
    await this.renderTitle()
    await this.renderStatusAndActions()
    await this.renderConclusion()
    await this.renderDetails()
  }

  private async renderTitle(): Promise<void> {
    if (!this.cardId) return
    const content = buildTitleMarkdown(this.meta.title ?? "AI 回复")
    if (this.rendered.title === content) return
    this.rendered.title = content
    await this.cardkit.updateElement(this.cardId, "reply_title", content, ++this.seq)
  }

  private async renderStatusAndActions(): Promise<void> {
    if (!this.cardId) return

    const status = buildStatusMarkdown(buildCompactStatus(this.runState))
    if (this.rendered.status !== status) {
      this.rendered.status = status
      await this.cardkit.updateElement(this.cardId, "reply_status", status, ++this.seq)
    }

    await this.renderActions()
  }

  private async renderConclusion(): Promise<void> {
    if (!this.cardId) return
    const content = buildConclusionMarkdown(this.conclusion)
    if (this.rendered.conclusion === content) return
    this.rendered.conclusion = content
    await this.cardkit.updateElement(this.cardId, "reply_conclusion", content, ++this.seq)
  }

  private async renderToolDetails(): Promise<void> {
    if (!this.cardId) return
    const toolSummary: string[] = []
    let hasRunning = false
    let hasError = false

    for (const [, toolState] of this.toolStates) {
      const icon = toolState.state === "completed" ? "✅" : toolState.state === "error" ? "❌" : "🔄"
      toolSummary.push(`${icon} ${toolState.tool}`)
      if (toolState.state === "running") hasRunning = true
      if (toolState.state === "error") hasError = true
    }

    if (toolSummary.length === 0) {
      await this.clearDetailPhase("tools")
      return
    }

    await this.setDetailPhase({
      phaseId: "tools",
      label: "工具进度",
      status: hasError ? "error" : hasRunning ? "running" : "completed",
      body: "",
      toolSummary,
      updatedAt: new Date().toISOString(),
    })
  }

  private async renderDetails(): Promise<void> {
    if (!this.cardId) return
    // 终态后把 running phase 映射为 completed，避免加载图标（🔄）残留在已收束的卡片上。
    const phases: Iterable<DetailPhaseSnapshot> = this.terminalState
      ? Array.from(this.detailPhases.values()).map((p) =>
          p.status === "running" ? { ...p, status: "completed" as const } : p,
        )
      : this.detailPhases.values()
    const markdown = buildDetailsMarkdown(phases) ?? ""
    if (!markdown) {
      if (!this.detailsElementPresent) return
      this.detailsElementPresent = false
      this.rendered.details = ""
      await this.cardkit.deleteElement(this.cardId, "reply_details", ++this.seq)
      return
    }

    if (this.rendered.details === markdown) return

    const element = buildDetailsElement(markdown)
    if (!element) return

    this.rendered.details = markdown
    if (!this.detailsElementPresent) {
      await this.cardkit.addElement(
        this.cardId,
        [element],
        ++this.seq,
        this.actionsElementPresent
          ? { position: "insert_before", targetElementId: ACTIONS_ELEMENT_ID }
          : undefined,
      )
      this.detailsElementPresent = true
      return
    }

    await this.cardkit.replaceElement(this.cardId, "reply_details", element, ++this.seq)
  }

  private async renderActions(): Promise<void> {
    if (!this.cardId) return

    const actions = this.terminalState ? [] : this.buildView().actions
    const signature = JSON.stringify(actions.map((action) => ({
      kind: action.kind,
      text: action.text,
      style: action.style,
      disabled: action.disabled ?? false,
      value: action.value,
    })))

    if (actions.length === 0) {
      if (!this.actionsElementPresent) return
      this.actionsElementPresent = false
      this.rendered.actionsSignature = ""
      await this.cardkit.deleteElement(this.cardId, ACTIONS_ELEMENT_ID, ++this.seq)
      return
    }

    if (this.rendered.actionsSignature === signature) return

    const element = buildActionsElement(actions)
    if (!element) return

    this.rendered.actionsSignature = signature
    if (!this.actionsElementPresent) {
      await this.cardkit.addElement(this.cardId, [element], ++this.seq)
      this.actionsElementPresent = true
      return
    }

    await this.cardkit.replaceElement(this.cardId, ACTIONS_ELEMENT_ID, element, ++this.seq)
  }

  private buildView() {
    const detailsMarkdown = buildDetailsMarkdown(this.detailPhases.values())
    return createReplyCardView({
      runId: this.meta.runId,
      title: this.meta.title ?? "AI 回复",
      state: this.runState,
      conclusion: this.conclusion,
      detailsMarkdown,
      actions: this.meta.abortAction ? [this.meta.abortAction] : [],
      terminalState: this.terminalState,
      fallbackMode: "structured",
    })
  }
}
