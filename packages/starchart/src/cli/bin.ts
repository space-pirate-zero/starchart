#!/usr/bin/env node
import { run } from "./main.js";

// `starchart emit graph | head` closes the pipe early; that is not an error
process.stdout.on("error", (error: NodeJS.ErrnoException) => {
  if (error.code === "EPIPE") process.exit(process.exitCode ?? 0);
  throw error;
});

run(process.argv).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    process.stderr.write(`starchart: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
  },
);
