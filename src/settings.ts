import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import { PLATFORM_NAME } from "./brand";
import type SPlugin from "./main";

export interface LinkedGame {
  userId: string;
  name: string;
  linkedAt: number;
}

export interface SSettings {
  /** master switch: false = S makes no network requests at all */
  online: boolean;
  supabaseUrl: string;
  supabaseAnonKey: string;
  useRequestUrl: boolean;
  /** games the player allowed to sync, per account */
  linkedGames: Record<string, LinkedGame>;
}

export const DEFAULT_SETTINGS: SSettings = {
  online: true,
  supabaseUrl: "",
  supabaseAnonKey: "",
  useRequestUrl: false,
  linkedGames: {},
};

export function normalizeSettings(raw: unknown): SSettings {
  const r = (raw && typeof raw === "object" ? raw : {}) as Partial<SSettings>;
  return {
    online: r.online !== false,
    supabaseUrl: typeof r.supabaseUrl === "string" ? r.supabaseUrl.trim() : "",
    supabaseAnonKey: typeof r.supabaseAnonKey === "string" ? r.supabaseAnonKey.trim() : "",
    useRequestUrl: r.useRequestUrl === true,
    linkedGames: r.linkedGames && typeof r.linkedGames === "object" ? { ...r.linkedGames } : {},
  };
}

export class SSettingTab extends PluginSettingTab {
  constructor(app: App, private plugin: SPlugin) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    const p = this.plugin;
    containerEl.empty();

    new Setting(containerEl)
      .setName("Online / sync")
      .setDesc(`When off, ${PLATFORM_NAME} makes no network requests at all and accepts nothing from games. Games keep working locally; their results wait until you switch this back on.`)
      .addToggle((t) => t.setValue(p.settings.online).onChange(async (v) => {
        await p.setOnline(v);
      }));

    new Setting(containerEl).setName("Server").setHeading();
    new Setting(containerEl)
      .setName("Supabase project URL")
      .setDesc("From your Supabase project: Project Settings → API → Project URL, e.g. https://abcd.supabase.co")
      .addText((t) => t.setPlaceholder("https://xxxx.supabase.co").setValue(p.settings.supabaseUrl)
        .onChange(async (v) => { p.settings.supabaseUrl = v.trim(); await p.saveSettings(false); }));
    new Setting(containerEl)
      .setName("Supabase anon (public) key")
      .setDesc("Project Settings → API → anon / publishable key. Never paste the service_role key here.")
      .addText((t) => {
        t.inputEl.type = "password";
        t.setValue(p.settings.supabaseAnonKey).onChange(async (v) => { p.settings.supabaseAnonKey = v.trim(); await p.saveSettings(false); });
      });
    new Setting(containerEl)
      .setName("Apply server settings")
      .setDesc("Reconnects with the URL and key above.")
      .addButton((b) => b.setButtonText("Apply").onClick(async () => {
        if (p.settings.supabaseAnonKey.startsWith("eyJ") && p.settings.supabaseAnonKey.includes("service_role")) {
          new Notice("That looks like a service_role key. Use the anon key.");
          return;
        }
        await p.saveSettings(true);
        new Notice(`${PLATFORM_NAME}: server settings applied`);
      }));
    new Setting(containerEl)
      .setName("Use Obsidian's network layer")
      .setDesc("Sends requests through Obsidian's requestUrl instead of fetch. Only needed if requests fail because of CORS or a proxy.")
      .addToggle((t) => t.setValue(p.settings.useRequestUrl).onChange(async (v) => { p.settings.useRequestUrl = v; await p.saveSettings(false); }));

    new Setting(containerEl).setName("Account").setHeading();
    const st = p.backend.status();
    new Setting(containerEl)
      .setName(st.signedIn ? `Signed in as @${st.username ?? "…"}` : "Not signed in")
      .setDesc(st.signedIn ? "" : `Open the ${PLATFORM_NAME} hub to sign in or create an account.`)
      .addButton((b) => st.signedIn
        ? b.setButtonText("Sign out").onClick(async () => { await p.backend.signOut(); this.display(); })
        : b.setButtonText(`Open ${PLATFORM_NAME}`).setCta().onClick(() => p.openHub()));

    new Setting(containerEl).setName("Connected games").setHeading();
    const games = Object.entries(p.settings.linkedGames);
    if (!games.length) containerEl.createEl("p", { cls: "setting-item-description", text: "No game has connected yet. Turn on \"Connect to " + PLATFORM_NAME + "\" in a game's settings." });
    for (const [id, g] of games) {
      new Setting(containerEl)
        .setName(g.name || id)
        .setDesc(`Allowed ${new Date(g.linkedAt).toLocaleDateString()}${g.userId !== st.userId ? " (for another account)" : ""}`)
        .addButton((b) => b.setButtonText("Disconnect").onClick(async () => { p.api.unlink(id); this.display(); }));
    }
  }
}
