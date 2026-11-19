// OBSIGAMA hub: catalog, library, friends, profiles. Plain DOM in one ItemView, no framework.
import { ItemView, Notice, setIcon, type WorkspaceLeaf } from "obsidian";
import { fmtDate, fromNow } from "./time";
import { HUB_VIEW_TYPE, PLATFORM_NAME, RIBBON_ICON } from "../brand";
import type { CatalogGame, FriendRow, Profile } from "../backend";
import type SPlugin from "../main";

type Tab = "catalog" | "library" | "friends" | "profile" | "auth";

const CACHE_MS = 60_000;

export class HubView extends ItemView {
  private tab: Tab = "catalog";
  private profileName: string | null = null; // null = me
  private cache = new Map<string, { at: number; data: unknown }>();
  private renderSeq = 0;
  private unsub: (() => void) | null = null;
  private lastAuthKey = "";

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
    await this.render();
  }

  async onClose(): Promise<void> {
    this.unsub?.();
  }

  show(tab: Tab, profileName: string | null = null): void {
    this.tab = tab;
    this.profileName = profileName;
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
      box.createEl("p", { text: `${PLATFORM_NAME} needs a server. Paste your Supabase project URL and anon key in the settings (see the README).` });
      box.createEl("button", { text: "Open settings", cls: "mod-cta" }).onclick = () => this.plugin.openSettings();
      return;
    }
    const needsAccount = this.tab === "library" || this.tab === "friends" || (this.tab === "profile" && !this.profileName);
    if (this.tab === "auth" || (needsAccount && !st.signedIn)) return this.renderAuth(body);

    const loading = body.createDiv({ cls: "s-muted", text: "Loading…" });
    try {
      if (this.tab === "catalog") await this.renderCatalog(body, seq);
      else if (this.tab === "library") await this.renderLibrary(body, seq);
      else if (this.tab === "friends") await this.renderFriends(body, seq);
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
    h.createSpan({ cls: "s-logo", text: PLATFORM_NAME });
    const nav = h.createDiv({ cls: "s-nav" });
    const tabs: [Tab, string][] = [["catalog", "Catalog"], ["library", "Library"], ["friends", "Friends"]];
    for (const [t, label] of tabs) {
      const b = nav.createEl("button", { text: label, cls: this.tab === t ? "is-active" : "" });
      b.onclick = () => this.show(t);
    }
    const me = h.createDiv({ cls: "s-me" });
    if (signedIn) {
      const b = me.createEl("button", { text: username ? "@" + username : "Profile", cls: this.tab === "profile" && !this.profileName ? "is-active" : "" });
      b.onclick = () => this.show("profile");
    } else {
      me.createEl("button", { text: "Sign in", cls: "mod-cta" }).onclick = () => this.show("auth");
    }
  }

  // ---------- auth ----------
  private renderAuth(body: HTMLElement): void {
    const box = body.createDiv({ cls: "s-card s-auth" });
    box.createEl("h3", { text: `Your ${PLATFORM_NAME} account` });
    let mode: "signin" | "signup" | "code" = "signin";
    const modes = box.createDiv({ cls: "s-nav" });
    const form = box.createDiv();
    const draw = () => {
      modes.empty();
      for (const [m, label] of [["signin", "Sign in"], ["signup", "Create account"], ["code", "Email code"]] as const) {
        const b = modes.createEl("button", { text: label, cls: mode === m ? "is-active" : "" });
        b.onclick = () => { mode = m; draw(); };
      }
      form.empty();
      const email = form.createEl("input", { type: "email", placeholder: "Email", cls: "s-input" });
      const user = mode === "signup" ? form.createEl("input", { type: "text", placeholder: "Nickname (3–20: letters, digits, _)", cls: "s-input" }) : null;
      const pass = mode !== "code" ? form.createEl("input", { type: "password", placeholder: "Password (min 6)", cls: "s-input" }) : null;
      const code = mode === "code" ? form.createEl("input", { type: "text", placeholder: "6-digit code from the email", cls: "s-input" }) : null;
      const msg = form.createDiv({ cls: "s-muted" });
      const row = form.createDiv({ cls: "s-row" });
      const run = async (fn: () => Promise<unknown>, ok?: string) => {
        msg.setText("…");
        try { await fn(); msg.setText(ok ?? ""); } catch (e) { msg.setText((e as Error)?.message ?? String(e)); }
      };
      if (mode === "signin") {
        row.createEl("button", { text: "Sign in", cls: "mod-cta" }).onclick = () => run(() => this.plugin.backend.signIn(email.value.trim(), pass!.value));
      } else if (mode === "signup") {
        row.createEl("button", { text: "Create account", cls: "mod-cta" }).onclick = () => run(async () => {
          const u = user!.value.trim();
          if (!/^[A-Za-z0-9_]{3,20}$/.test(u)) throw new Error("Nickname: 3–20 letters, digits or _.");
          const r = await this.plugin.backend.signUp(email.value.trim(), pass!.value, u);
          if (r === "confirm-email") msg.setText("Check your email to confirm the account, then sign in.");
        });
      } else {
        row.createEl("button", { text: "Send code" }).onclick = () => run(() => this.plugin.backend.sendCode(email.value.trim()), "Code sent. Check your email.");
        row.createEl("button", { text: "Sign in", cls: "mod-cta" }).onclick = () => run(() => this.plugin.backend.verifyCode(email.value.trim(), code!.value));
      }
    };
    draw();
  }

  // ---------- catalog ----------
  private async renderCatalog(body: HTMLElement, seq: number): Promise<void> {
    const games = await this.cached("catalog", () => this.plugin.backend.catalog());
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
    this.pic(top, g.icon_url, g.name, "s-game-icon");
    const t = top.createDiv();
    t.createDiv({ cls: "s-title", text: g.name });
    const plugins = (this.app as unknown as { plugins?: { manifests?: Record<string, unknown>; enabledPlugins?: Set<string> } }).plugins;
    const installed = !!plugins?.manifests?.[g.plugin_id];
    const enabled = !!plugins?.enabledPlugins?.has(g.plugin_id);
    const linked = this.plugin.api.isLinked(g.id);
    t.createDiv({
      cls: "s-muted",
      text: installed
        ? `${enabled ? "Installed" : "Installed, disabled"} · ${linked ? "connected" : `turn on "Connect to ${PLATFORM_NAME}" in its settings`}`
        : "Not installed in this vault",
    });
    if (g.description) card.createEl("p", { cls: "s-desc", text: g.description });
    const row = card.createDiv({ cls: "s-row" });
    if (g.repo_url) row.createEl("a", { text: "GitHub", href: g.repo_url });
    if (!installed) row.createSpan({ cls: "s-muted", text: g.repo_url ? "Install from the repo or Settings → Community plugins" : "Install via Settings → Community plugins" });
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
    if (seq !== this.renderSeq) return;
    const games = p?.games ?? [];
    if (!games.length) {
      body.createDiv({ cls: "s-empty", text: `Your library is empty. Add games from the catalog, or turn on "Connect to ${PLATFORM_NAME}" in a game: it appears here after your first run.` });
      return;
    }
    for (const g of games) {
      const row = body.createDiv({ cls: "s-card s-row s-lib" });
      this.pic(row, g.icon_url, g.name, "s-game-icon");
      const info = row.createDiv({ cls: "s-grow" });
      info.createDiv({ cls: "s-title", text: g.name });
      info.createDiv({ cls: "s-muted", text: `${g.runs} runs · ${fmtDuration(g.playtime_ms)}${g.last_played_at ? " · last played " + fromNow(g.last_played_at) : ""}` });
      progress(info, g.achievements, g.achievements_total);
    }
  }

  // ---------- friends ----------
  private async renderFriends(body: HTMLElement, seq: number): Promise<void> {
    const searchBox = body.createDiv({ cls: "s-card" });
    const input = searchBox.createEl("input", { type: "search", placeholder: "Find players by nickname", cls: "s-input" });
    const results = searchBox.createDiv();
    let timer: number | null = null;
    input.oninput = () => {
      if (timer) window.clearTimeout(timer);
      timer = window.setTimeout(async () => {
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
              };
            }
          }
        } catch (e) { results.createDiv({ cls: "s-error", text: (e as Error).message }); }
      }, 300);
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
      this.invalidate("friends"); this.invalidate("profile:"); void this.render();
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
        this.pic(r, g.icon_url, g.name, "s-game-icon-sm");
        const t = r.createDiv({ cls: "s-grow" });
        t.createDiv({ cls: "s-title", text: g.name });
        t.createDiv({ cls: "s-muted", text: `${g.runs} runs · ${fmtDuration(g.playtime_ms)}` });
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

    if (p.relation === "self") this.renderEdit(body, p);
  }

  private relationButtons(el: HTMLElement, p: Profile): void {
    if (p.relation === "self" || !this.plugin.backend.status().signedIn) return;
    const row = el.createDiv({ cls: "s-row" });
    const act = (fn: () => Promise<unknown>) => async () => {
      try { const r = await fn(); if (typeof r === "string") new Notice(friendMsg(r)); } catch (e) { new Notice((e as Error).message); }
      this.invalidate("profile:" + p.username.toLowerCase()); this.invalidate("friends"); void this.render();
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

  private renderEdit(body: HTMLElement, p: Profile): void {
    body.createEl("h4", { text: "Edit profile" });
    const box = body.createDiv({ cls: "s-card s-edit" });
    const avatarRow = box.createDiv({ cls: "s-row" });
    const file = avatarRow.createEl("input", { type: "file", attr: { accept: "image/*" } });
    const avatarMsg = avatarRow.createSpan({ cls: "s-muted", text: "Any image; converted to a 256 px WebP under 50 KB." });
    file.onchange = async () => {
      const f = file.files?.[0];
      if (!f) return;
      avatarMsg.setText("Converting and uploading…");
      try {
        await this.plugin.backend.uploadAvatar(f);
        this.invalidate("profile:");
        new Notice("Avatar updated");
        void this.render();
      } catch (e) { avatarMsg.setText((e as Error).message); }
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
    box.createEl("button", { text: "Save", cls: "mod-cta" }).onclick = async () => {
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
        new Notice("Profile saved");
        void this.render();
      } catch (e) { msg.setText((e as Error).message); }
    };
  }

  private pic(parent: HTMLElement, url: string | null, name: string, cls: string): void {
    if (url) parent.createEl("img", { cls, attr: { src: url, alt: "", loading: "lazy" } });
    else parent.createDiv({ cls: cls + " s-placeholder", text: (name || "?").slice(0, 1).toUpperCase() });
  }
}

function fmtDuration(ms: number): string {
  const m = Math.round((ms || 0) / 60000);
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
}

function progress(parent: HTMLElement, n: number, total: number): void {
  if (!total) return;
  const wrap = parent.createDiv({ cls: "s-progress", attr: { title: `${n} of ${total} achievements` } });
  wrap.createDiv({ cls: "s-progress-bar" }).style.width = `${Math.min(100, Math.round((n / total) * 100))}%`;
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
    case "new_best": return `New best in ${a.game_id}: ${String(a.payload?.value ?? "")}${name ? ` (${name})` : ""}`;
    case "friend": return `Became friends with @${a.friend ?? "someone"}`;
    default: return a.kind;
  }
}
