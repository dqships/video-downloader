// Counts saved files toward the review and share asks (see shared/asks.ts)
// and, when one comes due, opens the popup to show it. A popup or side panel
// that is already open shows it on its own.

import { afterSave, updateAsks } from "../shared/asks";

export async function noteSaved(): Promise<void> {
  const state = await updateAsks(afterSave);
  if (!state.due) return;
  const open = await chrome.runtime.getContexts({
    contextTypes: ["POPUP", "SIDE_PANEL"] as chrome.runtime.ContextType[],
  });
  if (open.length) return;
  // In side panel mode the panel can only open from a click; it shows the ask next time.
  if ((await chrome.action.getPopup({})) === "") return;
  // Chrome refuses when no window has focus; the ask then waits for the next open.
  await chrome.action.openPopup().catch(() => {});
}
