// Safe helpers around undocumented app.plugins, the community-plugin URI, and "Play".

export interface PluginInstallState {
  installed: boolean;
  enabled: boolean;
}

export interface CommandDir {
  listCommands?: () => { id: string; name?: string }[];
  executeCommandById?: (id: string) => boolean;
}

export interface PluginsDir {
  manifests?: Record<string, unknown>;
  enabledPlugins?: Set<string>;
  enablePluginAndSave?: (id: string) => Promise<unknown>;
}

export function pluginsDir(app: object): PluginsDir | undefined {
  return (app as { plugins?: PluginsDir }).plugins;
}

export function pluginState(app: object, pluginId: string): PluginInstallState {
  const p = pluginsDir(app);
  return {
    installed: !!p?.manifests?.[pluginId],
    enabled: !!p?.enabledPlugins?.has(pluginId),
  };
}

/** Official Obsidian URI that opens a plugin in the community directory. */
export function storePluginUri(pluginId: string): string {
  return `obsidian://show-plugin?id=${encodeURIComponent(pluginId)}`;
}

/** Install target: the store page when the game is listed there, otherwise the GitHub repo. */
export function installUrl(pluginId: string, inStore: boolean, repoUrl: string | null | undefined): string {
  if (inStore) return storePluginUri(pluginId);
  if (repoUrl) return repoUrl;
  return storePluginUri(pluginId);
}

/**
 * Pick a command that starts the game.
 * 1. `launchCommand` from the catalog (with or without the `pluginId:` prefix), if it exists
 * 2. a command of this plugin whose id looks like open/play/launch
 * 3. the first command of this plugin
 */
export function resolveLaunchCommand(
  pluginId: string,
  launchCommand: string | null | undefined,
  commandIds: string[],
): string | null {
  const mine = commandIds.filter((id) => id === pluginId || id.startsWith(pluginId + ":"));
  if (launchCommand) {
    const full = launchCommand.includes(":") ? launchCommand : `${pluginId}:${launchCommand}`;
    if (commandIds.includes(full)) return full;
  }
  const preferred = mine.find((id) => /:(open|play|launch)(-|$)/i.test(id) || /:(open|play|launch)$/i.test(id));
  return preferred ?? mine[0] ?? null;
}

export function listPluginCommandIds(commands: CommandDir | undefined): string[] {
  if (typeof commands?.listCommands !== "function") return [];
  try {
    return (commands.listCommands() ?? []).map((c) => c.id).filter(Boolean);
  } catch {
    return [];
  }
}

export function executeCommand(commands: CommandDir | undefined, id: string): boolean {
  return typeof commands?.executeCommandById === "function" && commands.executeCommandById(id) === true;
}

export async function enablePlugin(app: object, pluginId: string): Promise<void> {
  const fn = pluginsDir(app)?.enablePluginAndSave;
  if (typeof fn !== "function") {
    throw new Error("Enable this plugin in Settings → Community plugins.");
  }
  await fn.call(pluginsDir(app), pluginId);
}

export function openUrl(url: string): void {
  window.open(url);
}
