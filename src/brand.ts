// The platform's display name lives here and only here.
// The plugin id ("obsigama", see manifest.json and PLATFORM_PLUGIN_ID in the SDK) must stay stable,
// because game plugins find GAMA Hub by that id.
export const PLATFORM_NAME = "GAMA Hub";
export const HUB_VIEW_TYPE = "obsigama-hub";
export const RIBBON_ICON = "gamepad-2";

// The official GAMA Hub server. The publishable key is public by design (Supabase: "safe to expose ... source code");
// it only reaches what Row Level Security allows. Never put a secret / service_role key here.
export const DEFAULT_SUPABASE_URL = "https://eravzmmusvdtsqsxplij.supabase.co";
export const DEFAULT_SUPABASE_KEY = "sb_publishable_Rl-jTZM4dHMzZrQsKFzJ4g_MmmbMwrR";
