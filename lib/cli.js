import { collect } from "./collect.js";
import { demoReports } from "./demo.js";
import { displayWidth, render, dumps, truncate } from "./render.js";
import { terminalOptions } from "./terminal.js";

export const version = "0.3.2";

function printHelp() {
  process.stdout.write(`aiusage ${version}

查看 Claude、Codex、Grok 的套餐额度和本机 token 用量。

用法
  aiusage            打印额度和本机 token
  aiusage --json     输出 JSON
  aiusage --demo     用示例数据预览排版，不读取登录信息
  aiusage --ascii    使用 ASCII 线条，适合旧终端
  aiusage --details  展开输入输出、缓存命中率等逐项明细
  aiusage --no-color 关闭颜色
  aiusage --version  显示版本
`);
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
  const json = argv.includes("--json");
  const demo = argv.includes("--demo");
  const terminal = terminalOptions(argv);
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
    reports = demo ? demoReports(now) : await collect(now, status);
  } finally {
    if (terminal.status) process.stderr.write(`${" ".repeat(clearWidth)}\r`);
  }
  if (json) process.stdout.write(dumps(reports, now));
  else process.stdout.write(render(reports, { ...terminal, now, demo, details: argv.includes("--details") }));
  if (reports.some((report) => report.error)) return 1;
  if (reports.length && reports.every((report) => report.skipped)) return 1;
  return 0;
}
