import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const failures = [];
const checks = [];

function record(name, passed, detail = "") {
  checks.push({ name, passed, detail });
  if (!passed) failures.push(`${name}${detail ? `: ${detail}` : ""}`);
}

function readText(relativePath) {
  const absolutePath = resolve(projectRoot, relativePath);
  if (!existsSync(absolutePath)) {
    record(`file exists: ${relativePath}`, false, "missing");
    return "";
  }
  return readFileSync(absolutePath, "utf8");
}

function readJson(relativePath) {
  const text = readText(relativePath);
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch (error) {
    record(`valid JSON: ${relativePath}`, false, error.message);
    return null;
  }
}

const rootPackage = readJson("package.json");
const desktopPackage = readJson("apps/desktop/package.json");
const tauriConfig = readJson("apps/desktop/src-tauri/tauri.conf.json");
const windowsConfig = readJson("apps/desktop/src-tauri/tauri.windows.conf.json");
const macosConfig = readJson("apps/desktop/src-tauri/tauri.macos.conf.json");

for (const relativePath of [
  "Cargo.lock",
  "pnpm-lock.yaml",
  "scripts/ci-local.mjs",
  "scripts/ci-local.ps1",
  "scripts/ci-local.sh",
  "docs/本地CI使用.md",
  "docs/release-process.md",
  "docs/release-checklist.md",
  "scripts/generate_update_manifest.mjs",
  ".github/workflows/release.yml",
]) {
  const absolutePath = resolve(projectRoot, relativePath);
  record(`release input exists: ${relativePath}`, existsSync(absolutePath));
}

const requiredRootScripts = {
  "check:frontend": "pnpm --dir apps/desktop check",
  "test:frontend": "pnpm --dir apps/desktop test --run",
  "build:frontend": "pnpm --dir apps/desktop build",
  "verify:lifecycle": "node scripts/verify_frontend_lifecycle_scripts.mjs",
  "ci:local": "node scripts/ci-local.mjs",
  "verify:release": "node scripts/verify_release_readiness.mjs",
  "test:release": "node --test scripts/verify_release_readiness.test.mjs",
};
for (const [name, expected] of Object.entries(requiredRootScripts)) {
  record(`root script ${name}`, rootPackage?.scripts?.[name] === expected, `expected ${expected}`);
}

record("desktop dev script", desktopPackage?.scripts?.dev === "vite", "must start Vite for Tauri dev");
record("desktop build script", desktopPackage?.scripts?.build === "tsc --noEmit && vite build");
record("Tauri dev command is desktop-local", tauriConfig?.build?.beforeDevCommand === "pnpm dev");
record("Tauri build command is desktop-local", tauriConfig?.build?.beforeBuildCommand === "pnpm build");
record("Tauri frontend distribution", tauriConfig?.build?.frontendDist === "../dist");
record("Tauri updater artifacts enabled", tauriConfig?.bundle?.createUpdaterArtifacts === true);
const updaterEndpoints = tauriConfig?.plugins?.updater?.endpoints ?? [];
record(
  "Tauri updater endpoint is fixed official HTTPS",
  updaterEndpoints.length > 0 && updaterEndpoints.every((endpoint) => {
    try {
      const url = new URL(endpoint);
      return url.protocol === "https:" && url.hostname === "github.com" && url.pathname === "/crocketc/skill-hub/releases/latest/download/latest.json";
    } catch {
      return false;
    }
  }),
);
record("Tauri updater public key is configured", typeof tauriConfig?.plugins?.updater?.pubkey === "string" && tauriConfig.plugins.updater.pubkey.length > 20);
record("Windows installer is current-user", windowsConfig?.bundle?.windows?.nsis?.installMode === "currentUser");
record("macOS build is ad-hoc", macosConfig?.bundle?.macOS?.signingIdentity === "-");
record(
  "Windows updater artifact generation enabled",
  windowsConfig?.bundle?.createUpdaterArtifacts === true || windowsConfig?.bundle?.createUpdaterArtifacts === "v1Compatible",
);
record("macOS updater artifact generation enabled", macosConfig?.bundle?.createUpdaterArtifacts === true);
record("macOS first-install DMG and updater app target are both configured", macosConfig?.bundle?.targets?.includes("dmg") && macosConfig?.bundle?.targets?.includes("app"));

const placeholderPath = resolve(projectRoot, "apps/desktop/dist/.gitkeep");
record("tracked frontend dist placeholder exists", existsSync(placeholderPath));
if (existsSync(placeholderPath)) record("frontend dist placeholder is empty", statSync(placeholderPath).size === 0);
const gitignore = readText(".gitignore");
record("gitignore preserves frontend dist placeholder", gitignore.includes("!/apps/desktop/dist/.gitkeep"));

const releaseWorkflow = readText(".github/workflows/release.yml");
record("release preflight uses root frontend checks", releaseWorkflow.includes("pnpm check:frontend") && releaseWorkflow.includes("pnpm test:frontend"));
record("release packages desktop from its directory", releaseWorkflow.includes("pnpm --dir apps/desktop tauri build"));
record("release workflow injects signing key from CI secret", releaseWorkflow.includes("TAURI_SIGNING_PRIVATE_KEY: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY }}") && releaseWorkflow.includes("TAURI_SIGNING_PRIVATE_KEY_PASSWORD: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY_PASSWORD }}"));
record("release workflow checks the configured public key", releaseWorkflow.includes("TAURI_UPDATER_PUBLIC_KEY: ${{ vars.TAURI_UPDATER_PUBLIC_KEY }}") && releaseWorkflow.includes("TAURI_UPDATER_PUBLIC_KEY secret/variable is required"));
record("release workflow collects updater archives", releaseWorkflow.includes(".nsis.zip") && releaseWorkflow.includes(".app.tar.gz"));
record("release workflow generates latest.json", releaseWorkflow.includes("generate_update_manifest.mjs") && releaseWorkflow.includes("latest.json"));
record("release creates a draft", releaseWorkflow.includes("--draft"));
record("release is tag-bound", releaseWorkflow.includes("RELEASE_TAG") && releaseWorkflow.includes("git show-ref --verify"));

for (const relativePath of [".github/workflows/release.yml", ".github/workflows/supply-chain.yml"]) {
  const workflow = readText(relativePath);
  const refs = [...workflow.matchAll(/^\s*uses:\s*([^\s#]+)/gm)].map((match) => match[1]);
  record(`${relativePath} action refs are immutable`, refs.length > 0 && refs.every((ref) => /^[^@]+@[0-9a-f]{40}$/.test(ref)), refs.join(", "));
}

for (const relativePath of ["docs/install/windows-unsigned.md", "docs/install/macos-unnotarized.md"]) {
  const instructions = readText(relativePath).toLowerCase();
  const bypassCommand = /spctl\s+--master-disable|xattr\s+-d\s+com\.apple\.quarantine|set-mppreference|smartscreen.*disable/.test(instructions);
  record(`${relativePath} has no security bypass command`, !bypassCommand);
}

const report = { status: failures.length === 0 ? "pass" : "fail", failures, checks };
if (process.argv.includes("--json")) {
  console.log(JSON.stringify(report, null, 2));
} else {
  for (const check of checks) console.log(`${check.passed ? "PASS" : "FAIL"} ${check.name}${check.detail ? ` (${check.detail})` : ""}`);
  console.log(`\nRelease readiness: ${report.status.toUpperCase()}`);
}
process.exitCode = failures.length === 0 ? 0 : 1;
