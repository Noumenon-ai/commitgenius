import readline from "node:readline";
import readlinePromises from "node:readline/promises";
import type { CommitOption, GenerationResult } from "./generate";

export type SelectionResult =
  | { kind: "select"; option: CommitOption }
  | { kind: "regenerate" }
  | { kind: "cancel" };

const ansi = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  cyan: "\x1b[36m",
  yellow: "\x1b[33m",
};

function colorize(text: string, color: keyof typeof ansi): string {
  return `${ansi[color]}${text}${ansi.reset}`;
}

function renderOption(option: CommitOption, selected: boolean, index: number): string[] {
  const prefix = selected ? colorize(">", "cyan") : " ";
  const title = selected ? colorize(option.title, "cyan") : option.title;
  const lines = [`${prefix} ${index + 1}. ${title}`];
  if (option.body.trim()) {
    lines.push(colorize(`    ${option.body.replace(/\n/g, "\n    ")}`, "dim"));
  }
  return lines;
}

export function printOptionsPlain(result: GenerationResult): void {
  const lines: string[] = [];
  for (const [index, option] of result.options.entries()) {
    lines.push(`${index + 1}. ${option.title}`);
    if (option.body.trim()) {
      lines.push(option.body.replace(/\n/g, "\n   "));
    }
    lines.push("");
  }

  if (result.shouldSplit && result.splitPlan.length > 0) {
    lines.push("[split recommendation]");
    for (const step of result.splitPlan) {
      lines.push(`- ${step.title}`);
      lines.push(`  Files: ${step.files.join(", ")}`);
      lines.push(`  Why: ${step.why}`);
    }
  }

  process.stdout.write(`${lines.join("\n").trimEnd()}\n`);
}

export async function runInteractiveSelector(result: GenerationResult): Promise<SelectionResult> {
  const stdin = process.stdin;
  const stdout = process.stdout;

  if (!stdin.isTTY || !stdout.isTTY) {
    printOptionsPlain(result);
    return { kind: "cancel" };
  }

  const options = result.options.map((option) => ({ ...option }));
  let selected = 0;
  let showSplit = false;
  let editing = false;

  readline.emitKeypressEvents(stdin);
  stdin.setRawMode(true);
  stdin.resume();
  stdout.write("\x1b[?25l");

  function render(): void {
    const lines: string[] = [];
    lines.push("\x1b[2J\x1b[H");
    lines.push(`${ansi.bold}CommitGenius${ansi.reset}`);
    lines.push(colorize("↑/↓ select  Enter commit  e edit  r regenerate  s split  q quit", "dim"));
    lines.push("");

    if (result.shouldSplit) {
      const banner = showSplit ? "[split plan visible]" : "[split plan hidden]";
      lines.push(colorize(`Warning: this looks like a mixed commit ${banner}`, "yellow"));
      lines.push("");
    }

    for (const [index, option] of options.entries()) {
      lines.push(...renderOption(option, index === selected, index));
      lines.push("");
    }

    if (showSplit && result.splitPlan.length > 0) {
      lines.push(colorize("Split plan:", "yellow"));
      for (const item of result.splitPlan) {
        lines.push(`- ${item.title}`);
        lines.push(colorize(`  Files: ${item.files.join(", ")}`, "dim"));
        lines.push(colorize(`  Why: ${item.why}`, "dim"));
      }
    }

    stdout.write(lines.join("\n"));
  }

  async function editCurrent(): Promise<void> {
    editing = true;
    stdin.setRawMode(false);
    stdout.write("\x1b[2J\x1b[H");
    stdout.write(`${ansi.bold}Edit Commit Message${ansi.reset}\n`);

    const rl = readlinePromises.createInterface({ input: stdin, output: stdout });
    try {
      const title = await rl.question(`Title [${options[selected].title}]: `);
      const body = await rl.question(`Body (use \\n for line breaks) [${options[selected].body || "empty"}]: `);

      if (title.trim()) {
        options[selected].title = title.trim();
      }
      if (body.trim()) {
        options[selected].body = body.replace(/\\n/g, "\n").trim();
      }
    } finally {
      rl.close();
      stdin.setRawMode(true);
      editing = false;
      render();
    }
  }

  render();

  return await new Promise<SelectionResult>((resolve, reject) => {
    const onKeypress = (_: string, key: readline.Key) => {
      if (editing) {
        return;
      }

      if (key.ctrl && key.name === "c") {
        cleanup();
        resolve({ kind: "cancel" });
        return;
      }

      if (_ === "q") {
        cleanup();
        resolve({ kind: "cancel" });
        return;
      }

      if (_ === "r") {
        cleanup();
        resolve({ kind: "regenerate" });
        return;
      }

      if (key.name === "up") {
        selected = selected === 0 ? options.length - 1 : selected - 1;
        render();
        return;
      }

      if (key.name === "down") {
        selected = selected === options.length - 1 ? 0 : selected + 1;
        render();
        return;
      }

      if (key.name === "return") {
        cleanup();
        resolve({ kind: "select", option: options[selected] });
        return;
      }

      if (_ === "s" && result.shouldSplit) {
        showSplit = !showSplit;
        render();
        return;
      }

      if (_ === "e") {
        editCurrent().catch((error: unknown) => {
          cleanup();
          reject(error);
        });
      }
    };

    function cleanup(): void {
      stdin.off("keypress", onKeypress);
      stdin.setRawMode(false);
      stdin.pause();
      stdout.write("\x1b[?25h");
      stdout.write("\n");
    }

    stdin.on("keypress", onKeypress);
  });
}
