import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PLATFORM_PLUGIN_ID, PLATFORM_READY_EVENT, PLATFORM_UNLOAD_EVENT } from "../packages/sdk/src/protocol";

describe("plugin id", () => {
  it("manifest.json id matches the id games look for", () => {
    const m = JSON.parse(readFileSync(new URL("../manifest.json", import.meta.url), "utf8"));
    expect(m.id).toBe("obsigama");
    expect(PLATFORM_PLUGIN_ID).toBe(m.id);
    expect(PLATFORM_READY_EVENT).toBe(`${m.id}:ready`);
    expect(PLATFORM_UNLOAD_EVENT).toBe(`${m.id}:unload`);
  });
});
