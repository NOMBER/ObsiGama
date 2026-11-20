// Everything that talks to Supabase. Created lazily; torn down when OBSIGAMA is switched offline.
import { createClient, type Session, type SupabaseClient } from "@supabase/supabase-js";
import type { App } from "obsidian";
import { makeFetch, OfflineError } from "./net";
import { PLATFORM_NAME } from "./brand";
import { isSecretKey, serverOf } from "./server";
import type { SSettings } from "./settings";
import { AVATAR_WEBP, toWebp } from "./image/webp";

export interface BackendStatus {
  online: boolean;
  configured: boolean;
  signedIn: boolean;
  userId: string | null;
  username: string | null;
}

export interface CatalogGame {
  id: string;
  plugin_id: string;
  name: string;
  description: string | null;
  repo_url: string | null;
  icon_url: string | null;
}

export interface FriendRow {
  user_id: string;
  username: string;
  display_name: string | null;
  avatar_url: string | null;
  status: "pending" | "accepted";
  direction: "mutual" | "incoming" | "outgoing";
  since: string;
  last_seen_at: string | null;
}

export interface UserCard {
  id: string;
  username: string;
  display_name: string | null;
  avatar_url: string | null;
}

export interface ProfileGame {
  game_id: string;
  name: string;
  icon_url: string | null;
  runs: number;
  playtime_ms: number;
  last_played_at: string | null;
  achievements: number;
  achievements_total: number;
  stats: Record<string, number | string> | null;
  best: Record<string, number> | null;
}

export interface Profile {
  id: string;
  username: string;
  display_name: string | null;
  bio?: string | null;
  avatar_url: string | null;
  created_at: string;
  privacy: "public" | "friends";
  relation: "self" | "friend" | "request_sent" | "request_received" | "none";
  restricted: boolean;
  last_seen_at?: string | null;
  counts?: { runs: number; games: number; achievements: number; friends: number };
  badges?: { id: string; name: string; description: string | null; icon_url: string | null; awarded_at: string }[];
  games?: ProfileGame[];
  recent_achievements?: { game_id: string; ach_id: string; name: string; icon: string | null; unlocked_at: string }[];
  friends?: { id: string; username: string; avatar_url: string | null }[];
  activity?: { kind: string; game_id: string | null; ref: string | null; payload: Record<string, unknown>; created_at: string; friend: string | null }[];
}

const SESSION_KEY = "obsigama-auth";

export class Backend {
  private client: SupabaseClient | null = null;
  private clientKey = "";
  private session: Session | null = null;
  private username: string | null = null;
  private listeners = new Set<() => void>();
  private unsubAuth: (() => void) | null = null;

  constructor(private app: App, private settings: () => SSettings) {}

  /** (Re)creates or drops the client according to the settings. */
  async reconfigure(): Promise<void> {
    const s = this.settings();
    const srv = serverOf(s);
    const key = `${s.online}|${srv.url}|${srv.key}`;
    if (key === this.clientKey && (this.client || !s.online)) return;
    this.teardown();
    this.clientKey = key;
    if (s.online && this.configured()) {
      const vaultStorage = {
        getItem: (k: string) => (this.app.loadLocalStorage(k) as string | null) ?? null,
        setItem: (k: string, v: string) => this.app.saveLocalStorage(k, v),
        removeItem: (k: string) => this.app.saveLocalStorage(k, null),
      };
      this.client = createClient(srv.url, srv.key, {
        auth: { storage: vaultStorage, storageKey: SESSION_KEY, persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
        global: { fetch: makeFetch(() => this.settings().online, () => this.settings().useRequestUrl) },
      });
      const { data } = this.client.auth.onAuthStateChange((_ev, session) => {
        const changed = session?.user.id !== this.session?.user.id;
        this.session = session;
        if (changed) { this.username = null; if (session) void this.loadUsername(); }
        this.emit();
      });
      this.unsubAuth = () => data.subscription.unsubscribe();
      try {
        const { data: sd } = await this.client.auth.getSession();
        this.session = sd.session;
        if (this.session) await this.loadUsername();
      } catch (e) {
        console.warn("[GAMA Hub] session restore failed", e);
      }
    }
    this.emit();
  }

  teardown(): void {
    this.unsubAuth?.();
    this.unsubAuth = null;
    if (this.client) {
      try { void this.client.auth.stopAutoRefresh().catch(() => undefined); } catch { /* ignore */ }
    }
    this.client = null;
    this.clientKey = "";
    this.session = null;
    this.username = null;
  }

  configured(): boolean {
    const { url, key } = serverOf(this.settings());
    return /^https:\/\/.+/.test(url) && key.length > 20 && !isSecretKey(key);
  }

  status(): BackendStatus {
    return {
      online: this.settings().online,
      configured: this.configured(),
      signedIn: !!this.client && !!this.session,
      userId: this.client ? this.session?.user.id ?? null : null,
      username: this.username,
    };
  }

  onChange(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private emit(): void {
    for (const cb of this.listeners) { try { cb(); } catch (e) { console.error(e); } }
  }

  /** The client, or an error explaining why there is none. */
  sb(): SupabaseClient {
    if (!this.settings().online) throw new OfflineError();
    if (!this.client) throw new Error(`Server is not configured. Check the custom server fields in ${PLATFORM_NAME} settings.`);
    return this.client;
  }

  private async loadUsername(): Promise<void> {
    const uid = this.session?.user.id;
    if (!uid || !this.client) return;
    const { data } = await this.client.from("profiles").select("username").eq("id", uid).maybeSingle();
    this.username = (data as { username?: string } | null)?.username ?? null;
    this.emit();
  }

  // ---------- auth ----------
  async signUp(email: string, password: string, username: string): Promise<"signed-in" | "confirm-email"> {
    const { data, error } = await this.sb().auth.signUp({ email, password, options: { data: { username } } });
    if (error) throw error;
    return data.session ? "signed-in" : "confirm-email";
  }
  async signIn(email: string, password: string): Promise<void> {
    const { error } = await this.sb().auth.signInWithPassword({ email, password });
    if (error) throw error;
  }
  async sendCode(email: string): Promise<void> {
    const { error } = await this.sb().auth.signInWithOtp({ email, options: { shouldCreateUser: true } });
    if (error) throw error;
  }
  async verifyCode(email: string, code: string): Promise<void> {
    const { error } = await this.sb().auth.verifyOtp({ email, token: code.trim(), type: "email" });
    if (error) throw error;
  }
  async signOut(): Promise<void> {
    if (this.client) await this.client.auth.signOut();
    this.session = null;
    this.username = null;
    this.emit();
  }

  /** Typed wrapper: supabase-js without generated types returns `any` data. */
  private async rpc<T>(fn: string, args?: Record<string, unknown>): Promise<T> {
    const res: { data: unknown; error: unknown } = await this.sb().rpc(fn, args);
    if (res.error) throw toError(res.error);
    return res.data as T;
  }

  // ---------- reads ----------
  async catalog(): Promise<CatalogGame[]> {
    const { data, error } = await this.sb().from("games")
      .select("id, plugin_id, name, description, repo_url, icon_url").eq("status", "listed").order("sort_order").order("name");
    if (error) throw error;
    return data ?? [];
  }
  async profile(username: string): Promise<Profile | null> {
    return (await this.rpc<Profile | null>("get_profile", { p_username: username })) ?? null;
  }
  async searchUsers(q: string): Promise<UserCard[]> {
    return (await this.rpc<UserCard[] | null>("search_users", { p_query: q, p_limit: 20 })) ?? [];
  }
  async friends(): Promise<FriendRow[]> {
    return (await this.rpc<FriendRow[] | null>("my_friends")) ?? [];
  }

  // ---------- writes ----------
  async sendFriendRequest(username: string): Promise<string> {
    return this.rpc<string>("send_friend_request", { p_username: username });
  }
  async respondFriend(userId: string, accept: boolean): Promise<void> {
    const { error } = await this.sb().rpc("respond_friend_request", { p_user: userId, p_accept: accept });
    if (error) throw error;
  }
  async removeFriend(userId: string): Promise<void> {
    const { error } = await this.sb().rpc("remove_friend", { p_user: userId });
    if (error) throw error;
  }
  async addToLibrary(gameId: string): Promise<void> {
    const uid = this.requireUser();
    const { error } = await this.sb().from("user_library").insert({ user_id: uid, game_id: gameId });
    if (error && error.code !== "23505") throw error; // already in library
  }
  async updateProfile(p: { username?: string; display_name?: string | null; bio?: string | null; privacy?: "public" | "friends" }): Promise<void> {
    const uid = this.requireUser();
    const { error } = await this.sb().from("profiles").update(p).eq("id", uid);
    if (error) {
      if (error.code === "23505") throw new Error("This nickname is taken.");
      if (error.code === "23514") throw new Error("Check the fields: nickname 3–20 letters, digits or _, bio up to 300 characters.");
      throw error;
    }
    if (p.username) { this.username = p.username; this.emit(); }
  }

  /** Converts any image to a small WebP (256 px, < 50 KB) and makes it the avatar. */
  async uploadAvatar(file: Blob): Promise<string> {
    const uid = this.requireUser();
    const webp = await toWebp(file, AVATAR_WEBP);
    const sb = this.sb();
    const path = `${uid}/avatar.webp`;
    const { error } = await sb.storage.from("avatars").upload(path, webp.blob, { upsert: true, contentType: "image/webp", cacheControl: "31536000" });
    if (error) throw error;
    const url = `${sb.storage.from("avatars").getPublicUrl(path).data.publicUrl}?v=${Date.now()}`;
    const { error: e2 } = await sb.from("profiles").update({ avatar_url: url }).eq("id", uid);
    if (e2) throw e2;
    return url;
  }

  /** Sync RPC used by game plugins through the PlatformAPI. */
  async ingest(gameId: string, manifestVersion: number, events: unknown[]): Promise<Record<string, unknown>> {
    return (await this.rpc<Record<string, unknown> | null>("ingest_batch", { p_game_id: gameId, p_manifest_version: manifestVersion, p_events: events })) ?? {};
  }

  private requireUser(): string {
    const uid = this.session?.user.id;
    if (!uid) throw new Error("Sign in first.");
    return uid;
  }
}

/** PostgREST errors are plain objects; keep message and code on a real Error. */
function toError(e: unknown): Error {
  if (e instanceof Error) return e;
  const o = (e ?? {}) as { message?: string; code?: string };
  return Object.assign(new Error(o.message ?? "Request failed"), { code: o.code });
}
