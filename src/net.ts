// Network guard + optional Obsidian requestUrl transport for supabase-js.
import { requestUrl } from "obsidian";

export class OfflineError extends Error {
  constructor() { super("S is offline: the Online / sync switch is off"); }
}

/**
 * fetch() that refuses to touch the network when S is switched off, and optionally sends requests
 * through Obsidian's requestUrl (not subject to browser CORS). Supabase allows any origin, so the
 * normal fetch works; requestUrl is a fallback for networks/proxies that break CORS.
 */
export function makeFetch(isOnline: () => boolean, useRequestUrl: () => boolean): typeof fetch {
  return async (input: RequestInfo | URL, init?: RequestInit) => {
    if (!isOnline()) throw new OfflineError();
    if (!useRequestUrl()) return fetch(input, init);
    return requestUrlFetch(input, init);
  };
}

async function requestUrlFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  // Let the browser serialize the body (FormData, Blob, string...) and headers for us.
  const req = new Request(input, init);
  const method = req.method.toUpperCase();
  const body = method === "GET" || method === "HEAD" ? undefined : await req.arrayBuffer();
  const headers: Record<string, string> = {};
  req.headers.forEach((v, k) => { headers[k] = v; });
  const res = await requestUrl({
    url: req.url, method, headers, body: body && body.byteLength ? body : undefined,
    contentType: headers["content-type"], throw: false,
  });
  const noBody = res.status === 204 || res.status === 205 || res.status === 304 || method === "HEAD";
  return new Response(noBody ? null : res.arrayBuffer, { status: res.status, headers: res.headers });
}
