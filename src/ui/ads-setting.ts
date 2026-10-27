// The Ads row in Settings: whether ads are on, the way to remove them, and a
// check for a purchase made on another computer.

import { UPGRADE_URL, isAdFree, loadLicense, upgradeLink, type License } from "../shared/license";
import { sendCommand, storageKeys } from "../shared/messages";

const DATE = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "long", year: "numeric" });

export function bindAdsSetting(root: ParentNode): void {
  const status = root.querySelector<HTMLElement>(".vz-ads-status");
  const action = root.querySelector<HTMLButtonElement>(".vz-ads-action");
  const check = root.querySelector<HTMLButtonElement>(".vz-ads-check");
  if (!status || !action || !check) return;

  const render = (license: License): void => {
    const paid = isAdFree(license, Date.now());
    if (!paid) status.textContent = "A short ad for one of our other apps every few downloads. Remove them for $0.99 a year or $9 once.";
    else if (license.until) status.textContent = `Off until ${DATE.format(license.until)}. Thanks for supporting Vidzilla.`;
    else status.textContent = "Off for good. Thanks for supporting Vidzilla.";
    action.textContent = paid ? "Manage" : "Remove ads";
    // Lifetime has nothing to manage.
    action.hidden = paid && !license.until;
    check.hidden = paid;
  };

  action.addEventListener("click", async () => {
    await chrome.tabs.create({ url: await upgradeLink(UPGRADE_URL) });
  });
  check.addEventListener("click", async () => {
    check.disabled = true;
    check.textContent = "Checking";
    await sendCommand({ kind: "check-license" }).catch(() => {});
    check.textContent = "Check again";
    check.disabled = false;
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && storageKeys.license in changes) void loadLicense().then(render);
  });
  void loadLicense().then(render);
}
