# commitgenius

**Stop writing garbage commit messages.** commitgenius reads your actual diff, understands what changed and why, and generates specific, meaningful commit messages in seconds.

```
$ git add src/auth.ts src/middleware.ts
$ commitgenius

  Analyzing staged changes... done

  > 1. feat(auth): add JWT refresh token rotation with 7-day sliding expiry
    2. feat(auth): implement automatic token refresh on 401 response
    3. refactor(auth): replace session cookies with stateless JWT refresh flow

  [↑↓ navigate] [enter select] [e edit] [r regenerate] [q quit]
```

No more `"update files"`. No more `"fix bug"`. No more `"misc changes"`.

---

## Why commitgenius?

Every commit message tool writes the same generic garbage. GitHub Copilot [literally hallucinates](https://github.com/desktop/desktop/issues/20676) — claiming you added tests when you didn't, or saying "initial commit" on a repo with 500 commits.

commitgenius is different:

- **Reads the actual diff** — not just file names, the actual code changes
- **Understands context** — knows a renamed function is a refactor, not a new feature
- **Conventional commits** — `feat`, `fix`, `refactor`, `chore`, `docs`, `test`, `perf`
- **Detects mixed commits** — warns you when a diff should be split into multiple commits
- **Smart truncation** — handles massive diffs without blowing up token limits
- **Git hook ready** — auto-suggests on every `git commit`

## Install

```bash
npm install -g commitgenius
```

## Setup

### Option A: Anthropic API key (recommended for teams)

```bash
export ANTHROPIC_API_KEY="sk-ant-..."
```

Or run the config wizard:

```bash
commitgenius config
```

### Option B: Claude CLI (no API key needed)

If you have [Claude Code](https://docs.anthropic.com/en/docs/claude-code) installed with a Max/Pro plan:

```bash
commitgenius --cli
```

Set it as default:

```bash
echo '{"backend": "cli"}' > ~/.commitgenius.json
```

## Usage

```bash
# Stage your changes, then:
commitgenius

# Preview without committing:
commitgenius --dry-run

# Use Claude CLI instead of API:
commitgenius --cli

# Install as git hook (auto-suggest on every commit):
commitgenius hook install

# Remove the hook:
commitgenius hook uninstall
```

### Interactive controls

| Key | Action |
|-----|--------|
| `↑` `↓` | Navigate options |
| `Enter` | Accept and commit |
| `e` | Edit the selected message |
| `r` | Regenerate all options |
| `s` | Show split plan (if mixed commit detected) |
| `q` | Cancel |

### Piped input

```bash
git diff --staged | commitgenius --dry-run
```

Works in CI pipelines and scripts. In non-TTY mode, prints options as plain text.

## Configuration

Config lives at `~/.commitgenius.json`:

```json
{
  "backend": "api",
  "model": "claude-sonnet-4-20250514",
  "language": "English",
  "maxDiffLines": 500,
  "maxOptions": 3,
  "scopes": ["api", "ui", "db", "auth"],
  "rules": [
    "Include JIRA ticket from branch name",
    "Keep subject under 72 characters"
  ]
}
```

| Field | Default | Description |
|-------|---------|-------------|
| `backend` | `"api"` | `"api"` for Anthropic SDK, `"cli"` for `claude -p` |
| `apiKey` | — | Anthropic API key (or use `ANTHROPIC_API_KEY` env var) |
| `model` | `"claude-sonnet-4-20250514"` | Any Claude model ID |
| `language` | `"English"` | Language for commit messages |
| `maxDiffLines` | `500` | Truncate diffs beyond this |
| `maxOptions` | `3` | Number of commit message options |
| `scopes` | `[]` | Preferred conventional commit scopes |
| `rules` | `[]` | Custom style rules the AI follows |

## Git Hook

```bash
commitgenius hook install
```

This installs a `prepare-commit-msg` hook that:
- Auto-suggests a commit message when you run `git commit`
- Reattaches to `/dev/tty` so the interactive selector works
- Skips when a message is already provided (`git commit -m "..."`)
- Won't interfere with existing hooks — only adds a managed block

```bash
commitgenius hook uninstall  # clean removal
```

## Safety

- **Diff fingerprint check** — verifies staged changes haven't changed between generation and commit
- **Binary file filtering** — strips binary diffs before sending to the model
- **Smart truncation** — keeps the most important hunks when diffs are huge
- **Retry with backoff** — handles transient API failures gracefully
- **Defensive JSON parsing** — never crashes on malformed model output
- **No data storage** — your code never leaves the API request

## How it works

```
git diff --staged
       |
       v
  +-----------+     +-----------+     +------------+
  | Read diff | --> |  Claude   | --> | 3 options  |
  | + truncate|     | (API/CLI) |     | + selector |
  +-----------+     +-----------+     +------------+
                                            |
                                            v
                                     git commit -m "..."
```

1. Reads staged diff via `git diff --staged`
2. Strips binary files, truncates intelligently
3. Sends to Claude with a prompt engineered for conventional commits
4. Returns 3 distinct options in `type(scope): description` format
5. You pick one, edit if needed, and it commits

## vs. other tools

| Feature | commitgenius | GitHub Copilot | aicommits | OpenCommit |
|---------|:---:|:---:|:---:|:---:|
| Actually reads the diff | yes | partial | yes | yes |
| Specific messages (not generic) | yes | no | sometimes | sometimes |
| Multiple options to choose from | 3 | 1 | 1 | 1 |
| Mixed commit detection | yes | no | no | no |
| Edit inline before commit | yes | no | no | no |
| Git hook mode | yes | built-in | yes | yes |
| Claude CLI support (no API key) | yes | no | no | no |
| Custom rules per project | yes | no | no | partial |
| Zero runtime deps (besides SDK) | yes | N/A | no | no |

## Requirements

- Node.js >= 18
- Git
- Anthropic API key OR Claude Code CLI

## Contributing

PRs welcome. Please follow conventional commits (use commitgenius to write your commit messages).

## License

MIT
---
Built by [Noumenon](https://github.com/Noumenon-ai)
