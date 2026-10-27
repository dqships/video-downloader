import { describe, expect, it } from "vitest";
import { isAdFree, nextPaidAt, noLicense, parseLicense, shouldCheck } from "../../src/shared/license";

describe("ad-free license", () => {
  it("reads the website's answer and ignores anything else", () => {
    expect(parseLicense({ adFree: true, plan: "lifetime", until: null }, 5)).toEqual({ adFree: true, plan: "lifetime", until: null, checkedAt: 5 });
    expect(parseLicense({ adFree: true, plan: "yearly", until: 99 }, 5)).toEqual({ adFree: true, plan: "yearly", until: 99, checkedAt: 5 });
    expect(parseLicense({ adFree: false }, 5)).toEqual({ adFree: false, checkedAt: 5 });
    expect(parseLicense({ error: "Couldn't check right now" }, 5)).toBeUndefined();
    expect(parseLicense(null, 5)).toBeUndefined();
  });

  it("stays ad-free for good after a lifetime purchase, and until the end of a paid year", () => {
    expect(isAdFree(noLicense, 0)).toBe(false);
    expect(isAdFree({ adFree: true, until: null, checkedAt: 0 }, 1e15)).toBe(true);
    expect(isAdFree({ adFree: true, until: 1000, checkedAt: 0 }, 999)).toBe(true);
    expect(isAdFree({ adFree: true, until: 1000, checkedAt: 0 }, 1001)).toBe(false);
  });
});

describe("when a copy checks on its own", () => {
  const DAY = 24 * 3_600_000;
  const paid = { adFree: true, until: null, checkedAt: 0 } as const;
  const free = { adFree: false, checkedAt: 0 } as const;

  it("checks a paid copy once a day and leaves a free one alone", () => {
    expect(shouldCheck(paid, undefined, DAY - 1)).toBe(false);
    expect(shouldCheck(paid, undefined, DAY)).toBe(true);
    expect(shouldCheck(free, undefined, 10 * DAY)).toBe(false);
  });

  it("checks a free copy when another computer on the profile saw a purchase, every few minutes at most", () => {
    expect(shouldCheck(free, 5, 6)).toBe(true);
    // Checked a minute ago, before the purchase: ask again now.
    expect(shouldCheck({ adFree: false, checkedAt: 1000 }, 2000, 1000 + 60_000)).toBe(true);
    // Already asked since the purchase and Stripe said no yet: wait a little.
    expect(shouldCheck({ adFree: false, checkedAt: 1000 }, 5, 1000 + 60_000)).toBe(false);
    expect(shouldCheck({ adFree: false, checkedAt: 1000 }, 5, 1000 + 10 * 60_000)).toBe(true);
  });

  it("marks a purchase for the profile, and clears the mark once the answer stays no", () => {
    expect(nextPaidAt(undefined, true, 7)).toBe(7);
    expect(nextPaidAt(3, true, 7)).toBe(3);
    // Stripe's search can lag a fresh purchase: keep the mark a while.
    expect(nextPaidAt(3, false, 3 + DAY - 1)).toBe(3);
    expect(nextPaidAt(3, false, 3 + DAY)).toBeUndefined();
    expect(nextPaidAt(undefined, false, 7)).toBeUndefined();
  });
});
