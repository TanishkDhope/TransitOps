# TransitOps — Remediation Report

Every finding in [`ISSUES.md`](ISSUES.md) has been addressed, and a full toast notification
system has been added across the application.

**Verification:** 61 automated end-to-end assertions run against the live API and PostgreSQL
database — **61 passed, 0 failed**. The client builds clean (2,902 modules). ESLint went from
41 problems to 7, and all 7 remaining are pre-existing Fast-Refresh advisories that also fire
on the original code at `HEAD`.

---

## 1. The Toast System

### What was added

| File | Purpose |
|---|---|
| `client/src/components/ui/toast.jsx` | Provider, portal, animated stack, five variants |
| `client/src/hooks/useToast.js` | `success` / `error` / `warning` / `info` / `apiError` / `fromResponse` / `promise` |

### How errors reach the user

The API returns a machine-readable `code` on every failure, and the toast layer maps it to a
scannable title while showing the server's own sentence as the body:

```jsonc
{ "success": false, "code": "SCHEDULE_CONFLICT",
  "message": "Vehicle MH-12-AB-1234 is already booked: Pune → Surat (10 Sept, 01:30 pm – 11:30 pm).",
  "details": { "conflicts": [...] } }
```

renders as:

> **Scheduling conflict**
> Vehicle MH-12-AB-1234 is already booked: Pune → Surat (10 Sept, 01:30 pm – 11:30 pm).

Codes are split by tone so a user's *situation* is not styled as a system *failure*:

| Tone | Codes |
|---|---|
| 🔴 error | `INVALID_CREDENTIALS`, `UNAUTHENTICATED`, `INTERNAL`, `INTEGRATION_FAILED` |
| 🟡 warning | `SCHEDULE_CONFLICT`, `RESOURCE_BUSY`, `CAPACITY_EXCEEDED`, `LICENSE_EXPIRED`, `DUPLICATE`, `IN_USE`, `VALIDATION_FAILED`, `ILLEGAL_TRANSITION`, `FORBIDDEN`, `RATE_LIMITED` |
| 🟢 success | any `{ success: true, message }` |

### Behaviour

- **Auto-dismiss by severity** — success 4s, info 5s, warning 7s, error 8s. Hovering pauses it.
- **Deduplication** — a `dedupeKey` collapses repeats, so six parallel 401s show one message.
- **Warnings channel** — `fromResponse()` also surfaces any `warnings[]` the API returns, e.g.
  *"Actual distance differs from the plan by +180 km"* or *"Vehicle is due for service."*
- **Field hints** — `details.fields` renders as *"Check: cargoWeightKg"*.
- **Accessibility** — errors are `role="alert"` / `aria-live="assertive"`, others `role="status"`.
- **Network failures** — a request that never reaches the server gets its own message rather
  than a confusing generic error.

### Verified in the browser

| Case | Result |
|---|---|
| Wrong password | **Incorrect email or password** — *Incorrect email or password. Please try again.* |
| Successful login | **Welcome back, admin** — *Signed in as Admin.* |
| Driver opens `/fleet` | **Page not available for your role** — *Driver does not have access to /fleet.* (plus redirect) |

---

## 2. Findings — Resolution Summary

### 🔴 Critical

**#1 — `dotenv.config()` after the module graph.**
Replaced with `src/config/env.js`, imported first in `index.js`, which loads and validates the
environment and derives a `features` map. Verified by executing the exact call that previously
failed with `Must supply api_key`: it now uploads to Cloudinary successfully and the test asset
was cleaned up. Startup log confirms `✅ Email service ready (Gmail)`.

**#2 — RBAC enforced only in the browser.**
`server/src/config/permissions.js` defines a capability table; `authorize("vehicle:write")`
guards every route. `verifyJWT` re-enabled on the vehicle, driver and trip routers.
Verified: anonymous `GET /vehicles|/drivers|/trips` → **401**; dispatcher `POST /vehicles` → **403**;
dispatcher `GET /reports/*` → **403**; analyst `GET /reports/*` → **200**.

**#3 — Upload failure killed the whole extraction.**
Both halves now use `Promise.allSettled`; the response reports `extractionFailed` and
`uploadFailed` independently so a partial success is preserved and explained.

### 🟠 High

| # | Fix |
|---|---|
| **4** | `notification.routes.js` mounted; stale scaffolding comment removed. Adds `/logs` and `/status`. |
| **5** | Licence images now upload to Cloudinary; `licenseFrontUrl` / `licenseBackUrl` are populated. |
| **6** | One shared `validatePassword` (8+ chars, letter, digit) used by registration, admin creation and the login form. Plus a login throttle (8 attempts / 15 min). |
| **7** | Self-registration disabled by default behind `ALLOW_SELF_REGISTRATION`. |
| **8** | `username` is now `@unique` in the schema and enforced by the database. |
| **9** | One open work order per vehicle; closing only releases the vehicle when no other job is open. |
| **10** | `PATCH /drivers/:id/status` allows reinstatement and `OFF_DUTY`; `/restore` un-archives. |

### 🟡 Medium

| # | Fix |
|---|---|
| **11** | `bg-muted/80/80` → `bg-muted/80`, `bg-muted-foreground/20/80` → `bg-muted-foreground/20`. Verified: both now compute to real colours instead of transparent. |
| **12** | One cost definition everywhere — fuel + maintenance + expenses. `ExpenseType.MAINTENANCE` is rejected so nothing is double-counted. |
| **13** | Fuel efficiency now divides trip distance by *trip-linked* litres, and reports its `basis` and `unattributedLiters` rather than silently skewing. |
| **14** | Every Radix select converted to `<Controller>` with rules — empty required fields are caught inline instead of by the API. |
| **15** | `refresh-token` is now `POST`, and an axios interceptor performs a single silent refresh and replays the request. |
| **16** | Cookie `sameSite` is `none` + `secure` in production, `lax` in development. |
| **17** | Utilisation = `onTrip / (available + onTrip)` — in-shop vehicles no longer count as capacity. Identical in the dashboard and the report. |
| **18** | Vehicle filters now scope trip and driver counts server-side; `meta.filtered` lets the UI label the scope honestly. |
| **19** | Dead `utils/extractLicense.js` (with its top-level side effect) deleted. |
| **20** | Presence and numeric validity are checked separately, so `0` is a legal value. |
| **21** | Cursor-free pagination (`?page=&limit=`) on every list endpoint, with `meta.total`. |

### 🔵 Low

| # | Fix |
|---|---|
| **22** | Duplicate body-parser registration removed — the 16 KB limit is now actually applied. |
| **23** | `cors()` moved ahead of the body parsers. |
| **24** | All four debug `console.log`s removed, including the one printing plaintext passwords. |
| **25** | Leftover `useStateAlias` import deleted. |
| **26** | Topbar search actually searches vehicles, drivers and trips; the bell shows a real count from `/dashboard/alerts` and is unlit when there is nothing to report. |
| **27** | Drivers are archived, not hard-deleted; trip history is preserved. |
| **28** | 12 unused shadcn components removed (CSS bundle 87 KB → 73 KB). |
| **29** | Live config extracted to `client/src/config/roles.js`; the 523-line `mockData.js` deleted. |
| **30** | Settings persist to `localStorage`; the RBAC matrix is generated from `ROLE_ACCESS` and now includes Admin, Maintenance and Users. |

### 🧭 Ideation

| # | What was built |
|---|---|
| **31** | **Scheduling.** `plannedStart` / `plannedEnd` on every trip; availability is an interval-overlap query; overlapping bookings are refused with the conflicting trip named. Verified: a future-dated booking succeeds, an overlapping one is refused, a non-overlapping one succeeds. |
| **32** | **Safety score is now derived** from fines, post-dispatch cancellations, licence validity and completed trips — and is a dispatch input (warn below 60, block below 40). No longer hand-editable. |
| **33** | **Customers and rate cards.** Revenue is computed from a per-km / per-tonne-km / flat rate card, with a live quote preview and an auditable override. |
| **34** | **Preventive maintenance.** `serviceIntervalKm` + `lastServiceOdometer` drive a service-due warning off the odometer the system already tracks; PUC expiry now joins the cron. |
| **35** | **Per-trip and per-lane profitability**, with planned-vs-actual distance variance and cost/km. Lanes are sorted worst-margin first. |
| **36** | **Audit trail.** Every state change records actor, entity, action, before/after and a summary. `actorEmail` is denormalised so history survives account deletion. Admin-only. |
| **37** | **Driver self-service.** Drivers see their assignment, complete it with an odometer reading, and log fuel and expenses from the road. Every handler refuses to act on another driver's trip. |
| **38** | **Notification cooldown + delivery log.** The bug that would have emailed a driver every 30 minutes indefinitely is fixed by a per-(subject, type) cooldown, and every send is recorded in `NotificationLog`. |

---

## 3. Two Bugs Found *During* This Work

Both were mine, found by the verification suite rather than by reading:

**Status/code disagreement.** Three handlers threw `badRequest(..., ERROR_CODES.FORBIDDEN)` —
returning HTTP 400 with a `FORBIDDEN` body. Any standard client would have treated a permission
problem as a validation problem. Fixed to use `forbidden()`. A sweep of every `throw` in the
codebase confirmed no remaining mismatches.

**A greedy regex corrupted 19 error calls.** While unifying `RESOURCE_BUSY` to HTTP 409, a
`re.S` pattern matched across statement boundaries and renamed the wrong handlers. Caught
immediately, then repaired with a balanced-paren parser and re-verified to zero mismatches.
Worth recording because the intermediate state looked plausible and compiled fine.

---

## 4. What Changed, by the Numbers

| | Before | After |
|---|---|---|
| Prisma models | 6 | 9 (`+Customer`, `+AuditLog`, `+NotificationLog`) |
| Controllers | 11 | 14 (`+customer`, `+audit`, `+me`) |
| Services | 5 | 9 (`+gemini.client`, `+safety`, `+scheduling`, `+pricing`) |
| Routers mounted | 10 | 14 |
| Routes with auth | 7 of 11 | 14 of 14 |
| Routes with role guards | 1 | 14 |
| ESLint problems | 41 | 7 (all pre-existing) |
| CSS bundle | 87.3 KB | 72.9 KB |

---

## 5. Running It

```bash
cd server && npm install && npx prisma migrate dev && npm run seed:data && npm run seed:users && npm run dev
```

```bash
cd client && npm install && npm run dev
```

**Logins** — every password is `Password@123` except Admin (`Admin@12345`):

| Role | Email |
|---|---|
| Admin | `admin@transitops.com` |
| Fleet Manager | `fleetmanager@transitops.com` |
| Dispatcher | `dispatcher@transitops.com` |
| Safety Officer | `safetyofficer@transitops.com` |
| Financial Analyst | `financialanalyst@transitops.com` |
| **Driver** | `rajesh.kumar@transitops-drivers.com` |

Sign in as the Driver to see the self-service portal (#37); as Dispatcher to see scheduling
(#31) and rate cards (#33); as Admin to see the audit log (#36).

> Run `seed:data` before `seed:users` — the driver login is linked to a seeded driver record.
