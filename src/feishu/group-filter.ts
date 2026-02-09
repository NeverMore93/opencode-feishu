/**
 * 群聊智能过滤：仅在@提及、问句或明确请求时回复，避免刷屏
 */
const DEFAULT_BOT_NAMES = ["opencode", "bot", "助手", "智能体"];

/**
 * 判断是否应在群聊中回复该条消息
 * @param text 消息正文（已去除 @ 占位符）
 * @param mentions 飞书事件中的 @ 提及列表
 * @param botNames 用于称呼检测的机器人名称列表
 */
export function shouldRespondInGroup(
  text: string,
  mentions: unknown[],
  botNames?: string[]
): boolean {
  if (mentions.length > 0) return true;

  const t = text.toLowerCase();

  if (/[？?]$/.test(text)) return true;
  if (/\b(why|how|what|when|where|who|help)\b/.test(t)) return true;

  const verbs = [
    "帮", "麻烦", "请", "能否", "可以", "解释", "看看",
    "排查", "分析", "总结", "写", "改", "修", "查", "对比", "翻译",
  ];
  if (verbs.some((k) => text.includes(k))) return true;

  const names = botNames?.length ? botNames : DEFAULT_BOT_NAMES;
  const namePattern = new RegExp(
    `^(${names.map(escapeRegex).join("|")})[\\s,:，：]`,
    "i"
  );
  if (namePattern.test(text)) return true;

  return false;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
