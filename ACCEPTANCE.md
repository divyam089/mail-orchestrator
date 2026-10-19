# Acceptance

Run on 2026-10-19 with `npx vitest run`.

30 files, 136 tests, all passed. `SENDING_ENABLED` and `GMAIL_MIRROR_ENABLED` stayed false in the process environment. Tests that exercise a send pass `sendingEnabled: true` into the engine and use `MockMailAdapter`. No test opens a network socket to Gmail or to a DNS server.

The live dashboard stream in that run: 2.9 ms to the first change, 2.3 ms backfill, 2.1 ms live after backfill.

## Results

| Criterion | Result | Test |
| --- | --- | --- |
| Same contact imported twice, in any format, is one record | pass | `tests/import-pipeline.integration.test.ts` imports CSV, paste, and the API function as one record. `tests/dedupe.integration.test.ts` keeps one contact and every alias. |
| Zero duplicate sends, including a second insert of the same contact, campaign, and step | pass | `tests/dedupe.integration.test.ts` rejects the second prospect send. |
| Kill the worker mid-batch and restart: nothing is sent twice | pass | `tests/send-engine.integration.test.ts` kills the worker after the adapter returns, requeues, and the retry is `already_locked`. Adapter call count stays at the first attempt. |
| Concurrent workers racing one schedule call the adapter once | pass | `tests/acceptance.integration.test.ts` runs two `executeSend` calls on one schedule. One outcome is `sent`, the other is `already_locked`, and the mock adapter is called once. |
| Idempotent sends survive a retry | pass | The same two tests. The unique sent-log is `(contact, campaign, step)` where `kind = 'prospect'`. |
| Every address is verified before send. Unverified is not sent | pass | `tests/send-engine.integration.test.ts` refuses an unverified contact. `tests/import-pipeline.integration.test.ts` enrolls only `valid`. Risky and unknown stay on the hold list. |
| Suppressed address is not sent. Suppression is rechecked at send time | pass | `tests/send-engine.integration.test.ts`. `tests/api.integration.test.ts` returns `409 gate_blocked` for a suppressed compose. |
| Unsubscribe stops the sequence and is suppressed | pass | `tests/send-engine.integration.test.ts` stops on “Please unsubscribe me” with `stop_reason = unsubscribe`. MIME includes `List-Unsubscribe` (`tests/template-mime.test.ts`). |
| A normal reply stops the rest of the sequence | pass | `tests/acceptance.integration.test.ts` stops on “Tuesday afternoon works.” with `stop_reason = reply`, skips the schedule, and does not call the adapter. |
| Approval off: nothing leaves, drafts appear in Review | pass | `tests/send-engine.integration.test.ts` plans a draft and `executeSend` returns `deferred` with zero adapter calls even when the call is told sending is enabled. |
| Approval on globally, and a campaign can force Review | pass | The same file plans zero sends for a campaign whose override is `review` while the global mode is `auto`. |
| Caps, ramp, and send window | pass | `tests/caps.test.ts`, `tests/window.test.ts`, `tests/send-engine.integration.test.ts` (inbox cap, database hard cap 28 and 406 rejected, ramp held after a stop, weekend refused). `tests/api.integration.test.ts` checks the shared gate for an 08:00 ET instant, a paused inbox, ramp day 1 at 9, and the fleet cap. |
| Stop rules auto-pause | pass | `tests/send-engine.integration.test.ts` covers hard-bounce pause, complaint pause, seed-test pause, and a blacklist hit. Seed measurement stays `seed_test_only`. |
| Dashboard reflects a new send or reply within about 1 second | pass | `tests/dashboard-stream.integration.test.ts`. This run: 2.9 ms, backfill 2.3 ms, live-after-backfill 2.1 ms. |
| API has an endpoint for every UI action | pass | `tests/api-registry.test.ts` walks `UI_ACTIONS` and fails if a handler or an OpenAPI operation is missing. |
| API cannot bypass the gates | pass | `tests/api.integration.test.ts`. A body of `sendingEnabled: true` and `sendMode: live` is ignored. With approval on, the call is still deferred for dry-run and writes no sent row. Suppression returns `gate_blocked`. |
| Audit log records the actor | pass | API rows use `actor = api:<key name>` (`tests/api.integration.test.ts`). Approval changes record `source = ui` (`tests/send-engine.integration.test.ts`). |
| Roles | pass for API keys. fail for user login | Viewer, operator, and admin scopes are separate (`tests/acceptance.integration.test.ts`, `tests/api.integration.test.ts`). There is no user login. `/keys` is the local admin desk. |
| CSV export | pass | `tests/dashboard-view.test.tsx` links summary, funnel, and alerts exports and escapes formula cells. `tests/api.integration.test.ts` returns the dashboard CSV, including the complaints cell. |
| Complaints, opens, and sample labels stay honest | pass | `tests/dashboard-view.test.tsx` expects `no source`, `tracking off`, and the Apple Mail note. Tracked opens are labeled unreliable. |
| A full day of 405 sends across 15 inboxes, fake Gmail | pass | `tests/acceptance.integration.test.ts`. Ramp is held at 27, new prospects stay at 9 per inbox, 18 follow-ups fill the rest. 405 mock sends, 27 on each of 15 inboxes. A replay sends nothing more. One more schedule is deferred because a cap is reached. The process kill switch stays false. |
| A reply composed here appears in that inbox’s real Gmail Sent folder, in the same thread | fail | `tests/verify-sent-guard.test.ts` exits 2 and prints that no Gmail request was made. `GMAIL_MIRROR_ENABLED` is false. Local threading is covered: step 2 is a reply with `In-Reply-To` in `tests/send-engine.integration.test.ts`. The real Sent folder has not been checked. |

## TODOs that block real sending

These are still unset. Sending hard-blocks while the legal lines are TODO, and the kill switch is off.

- `SENDING_ENABLED` is not exactly true. It is env-only. A database edit cannot turn it on.
- `TODO: legal name`
- `TODO: postal address`
- `TODO: unsubscribe URL` (`unsubscribe_https_base` is empty, so the footer link cannot be built)
- `TODO: verification provider`. An MX pass stays `unknown` unless the owner sets `treat_mx_pass_as_valid`. That flag is off. Only `valid` can be enrolled.
- `TODO: hosting`
- `GMAIL_MIRROR_ENABLED` is false, and the service-account key is not on this machine. A reply cannot be placed in Gmail Sent from here.
- `TODO: warmup provider`. Warmup status is blank.
- Complaint source is unset, so the dashboard says `no source`.
- `TODO: reply model`. Classification is the rules list only.
- No user login. API keys carry admin, operator, and viewer. The keys page is open on this local process.

Placement numbers, when present, are seed-test estimates. They are not real-recipient placement.
