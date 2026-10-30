# aiusage

[English](README.md) | **简体中文**

在 macOS、Linux、Windows 的终端查看 Claude、Codex、Grok 的套餐额度、本机 Token、缓存用量和 API 等价费用。

它读取你已经登录过的 CLI，不创建自己的账号，也不上传日志或令牌。

```text
  aiusage                                                                              10-30 09:00
  套餐额度
  服务 / 套餐       窗口    已用               剩余  重置
  ────────────────────────────────────────────────────────────────────────────────────────────────
  Claude · pro      5 小时  ━───────────   6%   94%  今天 13:30 · 5 小时后
                    7 天    ━━━━━━━━━━──  84%   16%  11-01 03:00 · 42 小时后
  Codex · prolite   每周    ━━──────────  13%   87%  11-04 15:33 · 5 天后
  Grok · SuperGrok  每周    ━━━━━━━─────  60%   40%  11-02 14:56 · 3 天后

  本机 Token
  ┌────────┬─────────────┬────────────────┬───────────────────┬────────────────────┐
  │ 服务   │ 模型        │ 今天 Token/USD │ 近 7 天 Token/USD │ 近 30 天 Token/USD │
  ├────────┼─────────────┼────────────────┼───────────────────┼────────────────────┤
  │ Claude │ Opus 5.5    │  3.53M / $4.55 │ 1.66B / $2,142.77 │  1.99B / $2,567.10 │
  │        │   缓存读/写 │      3M / 353K │      1.41B / 166M │       1.69B / 199M │
  │        │ Sonnet 4.6  │   124K / $0.14 │    120M / $131.40 │     140M / $153.30 │
  │        │   缓存读/写 │   105K / 12.4K │        102M / 12M │         119M / 14M │
  │ Codex  │ GPT-6.1 Sol │      0 / $0.00 │    963M / $524.84 │  1.88B / $1,024.60 │
  │        │   读缓存    │              0 │              819M │               1.6B │
  │ Grok   │ Grok 4.7    │  11.7M / $9.43 │     107M / $86.13 │      122M / $98.21 │
  │        │   读缓存    │          9.96M │             90.9M │               104M │
  ├────────┼─────────────┼────────────────┼───────────────────┼────────────────────┤
  │ 合计   │ 估算 USD    │         $14.12 │         $2,885.14 │          $3,843.21 │
  └────────┴─────────────┴────────────────┴───────────────────┴────────────────────┘
  Token 含缓存 · API 估算 USD，非套餐扣费
```

上面的数字只是示例。

## 安装

macOS 可以用 Homebrew。装上的是独立可执行文件，不需要 Python，也不需要 Node.js。

```bash
brew install aict666/tap/aiusage
aiusage
```

三个系统都可以通过 npm 安装。需要 Node.js 18 或更高版本和 Git，没有额外依赖。Windows 的 PowerShell、CMD 均可运行：

```text
npm install --global github:aict666/aiusage
aiusage
aiusage --demo
aiusage --live
aiusage --offline
```

从源码运行也适用于三个系统：

```bash
git clone https://github.com/aict666/aiusage.git
cd aiusage
node bin/aiusage.js
```

也可以：

```bash
npx github:aict666/aiusage
```

本次源码包含 Linux、Windows 的构建支持；已有的旧版 Release 仍只有 macOS 文件。每次推送后的 [CI 构建](https://github.com/aict666/aiusage/actions/workflows/ci.yml) 会生成以下独立可执行文件，不依赖用户安装 Node.js 或 Bun：

| 系统 | 架构 | 文件 |
| --- | --- | --- |
| macOS | Apple Silicon | `aiusage-darwin-arm64` |
| macOS | Intel | `aiusage-darwin-x64` |
| Linux（glibc） | x64 | `aiusage-linux-x64` |
| Linux（glibc） | ARM64 | `aiusage-linux-arm64` |
| Windows | x64 | `aiusage-windows-x64.exe` |

下载构建产物并解压后，Linux/macOS 先给文件执行权限，例如 `chmod +x aiusage-linux-x64`，再运行 `./aiusage-linux-x64`。Windows PowerShell 运行 `.\aiusage-windows-x64.exe`，CMD 运行 `aiusage-windows-x64.exe`。各包同时提供 `SHA256SUMS`。

## 使用前

三个服务各自独立。没登录的会显示「未登录」，其余的照常输出。

| 服务 | 先完成 | macOS / Linux 默认路径 | Windows 默认路径 |
| --- | --- | --- | --- |
| Claude | 登录 Claude Code | macOS 钥匙串 `Claude Code-credentials`，或 `~/.claude/.credentials.json` | `%USERPROFILE%\.claude\.credentials.json` |
| Codex | 登录 Codex CLI | `~/.codex/auth.json` | `%USERPROFILE%\.codex\auth.json` |
| Grok | 登录 Grok CLI | `~/.grok/auth.json` | `%USERPROFILE%\.grok\auth.json` |

自定义目录时认这几个环境变量：`CLAUDE_CONFIG_DIR`、`CODEX_HOME`、`GROK_HOME`，支持带空格、中文和 `~` 的路径。Claude 也可以用 `CLAUDE_CODE_OAUTH_TOKEN`。[Claude 官方凭据说明](https://code.claude.com/docs/en/authentication#credential-management)列出了不同系统的存储方式。

Windows 原生程序与 WSL 各自读取所在系统的用户目录。如果 CLI 登录在 WSL 中，就在同一 WSL 环境运行 aiusage。

Claude 和 Grok 的访问令牌过期时，程序会用本机的 refresh token 换新令牌并写回原处，保留原文件里的其他字段。文件通过同目录临时文件替换；macOS/Linux 上权限为 `0600`，Windows 继承所在目录的访问控制，不调用 Unix 的 `chmod`。用环境变量提供的令牌不会被改写。

## 命令

```bash
aiusage
aiusage --json
aiusage --demo
aiusage --ascii
aiusage --details
aiusage --no-color
aiusage --version
```

终端里会同时读取三个服务。某个服务的接口失败时退出码为 1，已经读到的结果仍会打印。三个都未登录时退出码也是 1。

设置 `NO_COLOR`（包括空值）或加上 `--no-color` 会关掉颜色；终端不支持颜色时也不发送颜色转义。`TERM=dumb` 和重定向输出不会带颜色。`--json` 适合再交给别的脚本。

`--ascii` 把进度条、分隔线和装饰符号换成 ASCII 字符，中文标签仍然保留。`TERM=dumb` 时自动启用。旧终端的线条显示异常时可以使用 `aiusage --ascii --no-color`。

`aiusage --demo` 使用示例数据预览排版，不读取登录信息、本机日志，也不请求接口。可以与 `--no-color` 或 `--json` 组合使用。从源码预览时运行 `node bin/aiusage.js --demo`。

输出会根据终端宽度调整：宽屏用表格对齐窗口和模型，窄屏按服务分组换行，保留剩余额度、重置时间和 Token 明细。中文、组合字符和常见 emoji 按显示宽度对齐。

默认每个模型两行：第一行放 Token 合计和费用，第二行放缓存读／写，模型之间不留空行。参考 [ccusage](https://github.com/ccusage/ccusage)，宽屏采用轻边框表格，并明确标注 `Token/USD`；较小的终端使用无边框表格，再窄时自动换行。`--details` 展开输入、输出、缓存读写、命中率和费用等逐项明细。

## Live 与额度刷新

```text
aiusage --live
aiusage --live --interval 30 --quota-interval 1200
aiusage --live --offline
aiusage --live --demo
```

`aiusage live` 与 `--live` 等价。Live 需要交互终端，不能与 `--json` 同用。按 **q** 或 **Ctrl+C** 退出；内容超过屏幕高度时，用 **↑/↓** 或 **j/k** 滚动。缩放窗口和滚动只重绘画面，不请求接口。退出时恢复光标、输入模式和原先的终端画面。

本机日志默认 **15 秒**读取一次，`--interval` 可调整，最短 5 秒。远程额度独立在后台刷新，慢接口不会挡住本机 Token 更新。额度默认间隔为 **10 分钟，再加 0–60 秒的正向随机延迟**；`--quota-interval` 的单位是秒，至少 600 秒。这是保守的请求策略，不代表服务商承诺不会限流。

普通命令与 Live 共用额度缓存和冷却时间。同一缓存和配置下，关闭重开或同时打开多个实例会继续复用，不因重绘或重启立即再查。画面标出额度快照的成功读取时间；刷新失败保留上次成功的额度，并显示下次重试时间。

| 结果 | 下次尝试 |
| --- | --- |
| 成功 | 设置的额度间隔，再加 0–60 秒 |
| HTTP 429 | 至少等 30 分钟；连续失败翻倍，最长 6 小时 |
| HTTP 401 / 403 | 至少等 1 小时，并指数退避 |
| 其他错误 | 至少等一个额度间隔，并指数退避 |

服务端 `Retry-After`（秒数或 HTTP 日期）要求更久时继续等待。单次请求超时为 15 秒，限流后不会立即重试。OAuth 刷新也在同一个请求保护内：Claude 刷新令牌遇到限流时，不会换另一个地址再试。冷却时间在请求前就保存，多实例共用锁；缓存无法读写时继续显示本机 Token，并报告缓存错误，不继续轮询服务端。

`--offline` 完全不读取登录凭据、不请求远程接口，只读取本机日志和已保存的额度；没有额度缓存时会明确标注。普通模式也可使用这个选项。缓存只保存额度结果和时间，不保存访问令牌或刷新令牌：

| 系统 | 默认额度缓存 |
| --- | --- |
| macOS | `~/Library/Caches/aiusage` |
| Linux | `$XDG_CACHE_HOME/aiusage`，未设置时为 `~/.cache/aiusage` |
| Windows | `%LOCALAPPDATA%\aiusage\Cache` |

用 `AIUSAGE_CACHE_DIR` 可指定其他目录。每个服务的配置目录分别对应自己的额度快照。其他用量工具和其他机器不共享这里的缓存，它们的请求仍可能叠加到服务商的限制里。

## 额度

额度来自各家当前的用量接口，显示的是已用比例、剩余比例和重置时间。

- 绿色低于 50%，黄色 50% 到 80%，红色达到 80%。
- 重置列显示完整日期和倒计时。
- 当天、次日分别写成「今天」「明天」，更远的写成月-日。

这些接口没有公开文档。客户端改版后，这里可能需要跟着改。

## Token 怎么算

Token 来自本机日志，不是套餐剩余额度。按本地时区切分。近 7 天、近 30 天都包含今天。

终端按模型分行，并用 K、M、B 缩短数字。每个模型下单列缓存读取、缓存写入，以及今天、近 7 天、近 30 天的 API 等价费用。模型行显示的 Token 合计已经包含缓存，不能再把缓存明细加一次。`aiusage --details` 另外显示未缓存输入和输出；`aiusage --json` 保留原始数字和各模型明细。

- Claude：每次请求的输入、缓存写入、缓存读取和输出。同一次请求只取最后一条；没有请求 ID 时用消息 ID 合并快照。模型名来自这条请求。
- Codex：只取每次调用的 `usage.total_tokens`，不累加轮次、线程的累计字段；有 `response_id` 时，同一响应在多份日志中只计一次。缓存已经包含在输入里。模型名来自这一轮选定的模型。
- Grok：每次推理的 `prompt_tokens + completion_tokens`。缓存已经包含在输入里。日志里单次推理不带模型名，所以沿用最近一次模型切换。

缓存读取会让 Claude 的合计明显变大。

读缓存是**逐次请求累计的命中 Token**，不是去重后的缓存内容或缓存存储大小。同一段 100K 上下文命中十次，会累计成 1M。`--details` 中的命中率为「读缓存 ÷（未缓存输入 + 读缓存 + 写缓存）」，不包含输出；所需明细不完整时不猜测比例。终端的 K/M/B 会四舍五入，`--json` 保留精确原数。

## 费用怎么算

金额以 **USD** 显示，是把本机 Token 按当前官方 **Standard / global API 单价**折算的参考值，用于比较调用成本。它不代表 Claude Pro/Max、ChatGPT/Codex、SuperGrok 的实际扣费，也不包含套餐月费、工具调用、税费、Fast/Ultrafast 等速度档位和区域加价。

- 未缓存输入、输出、缓存读取、缓存写入分别计价，不用 Token 合计乘同一个单价。
- Claude 的 5 分钟与 1 小时缓存写入分开计价；Codex 支持记录里的 30 分钟与 12 小时缓存写入明细。只有写入总量、没有时长时，该条费用不会猜测。
- 长上下文价格根据**单次请求的总输入**（包括缓存）判断；不会因为近 30 天总量很大，就给全部记录加价。
- 使用推理 Token 明细时，不会把已包含在输出中的推理 Token 再加一次。
- `—` 表示无法取得价格或所需的日志明细；`123M+`、`$12.34+` 表示已知部分，完整结果可能更高。已知没有消耗的时段显示 `0` 和 `$0.00`。小于一美分的完整费用显示 `<$0.01`。
- 价格表随程序一起打包，不会在每次运行时联网查价。当前核对日期为 **2026-10-30**；未知模型显示无法估算，不套用名称相似的模型价格。过去的调用也按这份价格表折算，不追溯历史调价或私有折扣。

价格来源：[Claude 官方定价](https://platform.claude.com/docs/en/about-claude/pricing)、[OpenAI 官方定价](https://developers.openai.com/api/docs/pricing)与 [xAI 官方定价](https://docs.x.ai/developers/pricing)。OpenAI 缓存写入的分类计算见[官方缓存说明](https://developers.openai.com/api/docs/guides/prompt-caching#monitor-cache-performance)。

JSON 在已有 `today`、`days7`、`days30`、`models` 字段之外，增加 `tokens.usage` 和 `models[].usage`，每个时段包含：

| 字段 | 含义 |
| --- | --- |
| `input_tokens` / `output_tokens` | 未缓存输入 / 输出 |
| `cache_read_tokens` / `cache_write_tokens` | 已知缓存读取 / 写入数量 |
| `cache_write_short_tokens` / `cache_write_long_tokens` | 写入时长明细：Claude 5m/1h，Codex 30m/12h；包含在写入总量中 |
| `unclassified_tokens` / `missing` | 无法拆分的 Token 数 / 统计不完整的明细字段 |
| `cost_usd` | 已能估算的费用部分 |
| `priced_tokens` / `unpriced_tokens` / `cost_reasons` | 已计价 / 未计价覆盖量 / 无法计价的原因 |

顶层 `pricing` 给出价格核对日期、来源和计算口径，`cost_totals` 给出全部服务的费用合计及 `incomplete` 标志。判断完整费用时请检查 `unpriced_tokens` 或 `incomplete`，不要把只有 `cost_usd` 的部分结果当成完整账单。

各服务的 `quota` 另含 `updated_at`、`next_refresh_at`、`cached` 和 `status`（`ok`、`updating`、`backoff`、`offline`、`cache-error`），用于区分远程额度快照与本次读取的本机 Token。

## 开发与构建

```text
npm test
npm run build
npm run build -- linux-x64 linux-arm64
npm run build -- windows-x64
npm run build -- --all
```

运行和测试只需要 Node.js；独立可执行文件构建另外需要 Bun（CI 固定为 `1.3.11`）。Windows 原生构建使用 [Bun 的 x64 baseline 版本](https://github.com/oven-sh/bun/releases/download/bun-v1.3.11/bun-windows-x64-baseline.zip)，与编译目标保持一致；CI 会自动安装。不指定目标时构建当前系统、当前架构，产物放在 `dist/`。CI 在 macOS、Linux、Windows 上测试 Node.js 18、24，检查 npm 安装后的命令入口，并在各系统运行原生独立文件的示例与 JSON 输出检查。

## 隐私

程序只访问本机登录信息和上面三个额度接口。它不会打印令牌、邮箱或账号编号，也没有遥测。
