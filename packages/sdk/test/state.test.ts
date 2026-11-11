import { describe, expect, it } from "vitest";
import { validateManifest } from "../src/manifest";
import { applyAchievement, applyScore, applyStat, emptyState, evaluateRules, mergeAchievementMaps, mergeStat, normalizeState, snapshotPayload } from "../src/state";
import { M } from "./fixtures";

describe("manifest", () => {
  it("accepts the fixture", () => expect(validateManifest(M)).toEqual([]));
  it("reports problems without throwing", () => {
    expect(validateManifest(null)).not.toEqual([]);
    const bad = { ...M, gameId: "X", achievements: [{ id: "a", name: "A", rule: { stat: "nope", gte: 1 } }] };
    const errs = validateManifest(bad);
    expect(errs.some((e) => e.includes("gameId"))).toBe(true);
    expect(errs.some((e) => e.includes("unknown stat"))).toBe(true);
  });
});

describe("stat merge rules", () => {
  const kills = M.stats![0], best = M.stats![2], fastest = M.stats![3], loadout = M.stats![4];
  it("sum adds deltas, clamps a single delta, ignores negatives", () => {
    expect(mergeStat(kills, 5, 3)).toBe(8);
    expect(mergeStat(kills, 0, 1000)).toBe(100);
    expect(mergeStat(kills, 5, -2)).toBeUndefined();
  });
  it("sum as total (backfill/import) never double counts", () => {
    expect(mergeStat(kills, 50, 40, { asTotal: true })).toBeUndefined();
    expect(mergeStat(kills, 50, 70, { asTotal: true })).toBe(70);
  });
  it("max/min keep the best and respect the cap", () => {
    expect(mergeStat(best, 10, 7)).toBeUndefined();
    expect(mergeStat(best, 10, 9999)).toBe(500);
    expect(mergeStat(fastest, undefined, 30)).toBe(30);
    expect(mergeStat(fastest, 30, 25)).toBe(25);
  });
  it("latest: newer write wins, older loses", () => {
    expect(mergeStat(loadout, "a", "b", { at: 2, prevAt: 1 })).toBe("b");
    expect(mergeStat(loadout, "a", "b", { at: 1, prevAt: 2 })).toBeUndefined();
    expect(mergeStat(loadout, "a", 5)).toBeUndefined();
  });
});

describe("local state", () => {
  it("applies stats, scores and evaluates rule achievements", () => {
    const s = emptyState();
    expect(applyStat(s, M, "kills", 12, 1)).toBe(true);
    expect(applyStat(s, M, "unknown", 1, 1)).toBe(false);
    expect(evaluateRules(s, M, 1).sort()).toEqual(["first", "ten"]);
    expect(applyScore(s, M, "score", 10, 1)).toBe("best");
    expect(applyScore(s, M, "score", 5, 2)).toBe("ok");
    expect(applyScore(s, M, "score", -1, 2)).toBe("invalid");
    expect(applyScore(s, M, "time", 50, 1)).toBe("best");
    expect(applyScore(s, M, "time", 40, 2)).toBe("best");
    expect(snapshotPayload(s).best).toEqual({ score: 10, time: 40 });
  });
  it("achievements are a union, earliest time wins", () => {
    const s = emptyState();
    expect(applyAchievement(s, M, "nohit", 10)).toBe(true);
    expect(applyAchievement(s, M, "nohit", 20)).toBe(false);
    expect(applyAchievement(s, M, "nohit", 5)).toBe(false);
    expect(s.achievements.nohit).toBe(5);
    expect(applyAchievement(s, M, "fake", 5)).toBe(false);
    expect(mergeAchievementMaps({ a: 5, b: 1 }, { a: 3, c: 9 })).toEqual({ a: 3, b: 1, c: 9 });
  });
  it("normalizes garbage", () => {
    const s = normalizeState({ connect: "yes", stats: { a: 1, b: {}, c: "x" }, queue: [1, { idem: "i", type: "stat" }] });
    expect(s.connect).toBe(false);
    expect(s.stats).toEqual({ a: 1, c: "x" });
    expect(s.queue).toHaveLength(1);
  });
});
