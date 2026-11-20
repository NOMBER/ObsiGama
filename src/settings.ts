import { App, Notice, PluginSettingTab, Setting, type SettingDefinitionItem } from "obsidian";
import { DEFAULT_SUPABASE_URL, PLATFORM_NAME } from "./brand";
import { isSecretKey } from "./server";
import type SPlugin from "./main";

export interface LinkedGame {
  userId: string;
  name: string;
  linkedAt: number;
}

export interface SSettings {
  /** master switch: false = ObsiGama makes no network requests at all */
  online: boolean;
  /** custom server (advanced); empty = the official ObsiGama server */
  supabaseUrl: string;
  supabaseAnonKey: string;
  /** unused; kept so older data.json still loads (network always uses requestUrl) */
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

  /** Declarative settings for Obsidian 1.13+ (searchable). display() is the fallback on older app versions. */
  getSettingDefinitions(): SettingDefinitionItem[] {
    const p = this.plugin;
    const st = p.backend.status();
    const games = Object.entries(p.settings.linkedGames);
    return [
      {
        name: "Online / sync",
        desc: `When off, ${PLATFORM_NAME} makes no network requests at all and accepts nothing from games. Games keep working locally; their results wait until you switch this back on.`,
        control: { type: "toggle", key: "online" },
      },
      {
        type: "group",
        heading: "Advanced: custom server",
        items: [
          {
            name: "Official server",
            desc: `Leave both fields empty to use the official ${PLATFORM_NAME} server. Only for people running their own copy of the backend.`,
          },
          {
            name: "Supabase project URL",
            desc: "Project Settings → API → Project URL.",
            control: { type: "text", key: "supabaseUrl", placeholder: DEFAULT_SUPABASE_URL },
          },
          {
            name: "Supabase publishable (anon) key",
            desc: "Project Settings → API keys → publishable key. Never paste a secret or service_role key here.",
            control: { type: "secret", key: "supabaseAnonKey" },
          },
          {
            name: "Apply server settings",
            desc: "Reconnects with the server above (or the official one when the fields are empty).",
            action: () => { void this.applyServer(); },
          },
        ],
      },
      {
        type: "group",
        heading: "Account",
        items: [
          {
            name: st.signedIn ? `Signed in as @${st.username ?? "…"}` : "Not signed in",
            desc: st.signedIn ? "" : `Open the ${PLATFORM_NAME} hub to sign in or create an account.`,
            action: () => { void this.onAccount(); },
          },
        ],
      },
      {
        type: "list",
        heading: "Connected games",
        emptyState: `No game has connected yet. Turn on "Connect to ${PLATFORM_NAME}" in a game's settings.`,
        items: games.map(([id, g]) => ({
          name: g.name || id,
          desc: `Allowed ${new Date(g.linkedAt).toLocaleDateString()}${g.userId !== st.userId ? " (for another account)" : ""}`,
          action: () => { p.api.unlink(id); this.refresh(); },
        })),
      },
    ];
  }

  getControlValue(key: string): unknown {
    return (this.plugin.settings as unknown as Record<string, unknown>)[key];
  }

  async setControlValue(key: string, value: unknown): Promise<void> {
    const p = this.plugin;
    if (key === "online") {
      await p.setOnline(Boolean(value));
      return;
    }
    if (key === "supabaseUrl" || key === "supabaseAnonKey") {
      p.settings[key] = (typeof value === "string" ? value : "").trim();
      await p.saveSettings(false);
    }
  }

  display(): void {
    this.renderLegacy();
  }

  private refresh(): void {
    const tab = this as SSettingTab & { update?: () => void };
    if (typeof tab.update === "function") tab.update();
    else this.renderLegacy();
  }

  private async applyServer(): Promise<void> {
    const p = this.plugin;
    if (isSecretKey(p.settings.supabaseAnonKey)) {
      new Notice("That looks like a secret key. Use the publishable key.");
      return;
    }
    await p.saveSettings(true);
    new Notice(`${PLATFORM_NAME}: server settings applied`);
  }

  private async onAccount(): Promise<void> {
    const p = this.plugin;
    if (p.backend.status().signedIn) {
      await p.backend.signOut();
      this.refresh();
    } else {
      void p.openHub();
    }
  }

  /** Imperative fallback for Obsidian older than 1.13.0. */
  private renderLegacy(): void {
    const { containerEl } = this;
    const p = this.plugin;
    containerEl.empty();

    new Setting(containerEl)
      .setName("Online / sync")
      .setDesc(`When off, ${PLATFORM_NAME} makes no network requests at all and accepts nothing from games. Games keep working locally; their results wait until you switch this back on.`)
      .addToggle((t) => t.setValue(p.settings.online).onChange(async (v) => {
        await p.setOnline(v);
      }));

    new Setting(containerEl).setName("Advanced: custom server").setHeading();
    containerEl.createEl("p", { cls: "setting-item-description", text: `Leave both fields empty to use the official ${PLATFORM_NAME} server. Only for people running their own copy of the backend.` });
    new Setting(containerEl)
      .setName("Supabase project URL")
      .setDesc("Project Settings → API → Project URL.")
      .addText((t) => t.setPlaceholder(DEFAULT_SUPABASE_URL).setValue(p.settings.supabaseUrl)
        .onChange(async (v) => { p.settings.supabaseUrl = v.trim(); await p.saveSettings(false); }));
    new Setting(containerEl)
      .setName("Supabase publishable (anon) key")
      .setDesc("Project Settings → API keys → publishable key. Never paste a secret or service_role key here.")
      .addText((t) => {
        t.inputEl.type = "password";
        t.setPlaceholder("sb_publishable_…").setValue(p.settings.supabaseAnonKey).onChange(async (v) => { p.settings.supabaseAnonKey = v.trim(); await p.saveSettings(false); });
      });
    new Setting(containerEl)
      .setName("Apply server settings")
      .setDesc("Reconnects with the server above (or the official one when the fields are empty).")
      .addButton((b) => b.setButtonText("Apply").onClick(() => { void this.applyServer(); }));

    new Setting(containerEl).setName("Account").setHeading();
    const st = p.backend.status();
    new Setting(containerEl)
      .setName(st.signedIn ? `Signed in as @${st.username ?? "…"}` : "Not signed in")
      .setDesc(st.signedIn ? "" : `Open the ${PLATFORM_NAME} hub to sign in or create an account.`)
      .addButton((b) => st.signedIn
        ? b.setButtonText("Sign out").onClick(async () => { await p.backend.signOut(); this.refresh(); })
        : b.setButtonText(`Open ${PLATFORM_NAME}`).setCta().onClick(() => p.openHub()));

    new Setting(containerEl).setName("Connected games").setHeading();
    const games = Object.entries(p.settings.linkedGames);
    if (!games.length) containerEl.createEl("p", { cls: "setting-item-description", text: "No game has connected yet. Turn on \"Connect to " + PLATFORM_NAME + "\" in a game's settings." });
    for (const [id, g] of games) {
      new Setting(containerEl)
        .setName(g.name || id)
        .setDesc(`Allowed ${new Date(g.linkedAt).toLocaleDateString()}${g.userId !== st.userId ? " (for another account)" : ""}`)
        .addButton((b) => b.setButtonText("Disconnect").onClick(() => { p.api.unlink(id); this.refresh(); }));
    }
  }
}
