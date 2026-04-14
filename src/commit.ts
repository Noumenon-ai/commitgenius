import { spawnSync } from "node:child_process";
import type { CommitOption } from "./generate";
import { getCurrentStagedFingerprint } from "./diff";

export function formatCommitMessage(option: CommitOption): string {
  return option.body.trim() ? `${option.title.trim()}\n\n${option.body.trim()}\n` : `${option.title.trim()}\n`;
}

export function createCommit(cwd: string, option: CommitOption, expectedFingerprint: string): void {
  const currentFingerprint = getCurrentStagedFingerprint(cwd);
  if (currentFingerprint !== expectedFingerprint) {
    throw new Error("Staged changes changed after generation. Regenerate before committing.");
  }

  const args = ["commit", "-m", option.title.trim()];
  if (option.body.trim()) {
    args.push("-m", option.body.trim());
  }

  const result = spawnSync("git", args, {
    cwd,
    stdio: "inherit",
    env: {
      ...process.env,
      COMMITGENIUS_HOOK: "1",
    },
  });

  if (result.error) {
    throw new Error(`Unable to run git commit. ${result.error.message}`);
  }

  if (result.status !== 0) {
    throw new Error(`git commit failed with exit code ${result.status ?? 1}.`);
  }
}
