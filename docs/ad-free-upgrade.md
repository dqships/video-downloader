# Ad-free upgrade

Vidzilla without ads is a **subscription** (its price is under an A/B/C test,
see below) or **$9 once**, paid through Stripe in the **FollowUs AI** Stripe
account (FollowUs AI LLC). Every feature stays free; paying only turns the
house ads off (see [house-ads.md](house-ads.md)).

## How it works

```
Extension                    Website (Vercel)                Stripe
---------                    ----------------                ------
install ID (random UUID,
chrome.storage.sync)
  "Remove ads" ─────────────► /upgrade?id=<installId>
                              GET /api/prices?id ───────────► reads the prices
                              button ─► POST /api/checkout ─► Checkout Session
                                                              (install ID in
                                                              metadata)
                              /upgrade-thanks ◄────────────── buyer pays
  sees the thanks page ─────► GET /api/license?id&session ──► reads that session
  daily ────────────────────► GET /api/license?id ──────────► searches payments
                                                              and subscriptions
  ◄──────────── {adFree, plan, until}
```

- **Stripe is the only record.** The server keeps no database. A purchase
  carries the install ID in its metadata (`install_id` on the Checkout
  Session, the subscription and the payment), and a license check searches
  Stripe for it. The decision recorded on 27 October 2026 was "option A, our
  own small Vercel server"; the server is the two functions below, and
  Upstash turned out to be unnecessary.
- **The install ID** is made with `crypto.randomUUID()` the first time it's
  needed and kept in `chrome.storage.sync`, so it follows the person's Chrome
  profile to their other computers. It identifies nobody.
- **When the extension checks:** at once when the website's
  `/upgrade-thanks` page opens (the page carries the Checkout Session ID,
  which confirms the purchase without waiting for Stripe's search index),
  when the person presses **Check again** in Settings, under Ads, and once a
  day after that, but only while the copy is paid (on a completed download or
  a browser start, when the last answer is 24 hours old). Free copies never
  check on their own, so the server's Stripe searches scale with paying
  users, not installs. A paid answer also writes `paidAt` to
  `chrome.storage.sync`; other computers on the same Chrome profile see it
  and check at once, then every 10 minutes (on a download or browser start)
  until Stripe says yes. A "no" clears `paidAt` only once it is a day old,
  since Stripe's search can lag a fresh purchase. A failed check keeps the
  last answer.
- **The kept checkout:** the extension keeps the Checkout Session ID that
  confirmed a purchase (`paidSession` in `chrome.storage.sync`) and sends it
  with every check. That is what keeps a purchase that a 100% off coupon made
  free counted: Stripe makes no payment for it, so the payment search finds
  nothing, but the session says `no_payment_required`. The session path still
  checks for a refund (lifetime) or a lapsed subscription, and the extension
  drops the kept session once the answer is no.
- **Cancelling or changing the card:** on a subscription, **Manage** in
  Settings calls `POST /api/portal` with the install ID. The server finds
  the customer from the subscription's metadata and opens a Stripe customer
  portal session (return address: the website's home page).
- **Subscriptions** stay ad-free while the subscription is `active`,
  `trialing` or `past_due`, until the paid period ends. **Lifetime** stays
  ad-free unless the payment is refunded.

| Piece | File |
| --- | --- |
| Start a checkout | `api/checkout.js` (`POST {plan, id}` → `{url}`) |
| License check | `api/license.js` (`GET ?id=&session=` → `{adFree, plan, until}`) |
| Prices | `api/prices.js` (`GET ?id=` → this install's prices as text), `api/_prices.js` (tests: `tests/unit/prices-api.test.ts`) |
| Customer portal | `api/portal.js` (`POST {id}` → `{url}`), for Manage on a subscription |
| Shared Stripe code | `api/_stripe.js` (tests: `tests/unit/license-api.test.ts`) |
| Upgrade and thanks pages | `site/upgrade.html`, `site/upgrade-thanks.html`, `site/upgrade.js` |
| Extension | `src/shared/license.ts`, `src/sw/license.ts`, Settings row `src/ui/ads-setting.ts`, "Remove ads" in the ad |

## Settings it needs

Stripe (FollowUs AI account): the product **Vidzilla without ads**
(`prod_VWF2IPKPVl6qYF`) with these prices:

| Price | ID | Who sees it |
| --- | --- | --- |
| $0.99 USD a year (created 2026-10-27) | `price_1UVCY5DyfH6JDnExHp32eh4D` | group a, and the public pages |
| $0.99 USD a week (created 2026-10-29) | `price_1UVw1zDyfH6JDnEx6vg7rnpw` | group b |
| $7.00 USD every 3 months (created 2026-10-29) | `price_1UVw2LDyfH6JDnExXYV5n9bw` | group c |
| $9.00 USD one-time (created 2026-10-27) | `price_1UVCYWDyfH6JDnExJGS2PSsl` | everyone |

and a **restricted API key** named "Vidzilla website" with these permissions
and nothing else:

| Resource | Permission |
| --- | --- |
| Checkout Sessions | Write |
| PaymentIntents | Read |
| Charges | Read |
| Subscriptions | Read |
| Prices, Products, Customers | Read |
| Customer portal | Write (for Manage, `api/portal.js`) |

The customer portal must be turned on in live mode: Stripe dashboard,
Settings, Billing, Customer portal. Allow customers to cancel subscriptions
(at the end of the billing period) and update payment methods, then save.

Vercel (project `vidzilla`, Production):

| Variable | Value |
| --- | --- |
| `STRIPE_SECRET_KEY` | the restricted key (`rk_live_...`), saved as a Secret |
| `STRIPE_PRICE_SUBSCRIPTIONS` | the subscription prices under test, in group order: `price_1UVCY5DyfH6JDnExHp32eh4D,price_1UVw1zDyfH6JDnEx6vg7rnpw,price_1UVw2LDyfH6JDnExXYV5n9bw` |
| `STRIPE_PRICE_YEARLY` | `price_1UVCY5DyfH6JDnExHp32eh4D`, used only when `STRIPE_PRICE_SUBSCRIPTIONS` is empty |
| `STRIPE_PRICE_LIFETIME` | `price_1UVCYWDyfH6JDnExJGS2PSsl` |

Without them the API answers 503 and the upgrade page says checkout isn't set
up; ads keep working either way.

## Prices and the A/B/C test

- **Stripe holds the prices; nothing else does.** `api/_prices.js` reads each
  price from Stripe (cached for 10 minutes) and turns it into words ("$0.99 a
  week", "$7 every 3 months", "$9 once").
- **Groups:** with more than one price in `STRIPE_PRICE_SUBSCRIPTIONS`, an
  install's group is the first 8 hex digits of its random install ID modulo
  the number of prices, so installs split evenly and one person always sees
  the same price. Group a is the first price listed, b the second, and so on.
  Checkout charges the group's price, and the session, subscription and
  payment carry `variant` metadata (a, b, c) next to `install_id`.
- **Where prices show:** the upgrade page swaps in the install's prices from
  `/api/prices?id=` before its buttons work. Vidzilla's Settings asks the
  same address when opened (at most every 6 hours) and keeps the answer.
  The public pages (pricing, upgrade, support, terms, llms.txt) are filled in
  at build time with group a's prices from the `{{price.*}}` markers; without
  a Stripe key (local builds) they use `DEFAULT_OFFER`.
- **Changing prices:** make a new price in Stripe (a price's amount can't be
  edited), put its ID in the Vercel variable, and **Redeploy** so the public
  pages pick it up. Settings and the upgrade page follow within 6 hours and
  10 minutes; no extension release. Existing subscribers keep the price they
  signed up at.
- **Dropping one price:** delete its ID from `STRIPE_PRICE_SUBSCRIPTIONS`
  and redeploy; installs split evenly across the prices left. Removing or
  reordering IDs moves installs between groups, so some people see a
  different price than before; swapping an ID in place moves nobody.
- **Ending the test:** set `STRIPE_PRICE_SUBSCRIPTIONS` to the winner alone
  and redeploy; everyone then sees that price.
- **Reading the test:** in Stripe, Payments or Subscriptions, filter or
  export by the `variant` metadata, and compare against how many installs
  each group has (about a third each). The figure to compare is revenue per
  install over the same period, since a cheaper price may sell more often.

## Coupons

Checkout has `allow_promotion_codes` on, so Stripe's page shows an "Add
promotion code" field. A coupon is the discount; customers type a
**promotion code** made from it (Stripe dashboard, Product catalog, Coupons,
open the coupon, **Add promotion code**). A 100% off code works on lifetime
too: the kept checkout above keeps it counted.

## Running it

- **Refunds:** refund in the Stripe dashboard. A refunded lifetime payment
  stops counting at the next daily check. The terms promise a full refund
  within 30 days on request.
- **Cancelling a subscription:** the buyer presses **Manage** in Vidzilla's
  Settings (or the link in their Stripe receipt), which opens the customer
  portal; or you cancel it in the dashboard.
- **Moved to a different Chrome profile:** their new copy has a new install
  ID. In Stripe, open their payment or subscription and set its
  `install_id` metadata to the ID from the new copy. The ID is in
  `chrome.storage.sync`; support can ask them to read it from the address of
  the upgrade page that **Remove ads** opens.
- **Fees:** Stripe's standard US price is 2.9% + 30¢ (plus 0.7% for Billing on
  subscriptions), so a $0.99 payment keeps about 65¢, $7 keeps about $6.45
  and $9 keeps about $8.44. At $0.99 about a third goes to fees on every
  charge, weekly or yearly; weekly just charges 52 times a year.

## Store and policy

- Chrome Web Store: mark that the item has in-app purchases.
- The privacy policy, terms (refunds, what "once" means), pricing, support
  and upgrade pages describe all of this, including that the server exists
  only to check whether a copy paid.
