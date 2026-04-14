import fs from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";

const SENTINEL_START = "# >>> commitgenius >>>";
const SENTINEL_END = "# <<< commitgenius <<<";
const TTY_PATH = "/dev/tty";

export type HookResult = {
  hookPath: string;
  backupPath: string;
  changed: boolean;
};

function resolveHooksDir(cwd: string): string {
  const relative = execFileSync("git", ["rev-parse", "--git-path", "hooks"], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();

  return path.resolve(cwd, relative);
}

function shellEscape(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\$/g, "\\$").replace(/`/g, "\\`");
}

function buildBlock(_projectDir: string): string {
  const nodePath = shellEscape(process.execPath);
  const cliPath = shellEscape(path.resolve(__dirname, "..", "bin", "commitgenius.js"));

  return [
    SENTINEL_START,
    'if [ "${COMMITGENIUS_HOOK:-}" = "1" ]; then',
    "  :",
    'elif [ -n "${2:-}" ]; then',
    "  :",
    `elif [ ! -r "${TTY_PATH}" ] || [ ! -w "${TTY_PATH}" ]; then`,
    "  :",
    "else",
    `  COMMITGENIUS_HOOK=1 "${nodePath}" "${cliPath}" --hook-message-file "$1" --hook-source "\${2:-}" <"${TTY_PATH}" >"${TTY_PATH}" 2>&1 || exit $?`,
    "fi",
    SENTINEL_END,
    "",
  ].join("\n");
}

function removeManagedBlock(contents: string): string {
  const pattern = new RegExp(`${SENTINEL_START}[\\s\\S]*?${SENTINEL_END}\\n?`, "g");
  return contents.replace(pattern, "").trimEnd();
}

function isEffectivelyEmpty(contents: string): boolean {
  const compact = contents
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => line !== "#!/usr/bin/env sh");

  return compact.length === 0;
}

export async function installHook(projectDir: string): Promise<HookResult> {
  const hooksDir = resolveHooksDir(projectDir);
  const hookPath = path.join(hooksDir, "prepare-commit-msg");
  const backupPath = `${hookPath}.commitgenius.bak`;
  const block = buildBlock(projectDir);

  await fs.mkdir(hooksDir, { recursive: true });

  let existing = "";
  try {
    existing = await fs.readFile(hookPath, "utf8");
  } catch (error) {
    const typed = error as NodeJS.ErrnoException;
    if (typed.code !== "ENOENT") {
      throw error;
    }
  }

  if (existing.includes(SENTINEL_START) && existing.includes(SENTINEL_END)) {
    return { hookPath, backupPath, changed: false };
  }

  if (existing && !(await fileExists(backupPath))) {
    await fs.writeFile(backupPath, existing, "utf8");
  }

  const base = existing.trimEnd()
    ? `${existing.trimEnd()}\n\n${block}`
    : `#!/usr/bin/env sh\n\n${block}`;

  await fs.writeFile(hookPath, base, "utf8");
  await fs.chmod(hookPath, 0o755);
  return { hookPath, backupPath, changed: true };
}

export async function uninstallHook(projectDir: string): Promise<HookResult> {
  const hooksDir = resolveHooksDir(projectDir);
  const hookPath = path.join(hooksDir, "prepare-commit-msg");
  const backupPath = `${hookPath}.commitgenius.bak`;

  let existing = "";
  try {
    existing = await fs.readFile(hookPath, "utf8");
  } catch (error) {
    const typed = error as NodeJS.ErrnoException;
    if (typed.code === "ENOENT") {
      return { hookPath, backupPath, changed: false };
    }
    throw error;
  }

  if (!existing.includes(SENTINEL_START)) {
    return { hookPath, backupPath, changed: false };
  }

  const cleaned = removeManagedBlock(existing);
  if (isEffectivelyEmpty(cleaned)) {
    if (await fileExists(backupPath)) {
      const backup = await fs.readFile(backupPath, "utf8");
      await fs.writeFile(hookPath, backup, "utf8");
    } else {
      await fs.rm(hookPath, { force: true });
    }
  } else {
    await fs.writeFile(hookPath, `${cleaned}\n`, "utf8");
  }

  return { hookPath, backupPath, changed: true };
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}
