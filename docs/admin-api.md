# C2V Admin API — Contract

The HTTP API the vendor dashboard (separate Next.js repo) uses. It lives in the bot server, next to the
webhooks, and reuses the same business logic (`updateStatus`, `refundOrder`, `sendAndLog`).
This document is the contract: the dashboard codes against it, and the server must match it.

Decided with the user on 2026-11-15:
- The dashboard never talks to Postgres, Cashfree or Meta. Only the bot server does.
- The browser never calls this API. The Next.js **server** calls it, so there is no CORS. Next.js stores the
  session token in its own httpOnly cookie and sends it as a header.
- No summary or deliveries endpoints: the dashboard derives those from order lists.
- Rate limiting is deferred (backlog).

---

## 1. Conventions

- Base path: `/admin` (vendor, needs a session) and `/partner` (delivery partner private link, no session).
- JSON in and out. Field names are camelCase.
- **Money** is integer paise (`totalPaise: 57000` = ₹570). **Timestamps** are ISO 8601 UTC strings.
  **Delivery dates** are `YYYY-MM-DD` (Indian calendar day). **Phones** are `91XXXXXXXXXX`.
- **Auth:** `Authorization: Bearer <sessionToken>` on every `/admin/*` call except login.
- **Tenant** comes only from the session. No endpoint accepts a tenant id. Another tenant's ids return 404.
- **Paging** (where marked): `?page=1&pageSize=25` (pageSize max 100). Response: `{ items, page, pageSize, total }`.
- **Errors:** status code plus `{ "error": { "code": "...", "message": "...", "details"?: ... } }`.

| HTTP | `code` | When |
|---|---|---|
| 400 | `validation_error` | Bad body or query (`details` = list of `{ path, message }`) |
| 401 | `unauthorized` | Missing, unknown or expired session |
| 401 | `invalid_credentials` | Login or current-password check failed (never says which part was wrong) |
| 404 | `not_found` | No such record **for this tenant** (or partner link invalid) |
| 409 | `invalid_transition` | Status change not allowed from the current status (or changed concurrently) |
| 409 | `partner_unavailable` | Assigning to an inactive or unknown partner |
| 409 | `refund_not_possible` | No paid payment to refund |
| 409 | `conflict` | Unique value already used (product SKU, pincode, username) |
| 409 | `too_many_active_products` | Activating a 9th product (the WhatsApp order form has 8 slots) |
| 409 | `outside_reply_window` | Chat reply more than 24 h after the customer's last message |
| 422 | `not_supported` | e.g. refunding a subscription order |
| 502 | `provider_error` | Cashfree or WhatsApp call failed (nothing was changed in the DB) |
| 500 | `internal` | Unexpected; logged server-side |

---

## 2. Shared shapes

```ts
type OrderStatus = 'payment_pending' | 'confirmed' | 'assigned' | 'out_for_delivery'
                 | 'delivered' | 'cancelled' | 'payment_failed' | 'expired';
type PaymentStatus = 'created' | 'paid' | 'failed' | 'expired' | 'refunded';

interface OrderView {
  id: string;                 // uuid, use for actions
  orderCode: string;          // "NF-7K3QX9", show to humans
  status: OrderStatus;
  source: 'one_time' | 'subscription';
  deliveryDate: string;       // YYYY-MM-DD
  pincode: string;
  address: { name: string; line1: string; landmark?: string; pincode: string; phone?: string };
  location: { lat: number; lng: number } | null;
  mapUrl: string | null;      // https://maps.google.com/?q=<lat>,<lng>
  subtotalPaise: number; deliveryFeePaise: number; totalPaise: number;
  customer: { id: string; profileName: string | null; phone: string | null };
  partner: { id: string; name: string; phone: string } | null;
  paymentStatus: PaymentStatus | null;   // the order's payment-link payment
  items: { productId: string; name: string; unitPricePaise: number; quantity: number; lineTotalPaise: number }[];
  createdAt: string; updatedAt: string; paidAt: string | null; deliveredAt: string | null;
}
```
`customer.phone` is the WhatsApp number. For customers who chat without a visible number, it is the
mobile number they typed in the order form, with `91` added.

---

## 3. Auth

| Method & path | Body | Response |
|---|---|---|
| `POST /admin/auth/login` | `{ username, password }` | `200 { token, expiresAt, user }` · 401 `invalid_credentials` |
| `POST /admin/auth/logout` | none | `204` (ends this session) |
| `GET /admin/me` | none | `200 { user }` |
| `POST /admin/auth/change-password` | `{ currentPassword, newPassword }` (new: 10–128 chars) | `200 { token, expiresAt, user }`. Signs out every session of this user, then returns a fresh one for the current device. 401 `invalid_credentials` if the current password is wrong |

`user = { username, tenantId, tenantName }`. Sessions last **30 days** from login (no sliding renewal).
Usernames are unique across all tenants (login doesn't name the tenant) and are case-insensitive.
Inactive vendors can't log in, and deactivating one ends their sessions.

Vendor logins are created by the C2V operator, not via the API:
```
ENV=prod pnpm vendors create <tenantId> <username>     # prints a generated password once
ENV=prod pnpm vendors reset-password <username>        # new password, all sessions ended
ENV=prod pnpm vendors deactivate <username>            # can't log in, all sessions ended
ENV=prod pnpm vendors activate <username>
```

---

## 4. Orders

| Method & path | Notes | Response |
|---|---|---|
| `GET /admin/orders/active` | All `confirmed`, `assigned`, `out_for_delivery` orders. **Not paged** (a small working set). Sorted by delivery date, then oldest first | `200 { items: OrderView[] }` |
| `GET /admin/orders` | Paged history. Filters (all optional): `status` (comma list), `deliveryFrom`, `deliveryTo` (YYYY-MM-DD, inclusive), `pincode`, `partnerId`, `q` (order code or customer phone, partial match). Sorted newest first | `200 { items: OrderView[], page, pageSize, total }` |
| `GET /admin/orders/:id` | | `200 { order: OrderView }` |
| `GET /admin/refunds/needed` | Paid orders that were cancelled, plus payments that arrived after the link expired. Not paged | `200 { items: (OrderView & { refundReason: 'cancelled_after_payment' \| 'paid_after_expiry' })[] }` |

### Actions

All return the updated order. Only transitions valid for the current status succeed. Otherwise the API returns
409 `invalid_transition`.

| Method & path | Body | Allowed from | Response |
|---|---|---|---|
| `POST /admin/orders/:id/assign` | `{ partnerId }` | `confirmed`, `assigned` (reassign) | `200 { order }` |
| `POST /admin/orders/:id/out-for-delivery` | none | `assigned` | `200 { order }` |
| `POST /admin/orders/:id/delivered` | none | `out_for_delivery` | `200 { order, notified }`. `notified: false` = delivered, but the customer's WhatsApp message failed: show a warning |
| `POST /admin/orders/:id/cancel` | none | `confirmed`, `assigned`, `out_for_delivery` | `200 { order }`. **No money moves.** If `order.paymentStatus === 'paid'`, offer "Refund now?" |
| `POST /admin/orders/:id/refund` | none | any order whose payment is `paid` | `200 { result: 'refunded' \| 'already_refunded', order }`. Full amount via Cashfree; also cancels the order if not yet delivered. Safe to retry. 502 `provider_error` if Cashfree fails (nothing changed) |
| `POST /admin/orders/bulk-assign` | `{ orderIds: string[] (1–100), partnerId }` | as assign | `200 { results: { orderId, ok: true, order } \| { orderId, ok: false, error: { code, message } }[] }`. Each order is handled separately; one failure doesn't stop the rest |

---

## 5. Customers

| Method & path | Notes | Response |
|---|---|---|
| `GET /admin/customers` | Paged. `q` matches name, phone or saved-address name (partial). Sorted newest first | `{ items: CustomerView[], page, pageSize, total }` |
| `GET /admin/customers/:id` | Includes the 20 most recent orders | `{ customer: CustomerView, orders: OrderView[] }` |

`CustomerView = { id, profileName, phone, email, defaultAddress, defaultLocation, createdAt }`. `phone` follows
the rule in §2, using the saved address's phone when the customer has no WhatsApp number.

---

## 6. Catalogue and settings

**Products.** There is no delete, because old orders refer to products: set `active: false` instead.
At most **8 active** products. A 9th returns 409 `too_many_active_products`.

| Method & path | Body | Response |
|---|---|---|
| `GET /admin/products` | | `{ items: Product[] }` (sorted by sortOrder) |
| `POST /admin/products` | `{ sku, name, pricePaise, sortOrder?, active? }` | `201 { product }` |
| `PATCH /admin/products/:id` | any of `{ sku, name, pricePaise, sortOrder, active }` | `200 { product }` |

`Product = { id, sku, name, pricePaise, active, sortOrder, createdAt }`. `pricePaise` is a positive integer,
and `name` is 1–60 characters.

**Pincodes** (delivery areas). `deliveryWeekday`: 0 = Sunday … 6 = Saturday.

| Method & path | Body | Response |
|---|---|---|
| `GET /admin/pincodes` | | `{ items: Pincode[] }` (sorted by pincode) |
| `POST /admin/pincodes` | `{ pincode (6 digits), deliveryWeekday, note?, active? }` | `201 { pincode }` |
| `PATCH /admin/pincodes/:id` | any of `{ deliveryWeekday, note, active }` (the pincode itself can't change; add a new one) | `200 { pincode }` |

**Settings**

| Method & path | Body | Response |
|---|---|---|
| `GET /admin/settings` | | `{ settings }` |
| `PATCH /admin/settings` | any of `{ supportPhone, welcomeImageUrl, deliveryFeePaise, minOrderPaise }` | `200 { settings }` |

`settings = { supportPhone: string|null, welcomeImageUrl: string|null (https), deliveryFeePaise, minOrderPaise }`.

Changes to products, pincodes and settings apply to the next order form a customer opens.

---

## 7. Delivery partners

| Method & path | Body | Response |
|---|---|---|
| `GET /admin/partners` | | `{ items: Partner[] }` |
| `POST /admin/partners` | `{ name, phone }` (10 digits, or 12 starting with 91) | `201 { partner }` (a link token is generated) |
| `PATCH /admin/partners/:id` | any of `{ name, phone, active }` | `200 { partner }` |
| `POST /admin/partners/:id/reset-link` | none | `200 { partner }` (new token; the old link stops working immediately) |

`Partner = { id, name, phone, active, accessToken: string | null, accessTokenCreatedAt, openOrderCount, createdAt }`.
The dashboard builds the link as `<dashboard-origin>/p/<accessToken>`. Partners created before this API have no
token until "reset link" is used. Deactivating a partner disables their link. Their open orders stay assigned
(`openOrderCount` shows how many), so the vendor should reassign them.

---

## 8. Partner link (no login)

The token in the URL is the only credential. Invalid token or inactive partner → 404 `not_found`.

| Method & path | Response |
|---|---|
| `GET /partner/:token/orders` | `200 { partner: { name }, items: PartnerOrderView[] }`: this partner's `assigned` and `out_for_delivery` orders, sorted by delivery date |
| `POST /partner/:token/orders/:orderId/out-for-delivery` | `200 { order: PartnerOrderView }` |
| `POST /partner/:token/orders/:orderId/delivered` | `200 { order: PartnerOrderView, notified }` |

`PartnerOrderView = { id, orderCode, status, deliveryDate, address, mapUrl, customerName, customerPhone, items: { name, quantity }[] }`.
It has **no prices or payment info**. Actions on an order no longer assigned to this partner return 404.
The server sends `Referrer-Policy: no-referrer` and `Cache-Control: no-store` on these responses, and never
logs the token.

---

## 9. Chats

Messages are kept for 3 days, so these lists are small and not paged.

| Method & path | Response |
|---|---|
| `GET /admin/chats` | `{ items: { customer: { id, profileName, phone }, lastMessage: { direction, text, createdAt }, lastInboundAt: string \| null, canReply: boolean }[] }`, sorted by the latest message first |
| `GET /admin/chats/:customerId/messages` | `{ customer, canReply, items: { id, direction: 'in' \| 'out', type, text, createdAt }[] }`, oldest first |
| `POST /admin/chats/:customerId/reply` | body `{ text }` (1–4096 chars) → `201 { message }`. 409 `outside_reply_window` when the customer's last message is older than 24 h (WhatsApp rule). 502 `provider_error` if the send fails |

`canReply` = the customer messaged within the last 24 hours.

---

## 10. Not in this version

Rate limiting, audit trail (who changed what), staff logins (the table supports several per tenant, but the
CLI and dashboard assume one), customer messages on cancel or refund, the out-for-delivery customer message,
subscriptions UI, live push (polling is fine).
