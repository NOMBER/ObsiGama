# @obsigama/sdk

Zero-dependency SDK for Obsidian game plugins: offline-first local stats / best scores / achievements, and optional
sync of every finished run to the player's **OBSIGAMA** account. See [INTEGRATION.md](../../INTEGRATION.md).

```ts
const s = await SClient.create({ plugin: this, manifest });
await s.endRun({ durationMs, stats: { runs: 1, kills }, scores: { score }, achievements: ["no_damage"] });
addConnectSetting(containerEl, s, Setting, { lang: "en" });
```

## Changelog

- **0.1.1** — fix: unsent `sum`/`count` deltas collected offline were merged into one event, but the server caps every
  event at the stat's `maxDelta`, so e.g. two offline wins (`maxDelta: 1`) counted as one. Merging now stops at
  `maxDelta` (stats without one: the server default 1,000,000), so nothing is lost and requests stay small. Drop-in
  replacement for 0.1.0, no API or storage changes.
- **0.1.0** — first release.
