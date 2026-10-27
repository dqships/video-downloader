// The review and share asks (rules in shared/asks.ts). bindAsk shows the one
// that is due in the popup and side panel; bindAskButtons wires the Rate and
// Share buttons in the foot, which are always there.

import { answer, loadAsks, offersAlreadyRated, reviewUrl, storeUrl, updateAsks, type AskAnswer, type AskState } from "../shared/asks";
import { storageKeys } from "../shared/messages";
import { icons } from "./icons";

const reply = (r: AskAnswer) => updateAsks((s) => answer(s, r));

const COPIED_MS = 1200;

/** Saves the answer first: opening a tab closes the popup. */
function openReview(): void {
  void reply("rate").finally(() => chrome.tabs.create({ url: reviewUrl() }));
}

/** Copies the store link, counts it as shared, and shows "Copied" on the button for a moment. */
async function copyLink(button: HTMLButtonElement): Promise<void> {
  const idle = button.innerHTML;
  await navigator.clipboard.writeText(storeUrl()).catch(() => {});
  button.innerHTML = `${icons.check}<span>Copied</span>`;
  setTimeout(() => (button.innerHTML = idle), COPIED_MS);
  await reply("shared");
}

function button(label: string, quiet: boolean, onClick: (b: HTMLButtonElement) => void, icon = ""): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.className = `vz-btn vz-btn--small${quiet ? " vz-btn--quiet" : ""}`;
  b.innerHTML = `${icon}<span></span>`;
  b.querySelector("span")!.textContent = label;
  b.addEventListener("click", () => onClick(b));
  return b;
}

export function bindAsk(root: ParentNode): void {
  const card = root.querySelector<HTMLElement>("#ask")!;
  const edge = root.querySelector<HTMLElement>("#ask-edge")!;
  const title = root.querySelector<HTMLElement>("#ask-title")!;
  const text = root.querySelector<HTMLElement>("#ask-text")!;
  const actions = root.querySelector<HTMLElement>("#ask-actions")!;
  let shown: string | undefined;
  /** After Copy link the card stays a moment so "Copied" can be read. */
  let linger = false;

  const render = (s: AskState): void => {
    const key = s.due && `${s.due}:${s.reviewAsks}`;
    if (key === shown) return;
    shown = key;
    if (!s.due) {
      if (linger) setTimeout(() => (card.hidden = !shown), COPIED_MS);
      else card.hidden = true;
      linger = false;
      return;
    }
    card.hidden = false;
    edge.textContent = `${s.saved} ${s.saved === 1 ? "file" : "files"} saved`;
    if (s.due === "review") {
      title.textContent = "Would you rate Vidzilla?";
      text.textContent = "A rating on the Chrome Web Store helps other people find it. It takes a minute.";
      actions.replaceChildren(
        button("Rate Vidzilla", false, openReview, icons.external),
        button("Not now", true, () => void reply("review-later")),
        ...(offersAlreadyRated(s) ? [button("I already did", true, () => void reply("already-rated"))] : []),
      );
    } else {
      title.textContent = "Know someone who saves videos?";
      text.textContent = "Send them Vidzilla. Copy the link to its Chrome Web Store page and paste it in a message.";
      const copy = button("Copy link", false, (b) => {
        if (linger) return;
        linger = true;
        void copyLink(b);
      }, icons.copy);
      actions.replaceChildren(copy, button("Not now", true, () => void reply("share-dismissed")));
    }
  };

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && storageKeys.asks in changes) void loadAsks().then(render);
  });
  void loadAsks().then(render);
}

export function bindAskButtons(root: ParentNode): void {
  const rate = root.querySelector<HTMLButtonElement>("#rate")!;
  rate.innerHTML = `${icons.star}<span>Rate</span>`;
  rate.title = "Rate Vidzilla on the Chrome Web Store";
  rate.addEventListener("click", openReview);
  const share = root.querySelector<HTMLButtonElement>("#share")!;
  share.innerHTML = `${icons.share}<span>Share</span>`;
  share.title = "Copy the link to Vidzilla on the Chrome Web Store, to send to a friend";
  let copying = false;
  share.addEventListener("click", () => {
    if (copying) return;
    copying = true;
    void copyLink(share);
    setTimeout(() => (copying = false), COPIED_MS);
  });
}
