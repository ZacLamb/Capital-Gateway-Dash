# Capital Gateway — Deals & Commissions Dashboard

Reads funded deals from the Capital Gateway GHL sub-account (`WUqaLeDuJ5H8kocqpip7`), computes RTR, payment schedule, collected/balance and rep payouts, and writes missed payments + payment status back to the opportunity.

## Deploy (GitHub → Railway)
1. Create a private GitHub repo and upload everything in this folder (not `node_modules`).
2. Railway → New Project → Deploy from GitHub repo. Start command is `npm start`.
3. In Capital Gateway: **Settings → Private Integrations → Create** with scopes
   `opportunities.readonly`, `opportunities.write`, `locations/customFields.readonly`, `users.readonly`. Copy the token.
4. Railway variables:
   | Variable | Value |
   |---|---|
   | `GHL_TOKEN` | the Private Integration token |
   | `GHL_LOCATION_ID` | `WUqaLeDuJ5H8kocqpip7` |
   | `DASHBOARD_PASSWORD` | shared password for Capital Gateway's team |
   | `AUTO_WRITEBACK` | `true` (fills blank RTR / Payment / Commission $ / rep $ fields in GHL) |
   | `CACHE_SECONDS` | `120` |
5. Generate a domain, open it, log in with any username + the password. `/api/health` confirms all 24 fields were found.

With no `GHL_TOKEN` (or `DEMO_MODE=true`) it runs on sample data.

## Which deals show up
Any opportunity with **Funded Amount** filled in, in any pipeline.

## Math
- RTR = Funded × Factor (unless RTR is typed in)
- Total payments: Daily = business days (weeks × 5 if term is in weeks); Weekly = weeks (days ÷ 5 if term is in days)
- Payment = RTR ÷ total payments (unless typed in)
- Payments due = business days (daily) or full weeks (weekly) since Funded Date, capped at the term
- Payments made = due − Missed Payments; Collected = made × payment; Balance = RTR − collected
- Paid Off status → balance 0. Missed payments push the projected payoff date out.
- Renewal flag at ≥ 50% paid in (not shown for Default)
- Commission $ = Funded × Commission %; Opener/Closer $ = Commission $ × their %; House = Commission − rep payouts
- Any $ field typed into GHL overrides the computed value.

`npm test` runs the math checks.
