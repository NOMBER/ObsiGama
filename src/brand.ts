// The in-app brand lives here and only here.
// manifest.json → name is "GAMA Hub" (the community directory does not allow "ObsiGama").
// The plugin id ("obsigama", see manifest.json and PLATFORM_PLUGIN_ID in the SDK) must stay stable,
// because game plugins find ObsiGama by that id.
export const PLATFORM_NAME = "ObsiGama";
export const HUB_VIEW_TYPE = "obsigama-hub";
export const RIBBON_ICON = "gamepad-2";

// The official ObsiGama server. The publishable key is public by design (Supabase: "safe to expose ... source code");
// it only reaches what Row Level Security allows. Never put a secret / service_role key here.
export const DEFAULT_SUPABASE_URL = "https://eravzmmusvdtsqsxplij.supabase.co";
export const DEFAULT_SUPABASE_KEY = "sb_publishable_Rl-jTZM4dHMzZrQsKFzJ4g_MmmbMwrR";
