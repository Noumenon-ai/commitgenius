import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";

export type DiffPayload = {
  mode: "git" | "stdin";
  diffText: string;
  files: string[];
  truncated: boolean;
  fingerprint: string;
  omittedBinaryFiles: string[];
  originalLineCount: number;
  truncatedLineCount: number;
};

type FileBlock = {
  file: string;
  lines: string[];
};

const MAX_HUNKS_PER_FILE = 3;
const STDIN_LIMIT_BYTES = 512 * 1024;

function hashText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function runGit(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function parseBinaryFiles(numstat: string): Set<string> {
  const binaries = new Set<string>();

  for (const line of numstat.split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }

    const parts = line.split("\t");
    if (parts.length < 3) {
      continue;
    }

    if (parts[0] === "-" && parts[1] === "-") {
      binaries.add(parts[2]);
    }
  }

  return binaries;
}

function normalizeHeaderPath(header: string): string {
  const match = header.match(/^diff --git a\/(.+?) b\/(.+)$/);
  if (!match) {
    return header;
  }

  return match[2];
}

function parseFileBlocks(diffText: string): FileBlock[] {
  const lines = diffText.split("\n");
  const blocks: FileBlock[] = [];
  let current: FileBlock | null = null;

  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      if (current) {
        blocks.push(current);
      }

      current = {
        file: normalizeHeaderPath(line),
        lines: [line],
      };
      continue;
    }

    if (!current) {
      current = { file: "(unknown)", lines: [] };
    }

    current.lines.push(line);
  }

  if (current) {
    blocks.push(current);
  }

  return blocks;
}

function truncateBlock(lines: string[], remainingLines: number): { kept: string[]; exhausted: boolean; trimmed: boolean } {
  const header: string[] = [];
  const hunks: string[][] = [];
  let currentHunk: string[] | null = null;

  for (const line of lines) {
    if (line.startsWith("@@")) {
      if (currentHunk) {
        hunks.push(currentHunk);
      }
      currentHunk = [line];
      continue;
    }

    if (currentHunk) {
      currentHunk.push(line);
    } else {
      header.push(line);
    }
  }

  if (currentHunk) {
    hunks.push(currentHunk);
  }

  const kept: string[] = [];
  let budget = Math.max(remainingLines, 1);
  let trimmed = false;

  for (const line of header) {
    kept.push(line);
    budget -= 1;
    if (budget <= 0) {
      trimmed = lines.length > kept.length;
      if (trimmed) {
        kept.push("... diff truncated ...");
      }
      return { kept, exhausted: true, trimmed };
    }
  }

  for (const hunk of hunks.slice(0, MAX_HUNKS_PER_FILE)) {
    for (const line of hunk) {
      if (budget <= 0) {
        kept.push("... diff truncated ...");
        return { kept, exhausted: true, trimmed: true };
      }
      kept.push(line);
      budget -= 1;
    }
  }

  if (hunks.length > MAX_HUNKS_PER_FILE || lines.length > kept.length) {
    kept.push("... diff truncated ...");
    trimmed = true;
  }

  return { kept, exhausted: budget <= 0, trimmed };
}

function truncateGitDiff(diffText: string, binaryFiles: Set<string>, maxDiffLines: number): DiffPayload {
  const originalLines = diffText.split("\n");
  const blocks = parseFileBlocks(diffText);
  const keptLines: string[] = [];
  const files: string[] = [];
  const omittedBinaryFiles: string[] = [];
  let remaining = Math.max(maxDiffLines, 1);
  let truncated = false;

  for (const block of blocks) {
    const normalizedFile = block.file.replace(/^b\//, "");
    if (binaryFiles.has(normalizedFile)) {
      omittedBinaryFiles.push(normalizedFile);
      truncated = true;
      continue;
    }

    files.push(normalizedFile);
    const { kept, exhausted, trimmed } = truncateBlock(block.lines, remaining);
    keptLines.push(...kept);
    remaining -= kept.length;
    truncated = truncated || trimmed;

    if (exhausted || remaining <= 0) {
      truncated = true;
      break;
    }
  }

  const diffOutput = keptLines.join("\n").trimEnd();
  return {
    mode: "git",
    diffText: diffOutput,
    files,
    truncated,
    fingerprint: hashText(diffText),
    omittedBinaryFiles,
    originalLineCount: originalLines.length,
    truncatedLineCount: diffOutput ? diffOutput.split("\n").length : 0,
  };
}

async function readStdinText(stream: NodeJS.ReadStream): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;

  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += buffer.length;
    if (size > STDIN_LIMIT_BYTES) {
      throw new Error(`Piped input exceeded ${STDIN_LIMIT_BYTES} bytes.`);
    }
    chunks.push(buffer);
  }

  return Buffer.concat(chunks).toString("utf8");
}

function truncateRawText(input: string, maxDiffLines: number): DiffPayload {
  const lines = input.replace(/\r\n/g, "\n").split("\n");
  const keptLines = lines.slice(0, Math.max(maxDiffLines, 1));
  const truncated = lines.length > keptLines.length;
  const diffText = truncated ? `${keptLines.join("\n")}\n... diff truncated ...` : keptLines.join("\n");

  return {
    mode: "stdin",
    diffText: diffText.trimEnd(),
    files: [],
    truncated,
    fingerprint: hashText(input),
    omittedBinaryFiles: [],
    originalLineCount: lines.length,
    truncatedLineCount: diffText ? diffText.split("\n").length : 0,
  };
}

export async function getDiffPayload(cwd: string, maxDiffLines: number, stdin: NodeJS.ReadStream): Promise<DiffPayload> {
  if (!stdin.isTTY) {
    const piped = await readStdinText(stdin);
    if (piped.trim()) {
      return truncateRawText(piped, maxDiffLines);
    }
  }

  let nameOnly = "";
  let numstat = "";
  let diffText = "";

  try {
    nameOnly = runGit(cwd, ["diff", "--staged", "--name-only", "-z"]);
    numstat = runGit(cwd, ["diff", "--staged", "--numstat", "--no-color"]);
    diffText = runGit(cwd, ["diff", "--staged", "--no-color", "--no-ext-diff"]);
  } catch (error) {
    const typed = error as Error;
    throw new Error(`Unable to read staged diff. ${typed.message}`);
  }

  if (!nameOnly.trim() || !diffText.trim()) {
    throw new Error("No staged changes found.");
  }

  const payload = truncateGitDiff(diffText, parseBinaryFiles(numstat), maxDiffLines);
  payload.fingerprint = hashText(`${nameOnly}\n${diffText}`);
  return payload;
}

export function getCurrentStagedFingerprint(cwd: string): string {
  const nameOnly = runGit(cwd, ["diff", "--staged", "--name-only", "-z"]);
  const diffText = runGit(cwd, ["diff", "--staged", "--no-color", "--no-ext-diff"]);
  return hashText(`${nameOnly}\n${diffText}`);
}
