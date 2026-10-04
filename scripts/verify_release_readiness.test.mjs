import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { delimiter, dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import test from "node:test";

const scriptsDirectory = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(scriptsDirectory, "..");

function createCiLocalCommandMocks(scenario) {
  const temporaryDirectory = mkdtempSync(resolve(tmpdir(), "skillhub-ci-local-"));
  const binDirectory = resolve(temporaryDirectory, "bin");
  const stateDirectory = resolve(temporaryDirectory, "state");
  const pathDelimiter = process.platform === "win32" ? ";" : delimiter;
  mkdirSync(binDirectory);
  mkdirSync(stateDirectory);
  const mockTool = `
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const tool = process.argv[2];
const args = process.argv.slice(3);
const key = tool === "cargo" && args[0] === "fmt" ? "cargo-fmt" : tool;
const countFile = resolve(process.env.SKILLHUB_CI_LOCAL_TEST_STATE, key + ".count");
let count = 0;
try { count = Number(readFileSync(countFile, "utf8")); } catch {}
count += 1;
writeFileSync(countFile, String(count));

if (tool === "cargo" && process.env.SKILLHUB_CI_LOCAL_TEST_SCENARIO === "genuine-failure" && count === 1) {
  process.stderr.write("error: assertion failed in test target\\n");
  process.exit(17);
}
if (tool === "cargo" && process.env.SKILLHUB_CI_LOCAL_TEST_SCENARIO === "file-lock-recovery" && count === 1) {
  process.stderr.write("error: could not write file (os error 5)\\n");
  process.exit(17);
}
`;

  const makeExecutable = (name) => {
    if (process.platform === "win32") {
      writeFileSync(resolve(binDirectory, `${name}.cmd`), `@echo off\r\nnode "%~dp0mock-tool.mjs" ${name} %*\r\nexit /b %ERRORLEVEL%\r\n`);
    } else {
      const scriptPath = resolve(binDirectory, name);
      writeFileSync(scriptPath, `#!/bin/sh\nexec node "$(dirname "$0")/mock-tool.mjs" ${name} "$@"\n`);
      chmodSync(scriptPath, 0o755);
    }
  };

  writeFileSync(resolve(binDirectory, "mock-tool.mjs"), mockTool);
  makeExecutable("cargo");
  makeExecutable("pnpm");

  return {
    temporaryDirectory,
    env: {
      ...process.env,
      PATH: `${binDirectory}${pathDelimiter}${process.env.PATH ?? ""}`,
      SKILLHUB_CI_LOCAL_TEST_STATE: stateDirectory,
      SKILLHUB_CI_LOCAL_TEST_SCENARIO: scenario,
    },
    countFile(tool) {
      return resolve(stateDirectory, `${tool}.count`);
    },
  };
}

test("release readiness audit accepts the checked-out repository", () => {
  const result = spawnSync(process.execPath, ["scripts/verify_release_readiness.mjs", "--json"], {
    cwd: projectRoot,
    encoding: "utf8",
  });

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const report = JSON.parse(result.stdout);
  assert.equal(report.status, "pass");
  assert.equal(report.failures.length, 0);
});

test("frontend build cleanup restores the tracked dist placeholder", () => {
  const temporaryDirectory = mkdtempSync(resolve(tmpdir(), "skillhub-dist-"));
  try {
    const result = spawnSync(process.execPath, ["scripts/ensure_frontend_dist_placeholder.mjs"], {
      cwd: projectRoot,
      env: { ...process.env, SKILLHUB_FRONTEND_DIST: temporaryDirectory },
      encoding: "utf8",
    });

    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.equal(readFileSync(resolve(temporaryDirectory, ".gitkeep"), "utf8"), "");
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});

test("release configuration keeps updater artifacts separate from first-install packages", () => {
  const workflow = readFileSync(resolve(projectRoot, ".github/workflows/release.yml"), "utf8");
  const windowsConfig = JSON.parse(readFileSync(resolve(projectRoot, "apps/desktop/src-tauri/tauri.windows.conf.json"), "utf8"));
  const macosConfig = JSON.parse(readFileSync(resolve(projectRoot, "apps/desktop/src-tauri/tauri.macos.conf.json"), "utf8"));

  assert.equal(windowsConfig.bundle.targets.includes("nsis"), true);
  assert.equal(macosConfig.bundle.targets.includes("dmg"), true);
  assert.match(workflow, /TAURI_SIGNING_PRIVATE_KEY/);
  assert.match(workflow, /\.nsis\.zip/);
  assert.match(workflow, /\.app\.tar\.gz/);
  assert.match(workflow, /latest\.json/);
  assert.match(workflow, /TAURI_SIGNING_PRIVATE_KEY_PASSWORD/);
  assert.match(workflow, /TAURI_UPDATER_PUBLIC_KEY/);
  assert.match(workflow, /apt-get install -y pkg-config libglib2\.0-dev libgtk-3-dev libwebkit2gtk-4\.1-dev/);
  assert.doesNotMatch(workflow, /TAURI_SIGNING_PRIVATE_KEY_PASSWORD secret is required/);
});

test("release CSP allows the Tauri IPC custom protocol on every platform", () => {
  const config = JSON.parse(readFileSync(resolve(projectRoot, "apps/desktop/src-tauri/tauri.conf.json"), "utf8"));
  const directives = new Map(
    String(config.app?.security?.csp ?? "")
      .split(";")
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const [name, ...values] = part.split(/\s+/);
        return [name.toLowerCase(), values];
      }),
  );

  // connect-src 缺席会回落到 default-src 'self'，Tauri 的 IPC 自定义协议被拒后
  // 每次启动都退回 postMessage；ipc: 覆盖 macOS/Linux，http://ipc.localhost 覆盖
  // Windows/Android。
  assert.deepEqual(directives.get("connect-src"), ["'self'", "ipc:", "http://ipc.localhost"]);
  assert.deepEqual(directives.get("script-src"), ["'self'"]);
  assert.deepEqual(directives.get("default-src"), ["'self'"]);
  // DEV-4：内联样式显式放行（组件 `style={{…}}` 广泛存在），脚本源不放宽。
  assert.deepEqual(directives.get("style-src"), ["'self'", "'unsafe-inline'"]);
});

test("release readiness rejects updater endpoints that are not fixed HTTPS GitHub endpoints", () => {
  const config = JSON.parse(readFileSync(resolve(projectRoot, "apps/desktop/src-tauri/tauri.conf.json"), "utf8"));
  const endpoints = config.plugins?.updater?.endpoints ?? [];
  assert.ok(endpoints.length > 0);
  for (const endpoint of endpoints) {
    const url = new URL(endpoint);
    assert.equal(url.protocol, "https:");
    assert.equal(url.hostname, "github.com");
    assert.equal(url.pathname, "/crocketc/skill-hub/releases/latest/download/latest.json");
  }
});

test("release configuration stores the complete base64 minisign public key envelope", () => {
  const config = JSON.parse(readFileSync(resolve(projectRoot, "apps/desktop/src-tauri/tauri.conf.json"), "utf8"));
  const encodedPublicKey = config.plugins?.updater?.pubkey;
  assert.equal(typeof encodedPublicKey, "string");
  const decodedPublicKey = Buffer.from(encodedPublicKey, "base64").toString("utf8");
  assert.match(decodedPublicKey, /^untrusted comment: minisign public key:/);
  assert.match(decodedPublicKey, /\nRWQ[A-Za-z0-9+/=]+\s*$/);
});

test("release workflow collects bundles from the Tauri workspace target directory", () => {
  const workflow = readFileSync(resolve(projectRoot, ".github/workflows/release.yml"), "utf8");
  assert.match(workflow, /target\/\$\{\{ matrix\.target \}\}\/release\/bundle/);
  assert.match(workflow, /target\/universal-apple-darwin\/release\/bundle/);
  assert.doesNotMatch(workflow, /apps\/desktop\/src-tauri\/target/);
});

test("Windows updater configuration requests NSIS zip artifacts", () => {
  const windowsConfig = JSON.parse(readFileSync(resolve(projectRoot, "apps/desktop/src-tauri/tauri.windows.conf.json"), "utf8"));
  assert.equal(windowsConfig.bundle.createUpdaterArtifacts, "v1Compatible");
});

test("update manifest generator emits all supported updater platforms", () => {
  const temporaryDirectory = mkdtempSync(resolve(tmpdir(), "skillhub-manifest-"));
  try {
    for (const name of [
      "SkillHub-x86_64-pc-windows-msvc.nsis.zip",
      "SkillHub-aarch64-pc-windows-msvc.nsis.zip",
      "SkillHub-macos-universal.app.tar.gz",
    ]) {
      writeFileSync(resolve(temporaryDirectory, name), "package");
      writeFileSync(resolve(temporaryDirectory, `${name}.sig`), "untrusted-test-signature");
    }
    const result = spawnSync(process.execPath, [
      "scripts/generate_update_manifest.mjs",
      temporaryDirectory,
      resolve(temporaryDirectory, "latest.json"),
    ], {
      cwd: projectRoot,
      env: { ...process.env, SKILLHUB_RELEASE_VERSION: "0.2.0", SKILLHUB_RELEASE_TAG: "v0.2.0" },
      encoding: "utf8",
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const manifest = JSON.parse(readFileSync(resolve(temporaryDirectory, "latest.json"), "utf8"));
    assert.equal(manifest.version, "0.2.0");
    assert.deepEqual(Object.keys(manifest.platforms).sort(), [
      "darwin-aarch64",
      "darwin-x86_64",
      "windows-aarch64",
      "windows-x86_64",
    ]);
    assert.match(manifest.platforms["windows-x86_64"].url, /releases\/download\/v0\.2\.0/);
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});

test("release workflow keeps audit evidence out of public release assets", () => {
  const workflow = readFileSync(resolve(projectRoot, ".github/workflows/release.yml"), "utf8");
  assert.match(workflow, /Separate release evidence from public assets/);
  assert.match(workflow, /Upload release evidence/);
  assert.match(workflow, /name: release-evidence-\$\{\{ env\.RELEASE_TAG \}\}/);
  assert.match(workflow, /find artifacts -maxdepth 1 -type f/);
  assert.doesNotMatch(workflow, /cp docs\/install\/windows-unsigned\.md artifacts/);
  assert.doesNotMatch(workflow, /cp docs\/install\/macos-unnotarized\.md artifacts/);
});

test("ci-local fails immediately when the first command failure is not a Windows file lock", () => {
  const fixture = createCiLocalCommandMocks("genuine-failure");
  try {
    const result = spawnSync(process.execPath, ["scripts/ci-local.mjs"], {
      cwd: projectRoot,
      env: fixture.env,
      encoding: "utf8",
    });

    assert.equal(result.status, 17, `${result.stdout}\n${result.stderr}`);
    assert.equal(readFileSync(fixture.countFile("cargo-fmt"), "utf8"), "1");
    assert.match(`${result.stdout}\n${result.stderr}`, /assertion failed/);
  } finally {
    rmSync(fixture.temporaryDirectory, { recursive: true, force: true });
  }
});

test("ci-local retries a first failure that identifies a Windows file lock", () => {
  const fixture = createCiLocalCommandMocks("file-lock-recovery");
  try {
    const result = spawnSync(process.execPath, ["scripts/ci-local.mjs"], {
      cwd: projectRoot,
      env: fixture.env,
      encoding: "utf8",
    });

    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.equal(readFileSync(fixture.countFile("cargo-fmt"), "utf8"), "2");
    assert.match(`${result.stdout}\n${result.stderr}`, /第 2 次尝试通过/);
  } finally {
    rmSync(fixture.temporaryDirectory, { recursive: true, force: true });
  }
});
