# Ad-free upgrade

Vidzilla without ads costs **$0.99 a year** or **$9 once**, paid through Stripe
in the **FollowUs AI** Stripe account (FollowUs AI LLC). Every feature stays
free; paying only turns the house ads off (see [house-ads.md](house-ads.md)).

## How it works

```
Extension                    Website (Vercel)                Stripe
---------                    ----------------                ------
install ID (random UUID,
chrome.storage.sync)
  "Remove ads" ─────────────► /upgrade?id=<installId>
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
- **Cancelling or changing the card:** on a yearly plan, **Manage** in
  Settings calls `POST /api/portal` with the install ID. The server finds
  the customer from the subscription's metadata and opens a Stripe customer
  portal session (return address: the website's home page).
- **Yearly plans** stay ad-free while the subscription is `active`,
  `trialing` or `past_due`, until the paid period ends. **Lifetime** stays
  ad-free unless the payment is refunded.

| Piece | File |
| --- | --- |
| Start a checkout | `api/checkout.js` (`POST {plan, id}` → `{url}`) |
| License check | `api/license.js` (`GET ?id=&session=` → `{adFree, plan, until}`) |
| Customer portal | `api/portal.js` (`POST {id}` → `{url}`), for Manage on a yearly plan |
| Shared Stripe code | `api/_stripe.js` (tests: `tests/unit/license-api.test.ts`) |
| Upgrade and thanks pages | `site/upgrade.html`, `site/upgrade-thanks.html`, `site/upgrade.js` |
| Extension | `src/shared/license.ts`, `src/sw/license.ts`, Settings row `src/ui/ads-setting.ts`, "Remove ads" in the ad |

## Settings it needs

Stripe (FollowUs AI account): the product **Vidzilla without ads**
(`prod_VWF2IPKPVl6qYF`) with two prices, $0.99 USD yearly
(`price_1UVCY5DyfH6JDnExHp32eh4D`) and $9.00 USD one-time
(`price_1UVCYWDyfH6JDnExJGS2PSsl`), both created 2026-10-27, and a **restricted API key**
named "Vidzilla website" with these permissions and nothing else:

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
| `STRIPE_PRICE_YEARLY` | `price_1UVCY5DyfH6JDnExHp32eh4D` (set) |
| `STRIPE_PRICE_LIFETIME` | `price_1UVCYWDyfH6JDnExJGS2PSsl` (set) |

Without them the API answers 503 and the upgrade page says checkout isn't set
up; ads keep working either way.

## Running it

- **Refunds:** refund in the Stripe dashboard. A refunded lifetime payment
  stops counting at the next daily check. The terms promise a full refund
  within 30 days on request.
- **Cancelling a yearly plan:** the buyer presses **Manage** in Vidzilla's
  Settings (or the link in their Stripe receipt), which opens the customer
  portal; or you cancel it in the dashboard.
- **Moved to a different Chrome profile:** their new copy has a new install
  ID. In Stripe, open their payment or subscription and set its
  `install_id` metadata to the ID from the new copy. The ID is in
  `chrome.storage.sync`; support can ask them to read it from the address of
  the upgrade page that **Remove ads** opens.
- **Fees:** Stripe's standard US price is 2.9% + 30¢ (plus 0.7% for Billing on
  subscriptions), so a $0.99 payment keeps about 65¢ and $9 keeps about
  $8.44.

## Store and policy

- Chrome Web Store: mark that the item has in-app purchases.
- The privacy policy, terms (refunds, what "once" means), pricing, support
  and upgrade pages describe all of this, including that the server exists
  only to check whether a copy paid.
