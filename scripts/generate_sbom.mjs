import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(import.meta.dirname, "..");
const outArg = process.argv.indexOf("--out-dir");
const outDir = resolve(root, outArg >= 0 ? process.argv[outArg + 1] : "artifacts/sbom");
mkdirSync(outDir, { recursive: true });

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout;
}

function baseBom(name, version, components) {
  const digest = createHash("sha256").update(`${name}@${version}`).digest("hex");
  const serialNumber = `urn:uuid:${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-8${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
  return {
    bomFormat: "CycloneDX",
    specVersion: "1.5",
    serialNumber,
    version: 1,
    metadata: { timestamp: new Date().toISOString(), tools: [{ vendor: "SkillHub", name: "generate_sbom", version: "1" }] },
    components,
  };
}

const cargo = JSON.parse(run("cargo", ["metadata", "--locked", "--format-version", "1"]));
const cargoComponents = cargo.packages.map((pkg) => ({
  type: "library",
  name: pkg.name,
  version: pkg.version,
  purl: `pkg:cargo/${pkg.name}@${pkg.version}`,
  "bom-ref": `pkg:cargo/${pkg.name}@${pkg.version}`,
}));
writeFileSync(resolve(outDir, "rust.cdx.json"), `${JSON.stringify(baseBom("skillhub-rust", cargo.resolve?.nodes?.length ?? 0, cargoComponents), null, 2)}\n`);

const lock = readFileSync(resolve(root, "pnpm-lock.yaml"), "utf8");
const frontendComponents = [];
const seen = new Set();
for (const line of lock.split(/\r?\n/)) {
  const match = line.match(/^  ['"]?((?:@[^@:'"]+\/)?[^@:'"]+)@([^(:'"\s]+)['"]?:$/);
  if (!match) continue;
  const [, name, version] = match;
  const ref = `pkg:npm/${name}@${version}`;
  if (seen.has(ref)) continue;
  seen.add(ref);
  frontendComponents.push({ type: "library", name, version, purl: ref, "bom-ref": ref });
}
writeFileSync(resolve(outDir, "frontend.cdx.json"), `${JSON.stringify(baseBom("skillhub-frontend", frontendComponents.length, frontendComponents), null, 2)}\n`);

const combined = baseBom("skillhub", 1, [...cargoComponents, ...frontendComponents]);
combined.metadata.component = { type: "application", name: "SkillHub", version: "0.1.0" };
writeFileSync(resolve(outDir, "skillhub.cdx.json"), `${JSON.stringify(combined, null, 2)}\n`);
console.log(`SBOM written to ${outDir}: ${cargoComponents.length} Rust and ${frontendComponents.length} frontend components`);
