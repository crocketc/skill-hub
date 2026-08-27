import { expect, it } from "vitest";
import { projectFixture, unavailableProjectFacade } from "./api";

it("keeps production project queries unavailable", async () => {
  await expect(unavailableProjectFacade.list()).rejects.toThrow("unavailable");
});

it("provides multiple project tags and itemized assembly states", () => {
  const project = projectFixture();
  expect(project.tags).toEqual(expect.arrayContaining(["客户项目", "Rust"]));
  expect(project.assembly.map((item) => item.status)).toEqual(
    expect.arrayContaining(["satisfied", "skipped", "conflict", "failed"]),
  );
});
