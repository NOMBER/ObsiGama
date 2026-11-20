import { describe, expect, it } from "vitest";
import { requestUrlFetch, type RequestUrlLike } from "../src/net-adapter";

describe("requestUrlFetch", () => {
  it("maps a requestUrl-shaped response onto fetch Response", async () => {
    const send: RequestUrlLike = async (opts) => {
      expect(opts.method).toBe("GET");
      expect(opts.url).toContain("/games");
      expect(opts.headers?.apikey || opts.headers?.["apikey"]).toBeDefined();
      const body = new TextEncoder().encode('[{"id":"mini-old-games"}]');
      return { status: 200, headers: { "content-type": "application/json" }, arrayBuffer: body.buffer };
    };
    const res = await requestUrlFetch("https://example.test/rest/v1/games?select=id", { headers: { apikey: "k" } }, send);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([{ id: "mini-old-games" }]);
  });

  it("sends a JSON body on POST", async () => {
    let seen: { method?: string; body?: ArrayBuffer } = {};
    const send: RequestUrlLike = async (opts) => {
      seen = opts;
      return { status: 204, headers: {}, arrayBuffer: new ArrayBuffer(0) };
    };
    const res = await requestUrlFetch("https://example.test/auth/v1/token", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ grant_type: "password" }),
    }, send);
    expect(res.status).toBe(204);
    expect(seen.method).toBe("POST");
    expect(new TextDecoder().decode(seen.body)).toContain("password");
  });
});
