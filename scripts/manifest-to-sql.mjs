#!/usr/bin/env node
// Registers a game on S: prints SQL that upserts the catalog row and applies the manifest.
// Usage: node scripts/manifest-to-sql.mjs path/to/s-manifest.json [--listed] [--repo https://github.com/o/r] [--description "..."]
// Paste the output into the Supabase SQL editor (or save it as a new file in supabase/migrations/).
import { readFileSync } from "node:fs";

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith("--") && !args[args.indexOf(a) - 1]?.startsWith("--repo") && !args[args.indexOf(a) - 1]?.startsWith("--description"));
if (!file) { console.error("usage: manifest-to-sql.mjs <manifest.json> [--listed] [--repo URL] [--description TEXT]"); process.exit(1); }
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const m = JSON.parse(readFileSync(file, "utf8"));
const q = (s) => (s == null ? "null" : "'" + String(s).replace(/'/g, "''") + "'");
const json = JSON.stringify(m);
if (json.includes("$manifest$")) throw new Error("manifest contains the dollar-quote tag");
console.log(`-- ${m.name} (${m.gameId}) manifest v${m.manifestVersion}
insert into public.games (id, plugin_id, name, description, repo_url, status)
values (${q(m.gameId)}, ${q(m.pluginId)}, ${q(m.name)}, ${q(opt("--description"))}, ${q(opt("--repo"))}, ${q(args.includes("--listed") ? "listed" : "draft")})
on conflict (id) do update set plugin_id = excluded.plugin_id, name = excluded.name,
  description = coalesce(excluded.description, public.games.description),
  repo_url = coalesce(excluded.repo_url, public.games.repo_url), status = excluded.status;
select public.apply_manifest(${q(m.gameId)}, $manifest$${json}$manifest$::jsonb);
`);
