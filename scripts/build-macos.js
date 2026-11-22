import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform !== "darwin") {
  console.error("build:macos 仅支持在 macOS 上运行。");
  process.exit(1);
}

const root = fileURLToPath(new URL("../", import.meta.url));
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const args = new Set(process.argv.slice(2));
const skipCliBundle = args.has("--no-bundle-cli");

const appDir = join(root, "dist", "AIUsage.app");
const contentsDir = join(appDir, "Contents");
const macosDir = join(contentsDir, "MacOS");
const resourcesDir = join(contentsDir, "Resources");

rmSync(appDir, { recursive: true, force: true });
mkdirSync(macosDir, { recursive: true });
mkdirSync(resourcesDir, { recursive: true });

const swiftSourceDir = join(root, "macos", "AIUsage");
const swiftFiles = readdirSync(swiftSourceDir)
  .filter((name) => name.endsWith(".swift"))
  .sort()
  .map((name) => join(swiftSourceDir, name));

const binaryPath = join(macosDir, "AIUsage");
console.log("正在编译原生 AppKit 菜单栏应用 (AIUsage.app)…");
const compile = spawnSync("swiftc", [
  "-O",
  "-whole-module-optimization",
  "-swift-version", "5",
  "-framework", "AppKit",
  "-framework", "Foundation",
  "-framework", "QuartzCore",
  ...swiftFiles,
  "-o", binaryPath,
], { cwd: root, stdio: "inherit" });

if (compile.error || compile.status !== 0) {
  console.error("Swift 编译失败，请确认已安装 Xcode Command Line Tools (xcode-select --install)。");
  process.exit(1);
}

spawnSync("strip", ["-x", binaryPath], { stdio: "ignore" });

if (!skipCliBundle) {
  const archTarget = process.arch === "arm64" ? "darwin-arm64" : "darwin-x64";
  const bunCheck = spawnSync("bun", ["--version"], { stdio: "ignore" });
  const prebuilt = join(root, "dist", `aiusage-${archTarget}`);
  const bundledCli = join(resourcesDir, "aiusage");

  if (bunCheck.status === 0) {
    console.log(`正在编译内置独立采集引擎 (${archTarget})…`);
    const buildCli = spawnSync(process.execPath, [join(root, "scripts", "build.js"), archTarget], {
      cwd: root,
      stdio: "inherit",
    });
    if (buildCli.status === 0 && existsSync(prebuilt)) {
      copyFileSync(prebuilt, bundledCli);
      chmodSync(bundledCli, 0o755);
    }
  } else if (existsSync(prebuilt)) {
    copyFileSync(prebuilt, bundledCli);
    chmodSync(bundledCli, 0o755);
  } else {
    console.log("未检测到 Bun，AIUsage.app 将通过系统 Node.js 或全局 aiusage 调用引擎。");
  }
}

const escapeXml = (str) => String(str)
  .replace(/&/g, "&amp;")
  .replace(/</g, "&lt;")
  .replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;");

const infoPlist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key>
  <string>zh_CN</string>
  <key>CFBundleDisplayName</key>
  <string>AIUsage</string>
  <key>CFBundleExecutable</key>
  <string>AIUsage</string>
  <key>CFBundleIdentifier</key>
  <string>com.aiusage.app</string>
  <key>CFBundleInfoDictionaryVersion</key>
  <string>6.0</string>
  <key>CFBundleName</key>
  <string>AIUsage</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>${escapeXml(pkg.version)}</string>
  <key>CFBundleVersion</key>
  <string>${escapeXml(pkg.version)}</string>
  <key>LSMinimumSystemVersion</key>
  <string>13.0</string>
  <key>LSUIElement</key>
  <true/>
  <key>NSHighResolutionCapable</key>
  <true/>
  <key>NSSupportsAutomaticTermination</key>
  <false/>
  <key>AIUsageRepoRoot</key>
  <string>${escapeXml(root)}</string>
</dict>
</plist>
`;

writeFileSync(join(contentsDir, "Info.plist"), infoPlist, "utf8");

// Ad-hoc sign bundle so Apple Silicon runs stripped/bundled binaries cleanly.
spawnSync("codesign", ["--force", "--deep", "--sign", "-", appDir], { stdio: "inherit" });

const uiBytes = statSync(binaryPath).size;
console.log(`构建完成：${appDir}（原生 UI 可执行文件仅 ${(uiBytes / 1024).toFixed(1)} KB）`);
