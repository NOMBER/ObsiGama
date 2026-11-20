#!/usr/bin/env node
// Registers a game on OBSIGAMA: prints SQL that upserts the catalog row and applies the manifest.
// Usage: node scripts/manifest-to-sql.mjs path/to/obsigama-manifest.json [--listed] [--repo https://github.com/o/r] [--description "..."]
// For submitted games use scripts/approve-game.mjs (validates the issue first).
// Paste the output into the Supabase SQL editor (or save it as a new file in supabase/migrations/).
import { readFileSync } from "node:fs";
import { manifestToSql } from "./lib/game-sql.mjs";
import { validateManifest } from "./lib/submission.mjs";

const args = process.argv.slice(2);
const valued = new Set(["--repo", "--description"]);
const file = args.find((a, i) => !a.startsWith("--") && !valued.has(args[i - 1]));
if (!file) { console.error("usage: manifest-to-sql.mjs <manifest.json> [--listed] [--repo URL] [--description TEXT]"); process.exit(1); }
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const m = JSON.parse(readFileSync(file, "utf8"));
const { errors, warnings } = validateManifest(m);
for (const w of warnings) console.error("warning: " + w);
if (errors.length) { for (const e of errors) console.error("error: " + e); process.exit(1); }
process.stdout.write(manifestToSql(m, { status: args.includes("--listed") ? "listed" : "draft", repo: opt("--repo"), description: opt("--description") }));
