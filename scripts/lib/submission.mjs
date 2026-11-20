// Parsing and validation of "Add a game" issue submissions. Pure functions (no network, no fs), unit-tested.

/** Issue form fields: key -> English part of the label in .github/ISSUE_TEMPLATE/add-game.yml */
export const FIELDS = {
  name: "Game name",
  pluginId: "Plugin id",
  repo: "GitHub repository",
  store: "In the Obsidian community store?",
  storeUrl: "Community store link (optional)",
  description: "Short description",
  manifest: "obsigama-manifest.json",
  icon: "Icon",
  screenshots: "Screenshots (optional)",
  rules: "Rules",
};

/** Required checkboxes: key -> distinctive English text from the template. */
export const RULES = {
  offline: "plays fully offline and without GAMA Hub",
  optIn: "toggle is opt-in and OFF by default",
  noSecrets: "no Supabase keys or other secrets",
  officialSdk: "official GAMA Hub SDK unmodified",
  disclosure: "README discloses network use",
  noTelemetry: "No telemetry and no ads",
  mayReject: "may reject the game or remove it",
};

export const LIMITS = {
  nameLen: 80, descriptionLen: 200, achNameLen: 80, achDescLen: 300, statNameLen: 80,
  stats: 200, leaderboards: 50, achievements: 300, manifestBytes: 256 * 1024,
  maxDelta: 1e9, numberAbs: 1e15,
};

export const GAME_ID = /^[a-z0-9][a-z0-9-]{2,39}$/;
export const ITEM_ID = /^[a-z0-9][a-z0-9_.-]{0,63}$/;
export const PLUGIN_ID = /^[a-z0-9][a-z0-9_-]{1,63}$/;
export const REPO_URL = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/;
const AGGS = ["sum", "count", "max", "min", "latest"];
const RESERVED_PLUGIN_IDS = new Set(["obsigama"]);
const NO_RESPONSE = "_No response_";

const englishPart = (label) => label.split(" / ")[0].trim().toLowerCase();

/** Splits a rendered issue form body ("### Label\n\nvalue") into { [englishLabel]: rawValue }. */
export function splitSections(body) {
  const out = {};
  const text = String(body ?? "").replace(/\r\n/g, "\n");
  const re = /^###[ \t]+(.+)$/gm;
  const heads = [...text.matchAll(re)];
  heads.forEach((h, i) => {
    const start = h.index + h[0].length;
    const end = i + 1 < heads.length ? heads[i + 1].index : text.length;
    out[englishPart(h[1])] = text.slice(start, end).trim();
  });
  return out;
}

const clean = (v) => (v == null || v === NO_RESPONSE ? "" : v.trim());

/** Strips a ```json fence (render: json) if present. */
export function stripFence(v) {
  const m = /^```[a-zA-Z]*\n([\s\S]*?)\n?```\s*$/.exec(v.trim());
  return (m ? m[1] : v).trim();
}

/** All http(s) URLs in a field: markdown images/links, <img src>, bare links. */
export function extractUrls(v) {
  const urls = [];
  for (const m of String(v ?? "").matchAll(/https?:\/\/[^\s)"'<>\]]+/g)) urls.push(m[0].replace(/[.,;]+$/, ""));
  return [...new Set(urls)];
}

/** Parses the issue body into a submission object. Never throws. */
export function parseIssue(body) {
  const s = splitSections(body);
  const get = (k) => clean(s[englishPart(FIELDS[k])]);
  const missingSections = Object.entries(FIELDS)
    .filter(([, label]) => !(englishPart(label) in s))
    .map(([k]) => k);
  let manifest = null, manifestError = null, manifestText = stripFence(get("manifest"));
  if (!manifestText) manifestError = "the manifest field is empty";
  else {
    try { manifest = JSON.parse(manifestText); }
    catch (e) { manifestError = "the manifest is not valid JSON: " + e.message; }
  }
  const rulesText = s[englishPart(FIELDS.rules)] ?? "";
  const rules = {};
  for (const [k, needle] of Object.entries(RULES)) {
    const line = rulesText.split("\n").find((l) => l.toLowerCase().includes(needle.toLowerCase()));
    rules[k] = !!line && /^\s*-\s*\[[xX]\]/.test(line);
  }
  const store = get("store");
  return {
    name: get("name"),
    pluginId: get("pluginId"),
    repo: get("repo"),
    store: /^yes/i.test(store) ? "yes" : /^submitted/i.test(store) ? "submitted" : /^no/i.test(store) ? "no" : "",
    storeUrl: get("storeUrl"),
    description: get("description").replace(/\s+/g, " "),
    manifest, manifestText, manifestError,
    iconUrls: extractUrls(get("icon")),
    screenshotUrls: extractUrls(get("screenshots")),
    rules,
    missingSections,
  };
}

const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const isStr = (v) => typeof v === "string";

/** Server-side manifest rules + sane limits. Returns { errors, warnings }. Never throws. */
export function validateManifest(m) {
  const errors = [], warnings = [];
  if (!m || typeof m !== "object" || Array.isArray(m)) return { errors: ["the manifest must be a JSON object"], warnings };
  const known = new Set(["$schema", "gameId", "pluginId", "name", "manifestVersion", "stats", "leaderboards", "achievements"]);
  for (const k of Object.keys(m)) if (!known.has(k)) warnings.push(`unknown top-level field "${k}" is ignored`);
  const size = JSON.stringify(m).length;
  if (size > LIMITS.manifestBytes) errors.push(`the manifest is too large (${size} bytes, max ${LIMITS.manifestBytes})`);
  if (JSON.stringify(m).includes("$manifest$")) errors.push(`the manifest must not contain the text "$manifest$"`);

  if (!isStr(m.gameId) || !GAME_ID.test(m.gameId)) errors.push(`gameId "${m.gameId}" must be 3-40 chars of a-z, 0-9 and "-", starting with a letter or digit`);
  if (!isStr(m.pluginId) || !PLUGIN_ID.test(m.pluginId)) errors.push(`pluginId "${m.pluginId}" must be the Obsidian plugin id (lowercase a-z, 0-9, "-", "_")`);
  else if (RESERVED_PLUGIN_IDS.has(m.pluginId)) errors.push(`pluginId "${m.pluginId}" is reserved`);
  if (!isStr(m.name) || !m.name.trim()) errors.push("name is required");
  else if (m.name.length > LIMITS.nameLen) errors.push(`name is longer than ${LIMITS.nameLen} characters`);
  if (!Number.isInteger(m.manifestVersion) || m.manifestVersion < 1 || m.manifestVersion > 10000) errors.push("manifestVersion must be an integer from 1");

  for (const k of ["stats", "leaderboards", "achievements"]) if (m[k] != null && !Array.isArray(m[k])) errors.push(`${k} must be an array`);
  const stats = Array.isArray(m.stats) ? m.stats : [];
  const boards = Array.isArray(m.leaderboards) ? m.leaderboards : [];
  const achs = Array.isArray(m.achievements) ? m.achievements : [];
  if (stats.length > LIMITS.stats) errors.push(`too many stats (${stats.length}, max ${LIMITS.stats})`);
  if (boards.length > LIMITS.leaderboards) errors.push(`too many leaderboards (${boards.length}, max ${LIMITS.leaderboards})`);
  if (achs.length > LIMITS.achievements) errors.push(`too many achievements (${achs.length}, max ${LIMITS.achievements})`);
  if (!stats.length && !boards.length && !achs.length) warnings.push("the manifest declares no stats, leaderboards or achievements");

  const ids = (kind, list) => {
    const seen = new Set();
    list.forEach((x, i) => {
      const id = x && x.id;
      if (!isStr(id) || !ITEM_ID.test(id)) errors.push(`${kind} #${i + 1}: id "${id}" must be 1-64 chars of a-z, 0-9, "_", ".", "-"`);
      else if (seen.has(id)) errors.push(`${kind} "${id}" is declared twice`);
      else seen.add(id);
    });
  };
  ids("stat", stats); ids("leaderboard", boards); ids("achievement", achs);

  const statById = new Map();
  for (const s of stats) {
    if (!s || typeof s !== "object") { errors.push("every stat must be an object"); continue; }
    const at = `stat "${s.id}"`;
    statById.set(s.id, s);
    if (!AGGS.includes(s.agg)) errors.push(`${at}: agg must be one of ${AGGS.join(", ")}`);
    if (s.type != null && s.type !== "number" && s.type !== "string") errors.push(`${at}: type must be "number" or "string"`);
    if (s.type === "string" && s.agg !== "latest") errors.push(`${at}: string stats must use agg "latest"`);
    if (s.max != null && (!isNum(s.max) || Math.abs(s.max) > LIMITS.numberAbs)) errors.push(`${at}: max must be a finite number`);
    if (s.maxDelta != null) {
      if (!isNum(s.maxDelta) || s.maxDelta <= 0 || s.maxDelta > LIMITS.maxDelta) errors.push(`${at}: maxDelta must be a number between 1 and ${LIMITS.maxDelta}`);
      if (s.agg !== "sum" && s.agg !== "count") warnings.push(`${at}: maxDelta only applies to sum/count stats`);
    } else if (s.agg === "sum") warnings.push(`${at}: no maxDelta; the server caps one report at 1000000`);
    if (s.name != null && (!isStr(s.name) || s.name.length > LIMITS.statNameLen)) errors.push(`${at}: name must be text up to ${LIMITS.statNameLen} characters`);
  }
  for (const l of boards) {
    if (!l || typeof l !== "object") { errors.push("every leaderboard must be an object"); continue; }
    const at = `leaderboard "${l.id}"`;
    if (l.sort !== "asc" && l.sort !== "desc") errors.push(`${at}: sort must be "asc" or "desc"`);
    for (const k of ["min", "max"]) if (l[k] != null && (!isNum(l[k]) || Math.abs(l[k]) > LIMITS.numberAbs)) errors.push(`${at}: ${k} must be a finite number`);
    if (isNum(l.min) && isNum(l.max) && l.min > l.max) errors.push(`${at}: min is greater than max`);
    if (l.sort === "desc" && l.max == null) warnings.push(`${at}: no max; any high score would be accepted (set a plausible upper bound)`);
    if (l.sort === "asc" && l.min == null) warnings.push(`${at}: no min; an impossibly fast time would be accepted (set a plausible lower bound)`);
    if (l.name != null && (!isStr(l.name) || l.name.length > LIMITS.statNameLen)) errors.push(`${at}: name must be text up to ${LIMITS.statNameLen} characters`);
  }
  let claims = 0;
  for (const a of achs) {
    if (!a || typeof a !== "object") { errors.push("every achievement must be an object"); continue; }
    const at = `achievement "${a.id}"`;
    if (!isStr(a.name) || !a.name.trim()) errors.push(`${at}: name is required`);
    else if (a.name.length > LIMITS.achNameLen) errors.push(`${at}: name is longer than ${LIMITS.achNameLen} characters`);
    if (a.description != null && (!isStr(a.description) || a.description.length > LIMITS.achDescLen)) errors.push(`${at}: description must be text up to ${LIMITS.achDescLen} characters`);
    if (a.icon != null && (!isStr(a.icon) || a.icon.length > 16)) errors.push(`${at}: icon must be a short emoji (max 16 characters)`);
    if (a.hidden != null && typeof a.hidden !== "boolean") errors.push(`${at}: hidden must be true or false`);
    const r = a.rule;
    if (!r || typeof r !== "object") { errors.push(`${at}: rule is required ({"stat": "...", "gte": n} or {"claim": true})`); continue; }
    if ("stat" in r) {
      const s = statById.get(r.stat);
      if (!s) errors.push(`${at}: rule uses unknown stat "${r.stat}"`);
      else if (s.type === "string") errors.push(`${at}: rule uses string stat "${r.stat}"`);
      if (!isNum(r.gte) || r.gte <= 0) errors.push(`${at}: gte must be a positive number`);
      else if (s && isNum(s.max) && r.gte > s.max) errors.push(`${at}: gte ${r.gte} can never be reached (stat "${r.stat}" max is ${s.max})`);
      if (s && s.agg === "min") warnings.push(`${at}: a "gte" rule on a min stat is unusual`);
    } else if (r.claim === true) claims++;
    else errors.push(`${at}: rule must be {"stat": "...", "gte": n} or {"claim": true}`);
  }
  if (claims && claims === achs.length && achs.length > 5) warnings.push("all achievements are claim-type (trusted from the game); consider stat rules the server can verify");
  return { errors, warnings };
}

/** Validates the whole submission (form fields + manifest). Returns { errors, warnings }. */
export function validateSubmission(sub) {
  const errors = [], warnings = [];
  for (const k of sub.missingSections ?? []) {
    if (k !== "storeUrl" && k !== "screenshots") errors.push(`the issue has no "${FIELDS[k]}" section (was the template used?)`);
  }
  if (!sub.name) errors.push("game name is empty");
  else if (sub.name.length > LIMITS.nameLen) errors.push(`game name is longer than ${LIMITS.nameLen} characters`);
  if (!sub.pluginId) errors.push("plugin id is empty");
  if (!sub.repo) errors.push("GitHub repository is empty");
  else if (!REPO_URL.test(sub.repo)) errors.push(`"${sub.repo}" is not a https://github.com/<owner>/<repo> URL`);
  if (!sub.description) errors.push("short description is empty");
  else if (sub.description.length > LIMITS.descriptionLen) errors.push(`short description is ${sub.description.length} characters (max ${LIMITS.descriptionLen})`);
  if (!sub.store && !sub.fromManifest) warnings.push("community store answer not recognised");
  if (sub.store === "yes" && !sub.storeUrl) warnings.push("says it is in the community store but gives no link");
  if (!sub.iconUrls?.length) (sub.fromManifest ? warnings : errors).push(sub.fromManifest ? "no --icon given; the catalog keeps its current icon" : "no icon image or URL found in the Icon field");
  for (const [k, ok] of Object.entries(sub.rules ?? {})) if (!ok) errors.push(`rule not ticked: "${RULES[k]}"`);
  if (sub.manifestError) errors.push(sub.manifestError);
  if (sub.manifest) {
    const v = validateManifest(sub.manifest);
    errors.push(...v.errors.map((e) => "manifest: " + e));
    warnings.push(...v.warnings.map((w) => "manifest: " + w));
    if (sub.pluginId && isStr(sub.manifest.pluginId) && sub.manifest.pluginId !== sub.pluginId)
      errors.push(`plugin id "${sub.pluginId}" does not match manifest pluginId "${sub.manifest.pluginId}"`);
    if (sub.name && isStr(sub.manifest.name) && sub.manifest.name !== sub.name)
      warnings.push(`game name "${sub.name}" differs from manifest name "${sub.manifest.name}" (the manifest name is used)`);
  }
  return { errors, warnings };
}

/** Builds the submission from a bare manifest file (no issue): only manifest checks apply. */
export function submissionFromManifest(m, extra = {}) {
  return {
    name: m?.name ?? "", pluginId: m?.pluginId ?? "", repo: extra.repo ?? "", store: "", storeUrl: "",
    description: extra.description ?? "", manifest: m, manifestText: JSON.stringify(m, null, 2), manifestError: null,
    iconUrls: extra.icon ? [extra.icon] : [], screenshotUrls: [], rules: {}, missingSections: [], fromManifest: true,
  };
}

/** Markdown checklist for the maintainer's manual QA. */
export function reviewChecklist(sub, info = {}) {
  const m = sub.manifest ?? {};
  const n = (k) => (Array.isArray(m[k]) ? m[k].length : 0);
  const claims = (m.achievements ?? []).filter((a) => a?.rule?.claim === true).length;
  return `## Review: ${m.name ?? sub.name} (${m.gameId ?? "?"}), plugin \`${m.pluginId ?? sub.pluginId}\`
Repo: ${sub.repo || "?"}${info.issue ? `  ·  Issue #${info.issue}` : ""}
Manifest v${m.manifestVersion ?? "?"}: ${n("stats")} stats, ${n("leaderboards")} leaderboards, ${n("achievements")} achievements (${claims} claim-type)

Code review
- [ ] Repo is public, has a license, source matches the released main.js (no obfuscation, no minified-only release)
- [ ] manifest.json "id" in the repo equals pluginId; the plugin is not a copy of another game
- [ ] SDK folder is the official one, unmodified (diff against packages/sdk/src at the tag they name)
- [ ] No Supabase URL/keys, tokens or other secrets; no own fetch/requestUrl/WebSocket calls, no telemetry or ads
- [ ] "Connect to GAMA Hub" uses addConnectSetting and is OFF by default
- [ ] endRun is called once per finished run; claim achievements are only sent when really earned
- [ ] README has the network-use disclosure (Obsidian developer policies)
- [ ] Leaderboard bounds and maxDelta values are plausible for this game

Manual QA in a clean test vault
- [ ] Install the plugin WITHOUT GAMA Hub: it loads, plays, saves; no console errors
- [ ] Install GAMA Hub, switch it offline: the game still plays; the status shows queued events
- [ ] Sign in to a test account, turn the toggle on: consent dialog appears; backfill arrives
- [ ] Finish a run: one request; stats / best score / achievements appear in the test profile
- [ ] Go offline, play 2 runs, go online: queued results arrive once, no duplicates
- [ ] Disable/enable the game plugin a few times: no errors, no leaks
- [ ] Icon looks fine at 128x128 in the catalog; name and description are appropriate

Decision
- [ ] Approve: run the SQL in the Supabase SQL editor, upload the icon, comment and close the issue with label "approved"
- [ ] Or reject: comment with the reasons
`;
}
