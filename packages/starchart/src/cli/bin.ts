#!/usr/bin/env node
import { run } from "./main.js";

run(process.argv).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    process.stderr.write(`starchart: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
  },
);
