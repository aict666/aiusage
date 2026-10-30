import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const targets = {
  "darwin-arm64": "bun-darwin-arm64",
  "darwin-x64": "bun-darwin-x64-baseline",
  "linux-arm64": "bun-linux-arm64",
  "linux-x64": "bun-linux-x64-baseline",
  "windows-x64": "bun-windows-x64-baseline",
};
const root = fileURLToPath(new URL("../", import.meta.url));
const output = join(root, "dist");
const native = `${process.platform === "win32" ? "windows" : process.platform}-${process.arch}`;
const args = process.argv.slice(2);
const requested = args.length === 0 ? [native] : args.includes("--all") ? Object.keys(targets) : args;
if (requested.some((target) => !targets[target])) {
  console.error(`支持的构建目标：${Object.keys(targets).join(", ")}，或 --all`);
  process.exit(1);
}
mkdirSync(output, { recursive: true });
for (const target of requested) {
  const filename = `aiusage-${target}${target.startsWith("windows-") ? ".exe" : ""}`;
  const result = spawnSync("bun", [
    "build", "--compile", `--target=${targets[target]}`, "--minify",
    "--no-compile-autoload-dotenv", "--no-compile-autoload-bunfig",
    join(root, "bin", "aiusage.js"), "--outfile", join(output, filename),
  ], { cwd: root, stdio: "inherit" });
  if (result.error || result.status !== 0) {
    console.error(result.error?.code === "ENOENT" ? "构建需要先安装 Bun。" : `构建 ${target} 失败：${result.error?.message || result.status}`);
    process.exit(1);
  }
}
const sums = Object.keys(targets).map((target) => `aiusage-${target}${target.startsWith("windows-") ? ".exe" : ""}`)
  .filter((filename) => existsSync(join(output, filename)))
  .map((filename) => `${createHash("sha256").update(readFileSync(join(output, filename))).digest("hex")}  ${filename}`);
writeFileSync(join(output, "SHA256SUMS"), sums.join("\n") + "\n");
