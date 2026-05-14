/**
 * pending-forms：阻塞型 feishu_request_form tool 的全局注册表。
 *
 * 三路 race（用户提交 / abort signal / timeout）的核心数据结构：
 * - registerPendingForm(): tool execute 发送卡片后注册 resolver
 * - resolvePendingForm(): gateway form_submit 分支命中时触发 resolver
 * - unregisterPendingForm(): timeout/abort 清理
 *
 * TTL 由 TtlMap 自动管理，MAX_FORM_TIMEOUT_SECONDS 是上限兜底。
 */
import { TtlMap } from "../utils/ttl-map.js"
import type { FormFieldValue } from "./interactive.js"
import type { LogFn } from "../types.js"

export const MAX_FORM_TIMEOUT_SECONDS = 1800
export const DEFAULT_FORM_TIMEOUT_SECONDS = 600

export interface FormSubmitResult {
  formValue: Record<string, FormFieldValue>
  operatorId: string
  timezone?: string
  callbackChatId: string
}

export interface PendingForm {
  readonly formName: string
  readonly sessionId: string
  readonly chatId: string
  readonly createdAt: number
  readonly resolver: (value: FormSubmitResult) => void
}

const pendingForms = new TtlMap<PendingForm>(MAX_FORM_TIMEOUT_SECONDS * 1_000)

export function registerPendingForm(entry: PendingForm): void {
  pendingForms.set(entry.formName, entry)
}

export function unregisterPendingForm(formName: string): void {
  pendingForms.delete(formName)
}

/**
 * 尝试 resolve 一个 pending form。
 *
 * 未命中（formName 不在注册表中）→ 返回 false，gateway fallback 到 P1 syntheticCtx 路径。
 * 命中后先做 chatId 比对（EC-024 跨群拒收），通过则触发 resolver 并返回 true。
 */
export function resolvePendingForm(
  formName: string,
  result: FormSubmitResult,
  log: LogFn,
): boolean {
  const pending = pendingForms.get(formName)
  if (!pending) return false

  if (pending.chatId !== result.callbackChatId) {
    log("warn", "feishu_request_form chatId 不一致拒收", {
      formName,
      registeredChatId: pending.chatId,
      callbackChatId: result.callbackChatId,
    })
    return false
  }

  pendingForms.delete(formName)
  try {
    pending.resolver(result)
  } catch (err) {
    log("error", "feishu_request_form resolver 抛错，fallback 到 P1 路径", {
      formName,
      error: err instanceof Error ? err.message : String(err),
    })
    return false
  }
  return true
}
