// Game manifest: what a game tracks. The server keeps its own copy (registered per version)
// and validates against that copy, never against what the client sends.

export type StatAgg = "sum" | "count" | "max" | "min" | "latest";

export interface StatDef {
  id: string;
  /**
   * sum/count: the game reports deltas (count: usually 1), totals add up.
   * max/min: the game reports values, the best one is kept.
   * latest: the newest value by time wins (numbers or strings).
   */
  agg: StatAgg;
  type?: "number" | "string";
  /** hard cap for the stored value (server clamps) */
  max?: number;
  /** cap for a single reported delta (sum/count), server clamps */
  maxDelta?: number;
  name?: string;
}

export interface LeaderboardDef {
  id: string;
  name?: string;
  /** desc = higher is better (scores), asc = lower is better (times) */
  sort: "desc" | "asc";
  min?: number;
  /** hard upper bound: values above it are rejected */
  max?: number;
}

export type AchievementRule =
  /** unlocked when the stat reaches the value; the server evaluates it itself */
  | { stat: string; gte: number }
  /** the game claims it (e.g. "no damage taken"); accepted, but rate-limited and marked as claimed */
  | { claim: true };

export interface AchievementDef {
  id: string;
  name: string;
  description?: string;
  icon?: string;
  hidden?: boolean;
  rule: AchievementRule;
}

export interface GameManifest {
  /** globally unique, stable, lowercase: [a-z0-9-]{3,40} */
  gameId: string;
  /** the Obsidian plugin id of the game */
  pluginId: string;
  name: string;
  /** bump when you add stats/boards/achievements and register the new version on the server */
  manifestVersion: number;
  stats?: StatDef[];
  leaderboards?: LeaderboardDef[];
  achievements?: AchievementDef[];
}

const ID = /^[a-z0-9][a-z0-9_.-]{0,63}$/;
const GAME_ID = /^[a-z0-9][a-z0-9-]{2,39}$/;
const AGGS: StatAgg[] = ["sum", "count", "max", "min", "latest"];

/** Returns a list of problems; empty means valid. Never throws. */
export function validateManifest(m: unknown): string[] {
  const errs: string[] = [];
  if (!m || typeof m !== "object") return ["manifest must be an object"];
  const g = m as Partial<GameManifest>;
  if (typeof g.gameId !== "string" || !GAME_ID.test(g.gameId)) errs.push("gameId must match [a-z0-9-]{3,40}");
  if (typeof g.pluginId !== "string" || !g.pluginId) errs.push("pluginId is required");
  if (typeof g.name !== "string" || !g.name) errs.push("name is required");
  if (!Number.isInteger(g.manifestVersion) || (g.manifestVersion as number) < 1) errs.push("manifestVersion must be an integer >= 1");
  const seen = new Set<string>();
  const uniq = (kind: string, id: unknown) => {
    if (typeof id !== "string" || !ID.test(id)) { errs.push(`${kind} id "${String(id)}" is invalid`); return; }
    const k = kind + ":" + id;
    if (seen.has(k)) errs.push(`duplicate ${kind} id "${id}"`);
    seen.add(k);
  };
  const stats = new Map<string, StatDef>();
  for (const s of g.stats ?? []) {
    uniq("stat", s.id);
    if (!AGGS.includes(s.agg)) errs.push(`stat "${s.id}": agg must be one of ${AGGS.join(", ")}`);
    if (s.type === "string" && s.agg !== "latest") errs.push(`stat "${s.id}": string stats must use agg "latest"`);
    stats.set(s.id, s);
  }
  for (const l of g.leaderboards ?? []) {
    uniq("leaderboard", l.id);
    if (l.sort !== "asc" && l.sort !== "desc") errs.push(`leaderboard "${l.id}": sort must be asc or desc`);
    if (l.min != null && l.max != null && l.min > l.max) errs.push(`leaderboard "${l.id}": min > max`);
  }
  for (const a of g.achievements ?? []) {
    uniq("achievement", a.id);
    if (!a.name) errs.push(`achievement "${a.id}": name is required`);
    const r = a.rule as AchievementRule | undefined;
    if (!r) errs.push(`achievement "${a.id}": rule is required`);
    else if ("stat" in r) {
      const s = stats.get(r.stat);
      if (!s) errs.push(`achievement "${a.id}": unknown stat "${r.stat}"`);
      else if (s.type === "string") errs.push(`achievement "${a.id}": rule on a string stat`);
      if (typeof r.gte !== "number") errs.push(`achievement "${a.id}": gte must be a number`);
    } else if (!("claim" in r) || r.claim !== true) errs.push(`achievement "${a.id}": rule must be {stat, gte} or {claim: true}`);
  }
  return errs;
}

export function findStat(m: GameManifest, id: string): StatDef | undefined {
  return m.stats?.find((s) => s.id === id);
}
export function findBoard(m: GameManifest, id: string): LeaderboardDef | undefined {
  return m.leaderboards?.find((l) => l.id === id);
}
export function findAchievement(m: GameManifest, id: string): AchievementDef | undefined {
  return m.achievements?.find((a) => a.id === id);
}
