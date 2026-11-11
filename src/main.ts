import { Notice, Plugin, type WorkspaceLeaf } from "obsidian";
import { PLATFORM_READY_EVENT, PLATFORM_UNLOAD_EVENT } from "@s-platform/sdk";
import { Backend } from "./backend";
import { HUB_VIEW_TYPE, PLATFORM_NAME, RIBBON_ICON } from "./brand";
import { SPlatformAPI } from "./platform-api";
import { normalizeSettings, SSettingTab, type SSettings } from "./settings";
import { HubView } from "./views/hub-view";

export default class SPlugin extends Plugin {
  settings!: SSettings;
  backend!: Backend;
  /** Public API for game plugins (see packages/sdk). */
  api!: SPlatformAPI;

  async onload(): Promise<void> {
    this.settings = normalizeSettings(await this.loadData());
    this.backend = new Backend(this.app, () => this.settings);
    this.api = new SPlatformAPI(this);

    this.registerView(HUB_VIEW_TYPE, (leaf: WorkspaceLeaf) => new HubView(leaf, this));
    this.addRibbonIcon(RIBBON_ICON, PLATFORM_NAME, () => this.openHub());
    this.addCommand({ id: "open-hub", name: `Open ${PLATFORM_NAME}`, callback: () => this.openHub() });
    this.addCommand({ id: "toggle-online", name: `Toggle ${PLATFORM_NAME} online / sync`, callback: () => this.setOnline(!this.settings.online) });
    this.addSettingTab(new SSettingTab(this.app, this));

    this.app.workspace.onLayoutReady(async () => {
      await this.backend.reconfigure();
      // tell game plugins that loaded before us that the API is ready
      this.app.workspace.trigger(PLATFORM_READY_EVENT);
    });
  }

  onunload(): void {
    this.app.workspace.trigger(PLATFORM_UNLOAD_EVENT);
    this.backend?.teardown();
  }

  async saveSettings(reconnect: boolean): Promise<void> {
    await this.saveData(this.settings);
    if (reconnect) await this.backend.reconfigure();
  }

  async setOnline(on: boolean): Promise<void> {
    this.settings.online = on;
    await this.saveSettings(true);
    new Notice(`${PLATFORM_NAME} is ${on ? "online" : "offline: no network requests"}`);
  }

  async openHub(): Promise<void> {
    const ws = this.app.workspace;
    let leaf = ws.getLeavesOfType(HUB_VIEW_TYPE)[0];
    if (!leaf) {
      leaf = ws.getLeaf("tab");
      await leaf.setViewState({ type: HUB_VIEW_TYPE, active: true });
    }
    await ws.revealLeaf(leaf);
  }

  openSettings(): void {
    const setting = (this.app as unknown as { setting?: { open(): void; openTabById(id: string): void } }).setting;
    setting?.open();
    setting?.openTabById(this.manifest.id);
  }
}
