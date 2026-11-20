/** A requestUrl-shaped transport, so this file can be tested without importing "obsidian". */
export interface RequestUrlLike {
  (opts: {
    url: string;
    method?: string;
    headers?: Record<string, string>;
    body?: ArrayBuffer;
    contentType?: string;
    throw?: boolean;
  }): Promise<{ status: number; headers: Record<string, string>; arrayBuffer: ArrayBuffer }>;
}

/**
 * fetch() implementation that talks through Obsidian's requestUrl (or a test double).
 * supabase-js needs the Fetch API (Request/Response); this adapter provides that surface.
 */
export async function requestUrlFetch(input: RequestInfo | URL, init: RequestInit | undefined, send: RequestUrlLike): Promise<Response> {
  const req = new Request(input, init);
  const method = req.method.toUpperCase();
  const body = method === "GET" || method === "HEAD" ? undefined : await req.arrayBuffer();
  const headers: Record<string, string> = {};
  req.headers.forEach((v, k) => { headers[k] = v; });
  const res = await send({
    url: req.url, method, headers, body: body && body.byteLength ? body : undefined,
    contentType: headers["content-type"], throw: false,
  });
  const noBody = res.status === 204 || res.status === 205 || res.status === 304 || method === "HEAD";
  return new Response(noBody ? null : res.arrayBuffer, { status: res.status, headers: res.headers });
}
