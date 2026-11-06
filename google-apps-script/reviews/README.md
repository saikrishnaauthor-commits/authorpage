# Reader reviews on Google Drive

Reviews are stored in a Google Sheet in your Drive. A small Google Apps Script
attached to that Sheet is the "server": the website reads approved reviews from
it and sends new reviews to it. No changes to the Render backend are needed.

## One-time setup (about 10 minutes)

1. **Create the Sheet.** In Google Drive: New → Google Sheets. Name it
   `Author website reviews`.
2. **Add the script.** In the Sheet: Extensions → Apps Script. Delete what is
   in `Code.gs`, paste the whole contents of `Code.gs` from this folder, and
   save (Ctrl+S).
3. **Set the admin key.** In the Apps Script editor: Project Settings (gear
   icon) → Script properties → Add script property:
   - Property: `ADMIN_KEY`
   - Value: the same token you type to log in to `admin.html`
     (your `ADMIN_TOKEN`), so one login covers both.
4. **Create the Reviews tab and grant permissions.** Back in the editor, pick
   the `setup` function in the toolbar and click Run. Google asks you to
   authorise it: choose your account → Advanced → Go to project → Allow.
   A `Reviews` tab appears in the Sheet.
5. **Deploy as a web app.** Deploy → New deployment → gear icon → Web app.
   - Execute as: **Me**
   - Who has access: **Anyone**

   Click Deploy and copy the **Web app URL** (it ends in `/exec`).
6. **Connect the website.** Open `frontend/js/reviews-config.js` and paste the
   URL:
   ```js
   const REVIEWS_API_URL = 'https://script.google.com/macros/s/XXXX/exec';
   ```
   Commit and push so Vercel redeploys.

## Moderating reviews

New reviews arrive with status `pending` and are not shown until you approve
them. Either:

- **In admin.html** → Reader Reviews tab: Approve, Reject/Hide, or Delete; or
- **In the Sheet**: change the `status` cell to `approved` or `rejected`.
  The website shows the change within about a minute.

Readers who enter their order number and checkout email get a
"Verified purchase" badge. The script checks this against the store's
`/api/order-status` endpoint, and stores only the order number — never the
email.

## Updating the script later

After editing `Code.gs`, use Deploy → **Manage deployments** → edit (pencil)
→ Version: **New version** → Deploy. This keeps the same `/exec` URL.
Creating a *new* deployment instead gives a new URL that you would have to
paste into `reviews-config.js` again.

## Limits

- At most 30 new reviews per hour across all visitors (stops floods).
- 20 wrong admin keys locks admin actions for 15 minutes.
- The public list shows the newest 200 approved reviews.
