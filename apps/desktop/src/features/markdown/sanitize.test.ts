import { describe, expect, it } from "vitest";
import { classifyMarkdownUrl, normalizeSkillRelativePath } from "./sanitize";

describe("Markdown URL security policy", () => {
  it.each([
    ["https://example.com/a", { kind: "external", target: "https://example.com/a" }],
    ["http://example.com/a", { kind: "external", target: "http://example.com/a" }],
    ["#install", { fragment: "install", kind: "fragment" }],
    ["images/demo.png", { kind: "local", path: "images/demo.png" }],
    ["./images/demo.png", { kind: "local", path: "images/demo.png" }],
  ])("classifies the allowed target %s", (input, expected) => {
    expect(classifyMarkdownUrl(input)).toEqual(expected);
  });

  it.each([
    "javascript:alert(1)",
    "data:text/html;base64,WA==",
    "../secret.png",
    "%2e%2e/secret.png",
    "images\\secret.png",
    "C:/secret.png",
    "/rooted.png",
    "//example.com/image.png",
  ])("blocks executable or root-escaping target %s", (input) => {
    expect(classifyMarkdownUrl(input)).toEqual({ kind: "blocked" });
  });

  it("normalizes dot segments without changing the Skill-root boundary", () => {
    expect(normalizeSkillRelativePath("docs/./images/../guide.png")).toBe(
      "docs/guide.png",
    );
    expect(normalizeSkillRelativePath("docs/../../outside.png")).toBeNull();
  });
});
