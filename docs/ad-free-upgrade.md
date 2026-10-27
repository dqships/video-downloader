# Ad-free upgrade with Stripe

Plan for selling "Vidzilla without ads" for **$0.99 a year** or **$9 once**.
Nothing here is built yet; option A below is the chosen way. The extension already has the switch it needs
(`adFree` in the `ads` state, see `src/shared/ads.ts`) and a place for the
"Remove ads" link (`upgradeUrl` in `site/ads.json`).

## The one decision to make first: who remembers that someone paid

Taking the money is easy with Stripe alone. The hard part is the extension
finding out, on that person's Chrome, that they paid, and finding out again
when a yearly plan lapses or they install on a new computer. Something online
has to answer "has this person paid?". There are two ways to get that:

| | A. Your own small server on Vercel | B. ExtensionPay (extensionpay.com) |
| --- | --- | --- |
| What it is | Three Vercel Functions in this repo plus a small key-value store | A hosted service made for paid Chrome extensions, on top of your Stripe account |
| Server you run | Yes, a small one | No |
| Code in the extension | A few lines: open the upgrade page, check the license once a day | Their `ExtPay.js` library, bundled into the extension (not loaded remotely) |
| Sign-in for the user | None (an install ID), plus email to restore on a new computer | Email login on their page |
| Cost | Vercel's free tier covers it | A fee on every payment, on top of Stripe's; check their current pricing |
| Lock-in | None | Moving off later means moving your customers' licenses |

Note the earlier decision that the website has **no server**. That was for
the paste-a-link downloader and still holds there, but option A does add one
for payments. Option B keeps "no server of our own" at the price of a fee and
a dependency. Either one also means the privacy policy must change: payments
mean an email address and Stripe as a processor.

**Decided (DQ, 27 October 2026): A**, Vidzilla's own small server on
Vercel. The fee in B would land on a $0.99 price that Stripe's fixed fee
already eats into (see Fees). The "no server" decision still holds for the
paste-a-link downloader; this server only handles purchases.

## Fees, worth knowing before picking $0.99

Stripe's standard US card price is 2.9% + 30¢ per payment, plus 0.7% for
Stripe Billing on subscriptions. On $0.99 that's about 34¢, so you keep about
65¢ a year. On $9 you keep about $8.44. Options:

- Keep $0.99/yr as the "try it" price and push $9 lifetime as the main one.
- Raise the yearly price to $1.99 or $2.99, where the 30¢ matters less.
- Ask Stripe support about their micropayments pricing for low-priced goods.

Check stripe.com/pricing for current numbers before launch.

## Option A, step by step

### 1. Stripe dashboard (no code)

1. Create a Stripe account for the business (Michigan) and finish
   verification.
2. **Product catalog → Add product**: "Vidzilla ad-free". Add two prices:
   - $0.99 USD, recurring, yearly.
   - $9.00 USD, one-time.
3. **Settings → Tax**: turn on Stripe Tax if you want sales tax handled
   (digital goods are taxable in some states).
4. **Settings → Billing → Customer portal**: turn it on, so yearly customers
   can cancel or update their card themselves.
5. **Developers → API keys**: copy the secret key. **Developers → Webhooks**:
   add an endpoint `https://vidzilla.followusai.com/api/stripe-webhook` for
   `checkout.session.completed`, `customer.subscription.updated` and
   `customer.subscription.deleted`, and copy its signing secret.

### 2. Vercel

1. **Storage**: add an Upstash Redis store from the Vercel Marketplace (free
   tier) and connect it to the project. It holds one record per buyer.
2. **Environment variables** (Production): `STRIPE_SECRET_KEY`,
   `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_YEARLY`, `STRIPE_PRICE_LIFETIME`
   (the two price IDs), plus the Redis variables Vercel adds.
3. Add `api/` functions to this repo (Vercel deploys them next to the static
   site; `vercel.json` needs no change beyond allowing `/api/*` through the
   CSP's `connect-src`, which already allows `https:`):

| Function | Does |
| --- | --- |
| `POST /api/checkout` | Body `{ plan: "yearly" \| "lifetime", installId }`. Creates a Stripe Checkout Session with the matching price, `client_reference_id: installId`, `success_url: /upgrade/thanks`, and returns its URL. |
| `POST /api/stripe-webhook` | Verifies the Stripe signature, then on a completed checkout saves `install:<installId> → { email, plan, until }` (lifetime: `until` = never; yearly: the subscription's period end). On subscription updates and cancellations, moves `until`. |
| `GET /api/license?id=<installId>` | Returns `{ adFree: true, until }` or `{ adFree: false }`. No other data. |
| `POST /api/restore` | Body `{ email, installId }`. If that email bought, emails a one-time link that attaches the purchase to the new install ID. |

### 3. Website

- `site/upgrade.html`: two buttons, "$0.99 a year" and "$9 once", that call
  `/api/checkout` with the install ID from the page's `?id=` and go to Stripe.
  A "Bought it before?" form calls `/api/restore`.
- `site/upgrade/thanks.html`: "Ads are off. You can close this tab."
- Update the pricing page with the two plans.

### 4. Extension

1. On first run, make a random install ID (`crypto.randomUUID()`) and keep it
   in `chrome.storage.sync`, so it follows the person's Chrome profile to
   other computers where they're signed in to Chrome.
2. Set `upgradeUrl` in `site/ads.json` to
   `https://vidzilla.followusai.com/upgrade`. The ad's "Remove ads" link and a
   Settings row open it with `?id=<installId>`.
3. Once a day (and right after the thanks page loads), call `/api/license`
   and set `adFree` from the answer. If the call fails, keep the last answer
   so a network blip never brings ads back for a paying user.
4. Add a Settings row: "Ads: Off (lifetime)" / "Off until 27 Oct 2027" /
   "Remove ads".

### 5. Store and policy

- Chrome Web Store dashboard: tick that the item has in-app purchases, so the
  listing says so.
- Privacy policy: add that buying the upgrade sends your email and payment to
  Stripe, and that Vidzilla stores your install ID, email, plan and end date
  to remember the purchase.
- Terms: add refunds (Stripe lets you refund from the dashboard) and what
  "lifetime" means (the life of the product).

## Option B, step by step

1. Sign up at extensionpay.com with the extension's ID and connect Stripe.
2. Create the two plans there ($0.99 yearly, $9 one-time).
3. `pnpm add extpay`, call `ExtPay('vidzilla').startBackground()` in the
   service worker, add `https://extensionpay.com/*` to the manifest's host
   permissions (it already has `<all_urls>`), and read `user.paid` to set
   `adFree`.
4. "Remove ads" calls `extpay.openPaymentPage()` instead of `upgradeUrl`.
5. The same store and policy changes as in option A.
