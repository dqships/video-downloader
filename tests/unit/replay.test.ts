import { describe, expect, it } from "vitest";
import { buildReplayRules, headersToReplay, urlDirectory } from "../../src/sw/replay";

describe("replay rules", () => {
  it("keeps identity headers only", () => {
    expect(headersToReplay({ cookie: "a=1", referer: "https://p/", accept: "*/*", "x-token": "t" })).toEqual({
      cookie: "a=1", referer: "https://p/", "x-token": "t",
    });
  });

  it("scopes one rule per directory to extension requests", () => {
    const rules = buildReplayRules(
      ["https://cdn.x/v/1/a.mp4?sig=1", "https://cdn.x/v/1/b.mp4", "https://cdn.x/v/2/c.mp4"],
      { referer: "https://site.x/watch", origin: "https://site.x" },
      7,
    );
    expect(rules.map((r) => r.id)).toEqual([7, 8]);
    expect(rules[0]!.condition.urlFilter).toBe("|https://cdn.x/v/1/");
    expect(rules[0]!.condition.tabIds).toEqual([-1]);
    expect(rules[0]!.action.requestHeaders).toEqual([
      { header: "referer", operation: "set", value: "https://site.x/watch" },
      { header: "origin", operation: "set", value: "https://site.x" },
    ]);
  });

  it("makes no rules when there is nothing to replay", () => {
    expect(buildReplayRules(["https://cdn.x/a.mp4"], { accept: "*/*" }, 1)).toEqual([]);
  });

  it("escapes urlFilter special characters", () => {
    expect(urlDirectory("https://cdn.x/v/d.mp4?x=1")).toBe("https://cdn.x/v/");
    const [rule] = buildReplayRules(["https://cdn.x/a*b^c/d.mp4"], { referer: "r" }, 1);
    expect(rule!.condition.urlFilter).toBe("|https://cdn.x/a%2Ab%5Ec/");
  });
});
