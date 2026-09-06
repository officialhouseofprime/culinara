# CULINARA

A platform for independent private chefs to post their work and get booked directly by clients. This repo has two parts:

1. **The site** (`index.html`, `account.html`, `css/`, `js/`) — the public one-pager plus the login/profile page.
2. **The backend** (`server/`) — accounts, email verification, a real database, file uploads, and the founder-only dashboard.

The backend serves the site itself, so in normal use you only run one thing.

```
culinara/
├── index.html          → public one-pager (hero, about, menu, chef showcase, join form)
├── account.html         → login, password reset, and chef/client profile pages
├── css/
│   ├── style.css        → main design system
│   └── account.css      → account/profile page styles
├── js/
│   ├── main.js           → nav, tabs, homepage forms → POST to the backend
│   └── account.js        → login, password reset, profile editing, portfolio uploads
└── server/
    ├── src/
    │   ├── server.js      → Express app — serves the API, the site, and /dashboard
    │   ├── db.js           → SQLite schema (chefs, clients, chef_media)
    │   ├── mailer.js        → sends verification/approval/reset emails (or prints them in dev mode)
    │   ├── middleware/auth.js → JWT sign/verify, role checks
    │   └── routes/          → auth.js, chefs.js, clients.js, admin.js
    ├── public/               → the founder dashboard (dashboard.html/css/js), served at /dashboard
    ├── scripts/hash-password.js → generates your admin password hash
    ├── uploads/               → CVs, cover letters, and chef portfolio photos/videos (gitignored)
    ├── data/                   → the SQLite database file, created on first run (gitignored)
    ├── .env.example
    └── package.json
```

## Running it

You need [Node.js **22.5 or newer**](https://nodejs.org) — the database uses Node's built-in SQLite support, which only exists from that version on. Check yours with `node --version`.

```bash
cd server
npm install
cp .env.example .env
```

Open `.env` and fill in:

- **`JWT_SECRET`** — any long random string. Generate one with:
  ```bash
  node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
  ```
- **`ADMIN_EMAIL`** — the email you'll use to log into the founder dashboard. Set this to `culinarateam@gmail.com`.
- **`ADMIN_PASSWORD_HASH`** — generate this, don't type a plain password:
  ```bash
  npm run hash-admin-password -- "YourRealPassword"
  ```
  Paste the output into `.env`.

Leave `SMTP_HOST` blank for now — see **Email** below.

Then:

```bash
npm start
```

You'll see:

```
CULINARA server running at http://localhost:4000
  Site:      http://localhost:4000/
  Dashboard: http://localhost:4000/dashboard
```

Open `http://localhost:4000` for the site, and `http://localhost:4000/dashboard` to log in as the founder.

## How accounts & verification work

- Chefs apply through the **"I'm a Chef"** tab on the homepage: name, email, phone, chef type, CV, cover letter, why they want to join, and a password. Clients sign up through **"I'm a Client"**: name, email, phone, what they're looking for, and a password.
- On signup, CULINARA sends a verification email with a link. Until that link is clicked, the account can't log in — this confirms the email address is real and belongs to them.
- Passwords are never stored in plain text — they're hashed with bcrypt before touching the database.
- Chef applications start as **pending**. They're invisible on the public chef directory until you approve them from the dashboard. Clients don't need approval — they can log in as soon as they verify their email.
- Once approved, chefs can log in at `account.html`, edit their contact details, and post photos/videos to their portfolio (visible on their public profile).
- Forgot password is supported for both chefs and clients — a reset link is emailed and expires after 1 hour.

## Email

Real email needs an SMTP provider. Until you set one up, the server runs in **dev mode**: instead of sending anything, it prints each email (recipient, subject, and the verification/reset link) straight to your terminal — so you can test the whole flow with zero setup.

To send real email, fill in the SMTP block in `.env`:

```
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=your@gmail.com
SMTP_PASS=your-app-password
FROM_EMAIL="CULINARA <hello@culinara.com>"
```

- **Gmail**: use an [App Password](https://myaccount.google.com/apppasswords), not your normal Gmail password (Google blocks normal passwords for this).
- Any other provider works too — SendGrid, Mailgun, Postmark, Amazon SES, or your own mail server. They'll each give you an SMTP host, port, username, and password.

## The database

Every signup, application, and portfolio post lands in a real SQLite database at `server/data/culinara.db` — created automatically the first time you run the server. Three tables:

- **`chefs`** — application details, status (pending/approved/rejected), CV & cover letter file paths, password hash, verification state.
- **`clients`** — contact details, password hash, verification state.
- **`chef_media`** — photos/videos each chef has posted to their portfolio.

You can open this file directly with a free tool like [DB Browser for SQLite](https://sqlitebrowser.org/) to look at your data any time — no separate database server to install or pay for. If you outgrow it later (e.g. you need multiple servers sharing one database), `db.js` is the only file you'd need to rewrite to point at Postgres/MySQL instead — every route talks to the database only through that file.

## The founder dashboard

`http://localhost:4000/dashboard` is a separate, founder-only login — completely disconnected from chef/client accounts (there's no dashboard row in the database at all; it's just the `ADMIN_EMAIL`/`ADMIN_PASSWORD_HASH` pair in your `.env`). From there you can:

- See stats at a glance: pending applications, approved chefs, clients signed up, portfolio posts.
- Review every chef application — read their "why I want to join" answer, **download their actual CV and cover letter**, and see any portfolio photos/videos they've posted.
- **Approve** or **reject** a chef (this sends them an email either way) or delete an application entirely.
- View and remove client accounts.

CVs and cover letters are never public — they're only reachable through this authenticated dashboard, never as a plain link anyone could guess.

## Before you deploy

- **Hosting**: this is a real Node server with a database file and uploaded files on disk — it needs a host that keeps a process running and gives you persistent storage (e.g. Render, Railway, Fly.io, or a VPS). Static hosts like Netlify/Vercel's free tier won't work for this on their own, since they don't keep a server or disk around between requests.
- **HTTPS**: put the server behind HTTPS in production (most of the hosts above do this for you automatically) — passwords and CVs should never travel over plain HTTP.
- **`.env`**: never commit it. `server/.gitignore` already excludes it, along with the database file and uploaded documents.
- **Real chef photos**: the "Meet the Chefs" showcase on the homepage still shows illustrated placeholders. Once you have real approved chefs, you can wire that section up to `GET /api/chefs` and `GET /api/chefs/:id/media` (already built and working) instead of the static sample cards.
- **Privacy Policy & Terms**: the modal on the homepage has placeholder legal text, clearly flagged as such — replace it with something a lawyer has reviewed, especially since you're collecting résumés and personal documents.
- **Rate limiting**: consider adding a package like `express-rate-limit` on the login and signup routes before going live, to slow down brute-force attempts.

## Design notes

Palette: warm charcoal/espresso background with brass-gold and herb-green accents, and a cream "ticket paper" tone for chef cards and callouts. Typefaces: **Fraunces** (headlines), **Work Sans** (body), **Space Mono** (labels). The signature visual is chef profiles styled as order tickets clipped to a steel kitchen "pass" — a nod to the kitchen pass where a head chef checks every plate before it goes out, echoing CULINARA's review process for chef applications.
