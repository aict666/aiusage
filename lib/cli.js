import { applyQuotaUpdate, collect } from "./collect.js";
import { demoReports } from "./demo.js";
import { displayWidth, render, dumps, truncate } from "./render.js";
import { terminalOptions } from "./terminal.js";
import { runLive } from "./live.js";
import { MIN_QUOTA_INTERVAL, QuotaCache } from "./quota-cache.js";
import {
  formatAgyAccountsList,
  guardAgyKeychain,
  listAgyAccounts,
  prepareNewAgyLogin,
  removeAgyAccount,
  renameAgyAccount,
  saveCurrentAgyAccount,
  setAgyAutoGuard,
  stopRunningAgyProcesses,
  switchAgyAccount,
} from "./agy-accounts.js";

export const version = "0.4.7";

function printHelp() {
  process.stdout.write(`aiusage ${version}

查看 Claude、Codex、Grok 的套餐额度和本机 token 用量，以及 agy 的套餐额度与多账号票据管理。

用法
  aiusage            打印额度和本机 token
  aiusage --json     输出 JSON
  aiusage --live     持续刷新；本机 15 秒，远程额度 10–11 分钟
  aiusage --refresh  强制立即请求一次远程额度（跳过 10 分钟缓存，15 秒防连点）
  aiusage --offline  只读本机日志和已缓存额度，不请求网络
  --interval 秒     live 本机刷新间隔（默认 15，至少 5）
  --quota-interval 秒 额度刷新间隔（默认 600，至少 600，另加 0–60 秒）
  aiusage --demo     用示例数据预览排版，不读取登录信息
  aiusage --ascii    使用 ASCII 线条，适合旧终端
  aiusage --details  展开输入输出、缓存命中率等逐项明细
  aiusage --no-color 关闭颜色
  aiusage agy ...    管理本机 agy 账号票据与手动切换（详见 aiusage agy --help）
  aiusage --version  显示版本
`);
}

function printAgyHelp() {
  process.stdout.write(`aiusage agy — 本机 agy 账号票据保存与手动切换（macOS 钥匙串）

用法
  aiusage agy [list] [--verify] [--json]                    查看已保存的 agy 账号
  aiusage agy save [别名] [--json]                          保存当前已登录的 agy 票据（别名可省略）
  aiusage agy switch <别名|序号|-> [--close-running] [-f]   手动切换账号（切走前自动同步当前号最新票据）
  aiusage agy guard [--json]                                检查钥匙串防覆写（被旧进程改回时自动恢复目标号）
  aiusage agy auto-guard <on|off> [--json]                  开关切号防旧进程覆写保护（默认开启）
  aiusage agy stop-running [--all] [--json]                 温和退出切号前遗留的旧账号 agy（加 --all 关闭全部）
  aiusage agy logout [--force] [--json]                     清空当前活跃登录，方便运行 agy 登录新账号
  aiusage agy rename <原别名|序号> <新别名>                 重命名账号别名
  aiusage agy remove <别名|序号> [--json]                   删除已保存的票据（不影响当前登录）

说明
  票据保存在本机 macOS 钥匙串，不写明文到磁盘，不做任何 API 代理或自动轮换。
  切换账号后，若终端正在运行 agy，退出后运行 agy -c 即可继续最近会话。
`);
}

function writeAgyJson(payload) {
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

export function runAgyCommandCli(argv, options = {}) {
  const flags = {
    json: argv.includes("--json"),
    force: false,
    closeRunning: false,
    all: false,
    verify: false,
    help: false,
  };
  const positional = [];
  for (const arg of argv) {
    if (arg === "--json") flags.json = true;
    else if (arg === "--force" || arg === "-f") flags.force = true;
    else if (arg === "--close-running") flags.closeRunning = true;
    else if (arg === "--all") flags.all = true;
    else if (arg === "--verify") flags.verify = true;
    else if (arg === "--help" || arg === "-h") flags.help = true;
    else if (arg.startsWith("-") && arg !== "-") {
      const msg = `未知参数：${arg}`;
      if (flags.json) writeAgyJson({ ok: false, error: msg, code: "INVALID_ARGUMENT" });
      else process.stderr.write(`${msg}\n使用 aiusage agy --help 查看用法。\n`);
      return 2;
    } else {
      positional.push(arg);
    }
  }
  if (flags.help) {
    printAgyHelp();
    return 0;
  }

  const sub = (positional[0] || "list").toLowerCase();
  const rest = positional.slice(1);

  try {
    if (sub === "list" || sub === "ls" || sub === "accounts") {
      const result = listAgyAccounts({ verify: flags.verify, ...options });
      if (flags.json) writeAgyJson({ ok: true, ...result });
      else process.stdout.write(formatAgyAccountsList(result));
      return 0;
    }

    if (sub === "save" || sub === "add") {
      if (rest.length > 1) throw Object.assign(new Error("save 最多接受一个别名参数（带空格请加引号）"), { exitCode: 2 });
      const result = saveCurrentAgyAccount({ alias: rest[0] ?? null, ...options });
      if (flags.json) writeAgyJson({ ok: true, ...result });
      else {
        const showEmail = result.account.email && result.account.email.toLowerCase() !== result.account.alias.toLowerCase();
        const emailPart = showEmail ? `（${result.account.email}）` : "";
        const verb = result.action === "updated" ? "已更新保存的 agy 账号" : "已保存当前 agy 账号";
        process.stdout.write(`${verb}：${result.account.alias}${emailPart}\n`);
      }
      return 0;
    }

    if (sub === "switch" || sub === "use") {
      if (rest.length !== 1) throw Object.assign(new Error("请指定要切换的账号别名、序号或 \"-\""), { exitCode: 2 });
      const result = switchAgyAccount(rest[0], { force: flags.force, closeRunning: flags.closeRunning, ...options });
      if (flags.json) writeAgyJson({ ok: true, ...result });
      else if (result.action === "already_active") {
        process.stdout.write(`当前已是 agy 账号「${result.account.alias}」${result.synced_current ? "（已同步最新票据）" : ""}。\n`);
      } else {
        const synced = result.synced_current ? `（已自动同步「${result.synced_current}」最新票据）` : "";
        const stoppedPart = result.stopped_agy_count > 0 ? `已关闭 ${result.stopped_agy_count} 个旧账号 agy 进程，` : "";
        const staleCount = result.stale_agy_count ?? 0;
        const runningWarn = staleCount > 0
          ? (result.auto_guard
            ? `已开启防覆写保护（本机另有 ${staleCount} 个切号前遗留的旧账号 agy 进程，可按需运行 aiusage agy stop-running 关闭）。`
            : `注意：检测到本机有 ${staleCount} 个切号前的旧账号 agy 进程，请先退出旧 agy 再运行 agy -c 继续会话。`)
          : `${stoppedPart}新开终端运行 agy -c 即可继续会话。`;
        process.stdout.write(`已切换到 agy 账号「${result.account.alias}」${synced}。\n${runningWarn}\n`);
      }
      return 0;
    }

    if (sub === "guard") {
      if (rest.length > 0) throw Object.assign(new Error("guard 不接受额外参数"), { exitCode: 2 });
      const result = guardAgyKeychain(options);
      if (flags.json) writeAgyJson({ ok: true, ...result });
      else if (result.guarded) {
        process.stdout.write(`已自动防覆写：同步了「${result.guarded_overwriter}」的新票据，并恢复当前为「${result.active_alias}」。\n`);
      } else {
        process.stdout.write(`当前钥匙串状态正常（${result.active_alias || result.live_status}）。\n`);
      }
      return 0;
    }

    if (sub === "auto-guard") {
      const mode = (rest[0] || "").toLowerCase();
      if (!["on", "off", "true", "false", "1", "0"].includes(mode)) {
        throw Object.assign(new Error("用法：aiusage agy auto-guard <on|off>"), { exitCode: 2 });
      }
      const enabled = ["on", "true", "1"].includes(mode);
      const result = setAgyAutoGuard(enabled, options);
      if (flags.json) writeAgyJson({ ok: true, ...result });
      else process.stdout.write(`已${enabled ? "开启" : "关闭"} agy 切号防旧进程覆写保护。\n`);
      return 0;
    }

    if (sub === "stop-running" || sub === "stop") {
      if (rest.length > 0) throw Object.assign(new Error("stop-running 不接受额外参数"), { exitCode: 2 });
      const result = stopRunningAgyProcesses({ all: flags.all, ...options });
      if (flags.json) writeAgyJson({ ok: true, action: "stopped_running", ...result });
      else if (result.stopped_count > 0) {
        const keptNote = result.skipped_current_count > 0 ? `（保留了 ${result.skipped_current_count} 个当前账号窗口）` : "";
        process.stdout.write(`已向 ${result.stopped_count} 个${flags.all ? "" : "旧账号 "}agy 进程发送温和退出信号${keptNote}。\n`);
      } else if (result.skipped_current_count > 0) {
        process.stdout.write(`当前没有切号前遗留的旧账号 agy 进程（已保护 ${result.skipped_current_count} 个当前账号窗口；如需强制关闭全部请加 --all）。\n`);
      } else {
        process.stdout.write("当前没有检测到需要关闭的旧账号 agy 进程。\n");
      }
      return 0;
    }

    if (sub === "logout" || sub === "clear") {
      if (rest.length > 0) throw Object.assign(new Error("logout 不接受额外参数"), { exitCode: 2 });
      const result = prepareNewAgyLogin({ force: flags.force, ...options });
      if (flags.json) writeAgyJson({ ok: true, ...result });
      else {
        const synced = result.synced_account ? `（已保存「${result.synced_account}」最新票据）` : "";
        process.stdout.write(`已清空当前 agy 登录态${synced}。\n现在可在终端运行 agy 登录新账号，登录完成后运行 aiusage agy save <别名> 保存。\n`);
      }
      return 0;
    }

    if (sub === "rename" || sub === "mv") {
      if (rest.length !== 2) throw Object.assign(new Error("用法：aiusage agy rename <原别名|序号> <新别名>"), { exitCode: 2 });
      const result = renameAgyAccount(rest[0], rest[1], options);
      if (flags.json) writeAgyJson({ ok: true, ...result });
      else process.stdout.write(`已将「${result.previous_alias}」重命名为「${result.account.alias}」。\n`);
      return 0;
    }

    if (sub === "remove" || sub === "rm" || sub === "delete") {
      if (rest.length !== 1) throw Object.assign(new Error("用法：aiusage agy remove <别名|序号>"), { exitCode: 2 });
      const result = removeAgyAccount(rest[0], options);
      if (flags.json) writeAgyJson({ ok: true, ...result });
      else process.stdout.write(`已删除已保存的 agy 账号「${result.removed.alias}」（不影响当前登录态）。\n`);
      return 0;
    }

    throw Object.assign(new Error(`未知 agy 子命令：${sub}`), { exitCode: 2 });
  } catch (error) {
    const code = error.code || "ERROR";
    if (flags.json) writeAgyJson({ ok: false, error: error.message, code });
    else process.stderr.write(`${error.message}\n`);
    return error.exitCode || 1;
  }
}

export function parseOptions(argv) {
  const flags = new Set(["--json", "--demo", "--ascii", "--details", "--no-color", "--live", "--offline", "--refresh"]);
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
  if (options.refresh && options.live) throw new Error("--refresh 不能与 --live 同时使用");
  if (options.refresh && options.offline) throw new Error("--refresh 不能与 --offline 同时使用");
  if (!options.live && args.some((arg) => arg === "--interval" || arg.startsWith("--interval="))) throw new Error("--interval 需要与 --live 一起使用");
  return options;
}

export async function main(argv) {
  if (argv[0] === "agy") {
    return runAgyCommandCli(argv.slice(1));
  }
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
  const { json, demo, live, offline, refresh, interval, quotaInterval } = options;
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
    reports = demo ? demoReports(now) : await collect(now, status, { interval: quotaInterval, offline, force: Boolean(refresh) });
  } finally {
    if (terminal.status) process.stderr.write(`${" ".repeat(clearWidth)}\r`);
  }
  if (json) process.stdout.write(dumps(reports, now));
  else process.stdout.write(render(reports, { ...terminal, now, demo, details: argv.includes("--details") }));
  if (reports.some((report) => report.error)) return 1;
  if (reports.length && reports.every((report) => report.skipped)) return 1;
  return 0;
}
