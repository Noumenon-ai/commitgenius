import fs from "node:fs/promises";
import path from "node:path";
import {
  formatConfigForDisplay,
  loadConfig,
  resolveApiKey,
  runConfigWizard,
  type AppConfig,
} from "./config";
import { createCommit, formatCommitMessage } from "./commit";
import { getDiffPayload } from "./diff";
import { generateCommitOptions, type GenerationResult } from "./generate";
import { installHook, uninstallHook } from "./hook";
import { printOptionsPlain, runInteractiveSelector } from "./select";

const EXIT_SUCCESS = 0;
const EXIT_ERROR = 1;
const EXIT_CANCEL = 130;

const ansi = {
  reset: "\x1b[0m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  cyan: "\x1b[36m",
  dim: "\x1b[2m",
};

type ParsedArgs = {
  dryRun: boolean;
  help: boolean;
  version: boolean;
  cli: boolean;
  hookMessageFile?: string;
  hookSource?: string;
  positionals: string[];
};

function colorize(text: string, color: keyof typeof ansi): string {
  if (!process.stdout.isTTY) {
    return text;
  }
  return `${ansi[color]}${text}${ansi.reset}`;
}

function isInteractiveTerminal(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    dryRun: false,
    help: false,
    version: false,
    cli: false,
    positionals: [],
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--dry-run") {
      parsed.dryRun = true;
      continue;
    }
    if (arg === "--cli") {
      parsed.cli = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      parsed.help = true;
      continue;
    }
    if (arg === "--version" || arg === "-v") {
      parsed.version = true;
      continue;
    }
    if (arg === "--hook-message-file") {
      if (index + 1 >= argv.length) {
        throw new Error("--hook-message-file requires a file path argument.");
      }
      parsed.hookMessageFile = argv[index + 1];
      index += 1;
      continue;
    }
    if (arg === "--hook-source") {
      if (index + 1 >= argv.length) {
        throw new Error("--hook-source requires an argument.");
      }
      parsed.hookSource = argv[index + 1];
      index += 1;
      continue;
    }
    parsed.positionals.push(arg);
  }

  return parsed;
}

function compareVersions(current: string, minimum: string): number {
  const currentParts = current.split(".").map((part) => Number.parseInt(part, 10) || 0);
  const minimumParts = minimum.split(".").map((part) => Number.parseInt(part, 10) || 0);
  const maxLength = Math.max(currentParts.length, minimumParts.length);

  for (let index = 0; index < maxLength; index += 1) {
    const a = currentParts[index] ?? 0;
    const b = minimumParts[index] ?? 0;
    if (a > b) {
      return 1;
    }
    if (a < b) {
      return -1;
    }
  }

  return 0;
}

function assertNodeVersion(soft: boolean): void {
  const minimum = "22.13.1";
  if (compareVersions(process.versions.node, minimum) >= 0) {
    return;
  }

  const message = `Node ${minimum}+ is required. Current runtime: ${process.versions.node}.`;
  if (soft) {
    console.error(colorize(`Warning: ${message}`, "yellow"));
    return;
  }

  throw new Error(message);
}

async function getPackageVersion(): Promise<string> {
  const packagePath = path.resolve(__dirname, "..", "package.json");
  const raw = await fs.readFile(packagePath, "utf8");
  const parsed = JSON.parse(raw) as { version?: string };
  return parsed.version ?? "0.0.0";
}

function usage(): string {
  return [
    "Usage:",
    "  commitgenius                 Generate commit options from staged changes",
    "  commitgenius --dry-run       Generate options without creating a commit",
    "  commitgenius --cli           Use claude CLI (Max plan) instead of API",
    "  commitgenius config          Run the config wizard",
    "  commitgenius hook install    Install the prepare-commit-msg hook",
    "  commitgenius hook uninstall  Remove the managed hook block",
    "  commitgenius --help          Show help",
    "  commitgenius --version       Show version",
    "",
    "Examples:",
    "  git add -A && commitgenius",
    "  git add src/index.ts && commitgenius --dry-run",
    "  commitgenius config",
    "  commitgenius hook install",
  ].join("\n");
}

async function withSpinner<T>(label: string, task: () => Promise<T>): Promise<T> {
  if (!process.stdout.isTTY) {
    return task();
  }

  const frames = ["|", "/", "-", "\\"];
  let index = 0;
  process.stdout.write(`${colorize(label, "cyan")} `);
  const timer = setInterval(() => {
    process.stdout.write(`\r${colorize(label, "cyan")} ${frames[index % frames.length]}`);
    index += 1;
  }, 80);

  try {
    const result = await task();
    clearInterval(timer);
    process.stdout.write(`\r${colorize(label, "cyan")} ${colorize("done", "green")}\n`);
    return result;
  } catch (error) {
    clearInterval(timer);
    process.stdout.write(`\r${colorize(label, "cyan")} ${colorize("failed", "red")}\n`);
    throw error;
  }
}

function logWarnings(warnings: string[]): void {
  for (const warning of warnings) {
    console.error(colorize(`Warning: ${warning}`, "yellow"));
  }
}

function printGenerationNotes(result: GenerationResult): void {
  for (const warning of result.warnings) {
    console.error(colorize(`Warning: ${warning}`, "yellow"));
  }

  if (result.shouldSplit && result.splitPlan.length > 0 && process.stdout.isTTY) {
    console.log(colorize("Warning: mixed commit detected. Press s to inspect the split plan.", "yellow"));
  }
}

function requireApiKey(config: AppConfig): string {
  const apiKey = resolveApiKey(config);
  if (!apiKey) {
    throw new Error("No API key found. Run: commitgenius config");
  }
  return apiKey;
}

async function writeHookCommitMessage(filePath: string, projectDir: string, message: string): Promise<void> {
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(projectDir + path.sep) && resolved !== projectDir) {
    throw new Error(`Hook message file must be within the project directory: ${resolved}`);
  }
  await fs.writeFile(resolved, message, "utf8");
}

async function handleHookCommand(projectDir: string, subcommand: string | undefined): Promise<number> {
  if (subcommand === "install") {
    const result = await installHook(projectDir);
    const verb = result.changed ? "Installed" : "Hook already installed at";
    console.log(`${colorize("✓", "green")} ${verb} ${result.hookPath}`);
    return EXIT_SUCCESS;
  }

  if (subcommand === "uninstall") {
    const result = await uninstallHook(projectDir);
    const verb = result.changed ? "Removed managed hook block from" : "No CommitGenius block found in";
    console.log(`${colorize("✓", "green")} ${verb} ${result.hookPath}`);
    return EXIT_SUCCESS;
  }

  console.log(usage());
  return EXIT_ERROR;
}

async function generateFlow(projectDir: string, args: ParsedArgs): Promise<number> {
  const loaded = await loadConfig();
  logWarnings(loaded.warnings);

  if (args.cli) {
    loaded.config.backend = "cli";
  }

  const apiKey = loaded.config.backend === "cli" ? "cli-mode" : requireApiKey(loaded.config);
  const payload = await getDiffPayload(projectDir, loaded.config.maxDiffLines, process.stdin);

  if (payload.truncated && process.stdout.isTTY) {
    console.error(
      colorize(
        `Warning: diff excerpt truncated from ${payload.originalLineCount} to ${payload.truncatedLineCount} lines.`,
        "yellow",
      ),
    );
  }

  let result = await withSpinner("Generating commit options", () =>
    generateCommitOptions(apiKey, loaded.config, payload),
  );

  printGenerationNotes(result);

  if (!isInteractiveTerminal()) {
    printOptionsPlain(result);
    return EXIT_SUCCESS;
  }

  while (true) {
    const selection = await runInteractiveSelector(result);
    if (selection.kind === "cancel") {
      return EXIT_CANCEL;
    }

    if (selection.kind === "regenerate") {
      result = await withSpinner("Regenerating commit options", () =>
        generateCommitOptions(apiKey, loaded.config, payload),
      );
      printGenerationNotes(result);
      continue;
    }

    if (args.hookMessageFile) {
      await writeHookCommitMessage(args.hookMessageFile, projectDir, formatCommitMessage(selection.option));
      console.log(`${colorize("✓", "green")} Prepared commit message in ${args.hookMessageFile}`);
      return EXIT_SUCCESS;
    }

    if (args.dryRun) {
      console.log(formatCommitMessage(selection.option));
      return EXIT_SUCCESS;
    }

    createCommit(projectDir, selection.option, payload.fingerprint);
    console.log(`${colorize("✓", "green")} Commit created`);
    return EXIT_SUCCESS;
  }
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));

  if (args.version) {
    console.log(await getPackageVersion());
    return EXIT_SUCCESS;
  }

  if (args.help) {
    console.log(usage());
    return EXIT_SUCCESS;
  }

  assertNodeVersion(true);

  if (process.env.COMMITGENIUS_HOOK === "1" && !args.hookMessageFile) {
    return EXIT_SUCCESS;
  }

  const projectDir = process.cwd();
  const [command, subcommand] = args.positionals;

  if (command === "config") {
    const loaded = await loadConfig();
    logWarnings(loaded.warnings);
    if (!isInteractiveTerminal()) {
      console.log(formatConfigForDisplay(loaded.config, loaded.path));
      return EXIT_SUCCESS;
    }

    const saved = await runConfigWizard(loaded);
    console.log(`${colorize("✓", "green")} Saved config to ${saved.path}`);
    return EXIT_SUCCESS;
  }

  if (command === "hook") {
    return handleHookCommand(projectDir, subcommand);
  }

  return generateFlow(projectDir, args);
}

void main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(colorize(`Error: ${message}`, "red"));
    if (message.includes("No API key")) {
      console.error(colorize("Suggestion: run `commitgenius config` or export ANTHROPIC_API_KEY.", "dim"));
    } else if (message.includes("No staged changes")) {
      console.error(colorize("Suggestion: stage files first with `git add`.", "dim"));
    } else if (message.includes("Node 22.13.1+")) {
      console.error(colorize("Suggestion: switch to a supported Node runtime and retry.", "dim"));
    } else {
      console.error(colorize("Suggestion: rerun with valid staged changes and a configured API key.", "dim"));
    }
    process.exitCode = EXIT_ERROR;
  });
