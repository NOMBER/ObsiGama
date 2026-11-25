import { describe, expect, it } from "vitest";
import { installUrl, resolveLaunchCommand, storePluginUri } from "../src/plugin-host";

describe("plugin install and launch helpers", () => {
  it("builds the community-plugin URI", () => {
    expect(storePluginUri("good-old-games")).toBe("obsidian://show-plugin?id=good-old-games");
    expect(storePluginUri("a b")).toBe("obsidian://show-plugin?id=a%20b");
  });

  it("uses the store when in_store, otherwise the GitHub repo", () => {
    expect(installUrl("vault-shards", true, "https://github.com/NOMBER/HELLVAULT")).toBe("obsidian://show-plugin?id=vault-shards");
    expect(installUrl("other", false, "https://github.com/NOMBER/X")).toBe("https://github.com/NOMBER/X");
    expect(installUrl("other", false, null)).toBe("obsidian://show-plugin?id=other");
  });

  it("resolves launch_command with or without the plugin prefix", () => {
    const ids = ["vault-shards:open", "vault-shards:export-codex"];
    expect(resolveLaunchCommand("vault-shards", "open", ids)).toBe("vault-shards:open");
    expect(resolveLaunchCommand("vault-shards", "vault-shards:open", ids)).toBe("vault-shards:open");
    expect(resolveLaunchCommand("vault-shards", "missing", ids)).toBe("vault-shards:open");
  });

  it("falls back to an open/play command, then the first command", () => {
    expect(resolveLaunchCommand("good-old-games", null, [
      "good-old-games:close-popup",
      "good-old-games:open-hub",
      "good-old-games:play-snake",
    ])).toBe("good-old-games:open-hub");
    expect(resolveLaunchCommand("x", null, ["x:stats", "x:help"])).toBe("x:stats");
    expect(resolveLaunchCommand("x", "x:nope", [])).toBe(null);
  });
});
