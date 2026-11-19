// Where the SDK keeps its local state. Default: a small JSON file next to the game's data.json,
// so it never fights with the game's own saveData() and is removed with the plugin.

export interface SdkStorage {
  load(): Promise<unknown>;
  save(data: unknown): Promise<void>;
}

/** Minimal shape of an Obsidian Plugin the SDK needs (duck-typed, so the SDK has no dependencies). */
export interface PluginLike {
  app: unknown;
  manifest: { id: string; dir?: string; name?: string };
  register?(cb: () => unknown): void;
  registerEvent?(ref: unknown): void;
}

interface AdapterLike {
  exists(path: string): Promise<boolean>;
  read(path: string): Promise<string>;
  write(path: string, data: string): Promise<void>;
}

export function pluginFileStorage(plugin: PluginLike, fileName = "obsigama-sync.json"): SdkStorage {
  const app = plugin.app as { vault?: { adapter?: AdapterLike; configDir?: string } };
  const adapter = app.vault?.adapter;
  const dir = plugin.manifest.dir ?? `${app.vault?.configDir ?? ".obsidian"}/plugins/${plugin.manifest.id}`;
  const path = `${dir}/${fileName}`;
  if (!adapter) return memoryStorage();
  return {
    async load() {
      try {
        return (await adapter.exists(path)) ? JSON.parse(await adapter.read(path)) : null;
      } catch {
        return null; // corrupt file: start fresh rather than break the game
      }
    },
    async save(data) {
      await adapter.write(path, JSON.stringify(data));
    },
  };
}

export function memoryStorage(initial: unknown = null): SdkStorage & { data: unknown } {
  const st = {
    data: initial,
    async load() { return st.data; },
    async save(d: unknown) { st.data = JSON.parse(JSON.stringify(d)); },
  };
  return st;
}
