#!/usr/bin/env node
// Maintainer tool: turns an "Add a game" issue (or a local manifest) into reviewed SQL for the catalog.
// It NEVER runs SQL and never changes the database: you paste the output into the Supabase SQL editor yourself.
//
//   node scripts/approve-game.mjs 12 --check            validate issue #12 and print the manual review checklist
//   node scripts/approve-game.mjs 12                    validate, convert the icon, print SQL to stdout
//   node scripts/approve-game.mjs 12 --write            ... and save supabase/approved/<game-id>.sql (+ .webp icon)
//   node scripts/approve-game.mjs --manifest path/to/obsigama-manifest.json --repo-url https://github.com/o/r \
//        --description "Short pitch" [--icon file-or-url] [--check|--write]
//
// Options: --draft (catalog status draft instead of listed), --icon <file|url> (override the issue icon),
//   --supabase-url https://<ref>.supabase.co (or env OBSIGAMA_SUPABASE_URL) to put the icon URL into the SQL,
//   --repo NOMBER/ObsiGama (where the issues are), --offline (skip GitHub checks; not for real approvals).
// Needs: gh (logged in) for issues and repo checks; sharp (devDependency) for the icon.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { manifestToSql } from "./lib/game-sql.mjs";
import { parseIssue, REPO_URL, reviewChecklist, submissionFromManifest, validateSubmission } from "./lib/submission.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ICON_SIZE = 128;
const ICON_BUDGET = 24 * 1024;

const args = process.argv.slice(2);
const VALUED = new Set(["--manifest", "--repo-url", "--description", "--icon", "--supabase-url", "--repo"]);
const opt = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
const flag = (n) => args.includes(n);
const positional = args.filter((a, i) => !a.startsWith("--") && !VALUED.has(args[i - 1]));
const log = (...a) => console.error(...a);
const die = (msg) => { log("\n✖ " + msg); process.exit(1); };

if (flag("--help") || flag("-h") || (!positional.length && !opt("--manifest"))) {
  log(readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n").slice(1, 14).map((l) => l.replace(/^\/\/ ?/, "")).join("\n"));
  process.exit(flag("--help") || flag("-h") ? 0 : 1);
}

function gh(argv) {
  try {
    return execFileSync("gh", argv, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) {
    const msg = (e.stderr || e.message || "").toString().trim();
    if (e.code === "ENOENT") throw new Error("the GitHub CLI `gh` is not installed (https://cli.github.com)");
    throw new Error(msg || "gh failed");
  }
}

// ---- 1. load the submission
const issuesRepo = opt("--repo") ?? "NOMBER/ObsiGama";
let sub, issue = null;
if (opt("--manifest")) {
  const file = opt("--manifest");
  if (!existsSync(file)) die(`manifest file not found: ${file}`);
  let m;
  try { m = JSON.parse(readFileSync(file, "utf8")); } catch (e) { die(`${file} is not valid JSON: ${e.message}`); }
  sub = submissionFromManifest(m, { repo: opt("--repo-url"), description: opt("--description"), icon: opt("--icon") });
  if (!sub.repo) die("--repo-url https://github.com/<owner>/<repo> is required with --manifest");
  if (!sub.description) die('--description "..." is required with --manifest');
} else {
  issue = positional[0].replace(/^#/, "");
  if (!/^\d+$/.test(issue)) die(`"${positional[0]}" is not an issue number`);
  let raw;
  try { raw = JSON.parse(gh(["issue", "view", issue, "--repo", issuesRepo, "--json", "body,title,labels,state,url,author"])); }
  catch (e) { die(`cannot read issue #${issue} in ${issuesRepo}: ${e.message}`); }
  log(`Issue #${issue}: ${raw.title}  (${raw.state}, by @${raw.author?.login ?? "?"})  ${raw.url}`);
  if (!raw.labels?.some((l) => l.name === "game-submission")) log('  ! the issue has no "game-submission" label; was the template used?');
  sub = parseIssue(raw.body);
  if (opt("--icon")) sub.iconUrls = [opt("--icon")];
}

// ---- 2. validate
const { errors, warnings } = validateSubmission(sub);

// ---- 3. GitHub checks (repo exists and is public, manifest.json id)
const repoMatch = REPO_URL.exec(sub.repo || "");
if (repoMatch && !flag("--offline")) {
  const slug = `${repoMatch[1]}/${repoMatch[2]}`;
  try {
    const r = JSON.parse(gh(["repo", "view", slug, "--json", "visibility,isArchived,licenseInfo,url"]));
    if (r.visibility !== "PUBLIC") errors.push(`repository ${slug} is not public (${r.visibility})`);
    if (r.isArchived) warnings.push(`repository ${slug} is archived`);
    if (!r.licenseInfo?.spdxId && !r.licenseInfo?.key) warnings.push(`repository ${slug} has no license detected`);
    log(`Repo ${r.url}: ${r.visibility.toLowerCase()}, license ${r.licenseInfo?.spdxId ?? r.licenseInfo?.key ?? "none"}`);
  } catch (e) {
    errors.push(`repository ${slug} not found or not accessible: ${e.message.split("\n")[0]}`);
  }
  try {
    const content = gh(["api", `repos/${slug}/contents/manifest.json`, "--jq", ".content"]);
    const pm = JSON.parse(Buffer.from(content, "base64").toString("utf8"));
    if (sub.manifest?.pluginId && pm.id !== sub.manifest.pluginId) errors.push(`manifest.json in ${slug} has id "${pm.id}", but pluginId is "${sub.manifest.pluginId}"`);
    else log(`Plugin manifest.json: id "${pm.id}", version ${pm.version}, minAppVersion ${pm.minAppVersion}, desktop only: ${!!pm.isDesktopOnly}`);
  } catch {
    warnings.push(`could not read manifest.json from the root of ${slug}`);
  }
} else if (flag("--offline")) warnings.push("GitHub checks skipped (--offline)");

for (const w of warnings) log("  ! " + w);
if (errors.length) {
  log(`\n✖ ${errors.length} problem(s), not approvable:`);
  for (const e of errors) log("  - " + e);
  if (issue) log(`\nAsk the developer to edit the issue: https://github.com/${issuesRepo}/issues/${issue}`);
  process.exit(1);
}
log("✔ submission and manifest are valid");

if (flag("--check")) {
  process.stdout.write("\n" + reviewChecklist(sub, { issue }));
  log("\nWhen the manual review passes: node scripts/approve-game.mjs " + (issue ?? `--manifest ${opt("--manifest")} --repo-url ${sub.repo} --description "..."`) + " --write");
  process.exit(0);
}

// ---- 4. icon -> WebP 128x128
const m = sub.manifest;
const outDir = join(ROOT, "supabase", "approved");
let iconFile = null;
const iconSrc = sub.iconUrls[0];
if (iconSrc) {
  try {
    const input = /^https?:/.test(iconSrc) ? await download(iconSrc) : readFileSync(iconSrc);
    let sharp;
    try { sharp = (await import("sharp")).default; } catch { sharp = null; }
    if (!sharp) {
      const raw = join(flag("--write") ? outDir : tmpdir(), `${m.gameId}.icon-original`);
      mkdirSync(dirname(raw), { recursive: true });
      writeFileSync(raw, input);
      log(`  ! sharp is not installed (npm install), icon NOT converted. Original saved to ${raw}.`);
      log(`    Convert it to a ${ICON_SIZE}x${ICON_SIZE} WebP under ${ICON_BUDGET / 1024} KB (e.g. squoosh.app) and name it ${m.gameId}.webp.`);
    } else {
      const meta = await sharp(input).metadata();
      if (meta.width && meta.height && Math.abs(meta.width - meta.height) > Math.max(meta.width, meta.height) * 0.1)
        log(`  ! icon is not square (${meta.width}x${meta.height}); it is center-cropped`);
      if ((meta.width ?? 0) < ICON_SIZE) log(`  ! icon is smaller than ${ICON_SIZE}px (${meta.width}x${meta.height}); it is upscaled`);
      let webp, q = 85;
      do { webp = await sharp(input).rotate().resize(ICON_SIZE, ICON_SIZE, { fit: "cover" }).webp({ quality: q, effort: 6 }).toBuffer(); q -= 10; }
      while (webp.length > ICON_BUDGET && q >= 35);
      iconFile = join(flag("--write") ? outDir : tmpdir(), `${m.gameId}.webp`);
      mkdirSync(dirname(iconFile), { recursive: true });
      writeFileSync(iconFile, webp);
      log(`✔ icon: ${iconFile} (${ICON_SIZE}x${ICON_SIZE} WebP, ${(webp.length / 1024).toFixed(1)} KB)`);
    }
  } catch (e) {
    log(`  ! could not get the icon from ${iconSrc}: ${e.message}`);
    log(`    Download it by hand (open the issue in the browser) and re-run with --icon path/to/image.png`);
  }
}

// ---- 5. SQL
const base = (opt("--supabase-url") ?? process.env.OBSIGAMA_SUPABASE_URL ?? "").replace(/\/+$/, "");
const iconUrl = iconFile && base ? `${base}/storage/v1/object/public/game-icons/games/${m.gameId}.webp` : undefined;
const header = `-- Approved ${new Date().toISOString().slice(0, 10)}${issue ? ` from https://github.com/${issuesRepo}/issues/${issue}` : ""}
-- Repo: ${sub.repo}
-- Generated by scripts/approve-game.mjs. Review, then run it once in the Supabase SQL editor.`;
const sql = manifestToSql(m, { status: flag("--draft") ? "draft" : "listed", repo: sub.repo.replace(/\.git$|\/$/g, ""), description: sub.description, iconUrl, header });

if (flag("--write")) {
  mkdirSync(outDir, { recursive: true });
  const f = join(outDir, `${m.gameId}.sql`);
  writeFileSync(f, sql);
  log(`✔ SQL: ${f}`);
} else process.stdout.write(sql);

log(`
Next steps (nothing has been changed on the server):
  1. Supabase -> SQL Editor: paste and run the SQL${flag("--write") ? ` from supabase/approved/${m.gameId}.sql` : " above"}.`);
if (iconFile) log(`  2. Supabase -> Storage -> game-icons: upload ${iconFile} as games/${m.gameId}.webp${iconUrl ? "" : `
     then: update public.games set icon_url = '<project-url>/storage/v1/object/public/game-icons/games/${m.gameId}.webp' where id = '${m.gameId}';
     (or re-run with --supabase-url https://<ref>.supabase.co to put it into the SQL)`}`);
if (issue) log(`  3. Comment on the issue and close it: gh issue close ${issue} --repo ${issuesRepo} --comment "Approved, the game is in the catalog."`);

async function download(url) {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const type = res.headers.get("content-type") ?? "";
  if (type && !type.startsWith("image/") && !type.includes("octet-stream")) throw new Error(`not an image (${type})`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > 10 * 1024 * 1024) throw new Error("image is larger than 10 MB");
  return buf;
}
