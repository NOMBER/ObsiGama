import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
// @ts-ignore plain ESM maintainer scripts
import { FIELDS, RULES, parseIssue, validateManifest, validateSubmission, extractUrls, reviewChecklist } from "../scripts/lib/submission.mjs";
// @ts-ignore
import { manifestToSql } from "../scripts/lib/game-sql.mjs";

const template = readFileSync(new URL("../.github/ISSUE_TEMPLATE/add-game.yml", import.meta.url), "utf8");
const hellvault = JSON.parse(readFileSync(new URL("../examples/hellvault/obsigama-manifest.json", import.meta.url), "utf8"));
const mini = JSON.parse(readFileSync(new URL("../examples/mini-old-games/obsigama-manifest.json", import.meta.url), "utf8"));

const small = {
  gameId: "my-game", pluginId: "my-game", name: "My Game", manifestVersion: 1,
  stats: [{ id: "runs", agg: "count" }, { id: "kills", agg: "sum", maxDelta: 500 }, { id: "best_wave", agg: "max", max: 100 }],
  leaderboards: [{ id: "score", sort: "desc", min: 0, max: 100000 }],
  achievements: [
    { id: "first_blood", name: "First blood", rule: { stat: "kills", gte: 1 } },
    { id: "untouchable", name: "Untouchable", rule: { claim: true } },
  ],
};

/** What GitHub renders for a submitted issue form. */
function issueBody(o: { manifest?: string; ticked?: number; pluginId?: string; description?: string; icon?: string } = {}) {
  const rules = [...template.matchAll(/^\s+- label: "(.+)"$/gm)].map((m) => m[1]);
  const ticked = o.ticked ?? rules.length;
  return [
    "### Game name / Название игры", "", "My Game", "",
    "### Plugin id / Id плагина", "", o.pluginId ?? "my-game", "",
    "### GitHub repository / Репозиторий на GitHub", "", "https://github.com/someone/my-game", "",
    "### In the Obsidian community store? / Есть в каталоге плагинов Obsidian?", "", "No / Нет", "",
    "### Community store link (optional) / Ссылка в каталоге Obsidian (необязательно)", "", "_No response_", "",
    "### Short description / Краткое описание", "", o.description ?? "A tiny\nroguelike.", "",
    "### obsigama-manifest.json", "", "```json", o.manifest ?? JSON.stringify(small, null, 2), "```", "",
    "### Icon / Иконка", "", o.icon ?? '<img width="256" alt="icon" src="https://github.com/user-attachments/assets/abc-123" />', "",
    "### Screenshots (optional) / Скриншоты (необязательно)", "", "_No response_", "",
    "### Rules / Правила", "",
    ...rules.map((r, i) => `- [${i < ticked ? "X" : " "}] ${r}`),
  ].join("\r\n");
}

describe("issue template <-> parser", () => {
  it("every parser field is a label in the template", () => {
    const labels = [...template.matchAll(/^\s+label: "(.+)"$/gm)].map((m) => m[1].split(" / ")[0]);
    for (const l of Object.values(FIELDS) as string[]) expect(labels).toContain(l);
  });
  it("every required rule appears in the template checkboxes", () => {
    for (const needle of Object.values(RULES) as string[]) expect(template).toContain(needle);
    expect(template).toContain("game-submission");
  });
});

describe("parseIssue", () => {
  it("parses a complete submission", () => {
    const s = parseIssue(issueBody());
    expect(s.name).toBe("My Game");
    expect(s.pluginId).toBe("my-game");
    expect(s.repo).toBe("https://github.com/someone/my-game");
    expect(s.store).toBe("no");
    expect(s.storeUrl).toBe("");
    expect(s.description).toBe("A tiny roguelike.");
    expect(s.manifest).toEqual(small);
    expect(s.iconUrls).toEqual(["https://github.com/user-attachments/assets/abc-123"]);
    expect(Object.values(s.rules).every(Boolean)).toBe(true);
    expect(validateSubmission(s).errors).toEqual([]);
  });
  it("reports unticked rules, bad JSON, long descriptions, id mismatch, missing icon", () => {
    const e1 = validateSubmission(parseIssue(issueBody({ ticked: 5 }))).errors;
    expect(e1.filter((e: string) => e.startsWith("rule not ticked"))).toHaveLength(2);
    expect(validateSubmission(parseIssue(issueBody({ manifest: "{ nope" }))).errors.join()).toMatch(/not valid JSON/);
    expect(validateSubmission(parseIssue(issueBody({ description: "x".repeat(201) }))).errors.join()).toMatch(/max 200/);
    expect(validateSubmission(parseIssue(issueBody({ pluginId: "other" }))).errors.join()).toMatch(/does not match manifest pluginId/);
    expect(validateSubmission(parseIssue(issueBody({ icon: "_No response_" }))).errors.join()).toMatch(/no icon/);
  });
  it("rejects a body that did not use the template", () => {
    expect(validateSubmission(parseIssue("hi, please add my game")).errors.join()).toMatch(/was the template used/);
  });
  it("extracts urls from markdown and html", () => {
    expect(extractUrls("![a](https://x.io/a.png) and https://y.io/b.webp.")).toEqual(["https://x.io/a.png", "https://y.io/b.webp"]);
  });
});

describe("validateManifest", () => {
  const bad = (patch: object) => validateManifest({ ...small, ...patch }).errors.join("\n");
  it("accepts the real game manifests", () => {
    expect(validateManifest(hellvault).errors).toEqual([]);
    expect(validateManifest(mini).errors).toEqual([]);
    expect(validateManifest(small)).toEqual({ errors: [], warnings: [] });
  });
  it("checks ids, merge types, bounds, rules and limits", () => {
    expect(bad({ gameId: "My Game" })).toMatch(/gameId/);
    expect(bad({ pluginId: "obsigama" })).toMatch(/reserved/);
    expect(bad({ manifestVersion: 0 })).toMatch(/manifestVersion/);
    expect(bad({ stats: [{ id: "a", agg: "avg" }] })).toMatch(/agg must be one of/);
    expect(bad({ stats: [{ id: "a", agg: "max", type: "string" }] })).toMatch(/string stats/);
    expect(bad({ stats: [{ id: "a", agg: "sum", maxDelta: -1 }] })).toMatch(/maxDelta/);
    expect(bad({ stats: [{ id: "a", agg: "sum" }, { id: "a", agg: "max" }] })).toMatch(/declared twice/);
    expect(bad({ stats: [{ id: "Bad Id", agg: "sum" }] })).toMatch(/id "Bad Id"/);
    expect(bad({ leaderboards: [{ id: "s", sort: "up" }] })).toMatch(/sort/);
    expect(bad({ leaderboards: [{ id: "s", sort: "desc", min: 10, max: 1 }] })).toMatch(/min is greater than max/);
    expect(bad({ achievements: [{ id: "x", name: "X", rule: { stat: "nope", gte: 1 } }] })).toMatch(/unknown stat/);
    expect(bad({ achievements: [{ id: "x", name: "X", rule: { stat: "best_wave", gte: 500 } }] })).toMatch(/never be reached/);
    expect(bad({ achievements: [{ id: "x", name: "X", rule: { claim: false } }] })).toMatch(/rule must be/);
    expect(bad({ achievements: [{ id: "x", rule: { claim: true } }] })).toMatch(/name is required/);
    expect(bad({ stats: Array.from({ length: 201 }, (_, i) => ({ id: "s" + i, agg: "count" })) })).toMatch(/too many stats/);
    expect(bad({ name: "$manifest$" })).toMatch(/\$manifest\$/);
  });
  it("warns about unbounded leaderboards", () => {
    const w = validateManifest({ ...small, leaderboards: [{ id: "s", sort: "desc" }] }).warnings.join();
    expect(w).toMatch(/no max/);
  });
});

describe("SQL and checklist", () => {
  it("escapes quotes and keeps the manifest in a dollar quote", () => {
    const sql = manifestToSql({ ...small, name: "O'Brien" }, { status: "listed", repo: "https://github.com/a/b", description: "it's fun" });
    expect(sql).toContain("'O''Brien'");
    expect(sql).toContain("'it''s fun'");
    expect(sql).toContain("$manifest$");
    expect(sql).toContain("'listed'");
    expect(sql).toMatch(/select public\.apply_manifest\('my-game'/);
  });
  it("checklist mentions the manual QA steps", () => {
    const c = reviewChecklist(parseIssue(issueBody()), { issue: "7" });
    expect(c).toMatch(/WITHOUT GAMA Hub/);
    expect(c).toMatch(/Issue #7/);
    expect(c).toMatch(/1 claim-type/);
  });
});
