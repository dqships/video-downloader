// The two asks Vidzilla makes after downloads succeed: rate it on the Chrome
// Web Store, and share it with a friend. The rules are pure functions over a
// small record in chrome.storage.local, so they outlive browser restarts: an
// ask nobody answered is still due after the next download.
//
// The review ask can always be skipped (Web Store policy: no blocking, no
// incentives). "Not now" brings it back a few downloads later; "Rate" or
// "I already did" (offered from the second ask on) end it for good. Chrome
// can't see whether a review was posted, so opening the review page counts.

import { storageKeys } from "./messages";

export type AskKind = "review" | "share";

export interface AskState {
  /** Downloads that finished and were saved. */
  saved: number;
  /** The ask showing now, until the user answers it. */
  due?: AskKind;
  /** Times the review ask has come up. */
  reviewAsks: number;
  /** The saved count at which the review ask next comes up. */
  reviewAt: number;
  reviewDone: boolean;
  shareAt: number;
  shareDone: boolean;
}

/** The first review ask comes after this many saved files. */
export const REVIEW_FIRST = 3;
/** "Not now" brings the review ask back after this many more. */
export const REVIEW_AGAIN = 5;
/** The share ask, on a later download than the first review ask. */
export const SHARE_FIRST = 6;

export const initialAskState: AskState = {
  saved: 0,
  reviewAsks: 0,
  reviewAt: REVIEW_FIRST,
  reviewDone: false,
  shareAt: SHARE_FIRST,
  shareDone: false,
};

/** A download finished. Returns the new state; `due` says what to show. */
export function afterSave(state: AskState): AskState {
  const next = { ...state, saved: state.saved + 1 };
  if (next.due) return next; // still unanswered: show it again
  if (!next.reviewDone && next.saved >= next.reviewAt) return { ...next, due: "review", reviewAsks: next.reviewAsks + 1 };
  if (!next.shareDone && next.saved >= next.shareAt) return { ...next, due: "share" };
  return next;
}

export type AskAnswer =
  /** Opened the review page (from the ask or from Settings). */
  | "rate"
  | "already-rated"
  | "review-later"
  /** Copied or emailed the link. */
  | "shared"
  | "share-dismissed";

export function answer(state: AskState, reply: AskAnswer): AskState {
  const clear = (s: AskState, kind: AskKind): AskState => (s.due === kind ? { ...s, due: undefined } : s);
  switch (reply) {
    case "rate":
    case "already-rated":
      return clear({ ...state, reviewDone: true }, "review");
    case "review-later":
      return clear({ ...state, reviewAt: state.saved + REVIEW_AGAIN }, "review");
    case "shared":
    case "share-dismissed":
      return clear({ ...state, shareDone: true }, "share");
  }
}

/** "I already did" is offered on every review ask but the first. */
export function offersAlreadyRated(state: AskState): boolean {
  return state.reviewAsks > 1;
}

export async function loadAsks(): Promise<AskState> {
  const stored = (await chrome.storage.local.get(storageKeys.asks))[storageKeys.asks] as Partial<AskState> | undefined;
  return { ...initialAskState, ...stored };
}

/** Read-modify-write, chained so a save and a click can't drop each other. */
let pending: Promise<unknown> = Promise.resolve();
export function updateAsks(change: (s: AskState) => AskState): Promise<AskState> {
  const next = pending.then(async () => {
    const state = change(await loadAsks());
    await chrome.storage.local.set({ [storageKeys.asks]: state });
    return state;
  });
  pending = next.catch(() => {});
  return next;
}

/** Vidzilla's Chrome Web Store page. The store's item id is the extension id. */
export function storeUrl(): string {
  return `https://chromewebstore.google.com/detail/${chrome.runtime.id}`;
}

export function reviewUrl(): string {
  return `${storeUrl()}/reviews`;
}

export function shareMailto(): string {
  const subject = "Vidzilla saves the videos you watch";
  const body = `I use Vidzilla to save video from web pages. It's a free Chrome extension:\n\n${storeUrl()}`;
  return `mailto:?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}
