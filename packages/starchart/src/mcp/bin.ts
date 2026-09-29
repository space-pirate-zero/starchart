#!/usr/bin/env node
import { startStdio } from "./stdio.js";

/** `starchart-mcp`: the STARCHART MCP server over stdio. Project root: $STARCHART_ROOT or the cwd. */
startStdio().catch((error: unknown) => {
  process.stderr.write(`starchart-mcp: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
