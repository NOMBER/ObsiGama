import { describe, expect, it, vi } from "vitest";
import { SClient } from "../src/client";
import type { PlatformAPI, PlatformStatus, SubmitRequest, SubmitResponse } from "../src/protocol";
import { memoryStorage } from "../src/storage";
import { M } from "./fixtures";

function fakePlatform(over: Partial<PlatformStatus> = {}) {
  const status: PlatformStatus = { enabled: true, configured: true, signedIn: true, userId: "u1", username: "neo", ...over };
  const linked = new Set<string>();
  const subs = new Set<(s: PlatformStatus) => void>();
  const sent: SubmitRequest[] = [];
  let fail: SubmitResponse | null = null;
  const api: PlatformAPI = {
    protocol: 1, platformName: "OBSIGAMA",
    getStatus: () => ({ ...status }),
    onStatusChange: (cb) => { subs.add(cb); return () => subs.delete(cb); },
    isLinked: (g) => linked.has(g),
    requestLink: vi.fn(async (r) => { linked.add(r.gameId); return { ok: true as const, userId: status.userId! }; }),
    unlink: (g) => linked.delete(g),
    submit: vi.fn(async (req: SubmitRequest): Promise<SubmitResponse> => {
      if (fail) return fail;
      sent.push(JSON.parse(JSON.stringify(req)));
      return { ok: true, results: req.events.map((e) => ({ idem: e.idem, status: "accepted" as const })), unlocked: [], badges: [{ id: "first_run", name: "First run" }], stats: { kills: 1 } };
    }),
    openHub: () => {},
  };
  return {
    api, sent, status, linked,
    set: (p: Partial<PlatformStatus>) => { Object.assign(status, p); subs.forEach((cb) => cb({ ...status })); },
    failWith: (r: SubmitResponse | null) => { fail = r; },
  };
}

const plugin = { app: {}, manifest: { id: "test-game" } };
const noTimers = { setTimer: () => 0, clearTimer: () => {} };

describe("SClient", () => {
  it("works fully offline without OBSIGAMA and never throws", async () => {
    const c = await SClient.create({ plugin, manifest: M, storage: memoryStorage(), platform: () => null, ...noTimers, log: () => {} });
    await c.endRun({ durationMs: 1000, stats: { kills: 3, nope: 1 }, scores: { score: 50 }, achievements: ["nohit"] });
    c.reportStat("best_wave", "x" as unknown as number);
    expect(c.getStats()).toMatchObject({ kills: 3 });
    expect(c.getBest("score")).toBe(50);
    expect(Object.keys(c.getAchievements()).sort()).toEqual(["first", "nohit"]);
    expect(c.getStatus().state).toBe("off");
    await c.setConnect(true);
    expect(c.getStatus().state).toBe("no-platform");
  });

  it("connect: asks consent, backfills a snapshot, then sends each run once", async () => {
    const p = fakePlatform();
    const st = memoryStorage();
    const c = await SClient.create({ plugin, manifest: M, storage: st, platform: () => p.api, ...noTimers, log: () => {} });
    await c.endRun({ stats: { kills: 5 }, scores: { score: 100 } }); // before connecting: local only
    expect(p.sent).toHaveLength(0);
    const badges: string[] = [];
    c.on("badge", (b) => badges.push(b.id));
    await c.setConnect(true);
    expect(p.api.requestLink).toHaveBeenCalledOnce();
    expect(p.sent).toHaveLength(1);
    expect(p.sent[0].events.map((e) => e.type)).toEqual(["snapshot"]);
    expect(p.sent[0].events[0].payload).toMatchObject({ stats: { kills: 5 }, best: { score: 100 } });
    expect(badges).toEqual(["first_run"]);
    await c.endRun({ durationMs: 500, stats: { kills: 2 }, scores: { score: 10 } });
    expect(p.sent).toHaveLength(2);
    expect(p.sent[1].events.map((e) => e.type)).toEqual(["session", "stat", "score"]);
    expect(c.getStatus()).toMatchObject({ state: "synced", pending: 0 });
  });

  it("OBSIGAMA disabled or failing: results stay queued and go out when OBSIGAMA comes back", async () => {
    const p = fakePlatform();
    const c = await SClient.create({ plugin, manifest: M, storage: memoryStorage(), platform: () => p.api, ...noTimers, log: () => {} });
    await c.setConnect(true);
    p.set({ enabled: false });
    await c.endRun({ stats: { kills: 1 } });
    await c.endRun({ stats: { kills: 1 } });
    expect(c.getStatus()).toMatchObject({ state: "platform-disabled", pending: 4 });
    const before = p.sent.length;
    p.failWith({ ok: false, error: "network", message: "offline" });
    p.set({ enabled: true });
    await vi.waitFor(() => expect(c.getStatus().state).toBe("error"));
    p.failWith(null);
    await c.endRun({ stats: { kills: 1 } });
    expect(p.sent.length).toBe(before + 1);
    const evs = p.sent.at(-1)!.events;
    // the two unsent-then-failed kill deltas stay separate (they were sent once); the new one is added
    expect(evs.filter((e) => e.type === "stat").reduce((a, e) => a + Number((e.payload as { value: number }).value), 0)).toBe(3);
    expect(c.getStatus().pending).toBe(0);
  });

  it("offline runs: capped deltas are never merged past maxDelta (2 offline wins = 2)", async () => {
    const p = fakePlatform();
    const capped = { ...M, stats: [...M.stats!, { id: "wins", agg: "sum" as const, maxDelta: 1 }] };
    const c = await SClient.create({ plugin, manifest: capped, storage: memoryStorage(), platform: () => p.api, ...noTimers, log: () => {} });
    await c.setConnect(true);
    p.set({ enabled: false }); // offline: everything stays queued and unsent
    await c.endRun({ stats: { wins: 1, kills: 60 } });
    await c.endRun({ stats: { wins: 1, kills: 30 } });
    await c.endRun({ stats: { wins: 1, kills: 50 } });
    p.set({ enabled: true });
    await vi.waitFor(() => expect(c.getStatus().pending).toBe(0));
    const stats = p.sent.flatMap((r) => r.events).filter((e) => e.type === "stat") as { payload: { id: string; value: number } }[];
    const winEvents = stats.filter((e) => e.payload.id === "wins").map((e) => e.payload.value);
    const killEvents = stats.filter((e) => e.payload.id === "kills").map((e) => e.payload.value);
    expect(winEvents).toEqual([1, 1, 1]);
    expect(killEvents.every((v) => v <= 100)).toBe(true); // kills maxDelta 100: 60+30 merged, 50 separate
    expect(killEvents.reduce((a, b) => a + b, 0)).toBe(140);
  });

  it("never pops the consent dialog by itself after a run", async () => {
    const p = fakePlatform();
    const c = await SClient.create({ plugin, manifest: M, storage: memoryStorage(), platform: () => p.api, ...noTimers, log: () => {} });
    await c.setConnect(true);
    p.linked.clear(); // e.g. unlinked in OBSIGAMA
    (p.api.requestLink as ReturnType<typeof vi.fn>).mockClear();
    await c.endRun({ stats: { kills: 1 } });
    expect(p.api.requestLink).not.toHaveBeenCalled();
    expect(c.getStatus().state).toBe("needs-link");
  });

  it("persists state and reloads it", async () => {
    const st = memoryStorage();
    const c = await SClient.create({ plugin, manifest: M, storage: st, platform: () => null, ...noTimers, log: () => {} });
    await c.endRun({ stats: { kills: 4 } });
    const c2 = await SClient.create({ plugin, manifest: M, storage: st, platform: () => null, ...noTimers, log: () => {} });
    expect(c2.getStats().kills).toBe(4);
  });

  it("importTotals merges existing progress without double counting", async () => {
    const c = await SClient.create({ plugin, manifest: M, storage: memoryStorage(), platform: () => null, ...noTimers, log: () => {} });
    c.importTotals({ stats: { kills: 40 }, best: { score: 900 }, achievements: ["nohit"] });
    c.importTotals({ stats: { kills: 40 }, best: { score: 900 }, achievements: ["nohit"] });
    expect(c.getStats().kills).toBe(40);
    expect(c.getBest("score")).toBe(900);
    expect(Object.keys(c.getAchievements()).sort()).toEqual(["first", "nohit", "ten"]);
  });
});
