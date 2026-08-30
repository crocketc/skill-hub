import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import test from "node:test";

const scriptsDirectory = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(scriptsDirectory, "..");

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
