// esbuild `inject`: every bare `fetch(...)` in the bundle (including supabase-js fallbacks)
// is rewritten to this requestUrl-based implementation. Property names such as `this.fetch` are left alone.
import { requestUrl } from "obsidian";
import { requestUrlFetch } from "./net-adapter";

export function fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  return requestUrlFetch(input, init, requestUrl);
}
