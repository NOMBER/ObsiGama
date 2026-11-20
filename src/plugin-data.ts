// Serialized plugin data (data.json) with a queue so auth and settings cannot overwrite each other.
import type { Plugin } from "obsidian";

const AUTH = "__auth";

export class PluginDataFile {
  private q: Promise<unknown> = Promise.resolve();

  constructor(private plugin: Plugin) {}

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.q.then(fn, fn);
    this.q = run.then(() => undefined, () => undefined);
    return run;
  }

  private async load(): Promise<Record<string, unknown>> {
    return ((await this.plugin.loadData()) ?? {}) as Record<string, unknown>;
  }

  /** Merge a patch into data.json, preserving keys that the patch does not mention (e.g. the auth map). */
  merge(patch: Record<string, unknown>): Promise<void> {
    return this.enqueue(async () => {
      const cur = await this.load();
      await this.plugin.saveData({ ...cur, ...patch });
    });
  }

  async getAuth(key: string): Promise<string | null> {
    return this.enqueue(async () => {
      const auth = (await this.load())[AUTH];
      if (!auth || typeof auth !== "object") return null;
      const v = (auth as Record<string, unknown>)[key];
      return typeof v === "string" ? v : null;
    });
  }

  setAuth(key: string, value: string): Promise<void> {
    return this.enqueue(async () => {
      const cur = await this.load();
      const prev = cur[AUTH];
      const auth = { ...(prev && typeof prev === "object" ? prev as Record<string, unknown> : {}), [key]: value };
      await this.plugin.saveData({ ...cur, [AUTH]: auth });
    });
  }

  removeAuth(key: string): Promise<void> {
    return this.enqueue(async () => {
      const cur = await this.load();
      const prev = cur[AUTH];
      const auth = { ...(prev && typeof prev === "object" ? prev as Record<string, unknown> : {}) };
      delete auth[key];
      await this.plugin.saveData({ ...cur, [AUTH]: auth });
    });
  }
}
