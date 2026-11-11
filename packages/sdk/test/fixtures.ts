import type { GameManifest } from "../src/manifest";
export const M: GameManifest = {
  gameId: "test-game", pluginId: "test-game", name: "Test", manifestVersion: 1,
  stats: [
    { id: "kills", agg: "sum", maxDelta: 100 },
    { id: "runs", agg: "count" },
    { id: "best_wave", agg: "max", max: 500 },
    { id: "fastest", agg: "min" },
    { id: "loadout", agg: "latest", type: "string" },
  ],
  leaderboards: [
    { id: "score", sort: "desc", min: 0, max: 1_000_000 },
    { id: "time", sort: "asc", min: 1 },
  ],
  achievements: [
    { id: "first", name: "First", rule: { stat: "kills", gte: 1 } },
    { id: "ten", name: "Ten", rule: { stat: "kills", gte: 10 } },
    { id: "nohit", name: "No hit", rule: { claim: true } },
  ],
};
