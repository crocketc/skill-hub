import { describe, expect, it } from "vitest";
import { nativeErrorCode, nativeErrorParams, describeNativeError } from "./nativeErrors";

describe("nativeErrors", () => {
  it("parses a serialized AppError object from the Tauri IPC rejection", () => {
    const error = {
      code: "operation.conflict",
      severity: "error",
      params: { reason: "no_upstream_source", skill_id: "abc" },
      actions: [],
    };
    expect(nativeErrorCode(error)).toBe("operation.conflict");
    expect(nativeErrorParams(error)).toEqual({
      reason: "no_upstream_source",
      skill_id: "abc",
    });
  });

  it("parses a JSON-encoded AppError string", () => {
    const error = JSON.stringify({
      code: "object.not_found",
      severity: "error",
      params: { path: "C:/x" },
      actions: [],
    });
    expect(nativeErrorCode(error)).toBe("object.not_found");
    expect(nativeErrorParams(error)).toEqual({ path: "C:/x" });
  });

  it("extracts a code from a plain host string error", () => {
    expect(nativeErrorCode("directory_picker.canonicalize_failed: boom")).toBe(
      "directory_picker.canonicalize_failed",
    );
    expect(nativeErrorParams("directory_picker.canonicalize_failed")).toEqual({});
  });

  it("returns null for unknown shapes instead of the string [object Object]", () => {
    expect(nativeErrorCode(new Error("regular failure"))).toBeNull();
    expect(String(nativeErrorCode({ unexpected: true }))).toBe("null");
  });

  it("describes a known conflict reason with a localized, honest message", () => {
    const message = describeNativeError(
      {
        code: "operation.conflict",
        severity: "error",
        params: { reason: "no_upstream_source" },
        actions: [],
      },
      (key, options) => `${key}:${options?.reason ?? ""}`,
      "errors.generic",
    );
    expect(message).toContain("errors.sourceUpdate.noUpstreamConflict");
  });

  it("falls back to a generic message that still shows the error code", () => {
    const message = describeNativeError(
      { code: "internal.error", severity: "error", params: {}, actions: [] },
      (key, options) => `${key}:${JSON.stringify(options ?? {})}`,
      "errors.generic",
    );
    expect(message).toContain("errors.generic");
    expect(message).toContain("internal.error");
  });
});
