#!/usr/bin/env node
/**
 * scripts/stage-app.mjs — prepare `.app-stage/`, the folder Electron runs and packages.
 *
 * Why a separate folder: the app needs a build of better-sqlite3 that loads
 * under Electron. The repo's own copy (v11) is compiled for plain Node only and
 * does not build against current Electron. The app therefore gets its own
 * node_modules with better-sqlite3 v13 (see `appDependencyOverrides` in
 * package.json), which ships Node-API binaries that load in both — no compile.
 *
 * Do NOT run electron-rebuild against this folder: it walks up into the repo's
 * node_modules and wipes the binary that `node trader.mjs` and PM2 depend on.
 *
 * Steps: copy source → write package.json → npm install (only when deps changed).
 */

import { cpSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { execFileSync } from "child_process";
import { createHash } from "crypto";

const ROOT  = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const STAGE = resolve(ROOT, ".app-stage");

const SOURCE_FILES = [
  "analyst.mjs", "dashboard.mjs", "db.mjs", "execution.mjs", "hyperliquid.mjs", "markets.mjs", "paths.mjs",
  "runlock.mjs", "scheduler.mjs", "uniswap-api.mjs", "vultisig-account.mjs", "vultisig-vault.mjs",
  "ecosystem.config.cjs",
];
const SOURCE_DIRS = ["exchanges", "public", "electron"];

const rootPkg = JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf8"));
const electronVersion = JSON.parse(
  readFileSync(resolve(ROOT, "node_modules", "electron", "package.json"), "utf8"),
).version;

mkdirSync(STAGE, { recursive: true });
for (const f of SOURCE_FILES) cpSync(resolve(ROOT, f), resolve(STAGE, f));
for (const d of SOURCE_DIRS) cpSync(resolve(ROOT, d), resolve(STAGE, d), { recursive: true });

// The app defaults to this repo folder for .env and data/
writeFileSync(resolve(STAGE, "electron", "build-info.json"), JSON.stringify({ defaultHome: ROOT }, null, 2));

// Pin each dependency to the exact version the repo has installed, so the app
// trades with the same library versions as `node trader.mjs`.
const pinnedDeps = Object.fromEntries(Object.keys(rootPkg.dependencies).map(name => [
  name,
  JSON.parse(readFileSync(resolve(ROOT, "node_modules", name, "package.json"), "utf8")).version,
]));

const stagePkg = {
  name: "agentsignal-trader-app",
  productName: "AgentSignal Trader",
  version: rootPkg.version,
  description: rootPkg.description,
  private: true,
  type: "module",
  main: "electron/main.mjs",
  author: "ToknWrks",
  // The stage is installed with npm. Saying so stops electron-builder from
  // following the repo's pnpm setting and bundling the repo's node_modules.
  packageManager: `npm@${execFileSync("npm", ["-v"]).toString().trim()}`,
  dependencies: { ...pinnedDeps, ...(rootPkg.appDependencyOverrides ?? {}) },
};
writeFileSync(resolve(STAGE, "package.json"), JSON.stringify(stagePkg, null, 2));

// electron-builder runs with .app-stage as its project (see `app:build`), so it
// packages exactly this folder and its node_modules. Unsigned, this Mac only.
writeFileSync(resolve(STAGE, "electron-builder.json"), JSON.stringify({
  appId: "app.agentsignal.trader",
  productName: "AgentSignal Trader",
  electronVersion,
  directories: { output: "../dist" },
  asar: false,          // plain files: the Vultisig SDK loads WASM from disk
  npmRebuild: false,    // never rebuild native modules (see header)
  files: ["**/*", "!.deps-stamp", "!electron-builder.json"],
  mac: { target: "dir", identity: null, icon: "public/icon.png", category: "public.app-category.finance" },
}, null, 2));

// Install only when dependencies changed
const stamp     = createHash("sha256").update(JSON.stringify(stagePkg.dependencies) + electronVersion).digest("hex");
const stampPath = resolve(STAGE, ".deps-stamp");
const upToDate  = existsSync(stampPath) && readFileSync(stampPath, "utf8") === stamp && existsSync(resolve(STAGE, "node_modules"));

if (upToDate) {
  console.log("[stage] dependencies unchanged — skipping install");
} else {
  console.log("[stage] installing production dependencies…");
  execFileSync("npm", ["install", "--omit=dev", "--no-audit", "--no-fund"], { cwd: STAGE, stdio: "inherit" });
  writeFileSync(stampPath, stamp);
}

console.log(`[stage] ready: ${STAGE} (Electron ${electronVersion})`);
