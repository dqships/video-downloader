// Counts saved files toward the review and share asks (see shared/asks.ts)
// and the house ads (shared/ads.ts) and, when one comes due, opens the popup
// to show it. A popup or side panel that is already open shows it on its own.
// One prompt per save: when an ask comes up, no ad comes with it.

import { afterSave, updateAsks } from "../shared/asks";
import { noteSavedForAds } from "./ads";

export async function noteSaved(): Promise<void> {
  const state = await updateAsks(afterSave);
  const adDue = await noteSavedForAds(Boolean(state.due)).catch(() => false);
  if (!state.due && !adDue) return;
  const open = await chrome.runtime.getContexts({
    contextTypes: ["POPUP", "SIDE_PANEL"] as chrome.runtime.ContextType[],
  });
  if (open.length) return;
  // In side panel mode the panel can only open from a click; it shows the ask next time.
  if ((await chrome.action.getPopup({})) === "") return;
  // Chrome refuses when no window has focus; the ask then waits for the next open.
  await chrome.action.openPopup().catch(() => {});
}
