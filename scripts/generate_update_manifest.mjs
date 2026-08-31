import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";

const artifactsDirectory = resolve(process.argv[2] ?? "artifacts");
const version = process.env.SKILLHUB_RELEASE_VERSION;
const tag = process.env.SKILLHUB_RELEASE_TAG;
const notes = process.env.SKILLHUB_RELEASE_NOTES_FILE && existsSync(resolve(process.env.SKILLHUB_RELEASE_NOTES_FILE))
  ? readFileSync(resolve(process.env.SKILLHUB_RELEASE_NOTES_FILE), "utf8")
  : "";
const outputPath = resolve(process.argv[3] ?? `${artifactsDirectory}/latest.json`);

if (!version || !tag) {
  throw new Error("SKILLHUB_RELEASE_VERSION and SKILLHUB_RELEASE_TAG are required");
}
if (!existsSync(artifactsDirectory)) throw new Error(`Artifacts directory is missing: ${artifactsDirectory}`);

const baseUrl = `https://github.com/crocketc/skill-hub/releases/download/${encodeURIComponent(tag)}`;
const files = readdirSync(artifactsDirectory).map((name) => ({ name, path: resolve(artifactsDirectory, name) }));
const signatures = new Map(
  files
    .filter(({ name }) => name.endsWith(".sig"))
    .map(({ name, path }) => [name.slice(0, -4), readFileSync(path, "utf8").trim()]),
);
const platforms = {};

for (const { name } of files) {
  if (!name.endsWith(".nsis.zip") && !name.endsWith(".app.tar.gz")) continue;
  const signature = signatures.get(name);
  if (!signature) throw new Error(`Missing updater signature for ${name}`);
  const platformKeys = platformKeysFor(name);
  for (const key of platformKeys) {
    platforms[key] = { signature, url: `${baseUrl}/${encodeURIComponent(name)}` };
  }
}

for (const key of ["windows-x86_64", "windows-aarch64", "darwin-x86_64", "darwin-aarch64"]) {
  if (!platforms[key]) throw new Error(`Missing updater platform asset: ${key}`);
}

writeFileSync(outputPath, `${JSON.stringify({ version, notes, pub_date: new Date().toISOString(), platforms }, null, 2)}\n`);

function platformKeysFor(name) {
  if (name.endsWith(".app.tar.gz")) return ["darwin-x86_64", "darwin-aarch64"];
  if (/(aarch64|arm64)/i.test(name)) return ["windows-aarch64"];
  if (/(x86_64|x64|amd64)/i.test(name)) return ["windows-x86_64"];
  throw new Error(`Cannot infer Windows updater architecture from ${basename(name)}`);
}
