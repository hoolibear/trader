/**
 * paths.mjs — where the trader keeps its files.
 *
 * TRADER_HOME is the folder holding `.env` and `data/`. It defaults to the
 * repo folder, so the CLI and PM2 behave as before. The desktop app and the
 * tests set TRADER_HOME to point somewhere else.
 */

import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

export const APP_DIR  = dirname(fileURLToPath(import.meta.url));
export const HOME     = process.env.TRADER_HOME ? resolve(process.env.TRADER_HOME) : APP_DIR;
export const ENV_PATH = resolve(HOME, ".env");
export const DATA_DIR = resolve(HOME, "data");

/** Load KEY=value lines from the .env file into process.env. */
export function loadEnv() {
  try {
    const lines = readFileSync(ENV_PATH, "utf8").split("\n");
    for (const line of lines) {
      const m = line.match(/^([^#=\s][^=]*)=(.*)$/);
      if (m) process.env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, "").replace(/\s*#.*$/, "");
    }
  } catch {}
}
