import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { formatServerList } from "../build/tools/list-servers.js";

describe("formatServerList", () => {
  it("returns a friendly empty message for no servers", () => {
    assert.equal(formatServerList([]), "No SSH servers configured.");
  });

  it("lists a single connected server with status", () => {
    const text = formatServerList([{
      name: "dev",
      host: "10.0.0.1",
      port: 22,
      username: "root",
      connected: true,
      status: {
        hostname: "web-01",
        osName: "Linux",
        lastUpdated: "2026-08-22T00:00:00.000Z",
        reachable: true,
      },
    }]);
    assert.match(text, /\[connected\] dev/);
    assert.match(text, /root@10\.0\.0\.1:22/);
    assert.match(text, /hostname=web-01/);
    assert.match(text, /os=Linux/);
  });

  it("lists multiple servers in order and includes Raw JSON", () => {
    const servers = [
      { name: "a", host: "1.1.1.1", port: 22, username: "u1", connected: false },
      { name: "b", host: "2.2.2.2", port: 22, username: "u2", connected: false },
    ];
    const text = formatServerList(servers);
    const iA = text.indexOf("[disconnected] a");
    const iB = text.indexOf("[disconnected] b");
    assert.ok(iA !== -1 && iB !== -1 && iA < iB);
    assert.ok(text.includes("Raw JSON:"));
    assert.ok(text.includes('"name":"a"'));
  });
});