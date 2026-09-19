import { describe, expect, it } from "vitest";
import { displayPath } from "./displayPath";

describe("displayPath", () => {
  it("strips Win32 extended and kernel internal prefixes", () => {
    expect(displayPath("\\\\?\\C:\\Users\\demo\\.claude\\skills")).toBe(
      "C:\\Users\\demo\\.claude\\skills",
    );
    expect(displayPath("\\??\\C:\\Users\\demo\\.claude\\skills")).toBe(
      "C:\\Users\\demo\\.claude\\skills",
    );
    expect(displayPath("\\\\?\\UNC\\server\\share\\skills")).toBe(
      "\\\\server\\share\\skills",
    );
  });

  it("unifies slash spelling to backslashes for Windows-style paths", () => {
    expect(displayPath("C:/Users/demo/.claude/skills")).toBe(
      "C:\\Users\\demo\\.claude\\skills",
    );
    expect(displayPath("C:\\Users\\demo/.claude/skills")).toBe(
      "C:\\Users\\demo\\.claude\\skills",
    );
  });

  it("keeps POSIX paths untouched", () => {
    expect(displayPath("/Users/demo/.claude/skills")).toBe(
      "/Users/demo/.claude/skills",
    );
  });

  it("returns empty and bare values unchanged", () => {
    expect(displayPath("")).toBe("");
    expect(displayPath("skills")).toBe("skills");
  });
});
