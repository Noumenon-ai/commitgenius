import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline/promises";

export type Backend = "api" | "cli";

export type AppConfig = {
  apiKey?: string;
  backend: Backend;
  model: string;
  language: string;
  rules: string[];
  scopes: string[];
  maxDiffLines: number;
  maxOptions: number;
};

export type LoadedConfig = {
  config: AppConfig;
  path: string;
  warnings: string[];
};

const DEFAULT_CONFIG: AppConfig = {
  backend: "api",
  model: "claude-sonnet-4-20250514",
  language: "English",
  rules: [],
  scopes: [],
  maxDiffLines: 500,
  maxOptions: 3,
};

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
    .filter(Boolean);
}

function normalizePositiveNumber(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }

  const rounded = Math.trunc(value);
  return rounded > 0 ? rounded : fallback;
}

function normalizeConfig(raw: unknown): AppConfig {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ...DEFAULT_CONFIG };
  }

  const candidate = raw as Record<string, unknown>;
  const rawBackend = typeof candidate.backend === "string" ? candidate.backend.trim().toLowerCase() : "";
  const backend: Backend = rawBackend === "cli" ? "cli" : "api";

  const next: AppConfig = {
    apiKey: typeof candidate.apiKey === "string" && candidate.apiKey.trim() ? candidate.apiKey.trim() : undefined,
    backend,
    model: typeof candidate.model === "string" && candidate.model.trim() ? candidate.model.trim() : DEFAULT_CONFIG.model,
    language:
      typeof candidate.language === "string" && candidate.language.trim()
        ? candidate.language.trim()
        : DEFAULT_CONFIG.language,
    rules: normalizeStringArray(candidate.rules),
    scopes: normalizeStringArray(candidate.scopes),
    maxDiffLines: normalizePositiveNumber(candidate.maxDiffLines, DEFAULT_CONFIG.maxDiffLines),
    maxOptions: normalizePositiveNumber(candidate.maxOptions, DEFAULT_CONFIG.maxOptions),
  };

  return next;
}

export function getConfigPath(): string {
  if (process.env.COMMITGENIUS_CONFIG?.trim()) {
    return path.resolve(process.env.COMMITGENIUS_CONFIG.trim());
  }

  return path.join(os.homedir(), ".commitgenius.json");
}

export async function loadConfig(): Promise<LoadedConfig> {
  const configPath = getConfigPath();
  const warnings: string[] = [];

  try {
    const raw = await fs.readFile(configPath, "utf8");
    try {
      const parsed = JSON.parse(raw) as unknown;
      return { config: normalizeConfig(parsed), path: configPath, warnings };
    } catch {
      warnings.push(`Malformed config JSON at ${configPath}. Defaults were loaded instead.`);
      return { config: { ...DEFAULT_CONFIG }, path: configPath, warnings };
    }
  } catch (error) {
    const typed = error as NodeJS.ErrnoException;
    if (typed.code !== "ENOENT") {
      warnings.push(`Unable to read config at ${configPath}. Defaults were loaded instead.`);
    }
  }

  return { config: { ...DEFAULT_CONFIG }, path: configPath, warnings };
}

export async function saveConfig(next: Partial<AppConfig>): Promise<LoadedConfig> {
  const loaded = await loadConfig();
  const merged = normalizeConfig({ ...loaded.config, ...next });

  await fs.mkdir(path.dirname(loaded.path), { recursive: true });
  await fs.writeFile(loaded.path, `${JSON.stringify(merged, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });

  return { config: merged, path: loaded.path, warnings: [] };
}

function splitCsv(value: string): string[] {
  return value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

export async function runConfigWizard(current?: LoadedConfig): Promise<LoadedConfig> {
  const loaded = current ?? (await loadConfig());
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    const apiKeyDefault = resolveApiKey(loaded.config) ?? loaded.config.apiKey ?? "";
    const apiKeyAnswer = await rl.question(`Anthropic API key [${apiKeyDefault ? "saved" : "none"}]: `);
    const modelAnswer = await rl.question(`Model [${loaded.config.model}]: `);
    const languageAnswer = await rl.question(`Language [${loaded.config.language}]: `);
    const scopesAnswer = await rl.question(
      `Allowed scopes, comma-separated [${loaded.config.scopes.join(", ") || "none"}]: `,
    );
    const rulesAnswer = await rl.question(
      `Style rules, comma-separated [${loaded.config.rules.join(", ") || "none"}]: `,
    );

    const next: Partial<AppConfig> = {
      apiKey: apiKeyAnswer.trim() ? apiKeyAnswer.trim() : loaded.config.apiKey,
      model: modelAnswer.trim() || loaded.config.model,
      language: languageAnswer.trim() || loaded.config.language,
      scopes: scopesAnswer.trim() ? splitCsv(scopesAnswer) : loaded.config.scopes,
      rules: rulesAnswer.trim() ? splitCsv(rulesAnswer) : loaded.config.rules,
    };

    return await saveConfig(next);
  } finally {
    rl.close();
  }
}

export function resolveApiKey(config: AppConfig): string | null {
  const fromEnv = process.env.ANTHROPIC_API_KEY?.trim();
  if (fromEnv) {
    return fromEnv;
  }

  return config.apiKey?.trim() || null;
}

export function formatConfigForDisplay(config: AppConfig, configPath: string): string {
  const display = {
    apiKey: resolveApiKey(config) ? "***redacted***" : undefined,
    model: config.model,
    language: config.language,
    scopes: config.scopes,
    rules: config.rules,
    maxDiffLines: config.maxDiffLines,
    maxOptions: config.maxOptions,
    configPath,
  };

  return JSON.stringify(display, null, 2);
}
