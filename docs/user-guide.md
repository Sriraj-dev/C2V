# C2V WhatsApp Ordering — User Guide

This guide explains what C2V does and how each kind of user works with it. It describes behaviour,
not internals. (Setup and deployment are in `docs/runbook.md`.)

C2V is one service that runs WhatsApp ordering for several businesses ("clients"). Each client has
its own WhatsApp number, products, delivery areas, Cashfree account and orders. The first client is
**NutriFarm Eggs**.

---

## 1. Who uses it

| Role | Uses | Responsible for |
|---|---|---|
| **Customer** | WhatsApp, chatting with the client's business number | Placing orders, paying, subscribing and skipping deliveries, sharing a delivery location |
| **Vendor** (the client, e.g. NutriFarm) | The web dashboard (login from the C2V operator); order commands as a fallback | Products, prices, delivery areas, assigning deliveries, marking delivered, cancellations and refunds |
| **Delivery partner** | A private link (no login) | Delivering the orders assigned to them, marking them out for delivery and delivered |
| **C2V operator** (you) | Server, Meta, Cashfree, database | Onboarding clients, running the service, keeping it healthy |

---

## 2. Customer experience (WhatsApp)

1. **Say anything** (e.g. "Hi") → the bot replies with a welcome and a menu:
   - **Order Eggs**: pick packs and get them delivered
   - **My Orders**: recent orders and their status
   - **Subscribe**: regular deliveries paid by UPI AutoPay (section 2a). Until the client's Subscribe form
     is published, it replies "coming soon".
   - **Help**: a button to call the business
2. **Order Eggs** opens an order form inside WhatsApp:
   - Screen 1: choose quantities for each pack (prices shown).
   - Screen 2: name, address, landmark, pincode. Customers who chat without a visible phone number also
     enter a 10-digit mobile number. The address is remembered for next time.
3. After submitting, the customer gets an **order summary** (items, total, expected delivery date) with a
   **Pay ₹X** button. The payment link works for **30 minutes** (UPI, cards, netbanking via Cashfree).
   - Problems are explained right away: no items picked, invalid pincode, area not served yet, below the
     minimum order (NutriFarm: ₹90).
4. **After paying**: "Payment received… your order *NF-XXXXXX* is confirmed and will arrive on <date>."
   If the customer has never shared a location, the bot asks for one (optional) to help the delivery partner.
5. **If the link expires unpaid**: the customer is told the link expired and to order again from the menu.
6. **My Orders** shows the last 5 orders with status (*Payment pending, Confirmed, Assigned, Out for
   delivery, Delivered, Cancelled*) and any active subscriptions (amount, how often, next delivery). A
   pending one-time order includes a note: if already paid, it can take a few minutes; otherwise tap Help.
   An upcoming subscription order shows *Upcoming · payment tomorrow* (or *today* on the collection day).
7. **When delivered**, the customer receives a WhatsApp message: "Your order NF-XXXXXX has been delivered…".

**Delivery date rule:** each pincode has one delivery weekday. The delivery date is the next such weekday
after today (ordering on the delivery day itself means next week). Indian time.

## 2a. Subscriptions (UPI AutoPay)

1. **Subscribe** opens a form inside WhatsApp with three screens: pick packs, choose how often (*every
   week*, *every 2 weeks* or *every 4 weeks*), then name, address, pincode and email (Cashfree sends the
   AutoPay receipts there). The same minimum order and delivery areas apply as for one-time orders.
2. The customer gets a summary (packs, price per delivery, how often, expected first delivery) with a
   **Set up AutoPay** button. It opens a secure page where they approve a UPI AutoPay mandate in their UPI
   app. A ₹1 check is taken and refunded. The mandate allows up to twice the per-delivery price, so a
   modest price rise still goes through; nothing is taken until a delivery is due.
3. Once approved: "Your subscription is active! Deliveries every <weekday>, starting <date>." The first
   delivery is the pincode's weekday at least two days away (a week later if approved after 8 pm two days
   before). If approval fails or the link expires, the customer is told and can subscribe again.
4. **Two days before each delivery** the customer gets a message: "₹X will be collected tomorrow for your
   delivery on <date>", with a **Skip this delivery** button. The order appears for the vendor as payment
   pending. Prices are the current ones on that day; a product the vendor has hidden is left out (if all
   are hidden, that delivery is skipped).
5. **Skip this delivery:** if the money hasn't been taken yet, the charge is cancelled: "Done. We won't
   charge or deliver on <date>. Your next delivery is on <date>." If it was already taken, the delivery
   goes ahead and the customer is told to contact the business (support phone, or Help) to cancel it.
   If the bank is still processing, the customer is told the same. Not tapping means the delivery goes ahead.
6. **The day before delivery** AutoPay collects the money and the order is confirmed (no message; it then
   appears with the vendor's active orders). If collection fails, that delivery is skipped, the customer gets
   "We couldn't collect payment for your egg delivery on <date>… Your subscription stays active", and the
   order shows *payment failed*.
7. **Stopping:** the customer can pause or cancel the mandate from their UPI app (paused = deliveries are
   skipped until resumed; cancelled = the subscription ends and the customer is told). Otherwise they ask
   the business, and the vendor cancels it (section 3.4).

---

## 3. Vendor operations

### 3.1 Order lifecycle

```
payment_pending ──paid──▶ confirmed ──▶ assigned ──▶ out_for_delivery ──▶ delivered
       │                      │             │                │
   link expires            cancel        cancel           cancel
       ▼                      ▼             ▼                ▼
    expired               cancelled     cancelled        cancelled
```

- Only **confirmed and later** orders are real orders to fulfil. Payment-pending and expired orders are
  customers who didn't pay.
- An order can only move one step at a time. For example, you can't mark an unpaid order delivered.
- **Assign** needs an active delivery partner. You can reassign while the order is *assigned*.
- **Delivered** sends the customer the delivered message.
- **Cancel** only changes the status. **It does not return money.**
- **Refund** returns the full amount to the customer through Cashfree. If the order wasn't delivered yet,
  refunding also cancels it. A refund can be safely retried; it never refunds twice.
- **Needs refund:** paid orders that were cancelled, or payments that arrived after the link had expired.
  These need a refund decision (shown as a list in the dashboard).

### 3.2 Vendor login and partner links

- **Login:** the C2V operator creates one username and password per client and hands them over. The password
  is shown once and stored only as a hash. The vendor can change it from the dashboard (current password +
  a new one of 10-128 characters); that signs out every other device. Sessions last 30 days.
- **Lost password / ended access:** the operator runs
  `ENV=prod pnpm vendors reset-password <username>` (new password, all sessions ended),
  `... deactivate <username>` (can't log in, sessions ended) or `... activate <username>`.
  A new login is made with `ENV=prod pnpm vendors create <tenantId> <username>`.
- **Delivery partner link:** adding a partner (name + phone) generates a private link. The vendor shares it
  with the partner. Opening it shows only that partner's assigned orders (no prices) with buttons
  *Out for delivery* and *Delivered*. **Reset link** issues a new link and the old one stops working at
  once; **deactivating** a partner also disables the link. Deactivating does not unassign their open
  orders: reassign them.
  Partners created before this feature need one "reset link" to get a link.

### 3.3 Order commands (fallback)

Run by the C2V operator on the vendor's behalf:

```
ENV=prod pnpm orders <client> <orderCode> assign <partnerPhone>
ENV=prod pnpm orders <client> <orderCode> out-for-delivery
ENV=prod pnpm orders <client> <orderCode> delivered
ENV=prod pnpm orders <client> <orderCode> cancel
ENV=prod pnpm orders <client> <orderCode> refund
```
Example: `ENV=prod pnpm orders nutrifarm NF-7K3QX9 assign 9398651343`.

### 3.4 Subscriptions

- The dashboard lists subscriptions (filter by status: *pending authorisation, active, cancelled,
  authorisation failed*) and shows each one's packs at today's prices and every charge with its order.
- Subscription orders appear in the normal orders list. They are *payment pending* from two days before
  delivery and become *confirmed* when AutoPay collects the day before; only then do they show among
  active orders to assign. A skipped delivery shows as *cancelled*, a failed collection as *payment failed*.
- **Cancel subscription** stops AutoPay at Cashfree and cancels any upcoming order not yet paid. Paid
  orders stay and must still be delivered (or refunded). The customer gets a WhatsApp message.
  Fallback command: `ENV=prod pnpm orders <client> sub <subscriptionId> cancel`.
- **Refunds for subscription orders** are not in the dashboard yet. If a customer skipped too late and
  wants their money back, refund from the Cashfree dashboard for now.

### 3.5 Catalogue and settings

Vendors manage these in the dashboard (the operator can still change them in the database):
- **Products:** name, price, active/hidden, display order (up to 8 shown in the order form).
- **Delivery areas:** pincode, delivery weekday, active.
- **Delivery partners:** name, phone, active.
- **Settings:** support phone (Help button), delivery fee, minimum order, welcome image.

Price and product changes apply to the next order form a customer opens; the WhatsApp form itself does
not need re-publishing.

---

## 4. Service endpoints

The service has a few public addresses, all shared by every client. Nobody opens them in a browser;
Meta and Cashfree call them automatically.

| Endpoint | Called by | Purpose |
|---|---|---|
| `GET /health` | Monitoring / Cloud Run | Returns `{"ok":true}` when the service is up |
| `GET /webhooks/whatsapp` | Meta (once, during setup) | Webhook verification handshake using the verify token |
| `POST /webhooks/whatsapp` | Meta | Delivers customer messages, button taps, order-form submissions and locations. The service works out which client from the WhatsApp number that received the message |
| `POST /webhooks/cashfree` | Cashfree | Payment updates (paid, expired) and subscription updates (AutoPay approved or cancelled, charge collected, failed or cancelled). The service works out which client from the payment or subscription, and checks Cashfree's signature with that client's key |
| `GET /subscribe/<token>` | The customer's browser (from **Set up AutoPay**) | Opens Cashfree's AutoPay approval for that subscription; the link stops working once approved |
| `POST /jobs/subscription-charges` | Google Cloud Scheduler, daily 09:00 IST | Raises the charges for deliveries two days ahead and sends the upcoming messages; needs the jobs secret |

Unsigned or invalid requests are rejected. Duplicate deliveries from Meta or Cashfree are handled safely.

---

## 5. What's stored and for how long

- Customers (WhatsApp name, number or WhatsApp user ID, saved address, optional location), orders, order
  items, payments, delivery partners, products, delivery areas.
- **Chat messages are kept for 3 days**, then deleted automatically every night.
- Each client's data is kept separate and is only visible to that client.

---

## 6. Not available yet

Subscription refunds from the dashboard, pausing or changing a subscription from WhatsApp (customers pause
from their UPI app or ask the business), a message when a collected subscription order is confirmed,
several staff logins per client, cash on delivery, the out-for-delivery
message to customers, a message to customers when a refund is issued, and automatic refunds for late
payments.
