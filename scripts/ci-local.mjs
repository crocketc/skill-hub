import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(scriptDirectory, "..");
const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";

const steps = [
  { name: "Rust formatting", command: "cargo", args: ["fmt", "--all", "--", "--check"] },
  { name: "Dependency and license policy", command: "cargo", args: ["deny", "check", "advisories", "bans", "licenses", "sources"] },
  { name: "Rust lints", command: "cargo", args: ["clippy", "--locked", "--workspace", "--all-targets", "--all-features", "--", "-D", "warnings"] },
  { name: "Rust tests", command: "cargo", args: ["test", "--locked", "--workspace"] },
  { name: "Frontend dependencies", command: pnpm, args: ["install", "--frozen-lockfile", "--ignore-scripts"] },
  { name: "Frontend lifecycle policy", command: pnpm, args: ["verify:lifecycle"] },
  { name: "Frontend dependency audit", command: pnpm, args: ["audit:frontend"] },
  { name: "Frontend lint and typecheck", command: pnpm, args: ["check:frontend"] },
  { name: "Frontend tests", command: pnpm, args: ["test:frontend"] },
  { name: "Frontend production build", command: pnpm, args: ["build:frontend"] },
];

if (process.argv.includes("--list")) {
  for (const [index, step] of steps.entries()) console.log(`${index + 1}. ${step.name}`);
  process.exit(0);
}

if (!existsSync(resolve(projectRoot, "Cargo.toml")) || !existsSync(resolve(projectRoot, "pnpm-workspace.yaml"))) {
  console.error("无法定位 SkillHub 项目根目录，请从仓库内运行本地 CI。\n");
  process.exit(1);
}

console.log(`SkillHub local CI · ${process.platform} · ${new Date().toLocaleString()}`);
console.log(`项目目录：${projectRoot}\n`);

// Windows 上并行 rustc 会间歇性命中 target\debug\deps 下随机文件的写入拒绝
// （`os error 5`）或 link.exe LNK1104（文件句柄被安全软件/文件监视器瞬时占用）。
// 该抖动与代码无关且换一次进程即消失，因此仅当失败输出命中该特征时自动重试，
// 真实失败（断言、编译错误等）不重试、直接失败，避免掩盖问题。
const windowsFileLockPattern = /os error 5|LNK1104|拒绝访问/;
const maxRetries = 3;

function runStep(step, { capture = false, serial = false } = {}) {
  return spawnSync(step.command, step.args, {
    cwd: projectRoot,
    env: {
      ...process.env,
      CI: "1",
      // 串行复跑经验证可消除并行 rustc 的写入拒绝抖动；仅作用于第 3 次及
      // 以后的重试，首次与首次重试仍按默认并行度执行，不掩盖正常表现。
      ...(serial && step.command === "cargo" ? { CARGO_BUILD_JOBS: "1" } : {}),
    },
    stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
    // Windows exposes pnpm through a .cmd shim, which Node cannot launch
    // with shell=false. Every command and argument here is repository-owned;
    // enabling the platform shell only fixes shim resolution and does not
    // accept user-provided command text.
    shell: process.platform === "win32",
  });
}

for (const [index, step] of steps.entries()) {
  const startedAt = Date.now();
  console.log(`[${index + 1}/${steps.length}] ${step.name}`);
  let result = runStep(step);

  if (!result.error && result.status !== 0) {
    for (let retry = 1; retry <= maxRetries; retry++) {
      const retryResult = runStep(step, { capture: true, serial: retry >= 2 });
      const output = `${retryResult.stdout ?? ""}${retryResult.stderr ?? ""}`;
      if (output.trim()) process.stderr.write(output);
      if (retryResult.error) {
        console.error(`\n${step.name} 无法启动：${retryResult.error.message}`);
        process.exit(1);
      }
      if (retryResult.status === 0) {
        console.log(`第 ${retry + 1} 次尝试通过（此前失败命中 Windows 文件锁抖动，已自动重试）。`);
        result = retryResult;
        break;
      }
      if (!windowsFileLockPattern.test(output)) {
        // 非抖动特征的真实失败：不再重试，立即失败。
        result = retryResult;
        break;
      }
      console.warn(`重试 ${retry}/${maxRetries}：失败输出命中 Windows 文件锁抖动特征（os error 5 / LNK1104）。`);
      result = retryResult;
    }
  }

  if (result.error) {
    console.error(`\n${step.name} 无法启动：${result.error.message}`);
    process.exit(1);
  }
  if (result.status !== 0) {
    console.error(`\n本地 CI 在“${step.name}”失败（耗时 ${((Date.now() - startedAt) / 1000).toFixed(1)} 秒）。`);
    process.exit(result.status ?? 1);
  }
  console.log(`通过（耗时 ${((Date.now() - startedAt) / 1000).toFixed(1)} 秒）\n`);
}

console.log("本地 CI 全部通过。");
