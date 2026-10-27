import { describe, expect, it } from "vitest";
import { afterSave, answer, initialAskState, offersAlreadyRated, REVIEW_AGAIN, REVIEW_FIRST, SHARE_FIRST, type AskState } from "../../src/shared/asks";

const saves = (n: number, from: AskState = initialAskState) => Array.from({ length: n }).reduce<AskState>((s) => afterSave(s), from);

describe("review ask", () => {
  it("comes up after the first few saved files, without I already did", () => {
    expect(saves(REVIEW_FIRST - 1).due).toBeUndefined();
    const s = saves(REVIEW_FIRST);
    expect(s.due).toBe("review");
    expect(offersAlreadyRated(s)).toBe(false);
  });

  it("stays due after the next download when nobody answered it", () => {
    const s = saves(REVIEW_FIRST + 1);
    expect(s.due).toBe("review");
    expect(s.reviewAsks).toBe(1);
  });

  it("comes back after Not now, with I already did", () => {
    let s = answer(saves(REVIEW_FIRST), "review-later");
    expect(s.due).toBeUndefined();
    s = saves(REVIEW_AGAIN - 1, s);
    expect(s.due).not.toBe("review");
    s = answer(s, "share-dismissed");
    s = afterSave(s);
    expect(s.due).toBe("review");
    expect(offersAlreadyRated(s)).toBe(true);
  });

  it("stops for good after Rate or I already did", () => {
    for (const reply of ["rate", "already-rated"] as const) {
      const s = saves(30, answer(saves(REVIEW_FIRST), reply));
      expect(s.reviewDone).toBe(true);
      expect(s.due).not.toBe("review");
    }
  });
});

describe("share ask", () => {
  it("comes up on a later download than the first review ask", () => {
    const s = saves(SHARE_FIRST - REVIEW_FIRST, answer(saves(REVIEW_FIRST), "rate"));
    expect(s.saved).toBe(SHARE_FIRST);
    expect(s.due).toBe("share");
  });

  it("waits while the review ask is unanswered", () => {
    const s = saves(SHARE_FIRST);
    expect(s.due).toBe("review");
    expect(afterSave(answer(s, "review-later")).due).toBe("share");
  });

  it("is asked once, whether shared or dismissed", () => {
    for (const reply of ["shared", "share-dismissed"] as const) {
      const s = saves(30, answer(saves(SHARE_FIRST - REVIEW_FIRST, answer(saves(REVIEW_FIRST), "rate")), reply));
      expect(s.shareDone).toBe(true);
      expect(s.due).toBeUndefined();
    }
  });

  it("Rate from settings leaves a due share ask alone", () => {
    const s = saves(SHARE_FIRST - REVIEW_FIRST, answer(saves(REVIEW_FIRST), "review-later"));
    expect(s.due).toBe("share");
    expect(answer(s, "rate").due).toBe("share");
  });
});
