// Wire protocol between a game plugin (via this SDK) and the OBSIGAMA hub plugin.
// Both sides run in the same Obsidian process; OBSIGAMA holds the account session and the
// Supabase keys. Games never see tokens: they hand batches of events to OBSIGAMA.

import type { GameManifest } from "./manifest";

/** Obsidian plugin id of the OBSIGAMA hub. Stable on purpose: the display name may change, the id should not. */
export const PLATFORM_PLUGIN_ID = "obsigama";
/** Workspace event OBSIGAMA triggers when its API is ready (and on every status change). */
export const PLATFORM_READY_EVENT = "obsigama:ready";
/** Workspace event OBSIGAMA triggers when it unloads. */
export const PLATFORM_UNLOAD_EVENT = "obsigama:unload";
/** Bump only on breaking changes of PlatformAPI. */
export const PROTOCOL_VERSION = 1;

export type StatValue = number | string;

export type SyncEvent =
  | { idem: string; at: number; type: "stat"; payload: { id: string; value: StatValue }; sent?: boolean }
  | { idem: string; at: number; type: "score"; payload: { lb: string; value: number }; sent?: boolean }
  | { idem: string; at: number; type: "achievement"; payload: { id: string; unlockedAt: number }; sent?: boolean }
  | { idem: string; at: number; type: "session"; payload: { durationMs: number }; sent?: boolean }
  | {
      idem: string;
      at: number;
      type: "snapshot";
      payload: {
        stats: Record<string, StatValue>;
        achievements: Record<string, number>;
        best: Record<string, number>;
      };
      sent?: boolean;
    };

export type SyncEventType = SyncEvent["type"];

/** Per-event result from the server. accepted/duplicate/rejected/flagged/deferred are final; retry is not. */
export type EventStatus = "accepted" | "duplicate" | "rejected" | "flagged" | "deferred" | "retry";

export interface AwardedBadge {
  id: string;
  name: string;
  description?: string;
  iconUrl?: string | null;
}

export interface EventResult {
  idem: string;
  status: EventStatus;
  reason?: string;
}

export interface SubmitRequest {
  gameId: string;
  pluginId: string;
  manifestVersion: number;
  events: Omit<SyncEvent, "sent">[];
}

export type SubmitResponse =
  | {
      ok: true;
      results: EventResult[];
      /** achievements newly unlocked on the server by this batch */
      unlocked: string[];
      /** OBSIGAMA platform badges newly awarded by the server (evaluated server-side, e.g. "10 runs") */
      badges: AwardedBadge[];
      /** account-wide values for this game after the batch (what the OBSIGAMA profile shows) */
      stats: Record<string, StatValue>;
    }
  | { ok: false; error: PlatformError; message?: string; retryAfterMs?: number };

export type PlatformError =
  | "disabled" // OBSIGAMA's "Online / sync" switch is off: OBSIGAMA makes no network requests
  | "signed-out"
  | "not-linked" // the player has not approved this game in OBSIGAMA (or approved another account)
  | "unknown-game" // the game is not registered on the OBSIGAMA server
  | "rate-limited"
  | "network"
  | "server";

export interface PlatformStatus {
  /** OBSIGAMA "Online / sync" master switch. false = OBSIGAMA makes no network requests at all. */
  enabled: boolean;
  /** Supabase URL and key are configured. */
  configured: boolean;
  signedIn: boolean;
  userId: string | null;
  /** OBSIGAMA nickname (profiles.username) */
  username: string | null;
}

export interface LinkRequest {
  gameId: string;
  pluginId: string;
  name: string;
  manifest: GameManifest;
}

export type LinkResponse = { ok: true; userId: string } | { ok: false; error: PlatformError | "denied"; message?: string };

/** What OBSIGAMA exposes as `plugin.api`. */
export interface PlatformAPI {
  readonly protocol: number;
  readonly platformName: string;
  getStatus(): PlatformStatus;
  onStatusChange(cb: (s: PlatformStatus) => void): () => void;
  /** Linked for the currently signed-in account? */
  isLinked(gameId: string): boolean;
  /** Asks the player (modal in OBSIGAMA) to let this game sync to their account. */
  requestLink(req: LinkRequest): Promise<LinkResponse>;
  unlink(gameId: string): void;
  submit(req: SubmitRequest): Promise<SubmitResponse>;
  /** Opens the OBSIGAMA hub view (sign-in / profile). */
  openHub(): void;
}
