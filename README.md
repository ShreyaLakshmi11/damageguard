# DamageGuard – marketplace with AI damage-dispute resolution

Node.js + Express + SQLite backend, plain HTML/JS frontend, **Groq vision API** for photo analysis, **SMTP** for real emails.

## Features
- Register / sign in (bcrypt passwords, JWT sessions)
- Products, cart, orders with live stock
- **Dispute resolution**: customer uploads a damage photo -> Groq vision model decides
  - packaging damaged -> **delivery fault** -> exchange label email
  - product damaged, box intact -> **merchant fault** -> refund/replacement email
  - unclear / confidence < 60% -> **manual review** (admin decides, customer is emailed)
- Email sent immediately (SMTP) and always stored in the in-app Mailbox
- **Abuse blocking**: more than `MAX_RETURNS` (default 5) returns -> ordering blocked (enforced on the server); admin can unblock
- Admin page (account whose email = `ADMIN_EMAIL`): review queue with photos, blocked users, dispute log

## Run locally
1. Install Node.js 18+ (https://nodejs.org)
2. In this folder:
   ```bash
   npm install
   cp .env.example .env      # Windows: copy .env.example .env
   ```
3. Edit `.env`:
   - `JWT_SECRET` – any long random string
   - `GROQ_API_KEY` – create at https://console.groq.com/keys
   - `ADMIN_EMAIL` – the email you will register as admin
   - SMTP (optional, for real emails). Gmail: enable 2-step verification, create an App Password
     at https://myaccount.google.com/apppasswords, use it as `SMTP_PASS`.
4. Start: `npm start` and open http://localhost:3000
5. Register with your `ADMIN_EMAIL` to get the Admin page.

## Try the dispute flow
Register -> add a product to cart -> Place order -> Orders -> **Mark as delivered** -> **Report damage / Return** ->
upload a photo -> Analyze. The result card shows the verdict and the email (also in **Mailbox**).

## Deploy (Render, Railway, Fly.io, any VPS)
- Build command `npm install`, start command `npm start`.
- Set the same variables as in `.env` in the host's dashboard (do not commit `.env`).
- SQLite is a file (`data.db`): attach a **persistent disk/volume** to the app folder, or the data resets on every deploy.
- Put it behind HTTPS (Render/Railway do this automatically).
- Docker: `FROM node:20-slim`, `WORKDIR /app`, `COPY . .`, `RUN npm install --omit=dev`, `CMD ["npm","start"]`.

## Notes
- If the Groq call fails or the key is missing, the dispute still saves and goes to manual review (the customer is never blocked by an outage).
- The Groq model is set with `GROQ_MODEL`. It must accept image input; check the current list at https://console.groq.com/docs/vision.
- `SEED_PRODUCTS=false` starts with an empty catalog.
- Payments, shipping-carrier APIs and seller-specific order dashboards are not included in this MVP.
