import { readFileSync } from "node:fs";

function readPackageVersion(): string {
  const packageJson = JSON.parse(
    readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
  ) as { version?: unknown };

  if (typeof packageJson.version !== "string") {
    throw new Error("package.json must include a string version");
  }

  return packageJson.version;
}

/**
 * MCP Server configuration
 */
export const SERVER_CONFIG = {
  name: "ssh-mcp-server",
  version: readPackageVersion(),
};
