// OBSIGAMA hub: catalog, library, friends, profiles. Plain DOM in one ItemView, no framework.
import { ItemView, Notice, setIcon, type WorkspaceLeaf } from "obsidian";
import { fmtDate, fromNow } from "./time";
import logoEmblem from "../assets/logo-emblem.webp";
import iconMiniOldGames from "../assets/games/mini-old-games.webp";
import iconHellvault from "../assets/games/hellvault.webp";
import { HUB_VIEW_TYPE, PLATFORM_NAME, RIBBON_ICON } from "../brand";
import type { CatalogGame, FriendRow, GameReviews, NoticeRow, Profile } from "../backend";
import { noticeText } from "../notice-text";
import {
  enablePlugin, executeCommand, installUrl, listPluginCommandIds, openUrl,
  pluginState, resolveLaunchCommand, type CommandDir,
} from "../plugin-host";
import type SPlugin from "../main";

type Tab = "catalog" | "library" | "friends" | "profile" | "auth" | "game";

const CACHE_MS = 60_000;
const NOTICE_POLL_MS = 180_000;
const LOCAL_ICONS: Record<string, string> = {
  "mini-old-games": iconMiniOldGames,
  hellvault: iconHellvault,
};

export class HubView extends ItemView {
  private tab: Tab = "catalog";
  private profileName: string | null = null; // null = me
  private gameId: string | null = null;
  private gameSub: "about" | "reviews" = "about";
  private cache = new Map<string, { at: number; data: unknown }>();
  private renderSeq = 0;
  private unsub: (() => void) | null = null;
  private lastAuthKey = "";
  private notices: NoticeRow[] = [];
  private unread = 0;
  private bellOpen = false;
  private authMode: "signin" | "signup" = "signin";
  private authEmail = "";
  private authPassword = "";
  private authUsername = "";
  private authMsg = "";
  private authOk = false;

  constructor(leaf: WorkspaceLeaf, private plugin: SPlugin) {
    super(leaf);
  }

  getViewType(): string { return HUB_VIEW_TYPE; }
  getDisplayText(): string { return PLATFORM_NAME; }
  getIcon(): string { return RIBBON_ICON; }

  async onOpen(): Promise<void> {
    this.unsub = this.plugin.backend.onChange(() => {
      const s = this.plugin.backend.status();
      const key = `${s.online}|${s.configured}|${s.userId}|${s.username}`;
      if (key === this.lastAuthKey) return;
      if (s.userId !== this.lastAuthKey.split("|")[2]) this.cache.clear();
      this.lastAuthKey = key;
      if (s.signedIn && this.tab === "auth") this.tab = "catalog";
      void this.render();
    });
    this.registerDomEvent(activeDocument, "click", (ev) => {
      const t = ev.target as Node | null;
      const wrap = this.contentEl.querySelector(".s-bell-wrap");
      if (this.bellOpen && wrap && t && !wrap.contains(t)) {
        this.bellOpen = false;
        this.drawBellMenu();
      }
    });
    this.registerInterval(window.setInterval(() => void this.refreshNotifications(), NOTICE_POLL_MS));
    await this.render();
  }

  async onClose(): Promise<void> {
    this.unsub?.();
  }

  show(tab: Tab, profileName: string | null = null, gameId: string | null = null): void {
    this.tab = tab;
    this.profileName = profileName;
    this.gameId = tab === "game" ? gameId : null;
    if (tab !== "game") this.gameSub = "about";
    void this.render();
  }

  private invalidate(prefix?: string): void {
    if (!prefix) return this.cache.clear();
    for (const k of [...this.cache.keys()]) if (k.startsWith(prefix)) this.cache.delete(k);
  }

  private async cached<T>(key: string, load: () => Promise<T>): Promise<T> {
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.data as T;
    const data = await load();
    this.cache.set(key, { at: Date.now(), data });
    return data;
  }

  async render(): Promise<void> {
    const seq = ++this.renderSeq;
    const root = this.contentEl;
    root.empty();
    root.addClass("s-hub");
    const st = this.plugin.backend.status();
    this.renderHeader(root, st.signedIn, st.username);
    const body = root.createDiv({ cls: "s-body" });

    if (!st.online) {
      const box = body.createDiv({ cls: "s-empty" });
      box.createEl("p", { text: `${PLATFORM_NAME} is offline. The "Online / sync" switch is off, so nothing is sent or loaded. Games keep working and their results wait.` });
      box.createEl("button", { text: "Go online", cls: "mod-cta" }).onclick = () => void this.plugin.setOnline(true);
      return;
    }
    if (!st.configured) {
      const box = body.createDiv({ cls: "s-empty" });
      box.createEl("p", { text: `${PLATFORM_NAME} cannot reach a server: the custom server in the settings is incomplete or uses a secret key. Clear both fields to use the official server.` });
      box.createEl("button", { text: "Open settings", cls: "mod-cta" }).onclick = () => this.plugin.openSettings();
      return;
    }
    const needsAccount = this.tab === "library" || this.tab === "friends" || (this.tab === "profile" && !this.profileName);
    if (this.tab === "auth" || (needsAccount && !st.signedIn)) return this.renderAuth(body);

    if (st.signedIn) void this.refreshNotifications();

    const loading = body.createDiv({ cls: "s-muted", text: "Loading…" });
    try {
      if (this.tab === "catalog") await this.renderCatalog(body, seq);
      else if (this.tab === "library") await this.renderLibrary(body, seq);
      else if (this.tab === "friends") await this.renderFriends(body, seq);
      else if (this.tab === "game") await this.renderGame(body, seq);
      else await this.renderProfile(body, seq);
    } catch (e) {
      if (seq !== this.renderSeq) return;
      body.createDiv({ cls: "s-error", text: `Could not load: ${(e as Error)?.message ?? e}` });
      body.createEl("button", { text: "Retry" }).onclick = () => { this.invalidate(); void this.render(); };
    } finally {
      loading.remove();
    }
  }

  private renderHeader(root: HTMLElement, signedIn: boolean, username: string | null): void {
    const h = root.createDiv({ cls: "s-header" });
    h.createEl("img", { cls: "s-logo-img", attr: { src: logoEmblem, alt: PLATFORM_NAME } });
    h.createSpan({ cls: "s-logo", text: PLATFORM_NAME });
    const nav = h.createDiv({ cls: "s-nav" });
    const tabs: [Tab, string][] = [["catalog", "Catalog"], ["library", "Library"], ["friends", "Friends"]];
    for (const [t, label] of tabs) {
      const active = this.tab === t || (t === "catalog" && this.tab === "game");
      const b = nav.createEl("button", { text: label, cls: active ? "is-active" : "" });
      b.onclick = () => this.show(t);
    }
    const actions = h.createDiv({ cls: "s-header-actions" });
    const refresh = actions.createEl("button", { cls: "s-icon-btn", attr: { "aria-label": "Refresh", title: "Refresh" } });
    setIcon(refresh, "refresh-cw");
    refresh.onclick = (ev) => {
      ev.stopPropagation();
      this.invalidate();
      void this.render();
    };
    if (signedIn) {
      this.renderBell(actions);
      const b = actions.createEl("button", { text: username ? "@" + username : "Profile", cls: this.tab === "profile" && !this.profileName ? "is-active" : "" });
      b.onclick = () => this.show("profile");
    } else {
      actions.createEl("button", { text: "Sign in", cls: "mod-cta" }).onclick = () => this.show("auth");
    }
  }

  // ---------- notifications ----------
  private renderBell(parent: HTMLElement): void {
    const wrap = parent.createDiv({ cls: "s-bell-wrap" });
    const btn = wrap.createEl("button", { cls: "s-icon-btn", attr: { "aria-label": "Notifications", title: "Notifications" } });
    setIcon(btn, "bell");
    if (this.unread > 0) {
      wrap.createSpan({ cls: "s-bell-count", text: this.unread > 9 ? "9+" : String(this.unread) });
    }
    btn.onclick = (ev) => {
      ev.stopPropagation();
      this.bellOpen = !this.bellOpen;
      this.drawBellMenu();
    };
    if (this.bellOpen) this.drawBellMenu(wrap);
  }

  private drawBellMenu(wrap?: Element | null): void {
    const root = wrap ?? this.contentEl.querySelector(".s-bell-wrap");
    if (!root) return;
    root.querySelector(".s-bell-menu")?.remove();
    if (!this.bellOpen) return;
    const menu = (root as HTMLElement).createDiv({ cls: "s-card s-bell-menu" });
    const head = menu.createDiv({ cls: "s-row" });
    head.createSpan({ cls: "s-title", text: "Notifications" });
    if (this.unread > 0) {
      head.createEl("button", { text: "Mark all read" }).onclick = async (ev) => {
        ev.stopPropagation();
        try {
          await this.plugin.backend.markNotificationsRead();
          await this.refreshNotifications();
        } catch (e) { new Notice((e as Error).message); }
      };
    }
    if (!this.notices.length) {
      menu.createDiv({ cls: "s-muted", text: "No notifications yet." });
      return;
    }
    for (const n of this.notices) {
      const item = menu.createDiv({ cls: "s-bell-item" + (n.read_at ? "" : " is-unread") });
      item.createDiv({ text: noticeText(n) });
      item.createDiv({ cls: "s-muted", text: fromNow(n.created_at) });
      item.onclick = async () => {
        try {
          if (!n.read_at) await this.plugin.backend.markNotificationsRead([n.id]);
        } catch { /* still navigate */ }
        this.bellOpen = false;
        if (n.kind === "badge") this.show("profile");
        else if (n.actor_username) this.show("profile", n.actor_username);
        else void this.refreshNotifications();
      };
    }
  }

  private async refreshNotifications(): Promise<void> {
    const st = this.plugin.backend.status();
    if (!st.online || !st.configured || !st.signedIn) {
      this.notices = [];
      this.unread = 0;
      this.redrawBell();
      return;
    }
    try {
      const [list, count] = await Promise.all([
        this.plugin.backend.notifications(),
        this.plugin.backend.unreadNotificationCount(),
      ]);
      this.notices = list;
      this.unread = count;
      this.redrawBell();
    } catch {
      /* keep the last list; polling should stay quiet */
    }
  }

  private redrawBell(): void {
    const wrap = this.contentEl.querySelector(".s-bell-wrap");
    if (!wrap?.parentElement) return;
    const parent = wrap.parentElement;
    const next = wrap.nextSibling;
    wrap.remove();
    this.renderBellAt(parent, next);
  }

  private renderBellAt(parent: HTMLElement, before: ChildNode | null): void {
    const tmp = parent.createDiv();
    this.renderBell(tmp);
    const node = tmp.firstElementChild;
    if (node) {
      if (before) parent.insertBefore(node, before);
      else parent.appendChild(node);
    }
    tmp.remove();
  }

  // ---------- auth ----------
  private renderAuth(body: HTMLElement): void {
    const box = body.createDiv({ cls: "s-card s-auth" });
    box.createEl("h3", { text: `Your ${PLATFORM_NAME} account` });
    const modes = box.createDiv({ cls: "s-nav" });
    const form = box.createDiv();
    const draw = () => {
      modes.empty();
      for (const [m, label] of [["signin", "Sign in"], ["signup", "Create account"]] as const) {
        const b = modes.createEl("button", { text: label, cls: this.authMode === m ? "is-active" : "" });
        b.onclick = () => { this.authMode = m; this.authMsg = ""; this.authOk = false; draw(); };
      }
      form.empty();
      const email = form.createEl("input", { type: "email", placeholder: "Email", cls: "s-input" });
      email.value = this.authEmail;
      email.oninput = () => { this.authEmail = email.value; };
      const user = this.authMode === "signup"
        ? form.createEl("input", { type: "text", placeholder: "Nickname (3–20: letters, digits, _)", cls: "s-input" })
        : null;
      if (user) {
        user.value = this.authUsername;
        user.oninput = () => { this.authUsername = user.value; };
      }
      const pass = form.createEl("input", { type: "password", placeholder: "Password (min 6)", cls: "s-input" });
      pass.value = this.authPassword;
      pass.oninput = () => { this.authPassword = pass.value; };
      const msg = form.createDiv({ cls: this.authOk ? "s-saved" : "s-muted" });
      if (this.authMsg) msg.setText(this.authMsg);
      const row = form.createDiv({ cls: "s-row" });
      const run = async (fn: () => Promise<unknown>) => {
        this.authOk = false;
        msg.removeClass("s-saved");
        msg.addClass("s-muted");
        msg.setText("…");
        try {
          await fn();
        } catch (e) {
          this.authMsg = (e as Error)?.message ?? String(e);
          this.authOk = false;
          msg.setText(this.authMsg);
        }
      };
      if (this.authMode === "signin") {
        row.createEl("button", { text: "Sign in", cls: "mod-cta" }).onclick = () =>
          run(() => this.plugin.backend.signIn(email.value.trim(), pass.value));
      } else {
        row.createEl("button", { text: "Create account", cls: "mod-cta" }).onclick = () => run(async () => {
          const u = user!.value.trim();
          if (!/^[A-Za-z0-9_]{3,20}$/.test(u)) throw new Error("Nickname: 3–20 letters, digits or _.");
          const addr = email.value.trim();
          const r = await this.plugin.backend.signUp(addr, pass.value, u);
          if (r === "confirm-email") {
            this.authMsg = `Thanks! A confirmation email has been sent to ${addr}. Open it to activate your account.`;
            this.authOk = true;
            msg.removeClass("s-muted");
            msg.addClass("s-saved");
            msg.setText(this.authMsg);
          }
        });
      }
    };
    draw();
  }

  // ---------- catalog ----------
  private async catalogList(): Promise<CatalogGame[]> {
    return this.cached("catalog", () => this.plugin.backend.catalog());
  }

  private async catalogMap(): Promise<Map<string, CatalogGame>> {
    return new Map((await this.catalogList()).map((g) => [g.id, g]));
  }

  private async renderCatalog(body: HTMLElement, seq: number): Promise<void> {
    const games = await this.catalogList();
    const signedIn = this.plugin.backend.status().signedIn;
    const owned = signedIn ? new Set((await this.myProfile())?.games?.map((g) => g.game_id) ?? []) : new Set<string>();
    if (seq !== this.renderSeq) return;
    if (!games.length) { body.createDiv({ cls: "s-empty", text: "No games in the catalog yet." }); return; }
    const grid = body.createDiv({ cls: "s-grid" });
    for (const g of games) this.gameCard(grid, g, owned.has(g.id), signedIn);
  }

  private gameCard(grid: HTMLElement, g: CatalogGame, owned: boolean, signedIn: boolean): void {
    const card = grid.createDiv({ cls: "s-card s-game" });
    const top = card.createDiv({ cls: "s-row" });
    this.gamePic(top, g, "s-game-icon");
    const t = top.createDiv({ cls: "s-grow s-link" });
    t.createDiv({ cls: "s-title", text: g.name });
    const st = pluginState(this.app, g.plugin_id);
    const linked = this.plugin.api.isLinked(g.id);
    t.createDiv({
      cls: "s-muted",
      text: st.installed
        ? `${st.enabled ? "Installed" : "Installed, disabled"} · ${linked ? "connected" : `turn on "Connect to ${PLATFORM_NAME}" in its settings`}`
        : "Not installed in this vault",
    });
    t.onclick = () => this.show("game", null, g.id);
    if (g.description) card.createEl("p", { cls: "s-desc", text: g.description });
    const row = card.createDiv({ cls: "s-row" });
    this.renderInstallPlay(row, g);
    if (g.repo_url) row.createEl("a", { text: "GitHub", href: g.repo_url });
    if (signedIn) {
      if (owned) row.createSpan({ cls: "s-tag", text: "In library" });
      else row.createEl("button", { text: "Add to library" }).onclick = async () => {
        try { await this.plugin.backend.addToLibrary(g.id); this.invalidate("profile:"); void this.render(); }
        catch (e) { new Notice((e as Error).message); }
      };
    }
  }

  // ---------- library ----------
  private async myProfile(): Promise<Profile | null> {
    const me = this.plugin.backend.status().username;
    return me ? this.cached("profile:" + me.toLowerCase(), () => this.plugin.backend.profile(me)) : null;
  }

  private async renderLibrary(body: HTMLElement, seq: number): Promise<void> {
    const p = await this.myProfile();
    const catalog = await this.catalogMap();
    if (seq !== this.renderSeq) return;
    const games = p?.games ?? [];
    if (!games.length) {
      body.createDiv({ cls: "s-empty", text: `Your library is empty. Add games from the catalog, or turn on "Connect to ${PLATFORM_NAME}" in a game: it appears here after your first run.` });
      return;
    }
    for (const g of games) {
      const meta = catalog.get(g.game_id);
      const row = body.createDiv({ cls: "s-card s-row s-lib" });
      this.gamePic(row, meta ?? g, "s-game-icon");
      const info = row.createDiv({ cls: "s-grow s-link" });
      info.createDiv({ cls: "s-title", text: g.name });
      info.createDiv({ cls: "s-muted", text: `${g.runs} runs · ${fmtDuration(g.playtime_ms)}${g.last_played_at ? " · last played " + fromNow(g.last_played_at) : ""}` });
      progress(info, g.achievements, g.achievements_total);
      info.onclick = () => this.show("game", null, g.game_id);
      const actions = row.createDiv({ cls: "s-row" });
      if (meta) this.renderInstallPlay(actions, meta);
    }
  }

  // ---------- game page ----------
  private async renderGame(body: HTMLElement, seq: number): Promise<void> {
    const id = this.gameId;
    if (!id) { body.createDiv({ cls: "s-empty", text: "No game selected." }); return; }
    const catalog = await this.catalogMap();
    const g = catalog.get(id);
    if (seq !== this.renderSeq) return;
    if (!g) { body.createDiv({ cls: "s-empty", text: "This game is not in the catalog." }); return; }

    const back = body.createEl("button", { text: "← Catalog" });
    back.onclick = () => this.show("catalog");

    const signedIn = this.plugin.backend.status().signedIn;
    const owned = signedIn ? new Set((await this.myProfile())?.games?.map((x) => x.game_id) ?? []) : new Set<string>();
    if (seq !== this.renderSeq) return;

    const head = body.createDiv({ cls: "s-card s-row s-profile-head" });
    this.gamePic(head, g, "s-game-icon");
    const info = head.createDiv({ cls: "s-grow" });
    info.createDiv({ cls: "s-title", text: g.name });
    const st = pluginState(this.app, g.plugin_id);
    info.createDiv({
      cls: "s-muted",
      text: st.installed ? (st.enabled ? "Installed in this vault" : "Installed, currently disabled") : "Not installed in this vault",
    });
    const row = info.createDiv({ cls: "s-row" });
    this.renderInstallPlay(row, g);
    if (g.repo_url) row.createEl("a", { text: "GitHub", href: g.repo_url });
    if (signedIn) {
      if (owned.has(g.id)) row.createSpan({ cls: "s-tag", text: "In library" });
      else row.createEl("button", { text: "Add to library" }).onclick = async () => {
        try { await this.plugin.backend.addToLibrary(g.id); this.invalidate("profile:"); void this.render(); }
        catch (e) { new Notice((e as Error).message); }
      };
    }

    const tabs = body.createDiv({ cls: "s-nav s-subnav" });
    for (const [idTab, label] of [["about", "About"], ["reviews", "Reviews"]] as const) {
      const b = tabs.createEl("button", { text: label, cls: this.gameSub === idTab ? "is-active" : "" });
      b.onclick = () => { this.gameSub = idTab; void this.render(); };
    }

    if (this.gameSub === "about") {
      if (g.description) body.createEl("p", { cls: "s-bio", text: g.description });
      else body.createDiv({ cls: "s-muted", text: "No description yet." });
      return;
    }

    const reviews = await this.plugin.backend.gameReviews(g.id);
    if (seq !== this.renderSeq) return;
    this.renderReviews(body, g, reviews, owned.has(g.id), signedIn);
  }

  private renderReviews(body: HTMLElement, g: CatalogGame, data: GameReviews, inLibrary: boolean, signedIn: boolean): void {
    body.createDiv({
      cls: "s-muted",
      text: data.total ? `${data.total} review${data.total === 1 ? "" : "s"} · ${data.up} up · ${data.down} down` : "No reviews yet.",
    });

    if (signedIn && inLibrary) {
      const box = body.createDiv({ cls: "s-card" });
      box.createDiv({ cls: "s-label", text: data.mine ? "Your review" : "Write a review" });
      let recommend = data.mine?.recommend ?? true;
      const thumbs = box.createDiv({ cls: "s-row s-thumbs" });
      const up = thumbs.createEl("button", { text: "👍", cls: recommend ? "is-on" : "" });
      const down = thumbs.createEl("button", { text: "👎", cls: !recommend ? "is-on" : "" });
      const paint = () => {
        up.toggleClass("is-on", recommend);
        down.toggleClass("is-on", !recommend);
      };
      up.onclick = () => { recommend = true; paint(); };
      down.onclick = () => { recommend = false; paint(); };
      const text = box.createEl("textarea", { cls: "s-input", attr: { maxlength: "1000", rows: "4", placeholder: "What did you think? (optional, up to 1000 characters)" } });
      text.value = data.mine?.body ?? "";
      const counter = box.createDiv({ cls: "s-muted", text: `${text.value.length}/1000` });
      text.oninput = () => counter.setText(`${text.value.length}/1000`);
      const msg = box.createDiv({ cls: "s-muted" });
      const actions = box.createDiv({ cls: "s-row" });
      actions.createEl("button", { text: data.mine ? "Update review" : "Post review", cls: "mod-cta" }).onclick = async () => {
        msg.setText("…");
        try {
          await this.plugin.backend.upsertReview(g.id, recommend, text.value);
          void this.render();
        } catch (e) { msg.setText((e as Error).message); }
      };
      if (data.mine) {
        actions.createEl("button", { text: "Delete" }).onclick = async () => {
          try {
            await this.plugin.backend.deleteReview(g.id);
            void this.render();
          } catch (e) { msg.setText((e as Error).message); }
        };
      }
    } else if (signedIn) {
      body.createDiv({ cls: "s-muted", text: "Add this game to your library to write a review." });
    } else {
      body.createDiv({ cls: "s-muted", text: "Sign in to write a review." });
    }

    for (const r of data.reviews) {
      const card = body.createDiv({ cls: "s-card s-review" });
      const row = this.userRow(card, r.username, r.avatar_url, r.display_name);
      row.createSpan({ cls: "s-tag", text: r.recommend ? "👍" : "👎" });
      row.createSpan({ cls: "s-muted", text: fromNow(r.updated_at) });
      if (r.body) card.createEl("p", { cls: "s-bio", text: r.body });
    }
  }

  // ---------- play / install ----------
  private renderInstallPlay(row: HTMLElement, g: CatalogGame): void {
    const st = pluginState(this.app, g.plugin_id);
    if (st.enabled) {
      row.createEl("button", { text: "Play", cls: "mod-cta" }).onclick = () => this.playGame(g);
    } else if (st.installed) {
      row.createEl("button", { text: "Enable", cls: "mod-cta" }).onclick = async () => {
        try {
          await enablePlugin(this.app, g.plugin_id);
          new Notice(`${g.name} enabled`);
          void this.render();
        } catch (e) { new Notice((e as Error).message); }
      };
    } else {
      row.createEl("button", { text: "Install", cls: "mod-cta" }).onclick = () => {
        openUrl(installUrl(g.plugin_id, !!g.in_store, g.repo_url));
      };
    }
  }

  private playGame(g: CatalogGame): void {
    const commands = (this.app as unknown as { commands?: CommandDir }).commands;
    const id = resolveLaunchCommand(g.plugin_id, g.launch_command, listPluginCommandIds(commands));
    if (id && executeCommand(commands, id)) return;
    const setting = (this.app as unknown as { setting?: { open(): void; openTabById(id: string): void } }).setting;
    if (setting?.open && setting.openTabById) {
      setting.open();
      setting.openTabById(g.plugin_id);
      new Notice(`Could not start ${g.name} automatically. Its settings are open.`);
      return;
    }
    new Notice(`Could not start ${g.name}. Open it from the ribbon or the command palette.`);
  }

  // ---------- friends ----------
  private async renderFriends(body: HTMLElement, seq: number): Promise<void> {
    const searchBox = body.createDiv({ cls: "s-card" });
    const input = searchBox.createEl("input", { type: "search", placeholder: "Find players by nickname", cls: "s-input" });
    const results = searchBox.createDiv();
    let timer: number | null = null;
    input.oninput = () => {
      if (timer) window.clearTimeout(timer);
      timer = window.setTimeout(() => void (async () => {
        results.empty();
        const q = input.value.trim();
        if (q.length < 2) return;
        try {
          const users = await this.plugin.backend.searchUsers(q);
          if (!users.length) results.createDiv({ cls: "s-muted", text: "Nobody found." });
          for (const u of users) {
            const r = this.userRow(results, u.username, u.avatar_url, u.display_name);
            if (u.id !== this.plugin.backend.status().userId) {
              r.createEl("button", { text: "Add friend" }).onclick = async () => {
                const res = await this.plugin.backend.sendFriendRequest(u.username).catch((e) => (e as Error).message);
                new Notice(friendMsg(res));
                this.invalidate("friends");
                void this.refreshNotifications();
              };
            }
          }
        } catch (e) { results.createDiv({ cls: "s-error", text: (e as Error).message }); }
      })(), 300);
    };

    const list = await this.cached("friends", () => this.plugin.backend.friends());
    if (seq !== this.renderSeq) return;
    const section = (title: string, rows: FriendRow[], actions: (el: HTMLElement, f: FriendRow) => void) => {
      if (!rows.length) return;
      body.createEl("h4", { text: `${title} (${rows.length})` });
      for (const f of rows) actions(this.userRow(body, f.username, f.avatar_url, f.display_name, f.last_seen_at), f);
    };
    const act = (fn: () => Promise<unknown>) => async () => {
      try { await fn(); } catch (e) { new Notice((e as Error).message); }
      this.invalidate("friends"); this.invalidate("profile:");
      void this.refreshNotifications();
      void this.render();
    };
    section("Requests", list.filter((f) => f.direction === "incoming"), (el, f) => {
      el.createEl("button", { text: "Accept", cls: "mod-cta" }).onclick = act(() => this.plugin.backend.respondFriend(f.user_id, true));
      el.createEl("button", { text: "Decline" }).onclick = act(() => this.plugin.backend.respondFriend(f.user_id, false));
    });
    section("Friends", list.filter((f) => f.direction === "mutual"), (el, f) => {
      el.createEl("button", { text: "Remove" }).onclick = act(() => this.plugin.backend.removeFriend(f.user_id));
    });
    section("Sent", list.filter((f) => f.direction === "outgoing"), (el, f) => {
      el.createEl("button", { text: "Cancel" }).onclick = act(() => this.plugin.backend.removeFriend(f.user_id));
    });
    if (!list.length) body.createDiv({ cls: "s-empty", text: "No friends yet. Search for a nickname above." });
  }

  private userRow(parent: HTMLElement, username: string, avatar: string | null, displayName: string | null, lastSeen?: string | null): HTMLElement {
    const row = parent.createDiv({ cls: "s-row s-user" });
    this.pic(row, avatar, username, "s-avatar-sm");
    const name = row.createDiv({ cls: "s-grow s-link" });
    name.createSpan({ text: "@" + username });
    if (displayName) name.createSpan({ cls: "s-muted", text: " " + displayName });
    if (lastSeen) name.createDiv({ cls: "s-muted", text: "seen " + fromNow(lastSeen) });
    name.onclick = () => this.show("profile", username);
    return row;
  }

  // ---------- profile ----------
  private async renderProfile(body: HTMLElement, seq: number): Promise<void> {
    const name = this.profileName ?? this.plugin.backend.status().username;
    if (!name) { body.createDiv({ cls: "s-muted", text: "Loading your profile…" }); return; }
    const p = await this.cached("profile:" + name.toLowerCase(), () => this.plugin.backend.profile(name));
    if (seq !== this.renderSeq) return;
    if (!p) { body.createDiv({ cls: "s-empty", text: `No player @${name}.` }); return; }

    const head = body.createDiv({ cls: "s-card s-row s-profile-head" });
    this.pic(head, p.avatar_url, p.username, "s-avatar");
    const info = head.createDiv({ cls: "s-grow" });
    info.createDiv({ cls: "s-title", text: p.display_name ? `${p.display_name}` : "@" + p.username });
    if (p.display_name) info.createDiv({ cls: "s-muted", text: "@" + p.username });
    info.createDiv({ cls: "s-muted", text: `On ${PLATFORM_NAME} since ${fmtDate(p.created_at)}` });
    this.relationButtons(info, p);

    if (p.restricted) {
      body.createDiv({ cls: "s-empty", text: "This profile is visible to friends only." });
      return;
    }
    // bio is plain text: textContent, never innerHTML
    if (p.bio) body.createEl("p", { cls: "s-bio", text: p.bio });

    if (p.counts) {
      const c = body.createDiv({ cls: "s-counts" });
      for (const [k, v] of [["Games", p.counts.games], ["Runs", p.counts.runs], ["Achievements", p.counts.achievements], ["Friends", p.counts.friends]] as const) {
        const d = c.createDiv(); d.createDiv({ cls: "s-num", text: String(v) }); d.createDiv({ cls: "s-muted", text: k });
      }
    }

    if (p.badges?.length) {
      body.createEl("h4", { text: "Badges" });
      const row = body.createDiv({ cls: "s-badges" });
      for (const b of p.badges) {
        const el = row.createDiv({ cls: "s-badge", attr: { title: `${b.description ?? ""}\n${fmtDate(b.awarded_at)}` } });
        if (b.icon_url) el.createEl("img", { attr: { src: b.icon_url, alt: "", loading: "lazy", width: "20", height: "20" } });
        else setIcon(el.createSpan(), "award");
        el.createSpan({ text: b.name });
      }
    }

    if (p.games?.length) {
      body.createEl("h4", { text: "Games" });
      for (const g of p.games) {
        const card = body.createDiv({ cls: "s-card" });
        const r = card.createDiv({ cls: "s-row" });
        this.gamePic(r, g, "s-game-icon-sm");
        const t = r.createDiv({ cls: "s-grow s-link" });
        t.createDiv({ cls: "s-title", text: g.name });
        t.createDiv({ cls: "s-muted", text: `${g.runs} runs · ${fmtDuration(g.playtime_ms)}` });
        t.onclick = () => this.show("game", null, g.game_id);
        progress(card, g.achievements, g.achievements_total);
        const stats = Object.entries({ ...(g.best ?? {}), ...(g.stats ?? {}) }).slice(0, 8);
        if (stats.length) {
          const dl = card.createDiv({ cls: "s-stats" });
          for (const [k, v] of stats) { dl.createSpan({ cls: "s-muted", text: k }); dl.createSpan({ text: String(v) }); }
        }
      }
    }

    if (p.recent_achievements?.length) {
      body.createEl("h4", { text: "Recent achievements" });
      for (const a of p.recent_achievements) body.createDiv({ cls: "s-line", text: `${a.icon ?? "🏆"} ${a.name} · ${fromNow(a.unlocked_at)}` });
    }

    if (p.friends?.length) {
      body.createEl("h4", { text: "Friends" });
      const row = body.createDiv({ cls: "s-friends" });
      for (const f of p.friends) {
        const el = row.createDiv({ cls: "s-friend s-link", attr: { title: "@" + f.username } });
        this.pic(el, f.avatar_url, f.username, "s-avatar-sm");
        el.createSpan({ text: f.username });
        el.onclick = () => this.show("profile", f.username);
      }
    }

    if (p.activity?.length) {
      body.createEl("h4", { text: "Recent activity" });
      for (const a of p.activity) body.createDiv({ cls: "s-line", text: `${activityText(a)} · ${fromNow(a.created_at)}` });
    }

    if (p.relation === "self") this.renderEdit(body, p, head);
  }

  private relationButtons(el: HTMLElement, p: Profile): void {
    if (p.relation === "self" || !this.plugin.backend.status().signedIn) return;
    const row = el.createDiv({ cls: "s-row" });
    const act = (fn: () => Promise<unknown>) => async () => {
      try { const r = await fn(); if (typeof r === "string") new Notice(friendMsg(r)); } catch (e) { new Notice((e as Error).message); }
      this.invalidate("profile:" + p.username.toLowerCase()); this.invalidate("friends");
      void this.refreshNotifications();
      void this.render();
    };
    if (p.relation === "none") row.createEl("button", { text: "Add friend", cls: "mod-cta" }).onclick = act(() => this.plugin.backend.sendFriendRequest(p.username));
    if (p.relation === "request_sent") row.createEl("button", { text: "Cancel request" }).onclick = act(() => this.plugin.backend.removeFriend(p.id));
    if (p.relation === "request_received") {
      row.createEl("button", { text: "Accept", cls: "mod-cta" }).onclick = act(() => this.plugin.backend.respondFriend(p.id, true));
      row.createEl("button", { text: "Decline" }).onclick = act(() => this.plugin.backend.respondFriend(p.id, false));
    }
    if (p.relation === "friend") {
      row.createSpan({ cls: "s-tag", text: "Friend" });
      row.createEl("button", { text: "Remove friend" }).onclick = act(() => this.plugin.backend.removeFriend(p.id));
    }
  }

  private renderEdit(body: HTMLElement, p: Profile, head: HTMLElement): void {
    body.createEl("h4", { text: "Edit profile" });
    const box = body.createDiv({ cls: "s-card s-edit" });
    const avatarRow = box.createDiv({ cls: "s-row" });
    const file = avatarRow.createEl("input", { type: "file", attr: { accept: "image/*" } });
    const avatarMsg = avatarRow.createSpan({ cls: "s-muted", text: "Any image; converted to a 256 px WebP under 50 KB." });
    file.onchange = async () => {
      const f = file.files?.[0];
      if (!f) return;
      avatarMsg.removeClass("s-saved");
      avatarMsg.addClass("s-muted");
      avatarMsg.setText("Converting and uploading…");
      try {
        const url = await this.plugin.backend.uploadAvatar(f);
        this.invalidate("profile:");
        avatarMsg.setText("");
        const ok = avatarRow.createSpan({ cls: "s-saved", text: "Avatar updated" });
        window.setTimeout(() => ok.remove(), 2500);
        const img = head.querySelector("img.s-avatar");
        if (img) (img as HTMLImageElement).src = url;
        else {
          head.querySelector(".s-avatar")?.remove();
          const pic = head.createEl("img", { cls: "s-avatar", attr: { src: url, alt: "" } });
          head.insertBefore(pic, head.firstChild);
        }
      } catch (e) {
        avatarMsg.setText((e as Error).message);
      }
    };
    const label = (t: string) => box.createDiv({ cls: "s-label", text: t });
    label("Nickname");
    const user = box.createEl("input", { type: "text", cls: "s-input", value: p.username, attr: { maxlength: "20" } });
    label("Display name");
    const dn = box.createEl("input", { type: "text", cls: "s-input", value: p.display_name ?? "", attr: { maxlength: "40" } });
    label("About (up to 300 characters, plain text)");
    const bio = box.createEl("textarea", { cls: "s-input", attr: { maxlength: "300", rows: "3" } });
    bio.value = p.bio ?? "";
    const counter = box.createDiv({ cls: "s-muted", text: `${bio.value.length}/300` });
    bio.oninput = () => counter.setText(`${bio.value.length}/300`);
    label("Who can see my games, stats, friends and activity");
    const privacy = box.createEl("select", { cls: "dropdown" });
    for (const [v, t] of [["public", "Everyone"], ["friends", "Friends only"]]) privacy.createEl("option", { value: v, text: t });
    privacy.value = p.privacy;
    const msg = box.createDiv({ cls: "s-muted" });
    const saveRow = box.createDiv({ cls: "s-row" });
    const saveBtn = saveRow.createEl("button", { text: "Save", cls: "mod-cta" });
    saveBtn.onclick = async () => {
      const u = user.value.trim();
      if (!/^[A-Za-z0-9_]{3,20}$/.test(u)) { msg.setText("Nickname: 3–20 letters, digits or _."); return; }
      try {
        await this.plugin.backend.updateProfile({
          username: u === p.username ? undefined : u,
          display_name: dn.value.trim() || null,
          bio: bio.value.trim().slice(0, 300) || null,
          privacy: privacy.value === "friends" ? "friends" : "public",
        });
        this.invalidate("profile:");
        saveRow.querySelector(".s-saved")?.remove();
        const saved = saveRow.createSpan({ cls: "s-saved", text: "Saved" });
        window.setTimeout(() => saved.remove(), 2500);
        if (u !== p.username) void this.render();
      } catch (e) { msg.setText((e as Error).message); }
    };
  }

  private gamePic(parent: HTMLElement, g: { id?: string; game_id?: string; name: string; icon_url: string | null }, cls: string): void {
    const id = g.id ?? g.game_id ?? "";
    const local = LOCAL_ICONS[id];
    this.pic(parent, g.icon_url || local || null, g.name, cls, local && g.icon_url ? local : undefined);
  }

  private pic(parent: HTMLElement, url: string | null, name: string, cls: string, fallback?: string): void {
    if (url) {
      const img = parent.createEl("img", { cls, attr: { src: url, alt: "", loading: "lazy" } });
      if (fallback && fallback !== url) {
        img.addEventListener("error", () => { img.src = fallback; }, { once: true });
      }
    } else {
      parent.createDiv({ cls: cls + " s-placeholder", text: (name || "?").slice(0, 1).toUpperCase() });
    }
  }
}

function fmtDuration(ms: number): string {
  const m = Math.round((ms || 0) / 60000);
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
}

function progress(parent: HTMLElement, n: number, total: number): void {
  if (!total) return;
  const wrap = parent.createDiv({ cls: "s-progress", attr: { title: `${n} of ${total} achievements` } });
  const bar = wrap.createDiv({ cls: "s-progress-bar" });
  bar.style.setProperty("--s-progress", `${Math.min(100, Math.round((n / total) * 100))}%`);
  parent.createDiv({ cls: "s-muted", text: `Achievements ${n}/${total}` });
}

function friendMsg(r: string): string {
  return ({
    sent: "Friend request sent", accepted: "You are now friends", already_sent: "Request already sent",
    already_friends: "Already friends", not_found: "Player not found", self: "That's you", rate_limited: "Too many requests today",
  } as Record<string, string>)[r] ?? r;
}

function activityText(a: NonNullable<Profile["activity"]>[number]): string {
  const name = typeof a.payload?.name === "string" ? a.payload.name : a.ref ?? "";
  switch (a.kind) {
    case "joined": return `Joined ${PLATFORM_NAME}`;
    case "first_play": return `Started playing ${a.game_id}`;
    case "achievement": return `🏆 ${name}${a.game_id ? ` (${a.game_id})` : ""}`;
    case "badge": return `🎖 Badge: ${name}`;
    case "new_best": return `New best in ${a.game_id}: ${fmtValue(a.payload?.value)}${name ? ` (${name})` : ""}`;
    case "friend": return `Became friends with @${a.friend ?? "someone"}`;
    default: return a.kind;
  }
}

function fmtValue(v: unknown): string {
  return typeof v === "number" || typeof v === "string" ? String(v) : "";
}
