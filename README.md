# Figcel Outreach

Cold-email ledger for 15 Google Workspace mailboxes. Step 6 is the live dashboard: ledger counts for a date range, pushed over server-sent events when a send, reply, bounce, draft, pause, or alert commits. The kill switch ships off, so this process does not send.

```
UI ──┐
     ├── Next.js route handlers ── Postgres (unique constraints, source of truth)
API ─┘            │
                  ├── Redis (send queue: ready list plus a processing list)
                  └── Mail adapter
                        ├── mock (every test, and the web process)
                        └── Gmail API via one service account + domain-wide delegation
                              sync reads profile, messages.list, messages.get, history.list
                              sync never calls modify, labels, trash, or delete
                              messages.send exists only in the send worker, after every gate
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

## Sending

Approval defaults to **off** (`review`). The planner then writes a draft on `/review` and does not enqueue. Turning it on (`auto`) schedules sends. A campaign `approval_override` of `review` forces the queue. A campaign value of `auto` still waits while the global toggle is `review`. Every change is an `approval.change` row in `audit_log` with its source.

The send worker is separate from the web server:

```bash
npm run send:worker
```

With `SENDING_ENABLED` left false, that command exits before it builds a Gmail client. The web process approves drafts through the mock adapter, so clicking Approve does not send while the kill switch is off.

Redis is the queue (`outreach:send-queue` and a processing list). The worker moves a job to the processing list before it sends, and a restart moves that list back. The send itself is locked by inserting `sends` first. The unique key `(contact, campaign, step)` rejects a second insert, including after a crash.

Gates run again at send time: kill switch, send mode, legal name, postal address, unsubscribe URL, verification, suppression, reply, bounce, unsubscribe, out-of-office, inbox status, pause, caps, and the lead's local 09:00–17:00 intersected with US weekdays 09:00–17:00 Eastern. Dry-run sends nothing. Seed-only sends only to `seed_addresses`.

Stop rules match the reference sender. Hard bounce above 2% of the last 200 pauses (a fleet pause needs the full 200). Complaint rates are percent points: 0.10% pauses the domain, 0.30% pauses the fleet. Provider codes `4.7.28`, `5.7.515`, and `5.7.26` pause that inbox and do not retry. Seed placement under 80% and a blacklist hit pause too. An unsubscribe sync older than 24 hours, or a reply poll older than 24 hours, stops prospect sends. A successful inbox sync records the poll time. Thresholds can be tightened in settings. Making one looser requires `updateStopThresholds` with a reason, which writes `threshold_overrides` and an audit row. The database rejects a looser value that has no override id.

Sequence steps after the first are replies: same Gmail thread, `In-Reply-To`, `References`, and a `Re:` subject. Copy can use `{{field}}`, `{{field|fallback}}`, and `{Hi|Hello}` spintax. Plain text only, with a visible unsubscribe line, the postal address, and RFC 8058 headers. Open and click tracking stay off unless that campaign turns them on.

## Mailbox

`/mail` is one inbox over every synced mailbox. Filter by inbox, campaign, or label. Each message shows which inbox sent or received it. Search is Postgres full text over sender, recipient, subject, and body, with a literal match so an address still hits.

Star, read, archive, snooze, and labels write the local row immediately and queue a `gmail_mirror_jobs` row. `GMAIL_MIRROR_ENABLED` defaults to false, so those jobs stay held and `messages.modify` is not called. Sync stays on the read-only client. A later sync does not overwrite a flag that still has an unapplied mirror job. `npm run mail:unsnooze` returns due snoozes to the inbox. Opening the list does the same.

Reply, reply all, and forward leave from the original inbox. Reply and reply all set `In-Reply-To`, `References`, and the Gmail thread id. The HTML is allowlisted. A plain-text alternative is stored with it. Manual mail uses the same locks as a campaign send: kill switch, send mode, and approval. Approval off stores a Review draft and does not call the adapter. A suppressed recipient is skipped. Prospect mail (a contact with a pending or active enrollment) gets the legal footer and the unsubscribe headers. Manual sends count toward the 27/405 cap. A desk reply does not wait for the Eastern sending window. The web process passes the mock adapter and the real kill switch, so the page cannot send.

Classification is rules first: unsubscribe, out of office, not interested, not now, interested. `TodoReplyModel` is the swap point and returns nothing. Relabeling writes `classification.change` to the audit log.

Keyboard: `j` `k` move, `r` reply, `a` reply all, `f` forward, `e` archive, `s` star, `/` search, `?` the shortcut list.

The check that a reply shows up in Gmail Sent, on the same thread, cannot run here. On the key machine, with approval set to auto for that one message:

```bash
SEND_MODE=seed-only SENDING_ENABLED=true \
  npm run mail:verify-sent -- --confirm-seed-send \
  --inbox divyam@usefigcel.com --seed you@yourseed.com --thread <threads.id>
```

The seed address must already be in `seed_addresses`. Without those flags the script exits before it imports the Gmail sender. Put approval back to review and `SENDING_ENABLED` back to false afterwards.

## Dashboard

`/dashboard` shows today, or a from/to range, with totals, per inbox, per campaign, per day, a step-and-variant funnel, inbox health, and alerts. Each of those tables has a CSV link.

The browser uses server-sent events (`/api/dashboard/stream`), not a WebSocket. Updates travel server to client only, and this Next.js process already speaks HTTP, so EventSource is enough. It reconnects on its own and sends `Last-Event-ID`.

Postgres `LISTEN/NOTIFY` is the bus. Redis stays the send queue. Triggers on sends, events, review drafts, pauses, alerts, schedule, suppression, and inbox status append a `dashboard_events` row and `pg_notify('dashboard', id)` after the writing transaction commits. A dropped connection replays every id after `Last-Event-ID`, then live frames. The page refetches `/api/dashboard` on each change, so the numbers are the ledger, not a client-side increment. A Redis-only queue move that does not write Postgres does not push until the next ledger row. Queue depth is `LLEN` on that refresh. If Redis cannot be read, ready and processing say `unavailable`.

Complaints say `no source` until `app_kv.complaint_source` is a real source or a complaint event exists. Opens and clicks say `tracking off` unless that campaign has tracking on, and then they are labeled unreliable because Apple Mail Privacy Protection inflates opens. Warmup says `TODO: warmup provider` until someone records a manual or provider-reported status. Seed placement is a seed-test estimate, never real-recipient placement. Bounce rate over the last 200 says `no data yet` when that inbox has no sent mail. Days with no ledger rows are omitted. `no data yet` is also the empty state for a funnel, a disconnect, a pause, and a failed job.

CSV routes: `/api/dashboard/export?view=summary|by-inbox|by-campaign|by-day|funnel|health|alerts|caps`, with the same `from` and `to`.

The approval banner stays on this page. `SENDING_ENABLED` is still false.

## Import and verification

`/import` accepts a paste or a CSV. The same function, `importLeads`, is what an API route calls. Field mapping assigns columns to email, name, company, title, and timezone. Other columns can be stored as custom variables. List tags are attached to the contact. The first non-empty name and custom value win.

The dedupe report counts new, duplicate-in-file, already-in-system, invalid, and suppressed. One contact exists per `normalize_email`. Each distinct spelling is kept on `contact_aliases`.

Checks, in order: syntax, suppression (the address, or its domain and parent domains), then MX, role, and disposable.

- A null MX (exchange `.`) means the domain does not accept mail ([RFC 7505](https://www.rfc-editor.org/rfc/rfc7505)).
- If there is no MX, an A or AAAA record is an implicit mail host ([RFC 5321 §5.1](https://www.rfc-editor.org/rfc/rfc5321#section-5.1)).
- A timeout or a server failure stays `unknown`. It does not fall through to an address lookup, and it does not downgrade a status we already stored.
- Role mailboxes are the [RFC 2142](https://www.rfc-editor.org/rfc/rfc2142) names plus operational boxes such as `noreply` and `billing`. A `+tag` does not make a role mailbox personal.
- Disposable domains are the CC0 blocklist from [disposable-email-domains/disposable-email-domains](https://github.com/disposable-email-domains/disposable-email-domains) at commit `b63df8b431f37ef0b22524f9cae2e86c7114a9de`, retrieved 2026-10-19. See `src/lib/verify/vendor/SOURCE.txt`.

The verification provider is still `TODO: verification provider`. The adapter is the swap point. With no provider, an MX pass is `unknown`, not `valid`. `app_settings.treat_mx_pass_as_valid` defaults to false. Set it only as an explicit owner decision. Role and disposable results stay `risky` even if a provider says valid. A failed MX stays `invalid`.

Only `valid` is enrolled. `risky` and `unknown` go to `verification_holds`. Approve marks the contact valid, enrolls them when the hold names a campaign, and writes `hold.approve` to `audit_log`. Reject writes `hold.reject` and does not enroll.

Tests pass a fake DNS resolver. They do not query the network.

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

The token requests `gmail.send`, `gmail.readonly`, and `gmail.modify`, matching the domain-wide grant on the five tenants. Sync does not call `messages.send`. `GmailReadOnlyMailbox.send()` throws. The sync HTTP client rejects send, modify, label, trash, delete, draft, attachment, settings, and watch paths before any network call. `messages.send` lives in `src/lib/mail/gmail-send.ts` and is reached only from `npm run send:worker` after the gates above. An inbound reply, hard bounce, unsubscribe, or out-of-office message stops the contact's open sequences.

### Quota

Checked 2026-10-19 against the [Gmail API usage limits](https://developers.google.com/workspace/gmail/api/reference/quota) (page updated 2026-10-16 UTC). Projects created on or after 1 May 2026, including figcel-sender, use:

- 1,200,000 quota units per minute per project
- 6,000 quota units per minute per user per project
- `getProfile` 1, `history.list` 2, `messages.list` 5, `messages.get` 20, or 60 when `format` is `full`

`messages.list` allows at most 500 ids per page. The [error guide](https://developers.google.com/workspace/gmail/api/guides/handle-errors) says not to batch more than 50 requests. This sync uses page size 50 and at most 50 `messages.get` calls per inbox per run: 50 × 60 = 3,000 units, under the 6,000 per-user per-minute cap. Inboxes run one at a time so one mailbox is not hit with parallel requests (429 concurrent-request limit).

429, 500, 502, 503, 504, and 403 `rateLimitExceeded` / `userRateLimitExceeded` retry with truncated exponential backoff: `min(2^n seconds + up to 1s of jitter, 32s)`, five attempts, honoring `Retry-After`. 404 and other 403s (`domainPolicy`, `dailyLimitExceeded`) are not retried. A history 404 starts a full sync instead of a retry.
