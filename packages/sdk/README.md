# @obsigama/sdk

Zero-dependency SDK for Obsidian game plugins: offline-first local stats / best scores / achievements, and optional
sync of every finished run to the player's **OBSIGAMA** account. See [INTEGRATION.md](../../INTEGRATION.md).

```ts
const s = await SClient.create({ plugin: this, manifest });
await s.endRun({ durationMs, stats: { runs: 1, kills }, scores: { score }, achievements: ["no_damage"] });
addConnectSetting(containerEl, s, Setting, { lang: "en" });
```
