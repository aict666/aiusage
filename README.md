# aiusage

在终端查看 Claude、Codex、Grok 的套餐额度和本机 token 用量。

它读取你已经登录过的 CLI，不创建自己的账号，也不上传日志或令牌。

```text
额度

Claude  pro
  5 小时      [#---------------]    6%   剩余  94%   重置 今天 13:30，4 小时后
  7 天        [#############---]   84%   剩余  16%   重置 11-01 03:00，41 小时后

Codex  prolite
  每周        [##--------------]   13%   剩余  87%   重置 11-04 15:33，5 天后

Grok  SuperGrok
  每周        [#########-------]   60%   剩余  40%   重置 11-02 14:56，3 天后

Token

  Claude  Opus 5.5     今天   352.8万   近 7 天    16.61亿   近 30 天    19.88亿
          Sonnet 4.6   今天    12.4万   近 7 天     1.20亿   近 30 天     1.40亿
  Codex   GPT-6.1 Sol  今天        0   近 7 天     9.63亿   近 30 天    18.78亿
  Grok    Grok 4.7     今天   1171万   近 7 天     1.07亿   近 30 天     1.22亿
```

上面的数字只是示例。

## 安装

macOS 用 Homebrew。装上的是独立可执行文件，不需要 Python，也不需要 Node.js。

```bash
brew install aict666/tap/aiusage
aiusage
```

从源码运行需要 Node.js 18 或更高版本，没有额外依赖：

```bash
git clone https://github.com/aict666/aiusage.git
cd aiusage
node bin/aiusage.js
```

也可以：

```bash
npx github:aict666/aiusage
```

## 使用前

三个服务各自独立。没登录的会显示「未登录」，其余的照常输出。

| 服务 | 先完成 | 程序读取 |
| --- | --- | --- |
| Claude | 登录 Claude Code | macOS 钥匙串 `Claude Code-credentials`，或其他系统上的 `~/.claude/.credentials.json` |
| Codex | 登录 Codex CLI | `~/.codex/auth.json` |
| Grok | 登录 Grok CLI | `~/.grok/auth.json` |

自定义目录时认这几个环境变量：`CLAUDE_CONFIG_DIR`、`CODEX_HOME`、`GROK_HOME`。Claude 也可以用 `CLAUDE_CODE_OAUTH_TOKEN`。

Claude 和 Grok 的访问令牌过期时，程序会用本机的 refresh token 换新令牌并写回原处。Claude 写回钥匙串或 `~/.claude/.credentials.json`，Grok 写回 `~/.grok/auth.json`。用环境变量提供的令牌不会被改写。

## 命令

```bash
aiusage
aiusage --json
aiusage --no-color
aiusage --version
```

终端里会同时读取三个服务。某个服务的接口失败时退出码为 1，已经读到的结果仍会打印。三个都未登录时退出码也是 1。

设置 `NO_COLOR` 或加上 `--no-color` 会关掉颜色。`--json` 适合再交给别的脚本。

## 额度

额度来自各家当前的用量接口，显示的是已用比例、剩余比例和重置时间。

- 绿色低于 50%，黄色 50% 到 80%，红色达到 80%。
- 5 小时内重置会写成「今天」或「明天」，更远的写成月-日。
- 重置时间后面带倒计时，例如「41 小时后」或「5 天后」。

这些接口没有公开文档。客户端改版后，这里可能需要跟着改。

## Token 怎么算

Token 来自本机日志，不是套餐剩余额度。按本地时区切分。近 7 天、近 30 天都包含今天。

终端按模型分行，并用万、亿缩短数字。`aiusage --json` 里仍是原始 token 数，并带每个模型的明细。

- Claude：每次请求的输入、缓存写入、缓存读取和输出。同一次请求只取最后一条。模型名来自这条请求。
- Codex：每次调用的 `total_tokens`。缓存已经包含在输入里。模型名来自这一轮选定的模型。
- Grok：每次推理的 `prompt_tokens + completion_tokens`。缓存已经包含在输入里。日志里单次推理不带模型名，所以沿用最近一次模型切换。

缓存读取会让 Claude 的合计明显变大。

## 隐私

程序只访问本机登录信息和上面三个额度接口。它不会打印令牌、邮箱或账号编号，也没有遥测。

## English

aiusage prints Claude, Codex, and Grok plan quotas, plus local token totals for today, 7 days, and 30 days.

```bash
brew install aict666/tap/aiusage
aiusage
```

The Homebrew package is a standalone binary. Node.js 18 or newer can also run `node bin/aiusage.js` or `npx github:aict666/aiusage`. JSON output keeps raw token counts. The terminal shows 万 and 亿, split by model.
