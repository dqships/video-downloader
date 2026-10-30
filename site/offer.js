// Vidzilla website: the launch offer frame on /upgrade and /pricing. It shows
// the offer running now and the rounds before it, with how many people they
// reached. The words come from /api/prices (see api/_promos.js).

const DAY = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "long" });

/**
 * Fills #offer. `applied` says where the code is applied ("applied for you").
 * With no offer running, only the finished rounds show, muted; with none of
 * those either, the frame stays hidden.
 */
export function showOffer(promo, past, applied) {
  const box = document.getElementById("offer");
  const list = document.getElementById("offer-past");
  list.replaceChildren(
    ...past
      .filter((line) => typeof line === "string")
      .map((line) => Object.assign(document.createElement("li"), { textContent: line })),
  );
  if (promo) {
    document.getElementById("offer-edge").textContent = `${promo.label} · code ${promo.code}, ${applied}`;
    document.getElementById("offer-title").textContent = promo.headline;
    const ends = typeof promo.endsAt === "number" ? `ends ${DAY.format(promo.endsAt)}` : "";
    document.getElementById("offer-status").textContent = [promo.claimed, ends].filter(Boolean).join(" · ");
  }
  for (const el of box.querySelectorAll("[data-offer-running]")) el.hidden = !promo;
  box.classList.toggle("offer--ended", !promo);
  box.hidden = !promo && !list.children.length;
}
