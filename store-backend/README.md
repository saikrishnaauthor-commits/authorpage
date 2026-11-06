# Store API — data in Google Sheets

This is the author store's server (checkout, Razorpay payments, e-book access,
order tracking, admin). It replaces the old MongoDB version: **every piece of
store data is kept in one Google Sheet in your Drive**, in the same file as
your reader reviews.

| Tab | One row per | Used for |
|---|---|---|
| **Orders** | order (including unpaid checkouts, status `created`) | checkout, payment, tracking, e-book access |
| **Sales** | book sold in a paid/completed order | your sales report — sum `lineTotal`, filter by `book`, `format`, `date` |
| **Books** | book in the catalogue | the Books page, prices, e-book files |
| **Prices** | paperback / e-book SKU | MRP and selling price |
| Reviews | review | managed by the Apps Script — the server never touches it |

To get an Excel file at any time: open the Sheet → **File → Download →
Microsoft Excel (.xlsx)**.

## Editing the Sheet by hand

- Changes you make (a title, a price, a tracking number) reach the website
  within about a minute.
- You can sort, filter, reorder columns, and add your own extra columns.
  The server finds rows by their ID column (`orderNumber`, `id`, `bookId`,
  `saleId`) and columns by their header name.
- **Don't** rename or delete the header row, and don't change the ID columns.
- Prefer the admin page for order status changes: it enforces the
  one-step-at-a-time rule and the tracking-number requirement.
- Dates are written in Indian time as `YYYY-MM-DD HH:MM:SS`.

## One-time setup

1. **Find the Sheet ID.** Open the reviews Google Sheet. Its URL looks like
   `https://docs.google.com/spreadsheets/d/<SHEET_ID>/edit` — copy `<SHEET_ID>`.
2. **Share the Sheet with the service account.** The server already uses a
   Google service account to read the private e-book files. Its email is the
   `client_email` value inside `GOOGLE_SERVICE_ACCOUNT_JSON` on Render
   (it ends in `.iam.gserviceaccount.com`). In the Sheet click **Share**, paste
   that email, choose **Editor**, untick "Notify people", and share.
3. **Enable the Google Sheets API** for that service account's Google Cloud
   project: <https://console.cloud.google.com/apis/library/sheets.googleapis.com>
   → pick the project → **Enable**.
4. **Copy your existing MongoDB data into the Sheet** (on your computer):
   ```
   cd store-backend
   npm install
   copy .env.example .env      # then fill in MONGO_URI, GOOGLE_SHEETS_ID, GOOGLE_SERVICE_ACCOUNT_JSON
   npm run migrate -- --dry-run
   npm run migrate
   ```
   The dry run prints how many orders, books and prices it found and your total
   paid revenue — check those numbers before running it for real.
5. **Point Render at the new server.** In the Render dashboard → your service
   (`authorpage`) → **Settings**:
   - Root Directory: `store-backend`
   - Build Command: `npm install`
   - Start Command: `npm start`

   Then **Environment** → add `GOOGLE_SHEETS_ID`. Keep the existing
   `GOOGLE_SERVICE_ACCOUNT_JSON`, `RAZORPAY_*`, `ADMIN_TOKEN`,
   `SESSION_SECRET`, `SMTP_*`, `MAIL_FROM` and `GOOGLE_DRIVE_IMAGES_FOLDER_ID`.
6. **Deploy** right after the migration, so no orders are placed in between.
   The site's URLs don't change, so the website and admin page need no edits.
7. Check `https://authorpage-gybu.onrender.com/api/health` shows
   `"status":"ok"`, place a test order, and look for it in the Orders and Sales
   tabs. Once you are happy, remove `MONGO_URI` from Render.

If start-up can't open the Sheet, the Render log says why (usually step 2 or
3 was missed) and the server keeps retrying; the API answers "starting up"
until it succeeds.

## Things to know

- **Run one instance only.** The server keeps the Sheet in memory and writes
  through a single queue. Two copies running at once could overwrite each
  other's changes. (Render runs one instance unless you scale it up.)
- **Speed.** Reads come from memory and are instant. Each write (placing an
  order, saving a price) takes about half a second to reach Google.
- **Limits.** A Google Sheet holds up to 10 million cells — roughly 400,000
  orders at this width — and each cell up to 50,000 characters.
- **E-book verification codes** (the optional email OTP login) are kept in
  memory, not in the Sheet, because they expire in 10 minutes. A server restart
  just means asking for a new code.

## Tests

`npm test` runs the whole API (checkout, payment verification, free orders,
e-book access, admin catalogue/prices/fulfilment, and hand-edits to the Sheet)
against an in-memory fake of the Google Sheets API. No Google account needed.
