import { createRequire } from "node:module";

/** The package version, read from package.json (one level above both src/ and dist/). */
export const VERSION: string = (createRequire(import.meta.url)("../package.json") as { version: string }).version;
