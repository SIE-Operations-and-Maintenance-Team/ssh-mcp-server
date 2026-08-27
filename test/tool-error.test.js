import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ToolError, toToolError } from "../build/utils/tool-error.js";

describe("ToolError", () => {
  it("carries code, message, retriable and name", () => {
    const err = new ToolError("SFTP_ERROR", "boom", true);
    assert.equal(err.name, "ToolError");
    assert.equal(err.code, "SFTP_ERROR");
    assert.equal(err.message, "boom");
    assert.equal(err.retriable, true);
    assert.ok(err instanceof Error);
  });

  it("defaults retriable to false", () => {
    const err = new ToolError("HOST_NOT_FOUND", "no host");
    assert.equal(err.retriable, false);
  });
});

describe("toToolError", () => {
  it("passes through an existing ToolError unchanged", () => {
    const err = new ToolError("COMMAND_TIMEOUT", "too slow", true);
    assert.strictEqual(toToolError(err, "UNKNOWN_ERROR"), err);
  });

  it("wraps a generic Error with the fallback code (non-retriable)", () => {
    const out = toToolError(new Error("kaboom"), "UNKNOWN_ERROR");
    assert.ok(out instanceof ToolError);
    assert.equal(out.code, "UNKNOWN_ERROR");
    assert.equal(out.message, "kaboom");
    assert.equal(out.retriable, false);
  });

  it("stringifies a non-Error value", () => {
    const out = toToolError("just a string", "UNKNOWN_ERROR");
    assert.ok(out instanceof ToolError);
    assert.equal(out.code, "UNKNOWN_ERROR");
    assert.equal(out.message, "just a string");
  });
});