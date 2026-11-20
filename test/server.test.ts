import { describe, expect, it } from "vitest";
import { DEFAULT_SUPABASE_KEY, DEFAULT_SUPABASE_URL } from "../src/brand";
import { isSecretKey, serverOf } from "../src/server";

const jwt = (role: string) => "eyJhbGciOiJIUzI1NiJ9." + btoa(JSON.stringify({ role })).replace(/=+$/, "") + ".sig";

describe("server defaults", () => {
  it("works out of the box with the official server", () => {
    expect(serverOf({ supabaseUrl: "", supabaseAnonKey: "" })).toEqual({ url: DEFAULT_SUPABASE_URL, key: DEFAULT_SUPABASE_KEY, custom: false });
    expect(DEFAULT_SUPABASE_URL).toMatch(/^https:\/\/[a-z0-9]+\.supabase\.co$/);
    expect(DEFAULT_SUPABASE_KEY.startsWith("sb_publishable_")).toBe(true);
    expect(isSecretKey(DEFAULT_SUPABASE_KEY)).toBe(false);
  });
  it("uses a custom server only when both fields are set", () => {
    expect(serverOf({ supabaseUrl: "https://x.supabase.co", supabaseAnonKey: "" }).custom).toBe(false);
    expect(serverOf({ supabaseUrl: " https://x.supabase.co ", supabaseAnonKey: "sb_publishable_abc" })).toEqual({ url: "https://x.supabase.co", key: "sb_publishable_abc", custom: true });
  });
  it("recognises secret keys", () => {
    expect(isSecretKey("sb_secret_abc")).toBe(true);
    expect(isSecretKey(jwt("service_role"))).toBe(true);
    expect(isSecretKey(jwt("anon"))).toBe(false);
  });
});
