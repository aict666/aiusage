import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { runLive } from "../lib/live.js";

function surface() {
  const events = new EventEmitter();
  const stdout = Object.assign(new EventEmitter(), { columns: 120, rows: 40 });
  const stdin = Object.assign(new EventEmitter(), {
    isTTY: true, isRaw: false, paused: true,
    isPaused() { return this.paused; },
    setRawMode(raw) { this.isRaw = raw; },
    resume() { this.paused = false; },
    pause() { this.paused = true; },
  });
  const output = [];
  stdout.write = (text) => { output.push(text); return true; };
  return { events, stdout, stdin, output };
}

test("live refreshes sequentially, and resize/scroll never trigger a data read", async () => {
  const ui = surface();
  let reads = 0, running = 0, maxRunning = 0, repainted = false;
  const originalWrite = ui.stdout.write;
  ui.stdout.write = (text) => {
    originalWrite(text);
    if (text.includes("snapshot 1") && !repainted) {
      repainted = true;
      ui.stdout.emit("resize");
      ui.stdin.emit("data", Buffer.from("j"));
      assert.equal(reads, 1);
    }
    if (text.includes("snapshot 3")) ui.stdin.emit("data", Buffer.from("q"));
    return true;
  };
  await runLive({ ...ui, interval: 1,
    read: async () => {
      reads++; running++; maxRunning = Math.max(maxRunning, running);
      await new Promise((resolve) => setTimeout(resolve, 4));
      running--;
      return reads;
    },
    renderFrame: (value) => `snapshot ${value}\n`,
  });
  assert.equal(reads, 3);
  assert.equal(maxRunning, 1);
  assert.ok(ui.output[0].includes("\x1b[?1049h"));
  assert.ok(ui.output.at(-1).includes("\x1b[?25h\x1b[?1049l"));
  assert.equal(ui.stdin.isRaw, false);
  assert.equal(ui.stdin.paused, true);
  assert.equal(ui.stdout.listenerCount("resize"), 0);
  assert.equal(ui.stdin.listenerCount("data"), 0);
  assert.equal(ui.events.listenerCount("SIGINT"), 0);
});

test("short terminals show a scroll indicator and allow reading every row", async () => {
  const ui = surface();
  ui.stdout.rows = 6;
  let scrolled = false;
  const originalWrite = ui.stdout.write;
  ui.stdout.write = (text) => {
    originalWrite(text);
    if (text.includes("row 0") && !scrolled) {
      scrolled = true;
      ui.stdin.emit("data", Buffer.from("\x1b[B"));
      ui.stdin.emit("data", Buffer.from("q"));
    }
    return true;
  };
  await runLive({ ...ui, read: async () => [], renderFrame: () => Array.from({ length: 10 }, (_, index) => `row ${index}`).join("\n") });
  const viewport = ui.output.find((text) => text.includes("↑↓ 2-5/10"));
  assert.ok(viewport);
  assert.ok(viewport.includes("row 4"));
  assert.ok(!viewport.includes("row 0"));
  assert.ok(viewport.split("\r\n").length < ui.stdout.rows);
});

test("SIGINT aborts an active read and restores the terminal", async () => {
  const ui = surface();
  let aborted = false;
  await runLive({ ...ui,
    read: (_, signal) => new Promise((resolve) => {
      signal.addEventListener("abort", () => { aborted = true; resolve([]); }, { once: true });
      queueMicrotask(() => ui.events.emit("SIGINT"));
    }),
    renderFrame: () => "done",
  });
  assert.equal(aborted, true);
  assert.ok(ui.output.at(-1).includes("\x1b[?25h"));
  assert.equal(ui.events.listenerCount("SIGTERM"), 0);
});

test("an initially idle stdin is released on exit even when isPaused reports false", async () => {
  const ui = surface();
  ui.stdin.paused = false;
  ui.stdin.readableFlowing = null;
  await runLive({ ...ui,
    read: async () => { queueMicrotask(() => ui.events.emit("SIGINT")); return []; },
    renderFrame: () => "done",
  });
  assert.equal(ui.stdin.paused, true);
});
