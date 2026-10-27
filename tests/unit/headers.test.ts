import { describe, expect, it } from "vitest";
import { HeaderCache, replayableHeaders } from "../../src/sw/headers";

describe("headers", () => {
  it("drops transport headers and lowercases names", () => {
    expect(
      replayableHeaders([
        { name: "Referer", value: "https://p/" },
        { name: "Range", value: "bytes=0-" },
        { name: "User-Agent", value: "UA" },
        { name: "sec-ch-ua", value: "x" },
        { name: "Cookie", value: "a=1" },
      ]),
    ).toEqual({ referer: "https://p/", cookie: "a=1" });
  });

  it("expires entries after ten minutes", () => {
    let now = 0;
    const cache = new HeaderCache(() => now);
    cache.put("1", { referer: "r" });
    now = 9 * 60_000;
    expect(cache.get("1")).toEqual({ referer: "r" });
    now = 11 * 60_000;
    expect(cache.get("1")).toBeUndefined();
  });
});
