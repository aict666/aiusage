import { randomUUID } from "node:crypto";
import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, posix, win32 } from "node:path";

export function configHome(envName, fallback, { env = process.env, homeDir = homedir(), platform = process.platform } = {}) {
  const paths = platform === "win32" ? win32 : posix;
  const configured = env[envName];
  if (!configured) return paths.join(homeDir, fallback);
  if (configured === "~") return homeDir;
  if (configured.startsWith("~/") || (platform === "win32" && configured.startsWith("~\\"))) {
    return paths.join(homeDir, configured.slice(2));
  }
  return configured;
}

export function parseJson(text) {
  return JSON.parse(text.replace(/^\uFEFF/u, ""));
}

export function readJson(path) {
  const bytes = readFileSync(path);
  // PowerShell and Windows editors may write UTF-8 BOM or UTF-16 LE files.
  const text = bytes[0] === 0xff && bytes[1] === 0xfe ? bytes.subarray(2).toString("utf16le") : bytes.toString("utf8");
  return parseJson(text);
}

export function writePrivateJson(path, value) {
  const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}
