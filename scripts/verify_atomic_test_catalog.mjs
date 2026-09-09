import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const catalogPath = path.join(repositoryRoot, "docs", "testing", "原子测试目录-v0.2.0.md");
const catalog = await readFile(catalogPath, "utf8");
const rows = catalog.split(/\r?\n/).filter((line) => /^\| TC-/.test(line));
const ids = rows.map((line) => line.split("|")[1].trim());
const duplicateIds = ids.filter((id, index) => ids.indexOf(id) !== index);
if (duplicateIds.length > 0) throw new Error(`Duplicate case IDs: ${[...new Set(duplicateIds)].join(", ")}`);

const missingStories = [];
for (let number = 1; number <= 62; number += 1) {
  const storyId = `US-${String(number).padStart(3, "0")}`;
  if (!rows.some((row) => row.includes(storyId))) missingStories.push(storyId);
}
if (missingStories.length > 0) throw new Error(`Missing stories: ${missingStories.join(", ")}`);

const missingRules = [];
for (let number = 1; number <= 10; number += 1) {
  const ruleId = `GR-${String(number).padStart(2, "0")}`;
  if (!rows.some((row) => row.includes(ruleId))) missingRules.push(ruleId);
}
if (missingRules.length > 0) throw new Error(`Missing global rules: ${missingRules.join(", ")}`);

for (const row of rows) {
  const columns = row.split("|").slice(1, -1).map((value) => value.trim());
  if (columns.length !== 10 || columns.some((value) => value.length === 0)) {
    throw new Error(`Invalid required fields: ${columns[0] ?? row}`);
  }
}

console.log(`Atomic catalog verified: ${rows.length} unique cases, 62 stories, 10 global rules.`);
