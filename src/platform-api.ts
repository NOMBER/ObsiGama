// The in-process API game plugins use (through @obsigama/sdk). OBSIGAMA holds the session; games never see keys.
import { App, Modal, Setting } from "obsidian";
import {
  PROTOCOL_VERSION, type AwardedBadge, type EventResult, type LinkRequest, type PlatformError, type LinkResponse, type PlatformAPI, type PlatformStatus,
  type SubmitRequest, type SubmitResponse,
} from "@obsigama/sdk";
import { PLATFORM_NAME } from "./brand";
import type SPlugin from "./main";
import { OfflineError } from "./net";

export class SPlatformAPI implements PlatformAPI {
  readonly protocol = PROTOCOL_VERSION;
  readonly platformName = PLATFORM_NAME;
  private subs = new Set<(s: PlatformStatus) => void>();
  private pendingLinks = new Map<string, Promise<LinkResponse>>();

  constructor(private plugin: SPlugin) {
    plugin.backend.onChange(() => this.notify());
  }

  getStatus(): PlatformStatus {
    const s = this.plugin.backend.status();
    return { enabled: s.online, configured: s.configured, signedIn: s.signedIn, userId: s.userId, username: s.username };
  }

  onStatusChange(cb: (s: PlatformStatus) => void): () => void {
    this.subs.add(cb);
    return () => this.subs.delete(cb);
  }

  notify(): void {
    const st = this.getStatus();
    for (const cb of this.subs) { try { cb(st); } catch (e) { console.error("[OBSIGAMA] status listener", e); } }
  }

  isLinked(gameId: string): boolean {
    const l = this.plugin.settings.linkedGames[gameId];
    return !!l && l.userId === this.getStatus().userId;
  }

  requestLink(req: LinkRequest): Promise<LinkResponse> {
    const st = this.getStatus();
    if (!st.enabled) return Promise.resolve({ ok: false, error: "disabled", message: `${PLATFORM_NAME} is offline` });
    if (!st.signedIn || !st.userId) {
      this.plugin.openHub();
      return Promise.resolve({ ok: false, error: "signed-out", message: `Sign in to ${PLATFORM_NAME} first` });
    }
    if (this.isLinked(req.gameId)) return Promise.resolve({ ok: true, userId: st.userId });
    const existing = this.pendingLinks.get(req.gameId);
    if (existing) return existing;
    const userId = st.userId;
    const p = new Promise<LinkResponse>((resolve) => {
      new ConsentModal(this.plugin.app, req.name || req.gameId, st.username, async (allowed) => {
        this.pendingLinks.delete(req.gameId);
        if (!allowed) return resolve({ ok: false, error: "denied" });
        this.plugin.settings.linkedGames[req.gameId] = { userId, name: req.name, linkedAt: Date.now() };
        await this.plugin.saveSettings(false);
        this.notify();
        resolve({ ok: true, userId });
      }).open();
    });
    this.pendingLinks.set(req.gameId, p);
    return p;
  }

  unlink(gameId: string): void {
    delete this.plugin.settings.linkedGames[gameId];
    void this.plugin.saveSettings(false);
    this.notify();
  }

  async submit(req: SubmitRequest): Promise<SubmitResponse> {
    const st = this.getStatus();
    if (!st.enabled) return { ok: false, error: "disabled" };
    if (!st.configured) return { ok: false, error: "server", message: `${PLATFORM_NAME} has no server configured` };
    if (!st.signedIn) return { ok: false, error: "signed-out" };
    if (!this.isLinked(req.gameId)) return { ok: false, error: "not-linked" };
    if (!Array.isArray(req.events) || req.events.length > 200) return { ok: false, error: "server", message: "bad batch" };
    try {
      const data = await this.plugin.backend.ingest(req.gameId, req.manifestVersion, req.events);
      if (typeof data.error === "string") {
        const e = data.error;
        const known: PlatformError[] = ["disabled", "signed-out", "not-linked", "unknown-game", "rate-limited", "network", "server"];
        return {
          ok: false,
          error: known.includes(e as PlatformError) ? (e as PlatformError) : "server",
          message: typeof data.message === "string" ? data.message : e === "unknown-game" ? `This game is not registered on ${PLATFORM_NAME} yet` : undefined,
          retryAfterMs: typeof data.retryAfterMs === "number" ? data.retryAfterMs : undefined,
        };
      }
      return {
        ok: true,
        results: (data.results ?? []) as EventResult[],
        unlocked: (data.unlocked ?? []) as string[],
        badges: (data.badges ?? []) as AwardedBadge[],
        stats: (data.stats ?? {}) as Record<string, number | string>,
      };
    } catch (e) {
      if (e instanceof OfflineError) return { ok: false, error: "disabled" };
      const msg = (e as Error)?.message ?? String(e);
      const status = (e as { status?: number })?.status;
      return { ok: false, error: status && status >= 500 ? "server" : "network", message: msg };
    }
  }

  openHub(): void {
    this.plugin.openHub();
  }
}

class ConsentModal extends Modal {
  private decided = false;
  constructor(app: App, private gameName: string, private username: string | null, private done: (allowed: boolean) => void) {
    super(app);
  }
  onOpen(): void {
    const { contentEl } = this;
    this.setTitle(`Connect ${this.gameName} to ${PLATFORM_NAME}?`);
    contentEl.createEl("p", {
      text: `${this.gameName} will send your stats, best scores and achievements to your ${PLATFORM_NAME} account${this.username ? ` @${this.username}` : ""} after each run, including progress you made before. It never gets your password or login token. You can disconnect it any time in ${PLATFORM_NAME} settings.`,
    });
    new Setting(contentEl)
      .addButton((b) => b.setButtonText("Not now").onClick(() => this.finish(false)))
      .addButton((b) => b.setButtonText("Allow").setCta().onClick(() => this.finish(true)));
  }
  private finish(v: boolean): void {
    this.decided = true;
    this.done(v);
    this.close();
  }
  onClose(): void {
    this.contentEl.empty();
    if (!this.decided) this.done(false);
  }
}
