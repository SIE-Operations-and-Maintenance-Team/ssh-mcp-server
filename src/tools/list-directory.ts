import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { SSHConnectionManager } from "../services/ssh-connection-manager.js";
import { Logger } from "../utils/logger.js";
import { toToolError } from "../utils/tool-error.js";

/**
 * Register list directory tool
 */
export function registerListDirectoryTool(server: McpServer): void {
  const sshManager = SSHConnectionManager.getInstance();

  server.registerTool(
    "list-directory",
    {
      description: "List entries of a remote directory (name, type, size, mtime) via SFTP",
      inputSchema: {
        remotePath: z
          .string()
          .describe("Absolute POSIX directory path on the remote server, e.g. /var/log"),
        connectionName: z
          .string()
          .optional()
          .describe("SSH connection name (optional, default is 'default')"),
      },
    },
    async ({ remotePath, connectionName }) => {
      try {
        const entries = await sshManager.listDirectory(remotePath, connectionName);
        const lines = entries.map((e) => {
          const mtime = e.mtimeMs ? new Date(e.mtimeMs).toISOString() : "-";
          const size = e.type === "file" ? ` (${e.size ?? "?"} bytes)` : "";
          return `[${e.type}] ${e.name}${size} ${mtime}`;
        });
        return {
          content: [
            {
              type: "text",
              text: [`Directory: ${remotePath} (${entries.length} entries)`, ...lines].join("\n"),
            },
          ],
        };
      } catch (error: unknown) {
        const toolError = toToolError(error, "UNKNOWN_ERROR");
        Logger.handleError(toolError, "Failed to list directory");
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  code: toolError.code,
                  message: toolError.message,
                  retriable: toolError.retriable,
                },
                null,
                2,
              ),
            },
          ],
          isError: true,
        };
      }
    },
  );
}
