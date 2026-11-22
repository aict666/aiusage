import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  AGY_KEYCHAIN_ACCOUNT,
  AGY_KEYCHAIN_SERVICE,
  VAULT_KEYCHAIN_SERVICE,
  agyAccountsIndexPath,
  agyScopeForAccount,
  createMacKeychainStore,
  formatAgyAccountsList,
  guardAgyKeychain,
  inspectAgyCredential,
  listAgyAccounts,
  parseSecurityGenericOutput,
  prepareNewAgyLogin,
  readAgyAccountSummary,
  removeAgyAccount,
  renameAgyAccount,
  saveCurrentAgyAccount,
  setAgyAutoGuard,
  stopRunningAgyProcesses,
  switchAgyAccount,
} from "../lib/agy-accounts.js";
import { agyScope } from "../lib/agy.js";
import { QuotaCache } from "../lib/quota-cache.js";

const cliEntry = fileURLToPath(new URL("../bin/aiusage.js", import.meta.url));

function makeMemoryKeychain(initial = {}) {
  const map = new Map();
  let tick = 1;
  for (const [key, val] of Object.entries(initial)) {
    map.set(key, {
      buffer: Buffer.isBuffer(val) ? Buffer.from(val) : Buffer.from(String(val), "utf8"),
      createdAt: `2026112000000${tick++}Z`,
      modifiedAt: `2026112000000${tick++}Z`,
    });
  }
  const keyOf = (service, account) => `${service}\0${account}`;
  return {
    map,
    exists(service, account) {
      const entry = map.get(keyOf(service, account));
      if (!entry) return { exists: false, createdAt: null, modifiedAt: null };
      return { exists: true, createdAt: entry.createdAt, modifiedAt: entry.modifiedAt };
    },
    read(service, account) {
      const entry = map.get(keyOf(service, account));
      if (!entry) return null;
      return { buffer: Buffer.from(entry.buffer), createdAt: entry.createdAt, modifiedAt: entry.modifiedAt };
    },
    write(service, account, buffer) {
      const k = keyOf(service, account);
      const prev = map.get(k);
      const stamp = `202611200000${String(tick++).padStart(2, "0")}Z`;
      const entry = {
        buffer: Buffer.from(buffer),
        createdAt: prev ? prev.createdAt : stamp,
        modifiedAt: stamp,
      };
      map.set(k, entry);
      return { exists: true, createdAt: entry.createdAt, modifiedAt: entry.modifiedAt };
    },
    remove(service, account) {
      map.delete(keyOf(service, account));
      return true;
    },
  };
}

function makeJwt(payloadObj) {
  const b64 = (obj) => Buffer.from(JSON.stringify(obj), "utf8").toString("base64url");
  return `${b64({ alg: "RS256", typ: "JWT" })}.${b64(payloadObj)}.signature`;
}

test("parseSecurityGenericOutput decodes printable ASCII, hex-encoded JSON/binary, and NULL losslessly", () => {
  const meta = 'attributes:\n    "cdat"<timedate>=0x32303236  "20261117140105Z\\000"\n    "mdat"<timedate>=0x32303236  "20261120023638Z\\000"\n';

  const ascii = parseSecurityGenericOutput(meta, 'password: "simple-token-value"\n');
  assert.equal(ascii.buffer.toString("utf8"), "simple-token-value");
  assert.equal(ascii.createdAt, "20261117140105Z");
  assert.equal(ascii.modifiedAt, "20261120023638Z");

  const binaryOriginal = Buffer.from('{"a":"b\\nc"}\n\x00\xff', "latin1");
  const hex = parseSecurityGenericOutput(meta, `password: 0x${binaryOriginal.toString("hex").toUpperCase()}  "preview"\n`);
  assert.deepEqual(hex.buffer, binaryOriginal);

  const empty = parseSecurityGenericOutput(meta, "password: <NULL>\n");
  assert.equal(empty.buffer.length, 0);
});

test("inspectAgyCredential extracts safe email & stable identity hashes without returning raw secrets", () => {
  const jwt = makeJwt({ sub: "google-sub-1", email: "Alice@Example.com" });
  const credV1 = Buffer.from(JSON.stringify({
    access_token: "ya29.secret-v1",
    refresh_token: "1//refresh-secret-1",
    id_token: jwt,
  }));
  const credV2 = Buffer.from(JSON.stringify({
    access_token: "ya29.secret-v2-refreshed",
    refresh_token: "1//refresh-secret-1",
    id_token: jwt,
  }));

  const info1 = inspectAgyCredential(credV1);
  const info2 = inspectAgyCredential(credV2);
  assert.equal(info1.email, "Alice@Example.com");
  assert.equal(info1.identityHash, info2.identityHash);
  assert.notEqual(info1.payloadHash, info2.payloadHash);
  assert.doesNotMatch(JSON.stringify(info1), /ya29|refresh-secret/);

  // Binary / protobuf-like payload with embedded email still extracts email cleanly.
  const proto = Buffer.concat([Buffer.from([0x0a, 0x10]), Buffer.from("bob@company.org"), Buffer.from([0x12, 0x04, 0xde, 0xad, 0xbe, 0xef])]);
  const protoInfo = inspectAgyCredential(proto);
  assert.equal(protoInfo.email, "bob@company.org");
  assert.ok(protoInfo.identityHash);

  // go-keyring-base64: wrapped JSON (macOS Go keyring format used by agy) unwraps cleanly.
  const wrapped = Buffer.from(`go-keyring-base64:${credV1.toString("base64")}`, "utf8");
  const wrappedInfo = inspectAgyCredential(wrapped);
  assert.equal(wrappedInfo.email, "Alice@Example.com");
  assert.equal(wrappedInfo.identityHash, info1.identityHash);
  assert.doesNotMatch(JSON.stringify(wrappedInfo), /ya29|refresh-secret/);
});

test("createMacKeychainStore writes secrets via stdin hex only and checks stderr errors", () => {
  const calls = [];
  let itemExists = false;
  const store = createMacKeychainStore({
    agyExecutable: "/usr/local/bin/agy",
    spawnSync: (cmd, args, opts) => {
      calls.push({ cmd, args, input: opts?.input });
      if (args[0] === "find-generic-password") {
        if (!itemExists) return { status: 44, stdout: "", stderr: "The specified item could not be found in the keychain." };
        return { status: 0, stdout: '"cdat"<timedate>=0x31  "20261120000000Z\\000"\n', stderr: "" };
      }
      if (args[0] === "-i") {
        itemExists = true;
        return { status: 0, stdout: "", stderr: "" };
      }
      return { status: 0, stdout: "", stderr: "" };
    },
  });

  const secret = '{"refresh_token":"super-secret-token-xyz"}';
  store.write(AGY_KEYCHAIN_SERVICE, AGY_KEYCHAIN_ACCOUNT, Buffer.from(secret), { trustAgy: true });

  const writeCall = calls.find((c) => c.args[0] === "-i");
  assert.ok(writeCall);
  assert.ok(!JSON.stringify(writeCall.args).includes("super-secret"));
  assert.match(writeCall.input, /-T "\/usr\/bin\/security"/);
  assert.match(writeCall.input, /-X [0-9a-f]+\n$/);
  assert.ok(!writeCall.input.includes("super-secret"));

  // Updating an existing item uses -U without clobbering existing ACL via -T.
  calls.length = 0;
  store.write(AGY_KEYCHAIN_SERVICE, AGY_KEYCHAIN_ACCOUNT, Buffer.from(secret), { trustAgy: true });
  const updateCall = calls.find((c) => c.args[0] === "-i");
  assert.match(updateCall.input, /add-generic-password -U -s "gemini" -a "antigravity" -X /);
  assert.ok(!updateCall.input.includes("-T "));
});

test("full agy account lifecycle: save, auto-sync refreshed tokens, logout, switch '-', unsaved protection, rename, remove, and scope isolation", (t) => {
  const configDir = mkdtempSync(join(tmpdir(), "aiusage-agy-accounts-"));
  t.after(() => rmSync(configDir, { recursive: true, force: true }));
  const env = { AIUSAGE_CONFIG_DIR: configDir };

  const tokenA1 = JSON.stringify({ email: "main@gmail.com", refresh_token: "rt-A", access_token: "at-A-1" });
  const tokenA2 = JSON.stringify({ email: "main@gmail.com", refresh_token: "rt-A", access_token: "at-A-refreshed" });
  const tokenB1 = JSON.stringify({ email: "backup@gmail.com", refresh_token: "rt-B", access_token: "at-B-1" });
  const tokenC = JSON.stringify({ email: "unsaved@gmail.com", refresh_token: "rt-C", access_token: "at-C-1" });

  const keychain = makeMemoryKeychain({
    [`${AGY_KEYCHAIN_SERVICE}\0${AGY_KEYCHAIN_ACCOUNT}`]: tokenA1,
  });
  const opts = { env, keychain, platform: "darwin" };

  // 1. Save Account A
  const savedA = saveCurrentAgyAccount({ alias: "主号", ...opts });
  assert.equal(savedA.action, "saved");
  assert.equal(savedA.account.alias, "主号");
  assert.equal(savedA.account.email, "main@gmail.com");
  const scopeA = agyScope({ env });

  // Index file on disk must never contain raw tokens!
  const rawIndexText = readFileSync(agyAccountsIndexPath({ env }), "utf8");
  assert.doesNotMatch(rawIndexText, /rt-A|at-A-1/);

  // 2. Simulate agy refreshing A's access token in Keychain; saving again updates same slot instead of duplicating
  keychain.write(AGY_KEYCHAIN_SERVICE, AGY_KEYCHAIN_ACCOUNT, Buffer.from(tokenA2));
  const updatedA = saveCurrentAgyAccount(opts);
  assert.equal(updatedA.action, "updated");
  assert.equal(updatedA.accounts.length, 1);
  assert.equal(keychain.read(VAULT_KEYCHAIN_SERVICE, savedA.account.id).buffer.toString("utf8"), tokenA2);

  // 3. Logout cleanly so user can log into Account B
  const loggedOut = prepareNewAgyLogin(opts);
  assert.equal(loggedOut.action, "logged_out");
  assert.equal(keychain.exists(AGY_KEYCHAIN_SERVICE, AGY_KEYCHAIN_ACCOUNT).exists, false);

  // 4. User logs into Account B in agy and saves it
  keychain.write(AGY_KEYCHAIN_SERVICE, AGY_KEYCHAIN_ACCOUNT, Buffer.from(tokenB1));
  const savedB = saveCurrentAgyAccount({ alias: "副号", ...opts });
  assert.equal(savedB.action, "saved");
  assert.equal(savedB.accounts.length, 2);
  const scopeB = agyScope({ env });
  assert.notEqual(scopeA, scopeB);

  // 5. Switch back to previous account using "-" (B -> A) after B's token refreshed in live keychain
  const tokenB2 = JSON.stringify({ email: "backup@gmail.com", refresh_token: "rt-B", access_token: "at-B-refreshed" });
  keychain.write(AGY_KEYCHAIN_SERVICE, AGY_KEYCHAIN_ACCOUNT, Buffer.from(tokenB2));
  const switchedToA = switchAgyAccount("-", opts);
  assert.equal(switchedToA.action, "switched");
  assert.equal(switchedToA.account.alias, "主号");
  assert.equal(switchedToA.synced_current, "副号");
  assert.equal(keychain.read(AGY_KEYCHAIN_SERVICE, AGY_KEYCHAIN_ACCOUNT).buffer.toString("utf8"), tokenA2);
  assert.equal(keychain.read(VAULT_KEYCHAIN_SERVICE, savedB.account.id).buffer.toString("utf8"), tokenB2);
  assert.equal(readAgyAccountSummary({ env }).activeAccount.alias, "主号");

  // 6. Unsaved active login protection: external login to Account C must NOT be overwritten without force
  keychain.write(AGY_KEYCHAIN_SERVICE, AGY_KEYCHAIN_ACCOUNT, Buffer.from(tokenC));
  const verified = listAgyAccounts({ verify: true, ...opts });
  assert.equal(verified.live_status, "unsaved");
  assert.equal(verified.live_email, "unsaved@gmail.com");

  assert.throws(() => switchAgyAccount("副号", opts), (err) => err.code === "UNSAVED_ACTIVE_ACCOUNT");
  assert.throws(() => prepareNewAgyLogin(opts), (err) => err.code === "UNSAVED_ACTIVE_ACCOUNT");

  // With force: true, switching succeeds and restores Account B's refreshed bytes
  const forced = switchAgyAccount("副号", { force: true, ...opts });
  assert.equal(forced.action, "switched");
  assert.equal(keychain.read(AGY_KEYCHAIN_SERVICE, AGY_KEYCHAIN_ACCOUNT).buffer.toString("utf8"), tokenB2);

  // 7. Rename and duplicate rejection
  assert.throws(() => renameAgyAccount("副号", "主号", opts), /已存在/);
  const renamed = renameAgyAccount("副号", "备用号", opts);
  assert.equal(renamed.account.alias, "备用号");
  assert.equal(renamed.previous_alias, "副号");

  // 8. Remove deletes vault entry without logging out live keychain
  const removed = removeAgyAccount("主号", opts);
  assert.equal(removed.action, "removed");
  assert.equal(removed.accounts.length, 1);
  assert.equal(keychain.read(VAULT_KEYCHAIN_SERVICE, savedA.account.id), null);
  assert.equal(keychain.read(AGY_KEYCHAIN_SERVICE, AGY_KEYCHAIN_ACCOUNT).buffer.toString("utf8"), tokenB2);
});

test("CLI aiusage agy subcommands handle help, JSON listing, and argument validation cleanly", (t) => {
  const configDir = mkdtempSync(join(tmpdir(), "aiusage-agy-cli-"));
  t.after(() => rmSync(configDir, { recursive: true, force: true }));
  const env = { ...process.env, AIUSAGE_CONFIG_DIR: configDir };

  const help = spawnSync(process.execPath, [cliEntry, "agy", "--help"], { encoding: "utf8", env });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /aiusage agy save/);
  assert.match(help.stdout, /aiusage agy switch/);

  const list = spawnSync(process.execPath, [cliEntry, "agy", "list", "--json"], { encoding: "utf8", env });
  assert.equal(list.status, 0, list.stderr);
  const parsed = JSON.parse(list.stdout);
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.accounts, []);

  const badArg = spawnSync(process.execPath, [cliEntry, "agy", "--bogus", "--json"], { encoding: "utf8", env });
  assert.equal(badArg.status, 2);
  assert.equal(JSON.parse(badArg.stdout).ok, false);
});

test("listAgyAccounts attaches read-only per-account cached quota snapshots and detects passed reset times", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "aiusage-agy-snap-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const configDir = join(root, "config");
  const cacheDir = join(root, "cache");
  const env = { AIUSAGE_CONFIG_DIR: configDir, AIUSAGE_CACHE_DIR: cacheDir };

  const tokenA = JSON.stringify({ email: "a@example.com", refresh_token: "rt-a" });
  const tokenB = JSON.stringify({ email: "b@example.com", refresh_token: "rt-b" });
  const keychain = makeMemoryKeychain({ [`${AGY_KEYCHAIN_SERVICE}\0${AGY_KEYCHAIN_ACCOUNT}`]: tokenA });
  const opts = { env, keychain, platform: "darwin", cacheDirectory: cacheDir };

  const savedA = saveCurrentAgyAccount({ alias: "主号", ...opts });
  prepareNewAgyLogin(opts);
  keychain.write(AGY_KEYCHAIN_SERVICE, AGY_KEYCHAIN_ACCOUNT, Buffer.from(tokenB));
  const savedB = saveCurrentAgyAccount({ alias: "副号", ...opts });
  switchAgyAccount("主号", opts);

  // Seed separate QuotaCache entries for Account A and Account B (no network, no keychain writes).
  const t0 = Date.parse("2026-11-20T02:00:00Z");
  const cache = new QuotaCache({ directory: cacheDir, now: () => t0, random: () => 0 });
  await cache.refresh("agy", async () => [null, [
    { label: "Gemini 5 小时", usedPercent: 10, resetsAt: "2026-11-20T05:00:00Z" },
  ]], agyScopeForAccount(savedA.account.id, { env }));
  await cache.refresh("agy", async () => [null, [
    { label: "Gemini 5 小时", usedPercent: 100, resetsAt: "2026-11-20T03:00:00Z" },
    { label: "Claude/GPT 5 小时", usedPercent: 20, resetsAt: "2026-11-20T06:00:00Z" },
  ]], agyScopeForAccount(savedB.account.id, { env }));

  // At 02:30Z (before B's 03:00Z reset): reset_passed is false.
  const beforeReset = listAgyAccounts({ ...opts, now: new Date("2026-11-20T02:30:00Z") });
  const accBBefore = beforeReset.accounts.find((a) => a.alias === "副号");
  assert.equal(accBBefore.quota.windows[0].remaining_percent, 0);
  assert.equal(accBBefore.quota.windows[0].reset_passed, false);
  assert.equal(accBBefore.quota.windows[1].remaining_percent, 80);

  // At 03:30Z (after B's 03:00Z reset): Gemini 5h is marked reset_passed = true, Claude 5h stays false!
  const afterReset = listAgyAccounts({ ...opts, now: new Date("2026-11-20T03:30:00Z") });
  const accBAfter = afterReset.accounts.find((a) => a.alias === "副号");
  assert.equal(accBAfter.quota.windows[0].reset_passed, true);
  assert.equal(accBAfter.quota.windows[1].reset_passed, false);

  const rendered = formatAgyAccountsList(afterReset, { now: new Date("2026-11-20T03:30:00Z") });
  assert.match(rendered, /主号.*\[当前\]/);
  assert.match(rendered, /Gemini 5h 已到重置点（上次 0%）/);
  assert.match(rendered, /Claude 5h 80%/);
});

test("saving without an alias uses full email cleanly without duplicate display, and empty rename resets to email", (t) => {
  const configDir = mkdtempSync(join(tmpdir(), "aiusage-agy-email-alias-"));
  t.after(() => rmSync(configDir, { recursive: true, force: true }));
  const env = { AIUSAGE_CONFIG_DIR: configDir };

  const token = JSON.stringify({ email: "solo@gmail.com", refresh_token: "rt-solo" });
  const keychain = makeMemoryKeychain({ [`${AGY_KEYCHAIN_SERVICE}\0${AGY_KEYCHAIN_ACCOUNT}`]: token });
  const opts = { env, keychain, platform: "darwin" };

  // Save without alias -> defaults directly to email
  const saved = saveCurrentAgyAccount(opts);
  assert.equal(saved.account.alias, "solo@gmail.com");
  assert.equal(saved.account.email, "solo@gmail.com");

  const listText = formatAgyAccountsList(listAgyAccounts(opts));
  assert.match(listText, /solo@gmail\.com\s+\[当前\]/);
  assert.doesNotMatch(listText, /solo@gmail\.com.*\(solo@gmail\.com\)/);

  // Give custom nickname, then clear it back to email via empty rename
  renameAgyAccount(saved.account.id, "临时名", opts);
  const reset = renameAgyAccount(saved.account.id, "", opts);
  assert.equal(reset.account.alias, "solo@gmail.com");
});

test("auto-guard preserves old account refreshed tokens and restores pinned account, while manual mode reconciles honestly", (t) => {
  const configDir = mkdtempSync(join(tmpdir(), "aiusage-agy-drift-"));
  t.after(() => rmSync(configDir, { recursive: true, force: true }));
  const env = { AIUSAGE_CONFIG_DIR: configDir };

  const tokenA1 = JSON.stringify({ email: "first@example.com", refresh_token: "rt-A", access_token: "at-A-1" });
  const tokenA2 = JSON.stringify({ email: "first@example.com", refresh_token: "rt-A", access_token: "at-A-refreshed" });
  const tokenB1 = JSON.stringify({ email: "third@example.com", refresh_token: "rt-B", access_token: "at-B-1" });
  const tokenUnsaved = JSON.stringify({ email: "newfourth@example.com", refresh_token: "rt-D", access_token: "at-D-1" });

  const keychain = makeMemoryKeychain({
    [`${AGY_KEYCHAIN_SERVICE}\0${AGY_KEYCHAIN_ACCOUNT}`]: tokenA1,
  });
  const opts = { env, keychain, platform: "darwin" };

  // Save Account A and Account B; B is now active & pinned (autoGuard defaults to true).
  const savedA = saveCurrentAgyAccount({ alias: "master", ...opts });
  prepareNewAgyLogin(opts);
  keychain.write(AGY_KEYCHAIN_SERVICE, AGY_KEYCHAIN_ACCOUNT, Buffer.from(tokenB1));
  const savedB = saveCurrentAgyAccount({ alias: "third@example.com", ...opts });
  assert.equal(savedB.account.alias, "third@example.com");

  // 1. Default auto-guard ON: old running agy process refreshes Account A in place (same cdat, newer mdat).
  const beforeCdat = keychain.exists(AGY_KEYCHAIN_SERVICE, AGY_KEYCHAIN_ACCOUNT).createdAt;
  keychain.write(AGY_KEYCHAIN_SERVICE, AGY_KEYCHAIN_ACCOUNT, Buffer.from(tokenA2));
  assert.equal(keychain.exists(AGY_KEYCHAIN_SERVICE, AGY_KEYCHAIN_ACCOUNT).createdAt, beforeCdat);

  const guarded = guardAgyKeychain(opts);
  assert.equal(guarded.guarded, true);
  assert.equal(guarded.guarded_overwriter, "master");
  assert.equal(guarded.active_id, savedB.account.id);
  // Account A's newly refreshed token is safely preserved in vault, AND Keychain is restored to Account B!
  assert.equal(keychain.read(VAULT_KEYCHAIN_SERVICE, savedA.account.id).buffer.toString("utf8"), tokenA2);
  assert.equal(keychain.read(AGY_KEYCHAIN_SERVICE, AGY_KEYCHAIN_ACCOUNT).buffer.toString("utf8"), tokenB1);

  // Immediately checking again hits the fast path (no infinite loop!).
  const steady = guardAgyKeychain(opts);
  assert.equal(steady.guarded, false);
  assert.equal(steady.active_id, savedB.account.id);

  // 1b. Same-second collision regression: a second old agy process overwrites Keychain within
  // the EXACT same 1-second mdat timestamp as our guard restore! Payload-hash check must still catch it!
  const tokenA2b = JSON.stringify({ email: "first@example.com", refresh_token: "rt-A", access_token: "at-A-same-second-burst" });
  const liveSlotKey = `${AGY_KEYCHAIN_SERVICE}\0${AGY_KEYCHAIN_ACCOUNT}`;
  const sameSecondEntry = keychain.map.get(liveSlotKey);
  keychain.map.set(liveSlotKey, {
    buffer: Buffer.from(tokenA2b),
    createdAt: sameSecondEntry.createdAt,
    modifiedAt: sameSecondEntry.modifiedAt, // identical 1-second mdat!
  });
  const sameSecondGuarded = guardAgyKeychain(opts);
  assert.equal(sameSecondGuarded.guarded, true);
  assert.equal(sameSecondGuarded.guarded_overwriter, "master");
  assert.equal(sameSecondGuarded.active_id, savedB.account.id);
  assert.equal(keychain.read(VAULT_KEYCHAIN_SERVICE, savedA.account.id).buffer.toString("utf8"), tokenA2b);
  assert.equal(keychain.read(AGY_KEYCHAIN_SERVICE, AGY_KEYCHAIN_ACCOUNT).buffer.toString("utf8"), tokenB1);

  // 2. Auto-guard NEVER overwrites a brand-new UNSAVED login!
  keychain.write(AGY_KEYCHAIN_SERVICE, AGY_KEYCHAIN_ACCOUNT, Buffer.from(tokenUnsaved));
  const unsavedCheck = guardAgyKeychain(opts);
  assert.equal(unsavedCheck.guarded, false);
  assert.equal(unsavedCheck.live_status, "unsaved");
  assert.equal(keychain.read(AGY_KEYCHAIN_SERVICE, AGY_KEYCHAIN_ACCOUNT).buffer.toString("utf8"), tokenUnsaved);

  // Restore back to B with force, then disable auto-guard to verify honest reconciliation mode.
  switchAgyAccount(savedB.account.id, { force: true, ...opts });
  setAgyAutoGuard(false, opts);

  const tokenA3 = JSON.stringify({ email: "first@example.com", refresh_token: "rt-A", access_token: "at-A-refreshed-2" });
  keychain.write(AGY_KEYCHAIN_SERVICE, AGY_KEYCHAIN_ACCOUNT, Buffer.from(tokenA3));

  const listed = listAgyAccounts(opts);
  assert.equal(listed.guarded, false);
  assert.equal(listed.active_id, savedA.account.id);
  assert.equal(listed.reconciled_from, "third@example.com");
  assert.equal(listed.keychain_changed, true);
  assert.equal(keychain.read(VAULT_KEYCHAIN_SERVICE, savedA.account.id).buffer.toString("utf8"), tokenA3);

  // 3. Stale-only process protection: current-account agy windows must NEVER be closed!
  const killed = [];
  const tSwitch1 = new Date("2026-11-23T06:00:00.000Z");
  const tAfterSwitch1 = new Date("2026-11-23T06:01:00.000Z");
  const tSwitch2 = new Date("2026-11-23T06:02:00.000Z");

  // Before switching, active account is A; PIDs 4242 & 4243 are running on A -> NOT stale yet!
  const listBeforeSwitch = listAgyAccounts({
    ...opts,
    listRunningAgyProcesses: () => [
      { pid: 4242, startedAtMs: Date.parse("2026-11-23T05:50:00.000Z") },
      { pid: 4243, startedAtMs: Date.parse("2026-11-23T05:55:00.000Z") },
    ],
  });
  assert.equal(listBeforeSwitch.running_agy_count, 2);
  assert.equal(listBeforeSwitch.stale_agy_count, 0);

  // Calling stopRunningAgyProcesses when all windows belong to the current account must kill 0 processes!
  const stopCurrentOnly = stopRunningAgyProcesses({
    ...opts,
    listRunningAgyProcesses: () => [
      { pid: 4242, startedAtMs: Date.parse("2026-11-23T05:50:00.000Z") },
      { pid: 4243, startedAtMs: Date.parse("2026-11-23T05:55:00.000Z") },
    ],
    killPid: (pid, sig) => killed.push([pid, sig]),
  });
  assert.equal(stopCurrentOnly.stopped_count, 0);
  assert.equal(stopCurrentOnly.skipped_current_count, 2);
  assert.deepEqual(killed, []);

  // Switch A -> B WITHOUT closeRunning: PIDs 4242 & 4243 are now tagged as old Account A (stale_agy_count = 2).
  const switchedKeepOld = switchAgyAccount(savedB.account.id, {
    ...opts,
    now: tSwitch1,
    closeRunning: false,
    listRunningAgyProcesses: () => [
      { pid: 4242, startedAtMs: Date.parse("2026-11-23T05:50:00.000Z") },
      { pid: 4243, startedAtMs: Date.parse("2026-11-23T05:55:00.000Z") },
    ],
  });
  assert.equal(switchedKeepOld.stale_agy_count, 2);

  // User opens a NEW window PID 9002 under current Account B after the switch.
  const mixedProcs = () => [
    { pid: 4242, startedAtMs: Date.parse("2026-11-23T05:50:00.000Z") },
    { pid: 4243, startedAtMs: Date.parse("2026-11-23T05:55:00.000Z") },
    { pid: 9002, startedAtMs: tAfterSwitch1.getTime() },
  ];
  const listedMixed = listAgyAccounts({ ...opts, listRunningAgyProcesses: mixedProcs });
  assert.equal(listedMixed.running_agy_count, 3);
  assert.equal(listedMixed.stale_agy_count, 2);

  // Manual stop-running kills ONLY stale Account A PIDs (4242, 4243) and protects current Account B PID 9002!
  const manualStop = stopRunningAgyProcesses({
    ...opts,
    listRunningAgyProcesses: mixedProcs,
    killPid: (pid, sig) => killed.push([pid, sig]),
  });
  assert.equal(manualStop.stopped_count, 2);
  assert.equal(manualStop.skipped_current_count, 1);
  assert.deepEqual(killed, [[4242, "SIGTERM"], [4243, "SIGTERM"]]);

  // Switch back B -> A with closeRunning: PID 9002 (running on B) is closed, while an existing Account A PID 4244 stays untouched!
  killed.length = 0;
  const switchedBackWithClose = switchAgyAccount(savedA.account.id, {
    ...opts,
    now: tSwitch2,
    closeRunning: true,
    listRunningAgyProcesses: () => [{ pid: 9002, startedAtMs: tAfterSwitch1.getTime() }],
    killPid: (pid, sig) => killed.push([pid, sig]),
  });
  assert.equal(switchedBackWithClose.stopped_agy_count, 1);
  assert.equal(switchedBackWithClose.stale_agy_count, 0);
  assert.deepEqual(killed, [[9002, "SIGTERM"]]);
});
