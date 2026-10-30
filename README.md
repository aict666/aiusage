# aiusage

**English** | [简体中文](README.zh-CN.md)

Plan quotas, local token usage, prompt-cache usage, and estimated API costs for **Claude, Codex, and Grok**, in your terminal.

Runs on macOS, Linux, and Windows. Uses your existing CLI logins, with no extra account, third-party packages, or telemetry.

## Quick start

### Homebrew · macOS

```bash
brew install aict666/tap/aiusage
aiusage
```

The Homebrew package is a standalone executable; Node.js and Python are not required. Published releases can lag behind `main`. For features that have not been released yet, install from GitHub or download a CI build.

### npm · all platforms

Requires Node.js 18 or newer and Git. Works in Unix shells, Windows PowerShell, and CMD.

```text
npm install --global github:aict666/aiusage
aiusage
aiusage --demo
```

Run without a global install:

```text
npx github:aict666/aiusage
```

Or run from source:

```text
git clone https://github.com/aict666/aiusage.git
cd aiusage
node bin/aiusage.js
```

## What it shows

- **Plan quotas:** used percentage, remaining percentage, and reset time for each usage window.
- **Local tokens:** per-model totals for today, the last 7 days, and the last 30 days.
- **Prompt caching:** separate cache-read and cache-write counts, already included in the token totals.
- **API-equivalent costs:** per-model estimates in USD, plus a total across providers.

Example values from `aiusage --demo`:

| Provider | Model | Tokens today | Cache reads | Cache writes | Estimated API cost today |
| --- | --- | ---: | ---: | ---: | ---: |
| Claude | Opus 5.5 | 3.53M | 3M | 353K | $4.55 |
| Claude | Sonnet 4.6 | 124K | 105K | 12.4K | $0.14 |
| Codex | GPT-6.1 Sol | 0 | 0 | 0 | $0.00 |
| Grok | Grok 4.7 | 11.7M | 9.96M | 0 | $9.43 |

These are sample values, not live usage. The CLI currently uses Chinese labels. `--ascii` changes the decorations, not the language.

The default table uses **two rows per model**: token totals and estimated USD costs on the first row, then cache reads/writes on the second. Models have no blank rows between them. Horizontal layout uses the available terminal width, and narrow terminals wrap as needed. CJK characters, combining characters, and common emoji are aligned by display width.

## Commands

| Command | Description |
| --- | --- |
| `aiusage` | Show quotas, local tokens, cache usage, and estimated costs |
| `aiusage --demo` | Preview with sample data, without reading credentials or logs or calling provider APIs |
| `aiusage --details` | Expand token, cost, input/output, cache-write, and cache-hit-rate metrics into separate rows |
| `aiusage --json` | Output raw counts, usage breakdowns, pricing metadata, and cost coverage as JSON |
| `aiusage --ascii` | Use ASCII progress bars, separators, and decorations |
| `aiusage --no-color` | Disable colors |
| `aiusage --version` | Show the version |
| `aiusage --help` | Show help |

Options can be combined, for example `aiusage --demo --details --no-color`.

`NO_COLOR`, including an empty value, disables colors. Unsupported terminals and redirected output do not receive color escapes. `TERM=dumb` also enables ASCII decorations and disables the live loading status.

All three providers are read concurrently. If a provider request fails, the command exits with code `1` and still prints the results it collected. If all three providers are logged out, it also exits with code `1`.

## Authentication and local files

Log in to each provider's CLI first. Providers work independently: an unavailable login is shown as `未登录` (not logged in), while the others continue normally.

| Provider | Log in with | Default macOS / Linux location | Default Windows location |
| --- | --- | --- | --- |
| Claude | Claude Code | macOS Keychain entry `Claude Code-credentials`, or `~/.claude/.credentials.json` | `%USERPROFILE%\.claude\.credentials.json` |
| Codex | Codex CLI | `~/.codex/auth.json` | `%USERPROFILE%\.codex\auth.json` |
| Grok | Grok CLI | `~/.grok/auth.json` | `%USERPROFILE%\.grok\auth.json` |

Custom directories are supported through `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, and `GROK_HOME`, including paths with spaces, CJK characters, or a leading `~`. Claude also supports `CLAUDE_CODE_OAUTH_TOKEN`. See [Claude's credential management documentation](https://code.claude.com/docs/en/authentication#credential-management) for its platform-specific storage.

Native Windows and WSL use their own home directories. If you logged in to a CLI inside WSL, run aiusage in that same WSL environment.

When Claude or Grok access tokens expire, aiusage uses the locally stored refresh token and writes the refreshed credentials back to their original location, preserving other fields. File updates use a temporary file in the same directory. Files have mode `0600` on macOS/Linux and inherit the directory's access controls on Windows. Environment-provided tokens are never rewritten.

## Quotas

Quotas come from the providers' usage endpoints. Each window shows used percentage, remaining percentage, and reset time.

- Green: below 50% used. Yellow: 50% to below 80%. Red: 80% or more.
- The reset column shows the full local timestamp and a countdown.
- Resets today or tomorrow use the corresponding local-day label; later dates use month and day.

These quota endpoints are undocumented and may require updates when the provider clients change.

## Token accounting

Tokens come from local logs, independently of the plan quotas. Today starts at local midnight. The 7-day and 30-day windows both include today.

The terminal abbreviates and rounds counts using K, M, and B. Model rows show totals **including cached tokens**; do not add the cache detail rows again. Use `--details` for uncached input and output, or `--json` for exact raw numbers.

| Provider | Accounting |
| --- | --- |
| Claude | Input + cache writes + cache reads + output. Only the last snapshot of each request is counted; message ID is the fallback when request ID is absent. The model comes from that request. |
| Codex | Per-call `usage.total_tokens`, never cumulative turn/thread counters. When `response_id` is available, copied or repeated response records are counted once. The model comes from the selected turn model or the usage record. |
| Grok | `prompt_tokens + completion_tokens`. Cached input is already included. When a usage record omits the model, the most recent model selection is used. |

Cache reads can make Claude's token totals much larger than its uncached input and output alone.

Cache reads are **hits accumulated across requests**, not unique cached content or cache storage size. Reusing a cached 100K-token prefix in ten requests contributes 1M cache-read tokens. `--details` shows the hit rate as cache reads divided by all prompt tokens, including writes and uncached input; output tokens are excluded. A rate is left unknown when the required counters are incomplete.

## Cost estimates

Costs are **API-equivalent estimates in USD**, using the bundled snapshot of official **Standard / global API prices**. They are not actual Claude Pro/Max, ChatGPT/Codex, or SuperGrok subscription charges. They exclude subscription fees, tool charges, taxes, speed-tier premiums such as Fast/Ultrafast, and regional premiums.

- Uncached input, output, cache reads, and cache writes are priced separately. The total token count is not multiplied by a single rate.
- Claude's 5-minute and 1-hour cache writes are priced separately. Codex supports recorded 30-minute and 12-hour write breakdowns. If write lifetime is missing, the affected record is left unpriced.
- Long-context rates depend on the total input of **each request**, including cached input. A large monthly total does not trigger a surcharge on all records.
- Reasoning tokens already included in output are not added a second time.
- `—` means a price or required usage detail is unavailable. `123M+` and `$12.34+` indicate known portions; the full amount may be higher. Known empty periods show `0` and `$0.00`. Complete estimates below one cent show `<$0.01`.
- The bundled price snapshot was checked on **2026-10-30**. Prices are not fetched at runtime. Unknown model names do not inherit prices from similarly named models. Past usage is evaluated using this snapshot, without reconstructing historical price changes or private discounts.

Sources: [Claude pricing](https://platform.claude.com/docs/en/about-claude/pricing), [OpenAI pricing](https://developers.openai.com/api/docs/pricing), and [xAI pricing](https://docs.x.ai/developers/pricing). See [OpenAI's caching guide](https://developers.openai.com/api/docs/guides/prompt-caching#monitor-cache-performance) for its cache-write accounting.

### JSON details

The existing `today`, `days7`, `days30`, and `models` fields retain their raw token counts. `tokens.usage` and `models[].usage` add the following fields for each period:

| Field | Meaning |
| --- | --- |
| `input_tokens` / `output_tokens` | Uncached input / output |
| `cache_read_tokens` / `cache_write_tokens` | Known cache reads / writes |
| `cache_write_short_tokens` / `cache_write_long_tokens` | Write lifetime breakdown: Claude 5m/1h, Codex 30m/12h; already included in total writes |
| `unclassified_tokens` / `missing` | Tokens that cannot be classified / incompletely observed counters |
| `cost_usd` | The portion of cost that could be estimated |
| `priced_tokens` / `unpriced_tokens` / `cost_reasons` | Priced coverage / unpriced coverage / reasons a cost could not be estimated |

Top-level `pricing` records the price-check date, sources, and estimation basis. `cost_totals` aggregates costs across providers and includes an `incomplete` flag. Check `unpriced_tokens` or `incomplete` before treating an estimate as complete.

## Standalone executables

The [CI workflow](https://github.com/aict666/aiusage/actions/workflows/ci.yml) builds executables that do not require Node.js or Bun on the user's machine. Older Releases contain only macOS binaries; builds from the current source support:

| Platform | Architecture | File |
| --- | --- | --- |
| macOS | Apple Silicon | `aiusage-darwin-arm64` |
| macOS | Intel | `aiusage-darwin-x64` |
| Linux (glibc) | x64 | `aiusage-linux-x64` |
| Linux (glibc) | ARM64 | `aiusage-linux-arm64` |
| Windows | x64 | `aiusage-windows-x64.exe` |

Download and extract the appropriate build artifact. Each archive includes `SHA256SUMS`.

On Linux/macOS, make the file executable and run it, for example:

```bash
chmod +x aiusage-linux-x64
./aiusage-linux-x64
```

On Windows PowerShell, run `.\aiusage-windows-x64.exe`; in CMD, run `aiusage-windows-x64.exe`.

## Development and builds

Running and testing require Node.js only. Building standalone executables also requires Bun; CI pins version `1.3.11`.

```text
npm test
npm run build
npm run build -- linux-x64 linux-arm64
npm run build -- windows-x64
npm run build -- --all
```

Without a target, the build uses the current OS and architecture. Output goes to `dist/`. Native Windows builds use the [Bun x64 baseline executable](https://github.com/oven-sh/bun/releases/download/bun-v1.3.11/bun-windows-x64-baseline.zip) to match the compilation target; CI installs it automatically.

CI tests Node.js 18 and 24 on macOS, Linux, and Windows, checks the globally installed command, and runs demo and JSON smoke checks on each platform's native standalone executable.

## Privacy

aiusage reads local login information and usage logs, and contacts the three providers' quota endpoints. It does not upload logs or tokens to a separate service, print credentials, email addresses, or account IDs, or collect telemetry.

## License

[MIT](LICENSE)
