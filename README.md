# Sai Krishna Author Store — modular frontend

This package splits the existing working `cart.js` into smaller classic JavaScript files while preserving the existing HTML and Tailwind design.

## Files
- `index.html` — original page markup/design; script include updated only.
- `catalog.json` — original book catalogue.
- `js/config.js` — shared state and sample chapter content.
- `js/catalog.js` — catalog loading, escaping, and book rendering.
- `js/preview.js` — book preview modal.
- `js/cart.js` — cart persistence, UI, and quantity controls.
- `js/checkout.js` — Razorpay order creation and payment verification flow.
- `js/order-status.js` — pending/success order status and copy controls.
- `js/app.js` — startup initialization.

## Important
1. Copy these files into a backup/staging branch first; do not overwrite the live site until tested.
2. Keep `images/` from the existing project beside `index.html`.
3. Keep the backend URL in `js/config.js` pointed at the existing Render backend.
4. This split does not change backend routes or prices; backend remains authoritative for payment amounts.
5. Do not put `.env`, Razorpay secrets, or MongoDB credentials in this frontend package.
6. Test on a staging deployment: catalog, preview, add/remove/quantity, paperback shipping fields, e-book checkout, payment verification, confirmation modal, and mobile layout. Do not run a real payment just to test.
