import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { displayWidth } from "../lib/render.js";

const command = fileURLToPath(new URL("../bin/aiusage.js", import.meta.url));

function run(args, env = {}) {
  return spawnSync(process.execPath, [command, ...args], {
    encoding: "utf8",
    timeout: 10_000,
    env: { ...process.env, TERM: "xterm-256color", ...env },
  });
}

test("demo renders without credentials, errors, or terminal escape codes in a pipe", () => {
  const result = run(["--demo"]);
  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
  assert.match(result.stdout, /aiusage · 示例/);
  assert.match(result.stdout, /Sonnet 4\.6/);
  assert.equal(result.stdout.includes("\x1b"), false);
  assert.ok(result.stdout.split("\n").every((line) => displayWidth(line) <= 80));
});

test("demo JSON preserves raw counts and the existing schema", () => {
  const result = run(["--demo", "--json"]);
  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
  const data = JSON.parse(result.stdout);
  assert.equal(data.providers.length, 3);
  assert.equal(data.providers[0].tokens.models[0].today, 3_527_818);
  assert.equal(data.providers[1].windows[0].used_percent, 13);
  assert.equal(data.providers[0].tokens.today, data.providers[0].tokens.models.reduce((sum, row) => sum + row.today, 0));
  assert.ok(data.generated_at);
  assert.ok(data.token_notes);
  assert.equal(data.pricing.currency, "USD");
  assert.ok(data.providers[0].tokens.usage.today.cache_read_tokens > 0);
  assert.ok(data.providers[0].tokens.usage.today.cost_usd > 0);
  assert.equal(data.cost_totals.today.incomplete, false);
});

test("ASCII mode keeps data and column widths without Unicode decorations", () => {
  for (const entry of [{ args: ["--demo", "--ascii", "--no-color"] }, { args: ["--demo"], env: { TERM: "dumb" } }]) {
    const result = run(entry.args, entry.env);
    assert.equal(result.status, 0);
    assert.equal(result.stderr, "");
    assert.match(result.stdout, /#+-+/);
    assert.doesNotMatch(result.stdout, /[━─·—\x1b]/u);
    assert.match(result.stdout, /3\.53M/);
    assert.ok(result.stdout.split("\n").every((line) => displayWidth(line) <= 80));
  }
});
