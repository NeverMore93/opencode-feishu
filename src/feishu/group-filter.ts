/**
 * 群聊过滤：仅在 bot 被直接 @提及时回复
 */

/**
 * 检查 bot 是否被直接 @提及
 * @param mentions 飞书事件中的 @ 提及列表
 * @param botOpenId bot 自身的 open_id（启动时获取）
 * @returns 当 bot 被 @提及时返回 true
 */
export function isBotMentioned(
  mentions: Array<{ id?: { open_id?: string }; [key: string]: unknown }>,
  botOpenId: string
): boolean {
  return mentions.some((m) => m.id?.open_id === botOpenId);
}
