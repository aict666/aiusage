import assert from "node:assert/strict";
import test from "node:test";
import { terminalOptions } from "../lib/terminal.js";

const tty = { isTTY: true, columns: 60, hasColors: () => true };

test("modern terminals keep color and use their own column counts", () => {
  const options = terminalOptions([], { env: {}, stdout: tty, stderr: { ...tty, columns: 40 } });
  assert.equal(options.color, true);
  assert.equal(options.statusColor, true);
  assert.equal(options.status, true);
  assert.equal(options.ascii, false);
  assert.equal(options.width, 60);
  assert.equal(options.statusWidth, 39);
});

test("NO_COLOR, monochrome consoles, and pipes never receive color escapes", () => {
  for (const env of [{ NO_COLOR: "" }, { NO_COLOR: "1" }, { TERM: "dumb" }]) {
    const options = terminalOptions([], { env, stdout: tty, stderr: tty });
    assert.equal(options.color, false);
    assert.equal(options.statusColor, false);
  }
  assert.equal(terminalOptions(["--no-color"], { env: {}, stdout: tty }).color, false);
  assert.equal(terminalOptions([], { env: {}, stdout: { ...tty, hasColors: () => false } }).color, false);
  const piped = terminalOptions([], { env: {}, stdout: {}, stderr: {} });
  assert.equal(piped.color, false);
  assert.equal(piped.status, false);
  assert.equal(piped.width, 80);
});

test("dumb and legacy consoles can use ASCII decorations without a live status", () => {
  const dumb = terminalOptions([], { env: { TERM: "dumb" }, stdout: tty, stderr: tty });
  assert.equal(dumb.ascii, true);
  assert.equal(dumb.status, false);
  assert.equal(terminalOptions(["--ascii"], { env: {}, stdout: tty }).ascii, true);
  for (const flag of ["--json", "--demo"]) {
    assert.equal(terminalOptions([flag], { env: {}, stdout: tty, stderr: tty }).status, false);
  }
});
