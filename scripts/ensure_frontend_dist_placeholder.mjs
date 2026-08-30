import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptsDirectory = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(scriptsDirectory, "..");
const distributionDirectory = process.env.SKILLHUB_FRONTEND_DIST
  ? resolve(process.env.SKILLHUB_FRONTEND_DIST)
  : resolve(projectRoot, "apps/desktop/dist");

await mkdir(distributionDirectory, { recursive: true });
await writeFile(resolve(distributionDirectory, ".gitkeep"), "", "utf8");
