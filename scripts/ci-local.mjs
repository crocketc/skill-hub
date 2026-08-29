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

for (const [index, step] of steps.entries()) {
  const startedAt = Date.now();
  console.log(`[${index + 1}/${steps.length}] ${step.name}`);
  const result = spawnSync(step.command, step.args, {
    cwd: projectRoot,
    env: { ...process.env, CI: "1" },
    stdio: "inherit",
    shell: false,
  });
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
