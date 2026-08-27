import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { Logger } from "../build/utils/logger.js";

function captureStderr() {
  const chunks = [];
  const original = process.stderr.write;
  process.stderr.write = (chunk, ...rest) => {
    chunks.push(String(chunk));
    return true;
  };
  return {
    chunks,
    restore() { process.stderr.write = original; },
    all() { return chunks.join(""); },
  };
}

describe("Logger", () => {
  let cap;
  beforeEach(() => { cap = captureStderr(); });
  afterEach(() => cap.restore());

  it("log writes a timestamped, uppercased-level line to stderr", () => {
    Logger.log("hello", "info");
    assert.match(cap.all(), /\[\d{4}-\d{2}-\d{2}T.*\] \[INFO\] hello\n/);
  });

  it("log defaults to info level", () => {
    Logger.log("plain");
    assert.match(cap.all(), /\[INFO\] plain/);
  });

  it("handleError returns the prefixed message and logs at error level", () => {
    const result = Logger.handleError(new Error("bad"), "prefix");
    assert.equal(result, "prefix: bad");
    assert.match(cap.all(), /\[ERROR\] prefix: bad/);
  });

  it("handleError stringifies non-Error input", () => {
    const result = Logger.handleError(42, "num");
    assert.equal(result, "num: 42");
  });
});