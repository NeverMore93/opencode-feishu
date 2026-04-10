/**
 * 群聊过滤模块 — 检测 bot 是否被直接 @提及
 *
 * 群聊中 bot 默认静默监听（转发所有消息作为上下文），
 * 仅在被直接 @提及时才生成 AI 回复。
 * 本模块提供 @提及检测逻辑，由 gateway.ts 在收到群消息时调用。
 */

/**
 * 检查 bot 是否被直接 @提及
 *
 * 飞书消息事件中，@提及信息存储在 mentions 数组中，
 * 每个 mention 对象包含被 @ 用户的 open_id。
 * 本函数遍历该数组，与 bot 自身的 open_id 比较。
 *
 * @param mentions 飞书消息事件中的 @ 提及列表，每项包含 id.open_id 字段
 * @param botOpenId bot 自身的 open_id（插件启动时通过 fetchBotOpenId 获取）
 * @returns 当 bot 被 @提及时返回 true，否则返回 false
 */
export function isBotMentioned(
  mentions: Array<{ id?: { open_id?: string }; [key: string]: unknown }>,
  botOpenId: string
): boolean {
  // 遍历 mentions 数组，匹配任一提及的 open_id 等于 bot 的 open_id
  return mentions.some((m) => m.id?.open_id === botOpenId);
}
