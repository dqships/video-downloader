// Counts saved files toward the review and share asks (see shared/asks.ts)
// and the house ads (shared/ads.ts) and, when an ask comes due, opens the
// popup to show it. A popup or side panel that is already open shows it on
// its own. One prompt per download: after a download an ad ran before, no
// new ask comes up.

import { afterSave, quietSave, updateAsks } from "../shared/asks";
import { countSaveForAds } from "./ads";

export async function noteSaved(): Promise<void> {
  const hadAd = await countSaveForAds().catch(() => false);
  const state = await updateAsks(hadAd ? quietSave : afterSave);
  if (!state.due || hadAd) return;
  const open = await chrome.runtime.getContexts({
    contextTypes: ["POPUP", "SIDE_PANEL"] as chrome.runtime.ContextType[],
  });
  if (open.length) return;
  // In side panel mode the panel can only open from a click; it shows the ask next time.
  if ((await chrome.action.getPopup({})) === "") return;
  // Chrome refuses when no window has focus; the ask then waits for the next open.
  await chrome.action.openPopup().catch(() => {});
}
