import { collect } from "./collect.js";
import { displayWidth, render, dumps } from "./render.js";

export const version = "0.2.0";

function printHelp() {
  process.stdout.write(`aiusage ${version}

查看 Claude、Codex、Grok 的套餐额度和本机 token 用量。

用法
  aiusage            打印额度和本机 token
  aiusage --json     输出 JSON
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
  const noColor = argv.includes("--no-color") || Boolean(process.env.NO_COLOR);
  const useColor = process.stdout.isTTY && !noColor && !json;
  const showStatus = process.stderr.isTTY && !json;
  let clearWidth = 0;
  const status = showStatus
    ? (text) => {
        const width = displayWidth(text);
        const blank = Math.max(0, clearWidth - width);
        process.stderr.write(`\x1b[2m${text}${" ".repeat(blank)}\x1b[0m\r`);
        clearWidth = Math.max(clearWidth, width);
      }
    : null;
  let reports;
  try {
    reports = await collect(new Date(), status);
  } finally {
    if (showStatus) process.stderr.write(`${" ".repeat(clearWidth)}\r`);
  }
  if (json) process.stdout.write(dumps(reports));
  else process.stdout.write(render(reports, { color: useColor }));
  if (reports.some((report) => report.error)) return 1;
  if (reports.length && reports.every((report) => report.skipped)) return 1;
  return 0;
}
