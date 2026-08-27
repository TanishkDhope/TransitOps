# TransitOps — Technical Documentation

Complete technical reference: architecture, data model, request lifecycle, every endpoint, every
integration, and the state machines that hold the domain together.

Companion documents: [`README.md`](README.md) (product) · [`ISSUES.md`](ISSUES.md) (audit record) ·
[`FIXES.md`](FIXES.md) (remediation report)

---

## Table of Contents

1. [System Architecture](#1-system-architecture)
2. [Technology Stack](#2-technology-stack)
3. [Data Model](#3-data-model)
4. [Backend Architecture](#4-backend-architecture)
5. [Error Contract](#5-error-contract)
6. [Authentication & Authorisation](#6-authentication--authorisation)
7. [API Reference](#7-api-reference)
8. [Business Logic & State Machines](#8-business-logic--state-machines)
9. [Domain Services](#9-domain-services)
10. [Reporting Engine](#10-reporting-engine)
11. [External Integrations](#11-external-integrations)
12. [Background Jobs](#12-background-jobs)
13. [Frontend Architecture](#13-frontend-architecture)
14. [The Toast System](#14-the-toast-system)
15. [Configuration](#15-configuration)
16. [Data Flow Walkthroughs](#16-data-flow-walkthroughs)
17. [Build, Run & Seed](#17-build-run--seed)

---

## 1. System Architecture

```
┌──────────────────────────────────────────────────────────────────────────┐
│  Browser — React 19 SPA (:5173)                                          │
│                                                                           │
│  ErrorBoundary → ThemeProvider → ToastProvider → AuthProvider             │
│                                → DataProvider → TooltipProvider → Router  │
│                                        │                                  │
│         axios (withCredentials) ───────┴── 401 → silent refresh → replay  │
└──────────────────────────────────────┬───────────────────────────────────┘
                                       │  httpOnly cookies · JSON · multipart
                                       ▼
┌──────────────────────────────────────────────────────────────────────────┐
│  Express 5 API (:8000)                                                    │
│                                                                           │
│   config/env.js ← loaded FIRST, validates and derives `features`          │
│                                                                           │
│   app.js → cors · json(16kb) · cookieParser                              │
│          → 14 routers under /api/v1                                       │
│          → 404 handler → typed error handler                              │
│                                                                           │
│   route → verifyJWT → authorize("capability") → [multer] → controller     │
│                                                     │                     │
│              ┌──────────────────────────────────────┼────────────┐        │
│              ▼                    ▼                 ▼            ▼        │
│         Prisma Client      domain services     integrations   node-cron   │
│              │           (scheduling, pricing,  (Gemini,                  │
│              │            safety)               Cloudinary,               │
│              │                                  Nodemailer)               │
└──────────────┼───────────────────────────────────────────────────────────┘
               ▼
        ┌──────────────┐
        │  PostgreSQL  │
        └──────────────┘
```

**Key properties**

- **Env-first boot.** `src/config/env.js` is the first import in `index.js`, so every module in
  the tree sees a populated `process.env`. It also derives a `features` map, letting the app run
  with any subset of the optional integrations configured.
- **Stateless API.** Identity travels in a JWT carried by an httpOnly cookie.
- **Capability-based authorisation.** One table maps capabilities to roles; every route declares
  the capability it needs.
- **Typed errors.** Handlers `throw` `ApiError`s carrying a machine-readable `code`; one
  middleware renders them.
- **Transactional consistency.** Every multi-row state change runs inside `prisma.$transaction`,
  with the audit write included in the same transaction.
- **Graceful degradation.** A missing Gemini/Cloudinary/Gmail key disables that feature with a
  clear message rather than crashing or silently failing.

---

## 2. Technology Stack

### Backend (`server/`)

| Package | Role |
|---|---|
| `express` ^5.2 | HTTP framework |
| `@prisma/client` / `prisma` ^6.19 | ORM + migrations |
| `jsonwebtoken` ^9 | Access / refresh tokens |
| `bcrypt` ^6 | Password hashing (cost 10) |
| `cookie-parser`, `cors` | httpOnly cookie auth across origins |
| `multer` ^2 | Multipart uploads (memory storage) |
| `@google/genai` ^2.11 | Gemini vision extraction |
| `cloudinary` ^2.10 | Document image hosting |
| `nodemailer` ^9 | Compliance email |
| `node-cron` ^4.6 | Expiry scheduler |
| `pdfkit` ^0.19 | Server-rendered PDF reports |
| `dotenv` ^17 | Environment loading |

Runtime: **ES Modules**, Node 18+.

### Frontend (`client/`)

| Package | Role |
|---|---|
| `react` / `react-dom` ^19.2 | UI runtime |
| `vite` ^7.2 | Dev server and bundler |
| `react-router-dom` ^7.11 | Routing |
| `tailwindcss` ^4.1 (+ `@tailwindcss/vite`) | CSS-first Tailwind, no JS config |
| `radix-ui` ^1.6 | Headless primitives under shadcn/ui |
| `react-hook-form` ^7.81 | Form state and validation |
| `axios` ^1.18 | HTTP client with refresh interceptor |
| `recharts` ^3.9 | Charts |
| `framer-motion` ^12.42 | Animation |
| `lucide-react` | Icons |

---

## 3. Data Model

PostgreSQL via Prisma. Schema: `server/prisma/schema.prisma`.
Migrations: `20260712095935_init`, `20260827120000_ops_hardening`.

### 3.1 Enums

```prisma
enum Role              { ADMIN, FLEET_MANAGER, DRIVER, DISPATCHER, SAFETY_OFFICER, FINANCIAL_ANALYST }
enum VehicleStatus     { AVAILABLE, ON_TRIP, IN_SHOP, RETIRED }
enum DriverStatus      { AVAILABLE, ON_TRIP, OFF_DUTY, SUSPENDED, ARCHIVED }
enum TripStatus        { DRAFT, DISPATCHED, COMPLETED, CANCELLED }
enum MaintenanceStatus { OPEN, CLOSED }
enum ExpenseType       { TOLL, PARKING, FINE, MAINTENANCE, OTHER }
enum NotificationType  { LICENSE_EXPIRY, INSURANCE_EXPIRY, PUC_EXPIRY, SERVICE_DUE }
```

`ARCHIVED` and `NotificationType` are new; `MAINTENANCE` remains in `ExpenseType` for historical
rows but is **rejected on write** so it cannot double-count against maintenance logs.

### 3.2 Entities

#### `User`
`id`, `email @unique`, `password` (bcrypt), **`username @unique`**, `role`, `refreshToken?`,
`driver?` (back-relation).

#### `Vehicle`
Identity and capacity: `registrationNo @unique`, `name`, `type`, `maxLoadKg`, `odometer`,
`acquisitionCost Decimal(12,2)`, `region?`, `status`.

Compliance: `rcNumber?`, `insuranceNumber?`, `insuranceExpiry?`, `insuranceExpired`,
`pucNumber?`, `pucExpiry?`, **`pucExpired`**, `documentUrls String[]`.

Preventive maintenance: **`serviceIntervalKm?`**, **`lastServiceOdometer`**.

#### `Driver`
`name`, `email @unique`, `licenseNumber @unique`, `licenseCategory`, `licenseExpiry`,
`contactNumber`, `safetyScore` (derived), `status`, `licenseFrontUrl?`, `licenseBackUrl?`,
`userId? @unique` → optional login.

#### `Customer` *(new)*
`name @unique`, `email?`, `phone?`, and the rate card: `ratePerKm?`, `ratePerTonneKm?`,
`flatRate?` — all `Decimal`.

#### `Trip`
`source`, `destination`, `cargoWeightKg`, `plannedDistance`, `status`,
**`plannedStart`**, **`plannedEnd`**, `vehicleId`, `driverId`, **`customerId?`**,
`startOdometer?`, `endOdometer?`, `fuelConsumedL?`, `revenue?`,
`dispatchedAt?`, `completedAt?`, `cancelledAt?`.

Indexed on `[vehicleId, plannedStart, plannedEnd]` and `[driverId, plannedStart, plannedEnd]` —
these back the overlap queries.

#### `MaintenanceLog`
`vehicleId`, `description`, `cost`, `status`, `startedAt`, `closedAt?`.

#### `FuelLog` / `Expense`
`vehicleId`, `tripId?`, plus `liters`+`cost` / `type`+`amount`+`note?`.

#### `AuditLog` *(new)*
`actorId?` (nullable — history survives account deletion), **`actorEmail?`** (denormalised),
`entity`, `entityId`, `action`, `summary`, `before Json?`, `after Json?`, `createdAt`.

#### `NotificationLog` *(new)*
`type`, `subjectId`, `recipient`, `success`, `error?`, `sentAt`.
Indexed on `[type, subjectId, sentAt]` — this backs the cooldown lookup.

**Decimal handling:** money is `DECIMAL(12,2)`; Prisma returns `Decimal`, serialised as JSON
strings. Both the reporting layer (`toNumber`) and the client (`Number(...)`) coerce explicitly.

---

## 4. Backend Architecture

```
server/
├── index.js                  env → prisma.$connect → cron → listen
├── app.js                    middleware, 14 routers, 404, error handler
└── src/
    ├── config/
    │   ├── env.js            loads + validates env, derives `features`
    │   └── permissions.js    capability → roles table
    ├── db/prisma.js          singleton PrismaClient
    ├── routes/               URL → verifyJWT → authorize → controller
    ├── controllers/          validation + rules + Prisma + response
    ├── services/             scheduling · pricing · safety · gemini · cloudinary · email · notification
    ├── middlewares/          auth (verifyJWT, authorize) · upload
    └── utils/                ApiError · audit · pagination · validators · cookies · tokens
```

### Middleware chain

```js
cors({ origin: env.corsOrigins, credentials: true })   // before parsers
express.json({ limit: "16kb" })                        // registered once
express.urlencoded({ extended: true, limit: "16kb" })
cookieParser()
→ routers
→ 404 handler
→ typed error handler
```

### Request pipeline

```
Request
  → cors → parsers → cookieParser
  → verifyJWT            (401 UNAUTHENTICATED / TOKEN_EXPIRED)
  → authorize(cap)       (403 FORBIDDEN)
  → [multer]             (400 PAYLOAD_TOO_LARGE / VALIDATION_FAILED)
  → controller
       ├─ validators     (400 VALIDATION_FAILED + details.fields)
       ├─ domain rules   (400/409 + specific code)
       ├─ $transaction   (writes + audit together)
       └─ response       ({ success, message, warnings?, data })
  → error handler        ({ success, code, message, details? })
```

---

## 5. Error Contract

Every failure carries a stable `code` so the client can react without string-matching.

```jsonc
{
  "success": false,
  "code": "SCHEDULE_CONFLICT",
  "message": "Vehicle MH-12-AB-1234 is already booked: Pune → Surat (10 Sept, 01:30 pm – 11:30 pm).",
  "details": { "conflicts": [ /* the offending trips */ ] }
}
```

| Code | Status | Meaning |
|---|---|---|
| `VALIDATION_FAILED` | 400 | Bad input; `details.fields` names the inputs |
| `ILLEGAL_TRANSITION` | 400 | The state machine forbids this move |
| `CAPACITY_EXCEEDED` | 400 | Cargo exceeds the vehicle's rating |
| `LICENSE_EXPIRED` | 400 | Licence invalid for the trip window |
| `INTEGRATION_DISABLED` | 400 | Feature not configured on this server |
| `INVALID_CREDENTIALS` | 401 | Wrong email or password |
| `UNAUTHENTICATED` | 401 | No/invalid session |
| `TOKEN_EXPIRED` | 401 | Access token expired — **the only refreshable code** |
| `FORBIDDEN` | 403 | Role lacks the capability |
| `NOT_FOUND` | 404 | No such record |
| `DUPLICATE` | 409 | Unique constraint (Prisma `P2002`) |
| `RESOURCE_BUSY` | 409 | Blocked by the resource's current state |
| `SCHEDULE_CONFLICT` | 409 | Overlapping booking |
| `IN_USE` | 409 | Referenced by other records |
| `RATE_LIMITED` | 429 | Login throttle |
| `INTERNAL` | 500 | Unhandled |

Statuses and codes are consistent: one code never maps to two statuses.

**Success** responses carry a human message, and optionally non-fatal `warnings`:

```jsonc
{
  "success": true,
  "message": "Trip completed — 1,247 km recorded",
  "warnings": ["Actual distance differs from the plan by +180 km.",
               "MH-12-AB-1234 is due for service — 320 km past its interval."],
  "data": { /* … */ }
}
```

---

## 6. Authentication & Authorisation

### 6.1 Tokens

| Token | Lifetime | Storage |
|---|---|---|
| Access | `ACCESS_TOKEN_EXPIRY` (1d) | httpOnly cookie `accessToken` |
| Refresh | `REFRESH_TOKEN_EXPIRY` (7d) | httpOnly cookie + `User.refreshToken` |

Cookies: `httpOnly`, `secure` + `sameSite: "none"` in production (so a separately-hosted client
works), `lax` in development.

The payload carries only `{ id }`, so `verifyJWT` re-reads the user each request — role changes
take effect immediately. `verifyJWT` distinguishes an **expired** token (`TOKEN_EXPIRED`, which
the client silently refreshes) from a missing or invalid one (`UNAUTHENTICATED`, which it does not).

### 6.2 Capability table

`src/config/permissions.js` is the single source of truth:

```js
export const CAPABILITIES = {
  "vehicle:read":   ["ADMIN", "FLEET_MANAGER", "DISPATCHER", "SAFETY_OFFICER", "FINANCIAL_ANALYST"],
  "vehicle:write":  ["ADMIN", "FLEET_MANAGER"],
  "vehicle:retire": ["ADMIN", "FLEET_MANAGER"],
  "trip:dispatch":  ["ADMIN", "DISPATCHER"],
  "audit:read":     ["ADMIN"],
  // …
};
```

Routes declare what they need:

```js
router.use(verifyJWT);
router.route("/")
  .get(authorize("vehicle:read"), getVehicles)
  .post(authorize("vehicle:write"), createVehicle);
```

`client/src/config/roles.js` mirrors this table to decide which controls to render. The client
copy is **presentation only** — the server is what enforces it.

### 6.3 Login hardening

- Identical `INVALID_CREDENTIALS` for a wrong password and an unknown email — no user enumeration.
- Shared password policy: 8+ characters, at least one letter and one digit.
- In-process throttle: 8 failed attempts per (IP, identifier) per 15 minutes → `RATE_LIMITED`.
- Self-registration is off unless `ALLOW_SELF_REGISTRATION=true`.

---

## 7. API Reference

Base: `http://localhost:8000/api/v1`. Every router below `/auth` requires authentication.

### Auth — `/auth`

| Method | Path | Capability |
|---|---|---|
| `POST` | `/register` | public (disabled by default) |
| `POST` | `/login` | public |
| `POST` | `/refresh-token` | cookie |
| `POST` | `/logout` | authenticated |
| `GET` | `/current-user` | authenticated |
| `POST` | `/change-password` | authenticated |

### Vehicles — `/vehicles`

| Method | Path | Capability |
|---|---|---|
| `GET` | `/` | `vehicle:read` |
| `POST` | `/` | `vehicle:write` |
| `POST` | `/extract-documents` | `vehicle:write` |
| `GET` | `/:id` | `vehicle:read` |
| `PATCH` | `/:id` | `vehicle:write` |
| `DELETE` | `/:id` *(retire)* | `vehicle:retire` |
| `PATCH` | `/:id/reinstate` | `vehicle:retire` |

### Drivers — `/drivers`

| Method | Path | Capability |
|---|---|---|
| `GET` / `POST` | `/` | `driver:read` / `driver:write` |
| `POST` | `/extract-license` | `driver:write` |
| `POST` | `/recalculate-scores` | `driver:write` |
| `GET` / `PATCH` | `/:id` | `driver:read` / `driver:write` |
| `DELETE` | `/:id` *(archive)* | `driver:archive` |
| `PATCH` | `/:id/suspend` | `driver:suspend` |
| `PATCH` | `/:id/status` | `driver:suspend` |
| `PATCH` | `/:id/restore` | `driver:archive` |

### Trips — `/trips`

| Method | Path | Capability |
|---|---|---|
| `GET` | `/available-vehicles?plannedStart=&plannedEnd=&cargoWeightKg=` | `trip:write` |
| `GET` | `/available-drivers?plannedStart=&plannedEnd=` | `trip:write` |
| `GET` | `/schedule?from=&to=` | `trip:read` |
| `GET` / `POST` | `/` | `trip:read` / `trip:write` |
| `GET` | `/:id` *(includes `economics`)* | `trip:read` |
| `PATCH` | `/:id` *(drafts only)* | `trip:write` |
| `POST` | `/:id/dispatch` · `/:id/complete` · `/:id/cancel` | `trip:dispatch` |

### Customers — `/customers`

| Method | Path | Capability |
|---|---|---|
| `GET` | `/quote?customerId=&plannedDistance=&cargoWeightKg=` | `customer:read` |
| `GET` / `POST` | `/` | `customer:read` / `customer:write` |
| `GET` / `PATCH` / `DELETE` | `/:id` | `customer:read` / `customer:write` |

### Maintenance — `/maintenance`

| Method | Path | Capability |
|---|---|---|
| `GET` | `/service-due?warnKm=` | `maintenance:read` |
| `GET` / `POST` | `/` | `maintenance:read` / `maintenance:write` |
| `GET` / `PATCH` | `/:id` | `maintenance:read` / `maintenance:write` |
| `PATCH` | `/:id/close` | `maintenance:write` |

### Fuel & Expenses — `/fuel-logs`, `/expenses`

`GET` (`cost:read`), `POST` and `DELETE /:id` (`cost:write`). List responses include
`meta.totals` covering the whole filtered set, not just the page.

### Dashboard — `/dashboard`

`GET /kpis?type=&region=` and `GET /alerts` — both `dashboard:read`.

### Reports — `/reports` *(all `report:read`)*

`/fuel-efficiency`, `/fleet-utilization`, `/operational-cost`, `/vehicle-roi`,
`/trip-profitability`, `/lane-profitability`, plus `/export.csv` and `/export.pdf`
(`?report=<key>`). All accept `?from=&to=`.

### Users — `/users` *(all `user:write`)*

`GET /unlinked-drivers`, `GET /`, `POST /`, `PATCH /:id/role`, `DELETE /:id`.

### Audit — `/audit` *(all `audit:read`)*

`GET /?entity=&entityId=&actorId=&action=&from=&to=` and `GET /:entity/:entityId`.

### Notifications — `/notifications` *(all `notification:trigger`)*

`POST /check-expiries?check=licenses|insurance|puc|service`, `GET /logs`, `GET /status`.

### Driver self-service — `/me` *(authenticated; resolves the caller's own driver record)*

`GET /profile`, `GET /current-trip`, `GET /trips`,
`POST /trips/:id/complete`, `POST /fuel-logs`, `POST /expenses`.

Every handler refuses to act on a trip that is not the caller's.

---

## 8. Business Logic & State Machines

### 8.1 Vehicle

```
                  create
                    ▼
 ┌──────────► AVAILABLE ◄─────────┐
 │              │      │           │  close (only when no other job is open)
 │   dispatch   ▼      ▼  open     │
 │          ON_TRIP  IN_SHOP ──────┘
 │              │
 │  complete /  │
 └── cancel ────┘

 AVAILABLE / IN_SHOP ──retire──► RETIRED ──reinstate──► AVAILABLE
```

Guards: cannot retire while `ON_TRIP` or with scheduled trips; cannot open a job for an
`ON_TRIP`/`RETIRED` vehicle, or a second concurrent job; closing never resurrects a retired vehicle.

### 8.2 Driver

```
 AVAILABLE ──dispatch──► ON_TRIP ──complete/cancel──► AVAILABLE
     │  ▲
     │  └── restore ─── SUSPENDED / OFF_DUTY
     └── archive ─────► ARCHIVED ──restore──► AVAILABLE
```

Every transition except dispatch runs through `PATCH /:id/status`, which validates the move and
refuses any change while `ON_TRIP`.

### 8.3 Trip

| Transition | Trip | Vehicle | Driver | Side effect |
|---|---|---|---|---|
| create → `DRAFT` | window, cargo, route, revenue | — | — | audit |
| `DRAFT` → `DISPATCHED` | `dispatchedAt`, `startOdometer` | → `ON_TRIP` | → `ON_TRIP` | audit |
| `DISPATCHED` → `COMPLETED` | `completedAt`, `endOdometer`, fuel, revenue | → `AVAILABLE`, odometer advanced | → `AVAILABLE` | audit + safety recompute + service check |
| → `CANCELLED` | `cancelledAt` | released only if dispatched | released only if dispatched | audit + safety recompute if dispatched |

All four run inside `prisma.$transaction`, with the audit write included.

### 8.4 Creation cascade

```
window coherent?                    → 400 VALIDATION_FAILED
vehicle exists / not retired?       → 404 / 400 ILLEGAL_TRANSITION
vehicle not in shop?                → 409 RESOURCE_BUSY
vehicle insurance valid?            → 400 ILLEGAL_TRANSITION
cargo ≤ maxLoadKg?                  → 400 CAPACITY_EXCEEDED
vehicle free for the window?        → 409 SCHEDULE_CONFLICT  (names the clashing trip)
driver exists / assignable?         → 404 / 400 ILLEGAL_TRANSITION
licence valid through plannedEnd?   → 400 LICENSE_EXPIRED
safetyScore ≥ 40?                   → 400 ILLEGAL_TRANSITION
driver free for the window?         → 409 SCHEDULE_CONFLICT
                                    → create DRAFT (+ rate-card revenue)
```

---

## 9. Domain Services

### `scheduling.service.js`

Interval overlap, the standard half-open comparison:

```js
// Two windows clash when each starts before the other ends.
where: {
  vehicleId,
  status: { in: ["DRAFT", "DISPATCHED"] },
  plannedStart: { lt: plannedEnd },
  plannedEnd:   { gt: plannedStart },
  ...(excludeTripId ? { id: { not: excludeTripId } } : {}),
}
```

`getAvailableVehicles` / `getAvailableDrivers` apply it as an exclusion, so a window with no
argument degrades to "free right now". `describeConflict()` renders the clashing trip for the
error message.

### `pricing.service.js`

```js
if (flatRate != null)  return flatRate;                    // flat wins
let revenue = 0;
if (ratePerKm != null)      revenue += ratePerKm * distanceKm;
if (ratePerTonneKm != null) revenue += ratePerTonneKm * (cargoWeightKg / 1000) * distanceKm;
return revenue > 0 ? round2(revenue) : null;               // null = no rate card
```

`explainRevenue()` returns the human basis shown next to the quote.

### `safety.service.js`

```
start 100
  − 15  per FINE on the driver's trips
  − 10  per cancellation after dispatch
  − 20  if the licence is currently expired
  +  2  per completed trip (capped at +10)
clamped to 0…100
```

Thresholds: warn below **60**, block below **40**. Recomputed on completion, cancellation, and
fine creation/removal; `POST /drivers/recalculate-scores` rebuilds the whole fleet.

---

## 10. Reporting Engine

Six builders behind a lookup table, each accepting an optional date range.

**Fuel efficiency** — distance from completed trips' odometer readings; litres from fuel logs
**linked to those trips**. Fuel that was never attributed is reported as `unattributedLiters`
rather than skewing the ratio, and each row states its `basis`.

**Fleet utilisation** — `onTrip ÷ (available + onTrip) × 100`. In-shop vehicles are not
deployable capacity. Identical to the dashboard KPI.

**Operational cost** — `fuel + maintenance + otherExpenses`, per vehicle. `MAINTENANCE`-type
expenses are rejected at write time, so nothing is counted twice.

**Vehicle ROI** — `(revenue − totalCost) ÷ acquisitionCost`, using the same cost definition.

**Trip profitability** — per trip: revenue, cost, margin, margin %, cost/km, and
planned-vs-actual distance.

**Lane profitability** — trips grouped by route, sorted **worst margin first**.

**CSV** quotes each cell with `JSON.stringify`. **PDF** streams via `pdfkit` with repeated
headers on each page and `en-IN` number grouping; a stream error after headers are sent destroys
the response rather than emitting a corrupt file.

---

## 11. External Integrations

All three are optional. `config/env.js` derives a `features` map at boot, each service exports an
`isXEnabled()` guard, and a disabled feature returns `INTEGRATION_DISABLED` with a clear message.

### Gemini — `gemini.client.js` + two extractors

A single lazily-constructed client shared by the licence and vehicle-document extractors. Both
prompt for a strict JSON shape with `YYYY-MM-DD` dates (directly consumable by
`<input type="date">`), strip markdown fences defensively, and validate the parsed shape.
`matchLicenseCategory()` maps the model's output onto the canonical `HMV | LMV | Transport` set,
returning `null` rather than letting a hallucinated category reach the form.

### Cloudinary — `cloudinary.service.js`

Promisified `upload_stream`. Vehicle documents land in `transitops/vehicle-documents`, licences
in `transitops/licenses`.

Both capture flows run extraction and upload through `Promise.allSettled`, so each half survives
the other's failure, and the response reports `extractionFailed` / `uploadFailed` independently.

### Nodemailer — `email.service.js`

One Gmail transporter verified at boot. `sendEmail()` never throws — it returns
`{ success, messageId | error }` and writes a `NotificationLog` row, so one bad address cannot
abort a batch and every attempt is auditable.

### Multer — `upload.middleware.js`

Memory storage, `image/*` only, 8 MB cap. `handleUploadErrors()` converts multer's errors into
the standard contract (`PAYLOAD_TOO_LARGE`, `VALIDATION_FAILED`) so uploads fail like everything
else.

---

## 12. Background Jobs

`notification.service.js`, started after `prisma.$connect()`:

```js
runAllChecks();                            // once at startup, visible in a demo
cron.schedule("*/30 * * * *", runAllChecks);
```

Four checks: **licences** (≤30 days or expired), **insurance**, **PUC**, **service due**.
Insurance and PUC also maintain their `*Expired` flags, including un-flagging on renewal.

**The cooldown.** Before sending, each check consults `NotificationLog`:

```js
const recent = await prisma.notificationLog.findFirst({
  where: { type, subjectId, success: true, sentAt: { gte: new Date(Date.now() - COOLDOWN_MS) } },
});
if (recent) return "skipped";
```

Without this, a driver inside the 30-day window would have been emailed every 30 minutes
indefinitely — roughly 1,440 emails a month.

---

## 13. Frontend Architecture

### Provider composition

```jsx
<ErrorBoundary>            {/* render crashes → recoverable message, not a blank page */}
  <ThemeProvider>          {/* .dark on <html>, persisted */}
    <ToastProvider>        {/* above Auth/Data so both can raise toasts */}
      <AuthProvider>       {/* session, capabilities, registers axios handlers */}
        <DataProvider>     {/* domain collections, capability-aware loading */}
          <TooltipProvider>
            <Router>
```

### `AuthContext`

Keeps the backend enum on `user.role` and exposes the label separately, so `ROLE_ACCESS` is keyed
by enum and a label change cannot break access control. Exposes `can(capability)` mirroring the
server table, and registers the axios bridge:

```js
registerApiHandlers({ onSessionExpired: handleSessionExpired, onToast: toast.push });
```

### `DataContext`

Fetches **only what the role may read**, via `Promise.allSettled`:

```js
if (can("vehicle:read")) tasks.push(["vehicles", refreshVehicles]);
if (can("cost:read"))    tasks.push(["fuel logs", refreshFuelLogs]);
// …
```

A partial failure warns and keeps the rest; only a total failure blanks the page. Previously
every collection was requested for every role, so a Safety Officer generated a burst of 403s.

Mutations reconcile from the server's response and re-fetch collections whose state changed
server-side (dispatch touches vehicles and drivers), then re-throw so the page can toast.

### Axios layer

```js
// Only a genuinely expired token is refreshable — bad credentials must not loop.
const isRefreshable = status === 401 && code === "TOKEN_EXPIRED"
                   && !isAuthEndpoint && !original._retried;
```

Parallel 401s collapse onto a single in-flight refresh, then replay. Uploads and downloads get a
120 s timeout; everything else 30 s.

### Route protection

`ProtectedRoute` waits for the session probe (spinner, never a flash of `/login`), then checks
`hasAccess(pathname)`. An unauthorised path **explains itself in a toast** and redirects to the
role's home — drivers land on `/my-trips`.

---

## 14. The Toast System

`components/ui/toast.jsx` (provider + portal) and `hooks/useToast.js` (the API).

```js
const toast = useToast();

toast.success("Vehicle added");
toast.apiError(err);                     // code → title, server message → body, tone by severity
toast.fromResponse(data);                // success message + any warnings[]
await toast.promise(save(), { loading: "Saving…", success: "Saved" });
```

`describeError()` maps `code` → title and picks the tone, so a *situation* (schedule conflict,
capacity exceeded) is styled as a warning while a *failure* (bad credentials, server error) is
styled as an error. Unreachable-server and timeout cases get their own messages instead of a
generic one.

Details: auto-dismiss scaled by severity (4–8 s) and paused on hover; `dedupeKey` collapses
repeats; `details.fields` renders as a "Check: …" hint; errors are `role="alert"` /
`aria-live="assertive"`; the stack is capped at four.

---

## 15. Configuration

`server/.env`:

```ini
PORT=8000
CORS_ORIGIN=http://localhost:5173
DATABASE_URL=postgresql://user:pass@localhost:5432/dbname

ACCESS_TOKEN_SECRET=…          ACCESS_TOKEN_EXPIRY=1d
REFRESH_TOKEN_SECRET=…         REFRESH_TOKEN_EXPIRY=7d
NODE_ENV=development

# Optional — each disables only its own feature
GEMINI_API_KEY=…
GMAIL_USER=…                   GMAIL_APP_PASSWORD=…
CLOUDINARY_CLOUD_NAME=…        CLOUDINARY_API_KEY=…    CLOUDINARY_API_SECRET=…

# Off by default
ALLOW_SELF_REGISTRATION=false
```

Client: `VITE_API_URL` (defaults to `http://localhost:8000`).

`config/env.js` fails fast on a missing `DATABASE_URL` or token secret, and logs which optional
features are active at boot.

---

## 16. Data Flow Walkthroughs

### 16.1 Booking a trip for Thursday

```
Trips → "Create Trip" → pick the window first
  └─► GET /trips/available-vehicles?plannedStart=…&plannedEnd=…   (debounced 300 ms)
      GET /trips/available-drivers?plannedStart=…&plannedEnd=…
        └ overlap query excludes anything already booked in that window

pick a customer
  └─► GET /customers/quote?… → "Rate card: ₹42,500 (₹42.50/km + ₹1.80/tonne-km)"

cargo weight typed
  └─ live: > selectedVehicle.maxLoadKg → field reddens, submit disables

submit
  └─► POST /trips  → full cascade → DRAFT (+ computed revenue) + audit
  └─► toast.fromResponse(): "Trip Mumbai → Delhi created"
      plus any warnings (e.g. a low safety score)

on conflict instead
  └─► 409 SCHEDULE_CONFLICT
      toast: "Scheduling conflict — Vehicle MH-12-AB-1234 is already booked: … "
```

### 16.2 A driver closing out a trip from the road

```
/my-trips  → GET /me/profile · /me/current-trip · /me/trips
  └ licence banner if expiring; fuel and expenses logged so far

"Log Fuel" → POST /me/fuel-logs { tripId, liters, cost }
  └ server verifies the trip belongs to this driver, is DISPATCHED,
    and attributes the fuel to the trip's vehicle
  └► toast: "120 L logged — ₹10,800"

"Complete Trip" → POST /me/trips/:id/complete { endOdometer }
  └ odometer cannot go backwards
  └ $transaction: trip → COMPLETED · vehicle → AVAILABLE (odometer advanced) · driver → AVAILABLE · audit
  └ safety score recomputed
  └► toast: "Trip completed — 1,247 km recorded. Well done!"
     + warnings: distance variance, service due
```

### 16.3 Capturing vehicle documents

```
Fleet → "Add Vehicle" → choose 1–5 images (local previews via useObjectUrl)

"Extract Details from Documents"
  └─► POST /vehicles/extract-documents (multipart)
        multer → memory buffers (image/*, ≤8 MB)
        Promise.allSettled([ geminiExtract, cloudinaryUploads ])
        → { …fields, documentUrls, extractionFailed, uploadFailed }

  ├─ both ok        → fields pre-filled; toast "Details extracted"
  ├─ scan failed    → images kept;       toast "Partly completed — type the fields in manually"
  └─ upload failed  → fields kept;       toast names what did not save

submit → POST /vehicles (+ documentUrls) → insuranceExpired / pucExpired computed on write
```

### 16.4 A session expiring mid-use

```
any request → 401 { code: "TOKEN_EXPIRED" }
  └─ interceptor: single in-flight POST /auth/refresh-token (parallel 401s queue behind it)
      ├─ ok    → replay the original request; the user notices nothing
      └─ fails → onSessionExpired() → clear user → toast "Session expired" (deduped) → /login
```

---

## 17. Build, Run & Seed

### Server

| Command | Effect |
|---|---|
| `npm run dev` | nodemon |
| `npm start` | node |
| `npm run seed:data` | vehicles, drivers, customers, trips, costs, maintenance; reconciles statuses; computes safety scores |
| `npm run seed:users` | one login per role, including the linked driver account |
| `npx prisma migrate dev` | apply migrations |
| `npx prisma studio` | database GUI |

Both seeds are **idempotent** — upserted on natural keys, with trips matched on
`(source, destination, vehicle)`. Trip dates are relative to *now*, so demo data is never stale.
Run `seed:data` before `seed:users`.

### Client

| Command | Effect |
|---|---|
| `npm run dev` | Vite on `:5173` |
| `npm run build` | production bundle |
| `npm run lint` | ESLint 9 flat config (with `react/jsx-uses-vars`, so JSX-only identifiers are not false-flagged) |

---

## Appendix — Endpoint Index

```
POST   /api/v1/auth/register                     (disabled unless ALLOW_SELF_REGISTRATION)
POST   /api/v1/auth/login
POST   /api/v1/auth/refresh-token
POST   /api/v1/auth/logout                       [auth]
GET    /api/v1/auth/current-user                 [auth]
POST   /api/v1/auth/change-password              [auth]

GET    /api/v1/vehicles                          vehicle:read
POST   /api/v1/vehicles                          vehicle:write
POST   /api/v1/vehicles/extract-documents        vehicle:write
GET    /api/v1/vehicles/:id                      vehicle:read
PATCH  /api/v1/vehicles/:id                      vehicle:write
DELETE /api/v1/vehicles/:id                      vehicle:retire
PATCH  /api/v1/vehicles/:id/reinstate            vehicle:retire

GET    /api/v1/drivers                           driver:read
POST   /api/v1/drivers                           driver:write
POST   /api/v1/drivers/extract-license           driver:write
POST   /api/v1/drivers/recalculate-scores        driver:write
GET    /api/v1/drivers/:id                       driver:read
PATCH  /api/v1/drivers/:id                       driver:write
DELETE /api/v1/drivers/:id                       driver:archive
PATCH  /api/v1/drivers/:id/suspend               driver:suspend
PATCH  /api/v1/drivers/:id/status                driver:suspend
PATCH  /api/v1/drivers/:id/restore               driver:archive

GET    /api/v1/trips/available-vehicles          trip:write
GET    /api/v1/trips/available-drivers           trip:write
GET    /api/v1/trips/schedule                    trip:read
GET    /api/v1/trips                             trip:read
POST   /api/v1/trips                             trip:write
GET    /api/v1/trips/:id                         trip:read
PATCH  /api/v1/trips/:id                         trip:write
POST   /api/v1/trips/:id/dispatch                trip:dispatch
POST   /api/v1/trips/:id/complete                trip:dispatch
POST   /api/v1/trips/:id/cancel                  trip:dispatch

GET    /api/v1/customers/quote                   customer:read
GET    /api/v1/customers                         customer:read
POST   /api/v1/customers                         customer:write
GET    /api/v1/customers/:id                     customer:read
PATCH  /api/v1/customers/:id                     customer:write
DELETE /api/v1/customers/:id                     customer:write

GET    /api/v1/maintenance/service-due           maintenance:read
GET    /api/v1/maintenance                       maintenance:read
POST   /api/v1/maintenance                       maintenance:write
GET    /api/v1/maintenance/:id                   maintenance:read
PATCH  /api/v1/maintenance/:id                   maintenance:write
PATCH  /api/v1/maintenance/:id/close             maintenance:write

GET    /api/v1/fuel-logs                         cost:read
POST   /api/v1/fuel-logs                         cost:write
DELETE /api/v1/fuel-logs/:id                     cost:write

GET    /api/v1/expenses                          cost:read
POST   /api/v1/expenses                          cost:write
DELETE /api/v1/expenses/:id                      cost:write

GET    /api/v1/dashboard/kpis                    dashboard:read
GET    /api/v1/dashboard/alerts                  dashboard:read

GET    /api/v1/reports/fuel-efficiency           report:read
GET    /api/v1/reports/fleet-utilization         report:read
GET    /api/v1/reports/operational-cost          report:read
GET    /api/v1/reports/vehicle-roi               report:read
GET    /api/v1/reports/trip-profitability        report:read
GET    /api/v1/reports/lane-profitability        report:read
GET    /api/v1/reports/export.csv                report:read
GET    /api/v1/reports/export.pdf                report:read

GET    /api/v1/users/unlinked-drivers            user:write
GET    /api/v1/users                             user:write
POST   /api/v1/users                             user:write
PATCH  /api/v1/users/:id/role                    user:write
DELETE /api/v1/users/:id                         user:write

GET    /api/v1/audit                             audit:read
GET    /api/v1/audit/:entity/:entityId           audit:read

POST   /api/v1/notifications/check-expiries      notification:trigger
GET    /api/v1/notifications/logs                notification:trigger
GET    /api/v1/notifications/status              notification:trigger

GET    /api/v1/me/profile                        [auth · own driver record]
GET    /api/v1/me/current-trip                   [auth · own driver record]
GET    /api/v1/me/trips                          [auth · own driver record]
POST   /api/v1/me/trips/:id/complete             [auth · own trip only]
POST   /api/v1/me/fuel-logs                      [auth · own trip only]
POST   /api/v1/me/expenses                       [auth · own trip only]
```
