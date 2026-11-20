// Network guard + Obsidian requestUrl transport for supabase-js.
import { requestUrl } from "obsidian";
import { PLATFORM_NAME } from "./brand";
import { requestUrlFetch, type RequestUrlLike } from "./net-adapter";

export type { RequestUrlLike } from "./net-adapter";
export { requestUrlFetch } from "./net-adapter";

export class OfflineError extends Error {
  constructor() { super(`${PLATFORM_NAME} is offline: the Online / sync switch is off`); }
}

/**
 * fetch() that refuses to touch the network when the Online / sync switch is off,
 * and always sends requests through Obsidian's requestUrl (not subject to browser CORS).
 */
export function makeFetch(isOnline: () => boolean, send: RequestUrlLike = requestUrl): typeof fetch {
  return async (input: RequestInfo | URL, init?: RequestInit) => {
    if (!isOnline()) throw new OfflineError();
    return requestUrlFetch(input, init, send);
  };
}
