import { setTimeout as delay } from "node:timers/promises";
import { truncate } from "./render.js";

// Repaint/scroll/resize never trigger a read. There is only one sequential reader.
export async function runLive({ read, renderFrame, interval = 15_000, quotaInterval = 600_000, offline = false,
  ascii = false, stdout = process.stdout, stdin = process.stdin, events = process, now = () => new Date() }) {
  const controller = new AbortController();
  const stop = () => controller.abort();
  let reports = null;
  let offset = 0;
  let frameError = null;
  const raw = stdin.isRaw;
  const wasFlowing = stdin.readableFlowing === true;
  const footer = () => `LIVE · 本机 ${interval / 1000}秒 · ${offline ? "额度离线" : `额度 ≥${quotaInterval / 60_000}分`} · q/Ctrl+C 退出`;
  const paint = () => {
    if (controller.signal.aborted) return;
    const width = Math.max(16, stdout.columns || 80);
    const height = Math.max(4, stdout.rows || 24);
    const text = reports ? renderFrame(reports, now()) : "  正在读取本机日志与额度…\n";
    const lines = text.trimEnd().split("\n");
    if (frameError) lines.push(`  读取失败：${frameError}`);
    const available = height - 2;
    offset = Math.max(0, Math.min(offset, Math.max(0, lines.length - available)));
    const scroll = lines.length > available ? ` · ${ascii ? "j/k" : "↑↓"} ${offset + 1}-${Math.min(lines.length, offset + available)}/${lines.length}` : "";
    const status = `${footer()}${scroll}`;
    const visible = [...lines.slice(offset, offset + available), "  " + truncate(ascii ? status.replace(/·/g, "/") : status, width - 3)];
    stdout.write(`\x1b[H${visible.map((line) => `${line}\x1b[K`).join("\r\n")}\x1b[J`);
  };
  const onData = (bytes) => {
    const key = String(bytes);
    if (key === "q" || key === "Q" || key === "\x03" || key === "\x04") return stop();
    if (key === "\x1b[B" || key === "j") offset += 1;
    if (key === "\x1b[A" || key === "k") offset -= 1;
    if (key === "\x1b[6~") offset += Math.max(1, (stdout.rows || 24) - 3);
    if (key === "\x1b[5~") offset -= Math.max(1, (stdout.rows || 24) - 3);
    paint();
  };
  const signals = ["SIGINT", "SIGTERM", "SIGHUP"];
  try {
    for (const signal of signals) events.on(signal, stop);
    stdout.on("resize", paint);
    if (stdin.isTTY && typeof stdin.setRawMode === "function") {
      stdin.setRawMode(true);
      stdin.resume();
      stdin.on("data", onData);
    }
    stdout.write("\x1b[?1049h\x1b[?25l");
    paint();
    while (!controller.signal.aborted) {
      try {
        reports = await read(now(), controller.signal);
        frameError = null;
      } catch (error) {
        if (controller.signal.aborted) break;
        frameError = error.message;
      }
      paint();
      if (!controller.signal.aborted) await delay(interval, undefined, { signal: controller.signal }).catch((error) => {
        if (!controller.signal.aborted) throw error;
      });
    }
    return 0;
  } finally {
    controller.abort();
    for (const signal of signals) events.removeListener(signal, stop);
    stdout.removeListener("resize", paint);
    stdin.removeListener("data", onData);
    if (stdin.isTTY && typeof stdin.setRawMode === "function") {
      stdin.setRawMode(Boolean(raw));
      if (!wasFlowing) stdin.pause();
    }
    stdout.write("\x1b[?25h\x1b[?1049l");
  }
}
