# Figcel Outreach

Cold-email ledger and, later, a multi-inbox client for 15 Google Workspace mailboxes. Step 1 is the data model, the safety gates, and a bootable app. Nothing sends.

```
UI ──┐
     ├── Next.js route handlers ── Postgres (unique constraints, source of truth)
API ─┘            │
                  ├── Redis (queue and live events in later steps; health check only now)
                  └── Mail adapter
                        ├── mock (this build, and every test)
                        └── Gmail API via one service account + domain-wide delegation (step 2)
```

Postgres is what makes “no duplicates” and “no double send” true. Redis is not. A send is reserved by inserting a row. The unique key `(contact, campaign, step)` rejects a second insert, so a retry or a crash cannot send that step again.

## Run locally

Docker is the intended way to get Postgres and Redis:

```bash
cp .env.example .env
docker compose up -d
npm install
npm run migrate
npm run dev
```

The app listens on [http://127.0.0.1:43123](http://127.0.0.1:43123). `npm run migrate` applies `db/migrations` and seeds the 15 inboxes plus the singleton settings row. Starting the dev server does the same thing again; both are safe to repeat.

```bash
npm test
npm run typecheck
```

Tests that touch the database use `DATABASE_URL_TEST` and a mocked mail adapter. They do not send email.

## Environment

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | App database. Compose default: `postgres://outreach:outreach@127.0.0.1:54329/outreach` |
| `DATABASE_URL_TEST` | Test database. Compose init creates `outreach_test` on the same server. |
| `REDIS_URL` | `redis://127.0.0.1:63799` |
| `SENDING_ENABLED` | Kill switch. Only the exact value `true` can pass the gate. Default `false`. |
| `SEND_MODE` | `dry-run` (default), `seed-only`, or `live`. This build has no live sender. |
| `GMAIL_SA_KEY_PATH` | Path to the service-account JSON. Never commit the file. Empty until inbox connect. |

The compose password is a local default, not a production secret. Legal name, postal address, verification vendor, unsubscribe URL, and hosting are `TODO` until they are supplied. Sending stays blocked while the legal name or postal address is still TODO.

## Caps and window

Hard limits in code and in the database: **27 per inbox per day** and **405 per day**. Config may lower them. A value above either limit is rejected. Ramp per inbox is 9 (sending days 1–3), 18 (days 4–7), then 27, held at the previous level if the previous sending day had a stop. New prospects stay at 9 per inbox per day.

Sends are allowed only on US weekdays, 09:00–17:00 Eastern, and inside 18:30–06:30 IST. Both have to hold. Holidays are skipped only when listed.

Approval defaults to **review** (off): later, that means drafts in the review queue. `SENDING_ENABLED` is an environment variable on purpose, so a database edit cannot turn sending on.

## Identity

`normalize_email` lowercases and trims. Dots and `+tags` are removed only for `gmail.com` and `googlemail.com` (`googlemail.com` becomes `gmail.com`). Other domains, including the five Workspace sending domains, keep dots and `+tags`. The same function lives in Postgres and in `src/lib/email/normalize.ts`. A contact row must store the normalized form; the check constraint rejects anything else. `contacts.normalized_email` is unique.

Open and click tracking columns exist on campaigns and default to **off**. Inbox placement can be stored only as a seed test (`measurement = 'seed_test_only'`).

## Auth model (not connected yet)

One Google Cloud service account (`figcel-sender` / `coldsend`) with domain-wide delegation, scopes `gmail.send`, `gmail.readonly`, and `gmail.modify`, already authorized on the five tenants. The key file comes from `GMAIL_SA_KEY_PATH`. The adapter interface also allows a later swap to OAuth or IMAP+SMTP. This step’s Gmail adapter refuses to construct, and the mock used by tests refuses to send.
