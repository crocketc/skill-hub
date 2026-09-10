import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const productionContracts = [
  "crates/skillhub-core/src/api/command.rs",
  "crates/skillhub-core/src/api/mod.rs",
  "crates/skillhub-application/src/lib.rs",
  "apps/desktop/src/api/bindings.ts",
];

test("library lifecycle exposes only activate_library_root", async () => {
  const source = await Promise.all(
    productionContracts.map((path) => readFile(path, "utf8")),
  );
  const combined = source.join("\n");

  assert.doesNotMatch(combined, /set_library_root|SetLibraryRoot|set-library-root/);
  assert.match(combined, /activate_library_root|ActivateLibraryRoot/);
});
