import { applyQuotaUpdate, collect } from "./collect.js";
import { demoReports } from "./demo.js";
import { displayWidth, render, dumps, truncate } from "./render.js";
import { terminalOptions } from "./terminal.js";
import { runLive } from "./live.js";
import { MIN_QUOTA_INTERVAL, QuotaCache } from "./quota-cache.js";

export const version = "0.4.1";

function printHelp() {
  process.stdout.write(`aiusage ${version}

查看 Claude、Codex、Grok 的套餐额度和本机 token 用量。

用法
  aiusage            打印额度和本机 token
  aiusage --json     输出 JSON
  aiusage --live     持续刷新；本机 15 秒，远程额度 10–11 分钟
  aiusage --offline  只读本机日志和已缓存额度，不请求网络
  --interval 秒     live 本机刷新间隔（默认 15，至少 5）
  --quota-interval 秒 额度刷新间隔（默认 600，至少 600，另加 0–60 秒）
  aiusage --demo     用示例数据预览排版，不读取登录信息
  aiusage --ascii    使用 ASCII 线条，适合旧终端
  aiusage --details  展开输入输出、缓存命中率等逐项明细
  aiusage --no-color 关闭颜色
  aiusage --version  显示版本
`);
}

export function parseOptions(argv) {
  const flags = new Set(["--json", "--demo", "--ascii", "--details", "--no-color", "--live", "--offline"]);
  const options = { interval: 15_000, quotaInterval: MIN_QUOTA_INTERVAL };
  const args = argv.map((arg) => arg === "live" ? "--live" : arg);
  for (let index = 0; index < args.length; index += 1) {
    const [name, inline] = args[index].split("=");
    if (name === "--interval" || name === "--quota-interval") {
      const value = Number(inline ?? args[++index]);
      const minimum = name === "--interval" ? 5 : 600;
      if (!Number.isFinite(value) || value < minimum || value > 86400) throw new Error(`${name} 必须是 ${minimum}–86400 秒`);
      options[name === "--interval" ? "interval" : "quotaInterval"] = value * 1000;
    } else if (flags.has(name) && inline === undefined) options[name.slice(2)] = true;
    else throw new Error(`未知参数：${args[index]}`);
  }
  if (options.live && options.json) throw new Error("--live 不能与 --json 同时使用");
  if (!options.live && args.some((arg) => arg === "--interval" || arg.startsWith("--interval="))) throw new Error("--interval 需要与 --live 一起使用");
  return options;
}

export async function main(argv) {
  if (argv.includes("--help") || argv.includes("-h")) {
    printHelp();
    return 0;
  }
  if (argv.includes("--version") || argv.includes("-v")) {
    process.stdout.write(`aiusage ${version}\n`);
    return 0;
  }
  let options;
  try {
    options = parseOptions(argv);
  } catch (error) {
    process.stderr.write(`${error.message}\n使用 aiusage --help 查看用法。\n`);
    return 2;
  }
  const { json, demo, live, offline, interval, quotaInterval } = options;
  const terminal = terminalOptions(argv);
  if (live) {
    if (!terminal.interactive) {
      process.stderr.write("--live 需要支持光标控制的交互终端；管道输出请使用 aiusage 或 --json。\n");
      return 2;
    }
    const quotaCache = new QuotaCache({ interval: quotaInterval, offline, background: true });
    try {
      return await runLive({
        interval, quotaInterval, offline, ascii: terminal.ascii,
        subscribe: (listener) => quotaCache.subscribe(listener),
        applyUpdate: applyQuotaUpdate,
        read: (now, signal) => demo ? demoReports(now) : collect(now, null, { quotaCache, signal }),
        renderFrame: (reports, now) => render(reports, { ...terminalOptions(argv), now, demo, details: options.details }),
      });
    } finally {
      quotaCache.stop();
      await quotaCache.drain();
    }
  }
  const now = new Date();
  let clearWidth = 0;
  const status = terminal.status
    ? (text) => {
        text = truncate(text, terminal.statusWidth);
        const width = displayWidth(text);
        const blank = Math.max(0, clearWidth - width);
        const line = text + " ".repeat(blank);
        process.stderr.write(terminal.statusColor ? `\x1b[2m${line}\x1b[0m\r` : `${line}\r`);
        clearWidth = Math.max(clearWidth, width);
      }
    : null;
  let reports;
  try {
    reports = demo ? demoReports(now) : await collect(now, status, { interval: quotaInterval, offline });
  } finally {
    if (terminal.status) process.stderr.write(`${" ".repeat(clearWidth)}\r`);
  }
  if (json) process.stdout.write(dumps(reports, now));
  else process.stdout.write(render(reports, { ...terminal, now, demo, details: argv.includes("--details") }));
  if (reports.some((report) => report.error)) return 1;
  if (reports.length && reports.every((report) => report.skipped)) return 1;
  return 0;
}
