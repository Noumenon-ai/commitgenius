import Anthropic from "@anthropic-ai/sdk";
import { execFile } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import type { AppConfig } from "./config";
import type { DiffPayload } from "./diff";

export type CommitOption = {
  title: string;
  body: string;
};

export type SplitPlan = {
  title: string;
  files: string[];
  why: string;
};

export type GenerationResult = {
  options: CommitOption[];
  shouldSplit: boolean;
  splitPlan: SplitPlan[];
  rawResponse: string;
  warnings: string[];
};

type ClaudeShape = {
  options?: Array<Record<string, unknown>>;
  shouldSplit?: unknown;
  splitPlan?: Array<Record<string, unknown>>;
};

const RETRY_BACKOFF_MS = [1000, 3000];

function cleanText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeOption(value: Record<string, unknown>): CommitOption | null {
  const title = cleanText(value.title).replace(/\s+/g, " ");
  const body = cleanText(value.body).replace(/\r\n/g, "\n");
  if (!title) {
    return null;
  }

  return { title, body };
}

function normalizeSplitPlan(value: Record<string, unknown>): SplitPlan | null {
  const title = cleanText(value.title);
  const why = cleanText(value.why);
  const files = Array.isArray(value.files)
    ? value.files.map((entry) => cleanText(entry)).filter(Boolean)
    : [];

  if (!title || !why || files.length === 0) {
    return null;
  }

  return { title, files, why };
}

function extractJsonObject(text: string): string {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    throw new Error("Claude did not return a JSON object.");
  }

  return text.slice(start, end + 1);
}

function parseGeneration(text: string, maxOptions: number): GenerationResult {
  const requestedOptions = Math.max(maxOptions, 1);
  const parsed = JSON.parse(extractJsonObject(text)) as ClaudeShape;
  const rawOptions = Array.isArray(parsed.options) ? parsed.options : [];
  const seenTitles = new Set<string>();
  const options = rawOptions
    .map((entry) => (entry && typeof entry === "object" ? normalizeOption(entry) : null))
    .filter((entry): entry is CommitOption => Boolean(entry))
    .filter((entry) => {
      const key = entry.title.toLowerCase();
      if (seenTitles.has(key)) {
        return false;
      }
      seenTitles.add(key);
      return true;
    })
    .slice(0, requestedOptions);

  if (options.length < requestedOptions) {
    throw new Error(`Claude returned ${options.length} usable commit option(s); expected ${requestedOptions}.`);
  }

  const rawSplitPlan = Array.isArray(parsed.splitPlan) ? parsed.splitPlan : [];
  const splitPlan = rawSplitPlan
    .map((entry) => (entry && typeof entry === "object" ? normalizeSplitPlan(entry) : null))
    .filter((entry): entry is SplitPlan => Boolean(entry));
  const shouldSplit = parsed.shouldSplit === true;
  const warnings: string[] = [];

  if (shouldSplit && splitPlan.length === 0) {
    warnings.push("Claude flagged a mixed commit but did not return an actionable split plan.");
  }
  if (!shouldSplit && splitPlan.length > 0) {
    warnings.push("Claude returned a split plan even though shouldSplit was false.");
  }

  return {
    options,
    shouldSplit,
    splitPlan,
    rawResponse: text,
    warnings,
  };
}

function buildPrompt(config: AppConfig, payload: DiffPayload): string {
  const requestedOptions = Math.max(config.maxOptions, 1);
  const scopeRules =
    config.scopes.length > 0
      ? `Preferred conventional commit scopes: ${config.scopes.join(", ")}`
      : "Preferred conventional commit scopes: choose only when clearly justified by the diff.";
  const styleRules =
    config.rules.length > 0
      ? `Additional style rules:\n- ${config.rules.join("\n- ")}`
      : "Additional style rules:\n- Keep the title under 72 characters.\n- Use imperative mood.\n- Use the body only when it adds value.";

  const diffNotes: string[] = [];
  if (payload.truncated) {
    diffNotes.push(
      `The diff excerpt was truncated from ${payload.originalLineCount} lines to ${payload.truncatedLineCount} lines.`,
    );
  }
  if (payload.omittedBinaryFiles.length > 0) {
    diffNotes.push(`Binary files omitted: ${payload.omittedBinaryFiles.join(", ")}`);
  }

  return [
    "You generate git commit messages from diffs.",
    `Reply in ${config.language}.`,
    scopeRules,
    styleRules,
    "",
    "Return only valid JSON with this exact shape:",
    '{',
    '  "options": [{"title": "string", "body": "string"}],',
    '  "shouldSplit": true,',
    '  "splitPlan": [{"title": "string", "files": ["path"], "why": "string"}]',
    '}',
    "",
    "Rules:",
    `- Return exactly ${requestedOptions} commit options.`,
    "- Titles must be distinct and production-ready.",
    "- If the diff mixes unrelated concerns, set shouldSplit to true and describe an actionable split plan.",
    "- If the diff is cohesive, set shouldSplit to false and return an empty splitPlan array.",
    "",
    `Files:\n${payload.files.length > 0 ? payload.files.map((file) => `- ${file}`).join("\n") : "- inferred from stdin"}`,
    diffNotes.length > 0 ? `Notes:\n- ${diffNotes.join("\n- ")}` : "Notes:\n- No extra notes.",
    "",
    "Diff:",
    payload.diffText,
  ].join("\n");
}

async function callAnthropic(apiKey: string, model: string, prompt: string): Promise<string> {
  const client = new Anthropic({
    apiKey,
    maxRetries: 0,
    timeout: 15_000,
  });

  const response = await client.messages.create({
    model,
    temperature: 0.2,
    max_tokens: 1400,
    system: "You are a precise release engineer. Return strict JSON only.",
    messages: [{ role: "user", content: prompt }],
  });

  return response.content
    .filter((block): block is Anthropic.TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();
}

async function callClaudeCli(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile("claude", ["-p", prompt], {
      timeout: 60_000,
      maxBuffer: 1024 * 1024,
    }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`claude CLI failed: ${stderr || error.message}`));
        return;
      }
      resolve(stdout.trim());
    });
  });
}

export async function generateCommitOptions(
  apiKey: string,
  config: AppConfig,
  payload: DiffPayload,
): Promise<GenerationResult> {
  const prompt = buildPrompt(config, payload);
  const useCli = config.backend === "cli";
  let lastError: Error | null = null;

  for (let attempt = 0; attempt < RETRY_BACKOFF_MS.length + 1; attempt += 1) {
    try {
      const text = useCli
        ? await callClaudeCli(prompt)
        : await callAnthropic(apiKey, config.model, prompt);
      return parseGeneration(text, config.maxOptions);
    } catch (error) {
      lastError = error as Error;
      if (attempt < RETRY_BACKOFF_MS.length) {
        await delay(RETRY_BACKOFF_MS[attempt]);
      }
    }
  }

  throw new Error(`Commit generation failed after retries. ${lastError?.message ?? "Unknown error."}`);
}
