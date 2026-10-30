# aiusage

[English](README.md) | **简体中文**

在 macOS、Linux、Windows 的终端查看 Claude、Codex、Grok 的套餐额度、本机 Token、缓存用量和 API 等价费用。

它读取你已经登录过的 CLI，不创建自己的账号，也不上传日志或令牌。

```text
  aiusage                                                          10-30 09:00

  套餐额度
  服务 / 套餐       窗口    已用               剩余  重置
  ────────────────────────────────────────────────────────────────────────────
  Claude · pro      5 小时  ━───────────   6%   94%  今天 13:30 · 5 小时后
                    7 天    ━━━━━━━━━━──  84%   16%  11-01 03:00 · 42 小时后
  Codex · prolite   每周    ━━──────────  13%   87%  11-04 15:33 · 5 天后
  Grok · SuperGrok  每周    ━━━━━━━─────  60%   40%  11-02 14:56 · 3 天后

  本机 Token
  服务    模型                            今天         近 7 天        近 30 天
  ────────────────────────────────────────────────────────────────────────────
  Claude  Opus 5.5                       3.53M           1.66B           1.99B
            缓存读取                        3M           1.41B           1.69B
            缓存写入                      353K            166M            199M
            API 估算                     $4.55       $2,142.77       $2,567.10

          Sonnet 4.6                      124K            120M            140M
            缓存读取                      105K            102M            119M
            缓存写入                     12.4K             12M             14M
            API 估算                     $0.14         $131.40         $153.30

  Codex   GPT-6.1 Sol                        0            963M           1.88B
            缓存读取                         0            819M            1.6B
            缓存写入                         0               0               0
            API 估算                     $0.00         $524.84       $1,024.60

  Grok    Grok 4.7                       11.7M            107M            122M
            缓存读取                     9.96M           90.9M            104M
            缓存写入                         0               0               0
            API 估算                     $9.43          $86.13          $98.21
  ────────────────────────────────────────────────────────────────────────────
  合计    API 估算 / USD                $14.12       $2,885.14       $3,843.21

  模型行是 Token 合计，已含缓存 · 近 7 / 30 天均含今天
  费用按 API 标准价折算 USD，非套餐账单 · 价格 2026-10-30
  + 表示已知部分；— 表示价格或日志明细不足
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

## 额度

额度来自各家当前的用量接口，显示的是已用比例、剩余比例和重置时间。

- 绿色低于 50%，黄色 50% 到 80%，红色达到 80%。
- 当天、次日重置分别写成「今天」「明天」，更远的写成月-日。
- 重置时间后面带倒计时，例如「41 小时后」或「5 天后」。

这些接口没有公开文档。客户端改版后，这里可能需要跟着改。

## Token 怎么算

Token 来自本机日志，不是套餐剩余额度。按本地时区切分。近 7 天、近 30 天都包含今天。

终端按模型分行，并用 K、M、B 缩短数字。每个模型下单列缓存读取、缓存写入，以及今天、近 7 天、近 30 天的 API 等价费用。模型行显示的 Token 合计已经包含缓存，不能再把缓存明细加一次。`aiusage --details` 另外显示未缓存输入和输出；`aiusage --json` 保留原始数字和各模型明细。

- Claude：每次请求的输入、缓存写入、缓存读取和输出。同一次请求只取最后一条。模型名来自这条请求。
- Codex：每次调用的 `total_tokens`。缓存已经包含在输入里。模型名来自这一轮选定的模型。
- Grok：每次推理的 `prompt_tokens + completion_tokens`。缓存已经包含在输入里。日志里单次推理不带模型名，所以沿用最近一次模型切换。

缓存读取会让 Claude 的合计明显变大。

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
