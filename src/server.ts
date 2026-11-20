// Which Supabase project to talk to. Pure (no Obsidian imports) so it is unit-tested.
import { DEFAULT_SUPABASE_KEY, DEFAULT_SUPABASE_URL } from "./brand";

export interface ServerFields {
  supabaseUrl: string;
  supabaseAnonKey: string;
}

/** The server actually used: the custom one only when both fields are filled in, otherwise the built-in default. */
export function serverOf(s: ServerFields): { url: string; key: string; custom: boolean } {
  const url = s.supabaseUrl.trim(), key = s.supabaseAnonKey.trim();
  if (url && key) return { url, key, custom: true };
  return { url: DEFAULT_SUPABASE_URL, key: DEFAULT_SUPABASE_KEY, custom: false };
}

/** A secret key bypasses Row Level Security and must never be used in a client. */
export function isSecretKey(k: string): boolean {
  if (k.startsWith("sb_secret_")) return true;
  if (!k.startsWith("eyJ")) return false;
  try {
    const part = k.split(".")[1] ?? "";
    const payload = JSON.parse(atob(part.replace(/-/g, "+").replace(/_/g, "/"))) as { role?: unknown };
    return payload.role === "service_role";
  } catch {
    return k.includes("service_role");
  }
}
