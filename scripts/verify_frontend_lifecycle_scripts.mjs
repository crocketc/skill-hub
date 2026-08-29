import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const lockPath = join(root, "pnpm-lock.yaml");
const policyPath = join(root, "docs", "dependency-policy.md");
const packageRoots = [join(root, "node_modules", ".pnpm"), join(root, "apps", "desktop", "node_modules", ".pnpm")];
const lifecycleNames = ["preinstall", "install", "postinstall", "prepare"];

function fail(message) {
  console.error(`lifecycle policy: ${message}`);
  process.exitCode = 1;
}

if (!existsSync(lockPath) || !existsSync(policyPath)) {
  fail("pnpm-lock.yaml and docs/dependency-policy.md are required");
  process.exit();
}

const lockText = readFileSync(lockPath, "utf8");
const policyText = readFileSync(policyPath, "utf8");
const allow = new Set();
for (const line of policyText.split(/\r?\n/)) {
  const match = line.match(/^\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|/);
  if (!match || match[1].trim() === "package" || /^-+$/.test(match[1].trim())) continue;
  allow.add(`${match[1].trim()}@${match[2].trim()}#${match[3].trim()}`);
}

const observed = new Map();
function scan(directory) {
  if (!existsSync(directory)) return;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const entryPath = join(directory, entry.name);
    if (entry.isDirectory()) scan(entryPath);
    else if (entry.name === "package.json" && entryPath.includes(`${join("node_modules", "")}`)) {
      try {
        const pkg = JSON.parse(readFileSync(entryPath, "utf8"));
        const scripts = pkg.scripts ?? {};
        const names = lifecycleNames.filter((name) => typeof scripts[name] === "string");
        if (pkg.name && pkg.version && names.length) observed.set(`${pkg.name}@${pkg.version}`, { ...pkg, names });
      } catch {
        // Broken package metadata is reported by the package manager; do not execute it here.
      }
    }
  }
}
for (const packageRoot of packageRoots) scan(packageRoot);

for (const [identity, pkg] of observed) {
  if (!lockText.includes(`${pkg.name}@${pkg.version}`)) fail(`${identity} is not represented in pnpm-lock.yaml`);
  for (const scriptName of pkg.names) {
    const key = `${identity}#${scriptName}`;
    if (!allow.has(key)) fail(`${key} is not recorded in docs/dependency-policy.md`);
  }
}

for (const entry of allow) {
  const [identity, scriptName] = entry.split("#");
  if (!observed.has(identity)) fail(`${entry} is allowlisted but not present in the installed lockfile graph`);
  else if (!observed.get(identity).names.includes(scriptName)) fail(`${entry} is allowlisted but the package no longer declares that lifecycle script`);
}

if (process.exitCode) process.exit();
console.log(`lifecycle policy: ${observed.size} package identities checked; all lifecycle scripts are explicitly reviewed`);
