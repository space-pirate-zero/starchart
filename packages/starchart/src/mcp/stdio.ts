import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.js";

/** Runs the STARCHART MCP server over stdio until the client disconnects or a signal arrives. */
export async function startStdio(root?: string): Promise<void> {
  const server = createServer(root ? { root } : {});
  const transport = new StdioServerTransport();
  const shutdown = () => {
    server.close().finally(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  await server.connect(transport);
}
