import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const appBinary = join(root, "dist", "AIUsage.app", "Contents", "MacOS", "AIUsage");
const cliEntry = join(root, "bin", "aiusage.js");

test("macOS native AIUsage binary decodes CLI JSON (including Codex epoch resets_at) and lays out all tabs cleanly", {
  skip: process.platform !== "darwin" || !existsSync(appBinary),
}, () => {
  const demoJson = spawnSync(process.execPath, [cliEntry, "--demo", "--json"], {
    encoding: "utf8",
    timeout: 10_000,
  });
  assert.equal(demoJson.status, 0, demoJson.stderr);

  // Simulate Codex returning numeric Unix epoch seconds for resets_at (as wham/usage does in production)
  const parsed = JSON.parse(demoJson.stdout);
  parsed.providers[1].windows[0].resets_at = Math.floor(Date.now() / 1000) + 86_400;

  const check = spawnSync(appBinary, ["--self-test"], {
    input: JSON.stringify(parsed),
    encoding: "utf8",
    timeout: 10_000,
  });
  assert.equal(check.status, 0, check.stderr);
  assert.match(check.stdout, /SELF-TEST PASS: 4 providers decoded and 6 tabs laid out/);
});
