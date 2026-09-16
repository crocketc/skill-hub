// Standing gate for Windows-only code paths that this macOS machine cannot
// run or fully cross-compile (`skillhub-adapters` needs a Windows C toolchain
// because of `aws-lc-sys`). Type-checks, on the `x86_64-pc-windows-msvc`
// target:
//   1. `skillhub-core` with all targets (Windows branches of core modules).
//   2. A minimal scratch crate that `#[path]`-includes the real
//      `junction_windows.rs` so its Win32 signatures and `windows-sys` feature
//      flags are compiled on the Windows target.
// Type-checking is NOT runtime verification; runtime evidence still belongs
// to Windows manual acceptance (RC-13/RC-14).
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const repoRoot = resolve(new URL("..", import.meta.url).pathname);
const target = "x86_64-pc-windows-msvc";
const junctionModule = join(
  repoRoot,
  "crates/skillhub-adapters/src/deployment/junction_windows.rs",
);

function run(command, args, options = {}) {
  console.log(`$ ${command} ${args.join(" ")}`);
  execFileSync(command, args, {
    stdio: "inherit",
    cwd: repoRoot,
    ...options,
  });
}

let scratchDir;
try {
  run("rustup", ["target", "list", "--installed"], { stdio: "pipe" });
} catch {
  console.error(
    `error: ${target} is not installed; run \`rustup target add ${target}\` first.`,
  );
  process.exit(1);
}

try {
  run("cargo", [
    "check",
    `--target=${target}`,
    "-p",
    "skillhub-core",
    "--all-targets",
  ]);

  scratchDir = mkdtempSync(join(tmpdir(), "skillhub-windows-typecheck-"));
  writeFileSync(
    join(scratchDir, "Cargo.toml"),
    `[package]
name = "skillhub-junction-typecheck"
version = "0.0.0"
edition = "2021"
publish = false

[lib]
path = "lib.rs"

[dependencies]
windows-sys = { version = "0.61", features = [
  "Win32_Foundation",
  "Win32_Security",
  "Win32_Storage_FileSystem",
  "Win32_System_IO",
  "Win32_System_Ioctl",
  "Win32_System_SystemServices",
] }
`,
  );
  writeFileSync(
    join(scratchDir, "lib.rs"),
    `// Scratch crate: compiles the real junction module for the Windows target
// without building the rest of skillhub-adapters (see file header note).
#[path = "${junctionModule}"]
pub mod junction_windows;
`,
  );
  run("cargo", ["check", `--target=${target}`], { cwd: scratchDir });
} finally {
  if (scratchDir) {
    rmSync(scratchDir, { recursive: true, force: true });
  }
}

console.log("windows-only type checks passed (type check only, not runtime verification)");
