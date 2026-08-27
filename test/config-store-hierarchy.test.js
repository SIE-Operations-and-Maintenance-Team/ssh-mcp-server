import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { getFlatHosts, getFlatHostByName } from "../build/services/config-store.js";

describe("ConfigStore flat derivation", () => {
  it("derives flatName project/env/host", () => {
    const cfg = {
      port: 61823,
      projects: {
        ops: {
          environments: {
            prod: {
              hosts: {
                "web-01": { name: "web-01", host: "10.0.0.1", port: 22, username: "root" },
              },
            },
          },
        },
      },
    };
    const m = getFlatHosts(cfg);
    assert.equal(m.size, 1);
    assert.ok(m.has("ops/prod/web-01"));
    assert.equal(m.get("ops/prod/web-01").host, "web-01");
  });
  it("resolves single host uniquely", () => {
    const cfg = {
      port: 61823,
      projects: {
        p1: {
          environments: {
            prod: {
              hosts: { h1: { name: "h1", host: "1.1.1.1", port: 22, username: "u" } },
            },
          },
        },
      },
    };
    const r = getFlatHostByName("h1", cfg);
    assert.equal(r.flatName, "p1/prod/h1");
  });
  it("reports ambiguous host", () => {
    const cfg = {
      port: 61823,
      projects: {
        p1: {
          environments: {
            prod: { hosts: { h1: { name: "h1", host: "1.1.1.1", port: 22, username: "u" } } },
            test: { hosts: { h1: { name: "h1", host: "2.2.2.2", port: 22, username: "u" } } },
          },
        },
      },
    };
    const r = getFlatHostByName("h1", cfg);
    assert.ok(r.ambiguous);
    assert.equal(r.candidates.length, 2);
  });
  it("resolves full path directly", () => {
    const cfg = {
      port: 61823,
      projects: {
        p1: {
          environments: {
            prod: {
              hosts: { h1: { name: "h1", host: "1.1.1.1", port: 22, username: "u" } },
            },
          },
        },
      },
    };
    const r = getFlatHostByName("p1/prod/h1", cfg);
    assert.equal(r.flatName, "p1/prod/h1");
  });
  it("returns null for not found", () => {
    const cfg = { port: 61823, projects: {} };
    const r = getFlatHostByName("nope", cfg);
    assert.equal(r, null);
  });
});
