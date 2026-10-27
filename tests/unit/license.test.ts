import { describe, expect, it } from "vitest";
import { isAdFree, noLicense, parseLicense } from "../../src/shared/license";

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
