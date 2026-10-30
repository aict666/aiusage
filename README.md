# ai-quota

在终端查看 Claude、Codex、Grok 的套餐额度，以及本机今天、近 7 天、近 30 天的 token 用量。

已经用对应的 CLI 登录过就可以直接运行。程序只读本机登录和日志，没有自己的账号，也没有遥测。

## 安装

macOS 用 Homebrew。装上的是独立可执行文件，不需要 Python，也不需要 Node.js：

```bash
brew install jax-yu/tap/ai-quota
ai-quota
```

从源码运行需要 Node.js 18 或更高版本，没有额外依赖：

```bash
git clone https://github.com/jax-yu/ai-quota.git
cd ai-quota
node bin/ai-quota.js
```

已发布到 GitHub 后，也可以：

```bash
npx github:jax-yu/ai-quota
```

## 使用前

三个服务各自独立。没登录的会显示「未登录」，其余的照常输出。

| 服务 | 先完成 | 程序读取 |
| --- | --- | --- |
| Claude | 登录 Claude Code | macOS 钥匙串 `Claude Code-credentials`，或其他系统上的 `~/.claude/.credentials.json` |
| Codex | 登录 Codex CLI | `~/.codex/auth.json` |
| Grok | 登录 Grok CLI | `~/.grok/auth.json` |

自定义目录时认这几个环境变量：`CLAUDE_CONFIG_DIR`、`CODEX_HOME`、`GROK_HOME`。Claude 也可以用 `CLAUDE_CODE_OAUTH_TOKEN`。

Grok 的访问令牌大约 6 小时过期。过期时程序会用本机的 refresh token 换新令牌，并写回 `~/.grok/auth.json`。

## 命令

```bash
ai-quota
ai-quota --json
ai-quota --no-color
ai-quota --version
```

某个服务的接口失败时退出码为 1，已经读到的结果仍会打印。三个都未登录时退出码也是 1。

## Token 怎么算

额度来自各家当前的用量接口。Token 来自本机日志，按本地时区切分。近 7 天、近 30 天都包含今天。

- Claude：每次请求的输入、缓存写入、缓存读取和输出。同一次请求只取最后一条。
- Codex：每次调用的 `total_tokens`。缓存已经包含在输入里。
- Grok：每次推理的 `prompt_tokens + completion_tokens`。缓存已经包含在输入里。

这些数字是调用量，不是套餐剩余额度。缓存读取会让 Claude 的合计明显变大。

额度接口没有公开文档，客户端改版后这里可能需要跟着改。程序不会上传日志，也不会把令牌打印出来。

## English

ai-quota prints plan quotas for Claude, Codex, and Grok, plus local token totals for today, 7 days, and 30 days.

```bash
brew install jax-yu/tap/ai-quota
ai-quota
```

The Homebrew package is a standalone binary. Node.js 18 or newer can also run `node bin/ai-quota.js` or `npx github:jax-yu/ai-quota`.
