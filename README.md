# Figcel Outreach

Cold-email ledger and, later, a multi-inbox client for 15 Google Workspace mailboxes. Step 2 adds a read-only Gmail sync. Nothing sends.

```
UI ──┐
     ├── Next.js route handlers ── Postgres (unique constraints, source of truth)
API ─┘            │
                  ├── Redis (queue and live events in later steps; health check only now)
                  └── Mail adapter
                        ├── mock (every test)
                        └── Gmail API via one service account + domain-wide delegation
                              read: profile, messages.list, messages.get, history.list
                              send() throws. Sync never calls modify, labels, trash, or delete.
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
| `GMAIL_SA_KEY_PATH` | Absolute path to the service-account JSON on the machine that has the key. Empty in this repo. Never commit the file. |

The compose password is a local default, not a production secret. Legal name, postal address, verification vendor, unsubscribe URL, and hosting are `TODO` until they are supplied. Sending stays blocked while the legal name or postal address is still TODO.

## Caps and window

Hard limits in code and in the database: **27 per inbox per day** and **405 per day**. Config may lower them. A value above either limit is rejected. Ramp per inbox is 9 (sending days 1–3), 18 (days 4–7), then 27, held at the previous level if the previous sending day had a stop. New prospects stay at 9 per inbox per day.

Sends are allowed only on US weekdays, 09:00–17:00 Eastern, and inside 18:30–06:30 IST. Both have to hold. Holidays are skipped only when listed.

Approval defaults to **review** (off): later, that means drafts in the review queue. `SENDING_ENABLED` is an environment variable on purpose, so a database edit cannot turn sending on.

## Identity

`normalize_email` lowercases and trims. Dots and `+tags` are removed only for `gmail.com` and `googlemail.com` (`googlemail.com` becomes `gmail.com`). Other domains, including the five Workspace sending domains, keep dots and `+tags`. The same function lives in Postgres and in `src/lib/email/normalize.ts`. A contact row must store the normalized form; the check constraint rejects anything else. `contacts.normalized_email` is unique.

Open and click tracking columns exist on campaigns and default to **off**. Inbox placement can be stored only as a seed test (`measurement = 'seed_test_only'`).

## Checking the real inboxes

The service-account key is not on the app server and is not in this repo. Sync and the connect check run on a machine that already has the JSON, against a database you point `DATABASE_URL` at. The web process never starts the scheduler and never reads the key unless you run one of these commands.

```bash
export GMAIL_SA_KEY_PATH=/absolute/path/to/sa.json
export DATABASE_URL=postgres://outreach:outreach@127.0.0.1:54329/outreach
npm install
npm run inbox:check
npm run inbox:sync -- --inbox divyam@usefigcel.com --limit 50
npm run inbox:schedule
```

`inbox:check` calls `users.getProfile` for all 15 inboxes, or one inbox with `--inbox`. A match marks that inbox `active` and does not store a history cursor, so the first sync is a full sync. A failure marks it `disconnected` and writes one open `inbox_disconnect` alert. A later failure updates that alert. A later success acknowledges it.

`inbox:sync` requires `--inbox`. `--limit` defaults to 50 and cannot exceed 50. With no cursor it lists newest messages, fetches each with `format=full`, and stores the history id of the newest one. With a cursor it calls `history.list`. An HTTP 404 means the cursor expired, and that run falls back to a bounded full sync ([Synchronize clients with Gmail](https://developers.google.com/workspace/gmail/api/guides/sync)). Rows are upserted on `(inbox, gmail message id)`. A history deletion sets `messages.removed_at` locally. Gmail itself is not modified.

`inbox:schedule` repeats that sync, one inbox after another, every 300 seconds by default (`--interval` is seconds, minimum 60). Ctrl-C stops it. It is not started by `npm run dev`.

The token requests `gmail.send`, `gmail.readonly`, and `gmail.modify`, matching the domain-wide grant on the five tenants. `messages.send` is not called. `GmailReadOnlyMailbox.send()` throws. The HTTP client rejects send, modify, label, trash, delete, draft, attachment, settings, and watch paths before any network call.

### Quota

Checked 2026-10-19 against the [Gmail API usage limits](https://developers.google.com/workspace/gmail/api/reference/quota) (page updated 2026-10-16 UTC). Projects created on or after 1 May 2026, including figcel-sender, use:

- 1,200,000 quota units per minute per project
- 6,000 quota units per minute per user per project
- `getProfile` 1, `history.list` 2, `messages.list` 5, `messages.get` 20, or 60 when `format` is `full`

`messages.list` allows at most 500 ids per page. The [error guide](https://developers.google.com/workspace/gmail/api/guides/handle-errors) says not to batch more than 50 requests. This sync uses page size 50 and at most 50 `messages.get` calls per inbox per run: 50 × 60 = 3,000 units, under the 6,000 per-user per-minute cap. Inboxes run one at a time so one mailbox is not hit with parallel requests (429 concurrent-request limit).

429, 500, 502, 503, 504, and 403 `rateLimitExceeded` / `userRateLimitExceeded` retry with truncated exponential backoff: `min(2^n seconds + up to 1s of jitter, 32s)`, five attempts, honoring `Retry-After`. 404 and other 403s (`domainPolicy`, `dailyLimitExceeded`) are not retried. A history 404 starts a full sync instead of a retry.
