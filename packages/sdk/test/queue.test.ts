import { describe, expect, it } from "vitest";
import type { SyncEvent } from "../src/protocol";
import { applyResults, backoffMs, compact, enqueue, newIdem, replaceWithSnapshot, takeBatch } from "../src/queue";

const stat = (idem: string, id: string, value: number, sent = false): SyncEvent => ({ idem, at: 1, type: "stat", payload: { id, value }, sent });

describe("queue", () => {
  it("idempotency keys are unique and time-sortable", () => {
    const a = newIdem(1000), b = newIdem(2000);
    expect(a).not.toBe(newIdem(1000));
    expect(a < b).toBe(true);
  });
  it("overflow drops the oldest and tells the caller", () => {
    const q: SyncEvent[] = [];
    expect(enqueue(q, [stat("1", "k", 1), stat("2", "k", 1)], 3)).toBe(false);
    expect(enqueue(q, [stat("3", "k", 1), stat("4", "k", 1)], 3)).toBe(true);
    expect(q.map((e) => e.idem)).toEqual(["2", "3", "4"]);
  });
  it("compacts only unsent sum deltas", () => {
    const q = [stat("1", "kills", 2, true), stat("2", "kills", 3), stat("3", "best", 9), stat("4", "kills", 4)];
    const out = compact(q, (id) => id === "kills");
    expect(out.map((e) => e.idem)).toEqual(["1", "2", "3"]);
    expect((out[1] as Extract<SyncEvent, { type: "stat" }>).payload.value).toBe(7);
  });
  it("never merges deltas past the per-event cap (offline wins are not lost)", () => {
    const val = (e: SyncEvent) => (e as Extract<SyncEvent, { type: "stat" }>).payload.value;
    // wins: maxDelta 1 -> two offline wins stay two events
    const wins = compact([stat("1", "wins", 1), stat("2", "wins", 1), stat("3", "wins", 1)], () => 1);
    expect(wins.map(val)).toEqual([1, 1, 1]);
    // playtime: cap 10 -> packed greedily, never above the cap
    const pt = compact([stat("1", "pt", 4), stat("2", "pt", 5), stat("3", "pt", 3), stat("4", "pt", 12), stat("5", "pt", 2)], () => 10);
    expect(pt.map(val)).toEqual([9, 3, 12, 2]);
    expect(pt.map(val).reduce((a, b) => a + b)).toBe(26);
    // not mergeable at all
    expect(compact([stat("1", "x", 1), stat("2", "x", 1)], () => false)).toHaveLength(2);
  });
  it("snapshot replaces unsent events but keeps sent ones", () => {
    const snap: SyncEvent = { idem: "s", at: 1, type: "snapshot", payload: { stats: {}, achievements: {}, best: {} } };
    const out = replaceWithSnapshot([stat("1", "k", 1, true), stat("2", "k", 1)], snap);
    expect(out.map((e) => e.idem)).toEqual(["s", "1"]);
  });
  it("batches, then removes finished events and keeps retries", () => {
    const q = [stat("1", "k", 1), stat("2", "k", 1), stat("3", "k", 1)];
    const b = takeBatch(q, 2);
    expect(b.map((e) => e.sent)).toEqual([true, true]);
    const { queue, rejected } = applyResults(q, [{ idem: "1", status: "accepted" }, { idem: "2", status: "retry" }, { idem: "3", status: "rejected", reason: "bounds" }]);
    expect(queue.map((e) => e.idem)).toEqual(["2"]);
    expect(rejected).toHaveLength(1);
  });
  it("backoff grows and caps", () => {
    const mid = () => 0.5;
    expect(backoffMs(1, mid)).toBe(30_000);
    expect(backoffMs(2, mid)).toBe(60_000);
    expect(backoffMs(20, mid)).toBe(30 * 60_000);
  });
});
