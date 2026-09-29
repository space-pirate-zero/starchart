// Copies non-TS runtime assets (viewer template, rule packs) into dist.
import { cpSync, existsSync } from "node:fs";

for (const dir of ["src/viewer/assets", "src/rules/packs"]) {
  if (existsSync(dir)) cpSync(dir, dir.replace(/^src/, "dist"), { recursive: true, filter: (p) => !p.endsWith(".ts") });
}
