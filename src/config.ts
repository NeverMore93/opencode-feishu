import fs from "fs";
import os from "os";
import path from "path";
import type { Config, LoadConfigResult, ConfigSource } from "./types.js";

const DEFAULT_TIMEOUT = 120_000;
const DEFAULT_THINKING_DELAY = 2500;
const DEFAULT_STREAM_INTERVAL = 1000;

function getConfigPaths(options: { directory?: string; configPath?: string }): string[] {
  if (options.configPath) {
    return [options.configPath];
  }
  const paths: string[] = [];
  const directory = options.directory ?? process.cwd();
  const xdgConfig = process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config");
  paths.push(path.join(xdgConfig, "opencode", "feishu-bot.json"));
  paths.push(path.join(directory, ".opencode", "feishu-bot.json"));
  return paths;
}

function readConfigFile(filePath: string): Partial<Record<string, unknown>> | null {
  if (!fs.existsSync(filePath)) {
    return null;
  }
  const raw = fs.readFileSync(filePath, "utf8").trim();
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Partial<Record<string, unknown>>;
  } catch {
    throw new Error(`Invalid JSON in ${filePath}`);
  }
}

function readEnvConfig(): Partial<Record<string, unknown>> {
  return {
    feishu: {
      appId: process.env.FEISHU_APP_ID,
      appSecret: process.env.FEISHU_APP_SECRET,
    },
    opencode: {
      timeout: process.env.OPENCODE_TIMEOUT
        ? parseInt(process.env.OPENCODE_TIMEOUT, 10)
        : undefined,
    },
    bot: {
      thinkingDelay: process.env.BOT_THINKING_DELAY
        ? parseInt(process.env.BOT_THINKING_DELAY, 10)
        : undefined,
      enableStreaming: process.env.BOT_ENABLE_STREAMING
        ? process.env.BOT_ENABLE_STREAMING === "true"
        : undefined,
      streamInterval: process.env.BOT_STREAM_INTERVAL
        ? parseInt(process.env.BOT_STREAM_INTERVAL, 10)
        : undefined,
    },
  };
}

function getNested(
  obj: Record<string, unknown>,
  key: string
): Record<string, unknown> | undefined {
  const value = obj[key];
  return value != null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function merge(
  base: Record<string, unknown>,
  override: Record<string, unknown>
): Record<string, unknown> {
  const result = { ...base };
  for (const k of Object.keys(override)) {
    const v = override[k];
    if (v == null) continue;
    const baseVal = result[k];
    if (
      baseVal != null &&
      typeof baseVal === "object" &&
      !Array.isArray(baseVal) &&
      typeof v === "object" &&
      !Array.isArray(v)
    ) {
      result[k] = merge(
        baseVal as Record<string, unknown>,
        v as Record<string, unknown>
      );
    } else {
      result[k] = v;
    }
  }
  return result;
}

function resolveConfig(options: { directory?: string; configPath?: string }): {
  merged: Record<string, unknown>;
  sources: ConfigSource[];
} {
  const paths = getConfigPaths(options);
  let merged: Record<string, unknown> = {};
  const sources: ConfigSource[] = [];

  for (const p of paths) {
    const data = readConfigFile(p);
    if (data) {
      merged = merge(merged, data);
      sources.push({ type: "file", detail: p });
    }
  }

  const envData = readEnvConfig();
  const hasEnv =
    getNested(envData, "feishu")?.appId ||
    getNested(envData, "feishu")?.appSecret;
  if (hasEnv) {
    merged = merge(merged, envData);
    sources.push({ type: "env", detail: "FEISHU_* / OPENCODE_* / BOT_*" });
  }

  return { merged, sources };
}

function finalizeConfig(
  merged: Record<string, unknown>,
  sources: ConfigSource[]
): Config {
  const feishu = getNested(merged, "feishu") ?? {};
  const opencode = getNested(merged, "opencode") ?? {};
  const bot = getNested(merged, "bot") ?? {};

  if (!feishu.appId || !feishu.appSecret) {
    throw new Error(
      "Missing Feishu config: appId and appSecret are required. Set FEISHU_APP_ID and FEISHU_APP_SECRET or use feishu-bot.json."
    );
  }

  const timeout =
    typeof opencode.timeout === "number" && opencode.timeout > 0
      ? opencode.timeout
      : DEFAULT_TIMEOUT;

  return {
    feishu: {
      appId: String(feishu.appId),
      appSecret: String(feishu.appSecret),
    },
    opencode: {
      timeout,
    },
    bot: {
      thinkingDelay:
        typeof bot.thinkingDelay === "number" && bot.thinkingDelay >= 0
          ? bot.thinkingDelay
          : DEFAULT_THINKING_DELAY,
      enableStreaming:
        typeof bot.enableStreaming === "boolean"
          ? bot.enableStreaming
          : true,
      streamInterval:
        typeof bot.streamInterval === "number" && bot.streamInterval > 0
          ? bot.streamInterval
          : DEFAULT_STREAM_INTERVAL,
    },
  };
}

export function loadConfig(options: {
  directory?: string;
  configPath?: string;
} = {}): Config {
  return loadConfigWithSource(options).config;
}

export function loadConfigWithSource(options: {
  directory?: string;
  configPath?: string;
} = {}): LoadConfigResult {
  const { merged, sources } = resolveConfig(options);
  return {
    config: finalizeConfig(merged, sources),
    sources,
  };
}
