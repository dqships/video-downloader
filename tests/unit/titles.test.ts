import { describe, expect, it } from "vitest";
import { cleanTitle } from "../../src/shared/titles";

describe("cleanTitle", () => {
  it.each([
    ["Storm hits the coast | CNN", "edition.cnn.com", undefined, "Storm hits the coast"],
    ["Insane clutch - Twitch", "www.twitch.tv", undefined, "Insane clutch"],
    ["Episode 4 - video Dailymotion", "www.dailymotion.com", undefined, "Episode 4"],
    ["Budget explained - BBC News", "www.bbc.com", "BBC News", "Budget explained"],
    ['SpaceX on X: "Liftoff of Starship!" / X', "x.com", undefined, "SpaceX: Liftoff of Starship!"],
    ["(3) Real-time demo - Fixture", "fixture.test", undefined, "Real-time demo"],
    ["The New Vimeo Player (You Know, For Videos) on Vimeo", "vimeo.com", undefined, "The New Vimeo Player (You Know, For Videos)"],
    ["Cats - the musical", "example.com", undefined, "Cats - the musical"],
  ])("%s", (docTitle, host, siteName, expected) => {
    expect(cleanTitle({ docTitle, host, siteName })).toBe(expected);
  });

  it("uses og:title when the tab title is only the site's name", () => {
    expect(cleanTitle({ docTitle: "Dailymotion", ogTitle: "Episode 4 - video Dailymotion", host: "www.dailymotion.com" })).toBe("Episode 4");
  });
});
