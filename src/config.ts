import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  chmodSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { parse } from "yaml";
import type { ModelConfig } from "./types.js";

// Compiled files are in dist/src; development files are in src.
const sourceDir = dirname(fileURLToPath(import.meta.url));
export const ROOT = sourceDir.endsWith("/dist/src")
  ? resolve(sourceDir, "../..")
  : resolve(sourceDir, "..");
dotenv.config({ path: resolve(ROOT, ".env"), quiet: true });
export const DATA = resolve(
  process.env.AUDIT_DATA_DIR || resolve(ROOT, ".audit-harness"),
);
export const PORT = Number(process.env.PORT || 4317);
export const GITHUB_PROXY = process.env.GITHUB_PROXY || "http://127.0.0.1:7890";
mkdirSync(DATA, { recursive: true, mode: 0o700 });
const configFile = resolve(DATA, "config.json");

export function getConfig(): ModelConfig {
  const saved = existsSync(configFile)
    ? JSON.parse(readFileSync(configFile, "utf8"))
    : {};
  return {
    provider: process.env.MODEL_PROVIDER || "deepseek",
    baseUrl: process.env.MODEL_BASE_URL || "https://api.deepseek.com/v1",
    model: process.env.MODEL_ID || "deepseek-flash",
    api: process.env.MODEL_API || "openai-completions",
    contextWindow: 131072,
    maxTokens: 8192,
    ...saved,
  };
}

export function validateConfig(
  input: Record<string, unknown>,
  base = getConfig(),
): ModelConfig {
  const config = { ...base };
  for (const key of ["provider", "baseUrl", "model", "api"] as const) {
    if (typeof input[key] === "string")
      (config as unknown as Record<string, unknown>)[key] = input[key].trim();
  }
  if (
    !["openai-completions", "openai-responses", "anthropic-messages"].includes(
      config.api,
    )
  )
    throw new Error("不支持的模型 API 协议");
  if (!config.provider || !config.model)
    throw new Error("请填写供应商和模型 ID");
  const url = new URL(config.baseUrl);
  if (!["http:", "https:"].includes(url.protocol))
    throw new Error("模型地址必须是 HTTP/HTTPS URL");
  config.baseUrl = config.baseUrl.replace(/\/+$/, "");
  for (const key of ["contextWindow", "maxTokens"] as const) {
    if (input[key] !== undefined) {
      const n = Number(input[key]);
      if (!Number.isSafeInteger(n) || n < 256 || n > 2_000_000)
        throw new Error(`${key} 必须是 256–2000000 的整数`);
      config[key] = n;
    }
  }
  if (typeof input.apiKey === "string" && input.apiKey.trim())
    config.apiKey = input.apiKey.trim();
  if (input.clearApiKey === true) delete config.apiKey;
  return config;
}

export function resolveCredential(config: ModelConfig): {
  key?: string;
  source: string;
} {
  if (config.apiKey) return { key: config.apiKey, source: "工作台本地配置" };
  if (process.env.MODEL_API_KEY)
    return { key: process.env.MODEL_API_KEY, source: "MODEL_API_KEY" };
  const hostname = new URL(config.baseUrl).hostname;
  if (hostname === "api.deepseek.com") {
    if (process.env.DEEPSEEK_API_KEY)
      return { key: process.env.DEEPSEEK_API_KEY, source: "DEEPSEEK_API_KEY" };
    if (process.env.USE_DSH_CREDENTIALS !== "false") {
      const file = resolve(homedir(), ".dsh/.credentials.yaml");
      try {
        const value = parse(readFileSync(file, "utf8"));
        const key = value?.refs?.DEEPSEEK_API_KEY ?? value?.DEEPSEEK_API_KEY;
        if (typeof key === "string" && key.startsWith("sk-"))
          return { key, source: "本机 DSH · DeepSeek" };
      } catch {
        /* This optional fallback never writes to DSH. */
      }
    }
  }
  if (hostname === "api.openai.com" && process.env.OPENAI_API_KEY)
    return { key: process.env.OPENAI_API_KEY, source: "OPENAI_API_KEY" };
  if (hostname === "api.anthropic.com" && process.env.ANTHROPIC_API_KEY)
    return { key: process.env.ANTHROPIC_API_KEY, source: "ANTHROPIC_API_KEY" };
  return { source: "尚未配置" };
}

export function publicConfig(config = getConfig()) {
  const { apiKey: _, ...safe } = config;
  const credential = resolveCredential(config);
  return {
    ...safe,
    hasApiKey: Boolean(credential.key),
    credentialSource: credential.source,
    githubProxy: GITHUB_PROXY,
    defaultRepository: process.env.DEFAULT_REPO || ROOT,
  };
}

export function saveConfig(input: Record<string, unknown>) {
  const config = validateConfig(input);
  writeFileSync(configFile, JSON.stringify(config, null, 2), { mode: 0o600 });
  chmodSync(configFile, 0o600);
  return publicConfig(config);
}

export function redactSecrets<T>(value: T): T {
  const secrets = [
    resolveCredential(getConfig()).key,
    process.env.DEEPSEEK_API_KEY,
    process.env.MODEL_API_KEY,
  ].filter((v): v is string => Boolean(v));
  const json = JSON.stringify(value);
  if (json === undefined) return value;
  let clean = json;
  for (const secret of secrets) clean = clean.split(secret).join("[REDACTED]");
  return JSON.parse(clean);
}
