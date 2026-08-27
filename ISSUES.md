# TransitOps — Defect & Flaw Audit

> ## ✅ All 38 findings in this document have been fixed.
>
> This file is kept as the **historical audit record** — it describes the code as it was
> *before* remediation, so the reasoning behind each fix stays legible.
>
> For what changed, how, and the verification evidence, see **[`FIXES.md`](FIXES.md)**.
> Verification: 61 end-to-end assertions against the live API — 61 passed, 0 failed.

A full-codebase review of `client/` and `server/`. Findings are grouped by severity and each one
names the exact file, the mechanism, the observable impact, and the fix.

Findings marked **[verified]** were reproduced by executing code against this repository, not
inferred from reading it.

| Severity | Count |
|---|---|
| 🔴 Critical — breaks a feature or the security model | 3 |
| 🟠 High — wrong behaviour a user will hit | 7 |
| 🟡 Medium — logic gaps, incorrect numbers, dead paths | 11 |
| 🔵 Low — polish, dead code, inconsistency | 9 |
| 🧭 Ideation / product-design gaps | 8 |

---

## 🔴 Critical

### #1 — `dotenv.config()` runs *after* the module graph, so Cloudinary, Gemini and Nodemailer all start with no credentials **[verified]**

**Files:** [server/index.js:1](server/index.js:1), [server/src/services/cloudinary.service.js:3](server/src/services/cloudinary.service.js:3), [server/src/services/license.service.js:3](server/src/services/license.service.js:3), [server/src/services/vehicleDocument.service.js:3](server/src/services/vehicleDocument.service.js:3), [server/src/services/email.service.js:4](server/src/services/email.service.js:4)

```js
// index.js
import dotenv from "dotenv";
dotenv.config({ path: "./.env" });   // ← this line runs LAST
import app from "./app.js";          // ← hoisted; the whole tree evaluates FIRST
```

In ES Modules, **all `import` declarations are hoisted and their modules fully evaluated before any
statement in the importing module's body runs.** So `app.js` → routes → controllers → services are
all evaluated before `dotenv.config()` executes. Every service that reads `process.env` at module
scope therefore reads `undefined`.

Reproduced in this repo:

```
$ node probe.mjs
probe (module tree) sees GEMINI_API_KEY: false | CLOUDINARY: false
◇ injected env (14) from .env
index body ran, GEMINI set? true

$ node probe-cloudinary.mjs
cloudinary cloud_name at runtime: undefined | api_key: UNSET

$ node probe-upload.mjs
UPLOAD ERROR: Must supply api_key

$ node probe-gemini.mjs
API key should be set when using the Gemini API.
constructed with undefined apiKey OK; stored key: undefined
```

**Impact — three features are dead at runtime:**

| Feature | Failure |
|---|---|
| Vehicle document upload | `Must supply api_key` → **500** from `POST /vehicles/extract-documents` |
| Gemini extraction (both licence and vehicle) | client built with `apiKey: undefined` → every call fails |
| Expiry emails | Nodemailer transporter has `auth: { user: undefined, pass: undefined }` → `verify()` fails at boot, every send fails |

Prisma survives only by luck: `@prisma/client` loads `.env` itself (that `◇ injected env (14)` line
is Prisma's loader, not dotenv's), which is why the database works while nothing else does.

**Fix** — make env loading a side effect of the *first import*:

```js
// index.js — line 1, before every other import
import "dotenv/config";

import app from "./app.js";
import prisma from "./src/db/prisma.js";
import { startExpiryCron } from "./src/services/notification.service.js";
```

`import "dotenv/config"` is itself hoisted, and ESM evaluates hoisted modules in source order — so
it runs before `app.js`. A stricter alternative is a dedicated `src/config/env.js` that loads and
validates every required variable, imported first everywhere.

> This is the single most important fix in the repository. Do it before any demo.

---

### #2 — Role-based access control is enforced only in the browser

**Files:** [client/src/data/mockData.js:477](client/src/data/mockData.js:477), [server/src/routes/vehicle.routes.js:15](server/src/routes/vehicle.routes.js:15), [server/src/routes/driver.routes.js:16](server/src/routes/driver.routes.js:16), [server/src/routes/trip.routes.js:16](server/src/routes/trip.routes.js:16)

`authorizeRoles()` is correctly implemented in `auth.middleware.js` but applied to exactly **one**
mounted router: `/users`. Meanwhile three routers have their authentication commented out entirely:

```js
// vehicle.routes.js, driver.routes.js, trip.routes.js
// router.use(verifyJWT);
```

Consequences, all reachable with `curl` and no credentials at all:

```bash
curl http://localhost:8000/api/v1/vehicles                    # full fleet registry
curl http://localhost:8000/api/v1/drivers                     # names, emails, licence numbers, phones
curl -X DELETE http://localhost:8000/api/v1/drivers/<id>      # permanently deletes a driver
curl -X POST http://localhost:8000/api/v1/trips/<id>/cancel   # cancels anyone's trip
```

Driver records are personal data — full name, email, phone number and government licence number —
exposed unauthenticated.

And even on the routers that *do* require a JWT, any authenticated user of any role can call any
endpoint. A Financial Analyst can close maintenance logs; a Dispatcher can pull the full cost
ledger. `ROLE_ACCESS` only decides which links the sidebar renders.

**Fix, in two parts:**

1. Uncomment `router.use(verifyJWT)` in all three routers.
2. Apply `authorizeRoles` per route, mirroring `ROLE_ACCESS`:

```js
router.use(verifyJWT);
router.route("/")
  .get(authorizeRoles("ADMIN", "FLEET_MANAGER", "DISPATCHER"), getVehicles)
  .post(authorizeRoles("ADMIN", "FLEET_MANAGER"), createVehicle);
```

The cleanest version is a single shared permission table imported by both the routers and the
client, so the two can never drift.

---

### #3 — Cloudinary upload failure takes down the whole extraction request

**File:** [server/src/controllers/vehicle.controller.js:18](server/src/controllers/vehicle.controller.js:18)

```js
const [extractedResult, uploads] = await Promise.all([
  extractVehicleDocumentDetails(files).catch((err) => { … return null; }),  // ✅ guarded
  Promise.all(files.map((file) => uploadImageBuffer(file.buffer, { … }))),  // ❌ unguarded
]);
```

The comment above this block states the intent correctly — *"Uploads must succeed independently of
extraction"* — but the protection is one-directional. Extraction failure is tolerated; **upload
failure rejects the whole `Promise.all` and 500s the request**, discarding a successful extraction.

Combined with #1 (uploads currently always fail), the entire "Extract Details from Documents"
button returns 500 and the user sees only a generic error.

**Fix** — make the guard symmetric and report partial success:

```js
const [extractedResult, uploadResults] = await Promise.all([
  extractVehicleDocumentDetails(files).catch(() => null),
  Promise.allSettled(files.map((f) => uploadImageBuffer(f.buffer, { folder: "transitops/vehicle-documents" }))),
]);

const documentUrls = uploadResults
  .filter((r) => r.status === "fulfilled")
  .map((r) => r.value.secure_url);

return res.status(200).json({
  success: true,
  extractionFailed: !extractedResult,
  uploadFailed: documentUrls.length < files.length,
  data: { ...(extractedResult ?? EMPTY_EXTRACTION), documentUrls },
});
```

---

## 🟠 High

### #4 — The notification router is written but never mounted

**Files:** [server/src/routes/notification.routes.js:1](server/src/routes/notification.routes.js:1), [server/app.js:41](server/app.js:41)

`notification.routes.js` and `notification.controller.js` both exist and are correct, but `app.js`
never imports or mounts the router. `POST /api/v1/notifications/check-expiries` returns 404, so
there is no way to trigger an expiry sweep on demand — during a demo you must wait for the cron or
restart the server.

The file also still carries its scaffolding comment:

```js
// ⚠ ADJUST THESE TWO LINES to match your actual middleware file/exports.
// I don't have the contents of your auth.middleware.js, so this is a placeholder…
```

The imports it guesses at are in fact correct — the comment is stale and should be deleted.

**Fix:**

```js
import notificationRouter from "./src/routes/notification.routes.js";
app.use("/api/v1/notifications", notificationRouter);
```

---

### #5 — Driver licence images are uploaded nowhere, so `licenseFrontUrl` / `licenseBackUrl` are never populated

**Files:** [server/src/controllers/driver.controller.js:18](server/src/controllers/driver.controller.js:18), [client/src/pages/Drivers.jsx:158](client/src/pages/Drivers.jsx:158)

`Driver.licenseFrontUrl` and `licenseBackUrl` exist in the schema and in the migration.
`createDriver` will persist them if given. But nothing ever produces them:

- `extractDriverLicense` reads the two buffers, sends them to Gemini, and **discards them** — no
  Cloudinary call, unlike the vehicle equivalent.
- `Drivers.jsx` `handleExtractLicense` copies name / number / category / expiry into the form and
  never touches the URLs.
- The submit payload is `{ ...formValues, safetyScore }` — no URL fields.

So the columns are permanently `NULL`, and the audit trail that exists for vehicle documents does
not exist for licences. This is an inconsistency between two features that were meant to be
symmetric.

**Fix** — mirror the vehicle flow in `extractDriverLicense`: upload both buffers to
`transitops/licenses`, return the URLs alongside the extracted fields, and include them in the
create payload.

---

### #6 — Password rules disagree across three places

**Files:** [client/src/pages/Login.jsx:165](client/src/pages/Login.jsx:165), [server/src/controllers/user.controller.js:33](server/src/controllers/user.controller.js:33), [server/src/controllers/auth.controller.js:21](server/src/controllers/auth.controller.js:21)

| Location | Minimum length |
|---|---|
| `Login.jsx` validation | **3** characters |
| `Users.jsx` create form | 8 characters |
| `POST /users` (admin creation) | 8 characters |
| `POST /auth/register` (self-registration) | **none at all** |

Public self-registration accepts a one-character password. There is no complexity requirement, no
rate limiting on login, and no account lockout anywhere.

**Fix** — extract one validation module used by both the register and create-user paths (minimum
8 characters plus a complexity rule), and align the login form's `minLength` with it.

---

### #7 — Public self-registration exists and cannot be disabled

**File:** [server/src/routes/auth.routes.js:9](server/src/routes/auth.routes.js:9)

`POST /api/v1/auth/register` is unauthenticated and creates a user with the schema default role
`DRIVER`. Anyone who can reach the API can mint an account.

The blast radius is currently limited on the client — `ROLE_LABELS` has no `DRIVER` entry, so
`ROLE_ACCESS[user.role]` is `undefined` and `hasAccess()` allows only `/dashboard` and `/settings`.
But combined with #2, that account (or no account at all) can call every vehicle, driver and trip
endpoint directly.

The product intent is clearly admin-provisioned accounts — that is what `/users` is for. The
register endpoint contradicts it.

**Fix** — remove the route, or gate it behind `verifyJWT + authorizeRoles("ADMIN")` and delete the
cookie-setting/auto-login behaviour that only makes sense for self-signup.

---

### #8 — `User.username` is not unique, but the code treats it as if it were

**Files:** [server/prisma/schema.prisma:59](server/prisma/schema.prisma:59), [server/src/controllers/auth.controller.js:27](server/src/controllers/auth.controller.js:27)

```prisma
model User {
  email    String @unique
  username String            // ← no @unique
}
```

Three consequences:

1. `registerUser` checks `findFirst({ OR: [{ email }, { username }] })` before inserting — a
   read-then-write with no database constraint behind it, so two concurrent registrations can both
   pass the check and both insert the same username.
2. The `P2002` handler for duplicate usernames can never fire, because no unique index exists.
3. `loginUser` accepts login by username via `findFirst`. With duplicate usernames, *which* account
   you authenticate against is arbitrary.

**Fix** — add `@unique` to `username` and generate a migration (de-duplicating existing rows
first), or drop username-based login and treat username as a display name only.

---

### #9 — A vehicle can have several concurrent open maintenance logs; closing any one releases it

**File:** [server/src/controllers/maintenance.controller.js:4](server/src/controllers/maintenance.controller.js:4)

`createMaintenanceLog` rejects vehicles that are `ON_TRIP` or `RETIRED`, but not vehicles that are
already `IN_SHOP`. So:

1. Open log A → vehicle `IN_SHOP`
2. Open log B → still `IN_SHOP` (the second write is a no-op)
3. Close log A → **vehicle → `AVAILABLE`** while log B is still `OPEN`

The vehicle is now dispatchable while an open work order says it is in the shop.

**Fix** — either reject a new log when an `OPEN` one exists for that vehicle, or make close
conditional:

```js
const remainingOpen = await prisma.maintenanceLog.count({
  where: { vehicleId: log.vehicleId, status: "OPEN", id: { not: log.id } },
});
// only include the vehicle.update in the transaction when remainingOpen === 0
```

---

### #10 — A suspended driver can never be reinstated through the API

**File:** [server/src/controllers/driver.controller.js:169](server/src/controllers/driver.controller.js:169)

`PATCH /drivers/:id/suspend` sets `status = SUSPENDED`. There is no unsuspend endpoint, and
`updateDriver` deliberately whitelists fields — `status` is not among them. Once suspended, a
driver is permanently unassignable; the only recovery is direct database access.

The `OFF_DUTY` enum value has the same problem in reverse: no code path ever sets it, so a driver
can never be marked temporarily unavailable (leave, rest period) at all.

**Fix** — add `PATCH /drivers/:id/status` accepting the valid transitions
(`AVAILABLE ↔ OFF_DUTY`, `SUSPENDED → AVAILABLE`), rejecting any change while `ON_TRIP`.

---

## 🟡 Medium

### #11 — Malformed Tailwind opacity classes render nothing

**File:** [client/src/pages/Trips.jsx:270](client/src/pages/Trips.jsx:270)

```jsx
<TabsList className="bg-muted/80/80 p-1 rounded-lg w-full grid grid-cols-4">
…
<span className="… bg-muted-foreground/20/80 text-muted-foreground …">
```

`bg-muted/80/80` and `bg-muted-foreground/20/80` carry two opacity modifiers. Tailwind cannot parse
them, so no class is generated — the tab strip and the per-tab count pills have no background at
all. This looks like a bad find-and-replace during the dark-mode migration.

**Fix:** `bg-muted/80` and `bg-muted-foreground/20`.

---

### #12 — "Operational cost" means two different things in two places

**Files:** [server/src/controllers/report.controller.js:60](server/src/controllers/report.controller.js:60), [client/src/pages/FuelExpenses.jsx:85](client/src/pages/FuelExpenses.jsx:85)

| Source | Formula |
|---|---|
| `/reports/operational-cost` and the Analytics KPI | `fuel + maintenance` — **`Expense` rows are excluded entirely** |
| The Fuel & Expenses banner | `fuel + maintenance + expenses` |

The same user sees two different "total operational cost" figures on two pages. Worse, tolls,
parking and fines — real operating costs the app goes out of its way to capture — are silently
omitted from the ROI calculation, systematically overstating every vehicle's return.

There is also a latent double-count: `ExpenseType.MAINTENANCE` exists, so a repair logged as an
expense *and* as a maintenance log is counted twice in the Fuel & Expenses banner.

**Fix** — pick one definition (`fuel + maintenance + expenses` is the correct one), apply it in
`buildOperationalCostReport` and `buildVehicleRoiReport`, and either remove `ExpenseType.MAINTENANCE`
or exclude it from the sum with a documented rule.

---

### #13 — Fuel efficiency mixes a filtered numerator with an unfiltered denominator

**File:** [server/src/controllers/report.controller.js:22](server/src/controllers/report.controller.js:22)

```js
const totalDistance   = vehicle.trips.reduce(…);   // trips: { where: { status: "COMPLETED" } }
const totalFuelLiters = vehicle.fuelLogs.reduce(…); // ALL fuel logs, no filter
```

Distance counts only completed trips; litres count every fill ever recorded, including fuel burned
on cancelled trips or on non-trip movement. Every vehicle's km/L is therefore biased low, and the
bias grows with the proportion of cancelled trips.

There is also unused redundancy: `Trip.fuelConsumedL` is captured at completion but no report reads
it. Two competing sources of fuel truth exist and neither is reconciled.

**Fix** — restrict litres to fuel logs linked to completed trips, or (better) define the report over
trips: `Σ(endOdometer − startOdometer) / Σ fuelConsumedL` for completed trips, and either drop
`fuelConsumedL` or drop the trip-linked fuel logs.

---

### #14 — Selects wired with `setValue` bypass validation, so empty required fields reach the API

**Files:** [client/src/pages/Maintenance.jsx:142](client/src/pages/Maintenance.jsx:142), [client/src/pages/FuelExpenses.jsx:231](client/src/pages/FuelExpenses.jsx:231)

Three forms wire Radix selects as `onValueChange={(val) => setValue('field', val)}` +
`value={watch('field')}` instead of `<Controller>`. Because the field was never registered with
rules, `handleSubmit` treats it as valid when empty:

| Form | Unvalidated required fields |
|---|---|
| Create Maintenance | `vehicleId`, `description` |
| Add Fuel Log | `vehicleId` |
| Add Expense | `vehicleId`, `type` |

Submitting with the select untouched sends `vehicleId: ""`, and the user gets a raw backend
message — *"vehicleId and description are required"* — instead of inline field errors. The
`errors.description` block in `Maintenance.jsx` can never render.

**Fix** — convert all of them to `<Controller … rules={{ required: '…' }}>`, matching the pattern
already used correctly in `Trips.jsx` and `Fleet.jsx`.

---

### #15 — `GET /auth/refresh-token` is a GET that reads `req.body`, and nothing ever calls it

**Files:** [server/src/routes/auth.routes.js:11](server/src/routes/auth.routes.js:11), [server/src/controllers/auth.controller.js:240](server/src/controllers/auth.controller.js:240), [client/src/api/auth.js:19](client/src/api/auth.js:19)

```js
router.route('/refresh-token').get(refreshAccessToken);
…
const incomingRefreshToken = req.cookies?.refreshToken || req.body?.refreshToken;
```

A GET request has no body, so the fallback is unreachable. More importantly there is **no axios
response interceptor**: `refreshAccessToken()` is exported from `api/auth.js` and never imported
anywhere. When the 1-day access token expires, every request returns 401, `DataContext` sets a
generic "Failed to load fleet data", and the user is stranded on a broken page rather than being
silently refreshed or redirected to login.

The refresh token is also never rotated — `refreshAccessToken` issues a new access token but leaves
the old refresh token valid for its full 7 days.

**Fix:**

1. Change the route to `POST`.
2. Add an axios interceptor: on 401, call refresh once, replay the original request, and on refresh
   failure clear the user and redirect to `/login`.
3. Rotate the refresh token on each use and persist the new one.

---

### #16 — `sameSite: "strict"` cookies will break the moment the app is deployed

**File:** [server/src/controllers/auth.controller.js:6](server/src/controllers/auth.controller.js:6)

```js
const cookieOptions = { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "strict" };
```

This works in development because `localhost:5173` and `localhost:8000` share a site (ports are not
part of the same-site computation). In production — `app.example.com` calling `api.example.com`, or
Vercel calling Render — the browser will refuse to send the cookies and every request will be 401
with no visible error.

**Fix:** `sameSite: "none"` with `secure: true` for cross-site production deployments (or serve
both from one origin behind a reverse proxy and keep `strict`).

---

### #17 — `fleetUtilization` counts vehicles in the shop as utilisable capacity

**Files:** [server/src/controllers/dashboard.controller.js:38](server/src/controllers/dashboard.controller.js:38), [server/src/controllers/report.controller.js:41](server/src/controllers/report.controller.js:41)

```js
activeVehicles = count(status != RETIRED)          // includes IN_SHOP
fleetUtilization = onTripVehicles / activeVehicles * 100
```

A vehicle in the shop cannot be dispatched, so including it in the denominator understates
utilisation and makes the metric move when maintenance opens or closes — which is not what a
utilisation metric should measure.

It is also an instantaneous snapshot, not time-weighted, so it swings wildly through the day and
means very little as a daily figure.

**Fix** — decide explicitly: either `onTrip / (AVAILABLE + ON_TRIP)` for "capacity in use", or
compute a proper time-weighted utilisation over a date range from `dispatchedAt` / `completedAt`.
Whichever is chosen, use the same formula in both the dashboard and the report.

---

### #18 — The dashboard's KPI filters and trip table filter on different things

**File:** [client/src/pages/Dashboard.jsx:68](client/src/pages/Dashboard.jsx:68)

The type and region filters are sent to `GET /dashboard/kpis`, where they are applied **only to the
vehicle counts** — `activeTrips`, `pendingTrips` and `driversOnDuty` ignore them entirely. Meanwhile
the trips table below applies all three filters client-side.

So with `type = Truck` selected: the vehicle KPIs are truck-only, the trip KPIs are fleet-wide, and
the table is truck-only. Three different scopes on one screen.

**Fix** — either apply the vehicle filter to the trip and driver counts server-side (join through
`trip.vehicle`), or label the KPI strip as fleet-wide and move the filters onto the table alone.

---

### #19 — Dead file with a destructive top-level side effect

**File:** [server/src/utils/extractLicense.js:1](server/src/utils/extractLicense.js:1)

An early prototype superseded by `services/license.service.js`. Nothing imports it — verified — but
it still ends with a bare top-level call:

```js
extractLicense("./DriversLicense.jpeg", "./DriversLicenseBack.jpeg");
```

Any future `import` of this file — or any tooling that eagerly loads `utils/` — fires a Gemini API
call and crashes with `ENOENT` because those two JPEGs are not in the repository. It also carries a
second `dotenv.config()`, hiding the class of bug described in #1.

**Fix:** delete the file.

---

### #20 — `POST /vehicles` rejects legitimate zero values

**File:** [server/src/controllers/vehicle.controller.js:66](server/src/controllers/vehicle.controller.js:66)

```js
if (!registrationNo || !name || !type || !maxLoadKg || !acquisitionCost) { … 400 … }
```

`!0` is `true`, so `maxLoadKg: 0` or `acquisitionCost: 0` is rejected as "missing". A leased vehicle
with no acquisition cost, or a passenger car with no rated cargo load, cannot be registered. The
same falsy-check pattern would reject `""` for a legitimately empty string field.

Compare `trip.controller.js`, which gets this right with `cargoWeightKg == null`.

**Fix:** use `== null` checks and validate ranges separately.

---

### #21 — No pagination anywhere

**Files:** all list endpoints; [client/src/contexts/DataContext.jsx:60](client/src/contexts/DataContext.jsx:60)

Every `GET` collection endpoint returns every row, and `DataProvider` loads all six collections into
memory on login. A fleet with two years of trips, fuel logs and expenses will ship tens of thousands
of rows on every page load, and the report builders `findMany` entire tables with all relations
included before aggregating in JavaScript.

This is fine for a hackathon dataset and will not survive a real depot.

**Fix** — add `?page=&limit=` with `skip`/`take`, move report aggregation into SQL (`groupBy` or raw
queries), and load per-page rather than all-at-once.

---

## 🔵 Low

### #22 — Duplicate body-parser registration

**File:** [server/app.js:17](server/app.js:17)

`express.json()` and `express.urlencoded()` are registered twice — once unlimited at lines 17-18,
then again with `limit: "16kb"` at lines 29-30. The **first** registration wins, so the 16 KB limit
is silently ineffective and the API accepts unbounded JSON bodies. Delete the first pair.

### #23 — CORS is configured after the body parsers

**File:** [server/app.js:21](server/app.js:21)

`cors()` should come before the body parsers so preflight requests short-circuit without parsing.
Functionally harmless here, but it is the wrong order.

### #24 — Leftover debug `console.log`s on hot paths

**Files:** [server/src/controllers/auth.controller.js:106](server/src/controllers/auth.controller.js:106), [server/src/controllers/vehicle.controller.js:49](server/src/controllers/vehicle.controller.js:49), [server/src/controllers/driver.controller.js:93](server/src/controllers/driver.controller.js:93), [server/src/services/notification.service.js:40](server/src/services/notification.service.js:40)

```js
console.log("Login request body:", req.body);   // ← logs plaintext passwords
console.log("Request body:", req.body);
console.log("Query parameters:", req.query);
console.log(driver)                             // full driver record, every cron tick
```

The first one writes user passwords to the server log in plaintext. Remove all four.

### #25 — Nonsense import left in Analytics

**File:** [client/src/pages/Analytics.jsx:3](client/src/pages/Analytics.jsx:3)

```js
import { useState as useStateAlias } from 'react'; // skip if already imported
```

An unused alias with a comment addressed to the author. Delete it.

### #26 — Topbar search and notification bell are non-functional

**File:** [client/src/components/layout/Topbar.jsx:49](client/src/components/layout/Topbar.jsx:49)

The global search input holds state but filters nothing — the placeholder promises "Search vehicles,
drivers, trips…". The notification bell has no handler and displays a permanently lit red dot
implying unread items that do not exist. Both look like working features in a demo. Either implement
them or remove them.

### #27 — Vehicle deletion is soft, driver deletion is hard

**Files:** [server/src/controllers/vehicle.controller.js:184](server/src/controllers/vehicle.controller.js:184), [server/src/controllers/driver.controller.js:195](server/src/controllers/driver.controller.js:195)

`retireVehicle` preserves history by design. `deleteDriver` calls `prisma.driver.delete()`. Since
`Trip.driverId` is a required foreign key, deleting a driver with any trip history throws a Prisma
foreign-key error surfaced as a generic 500 — so in practice only never-dispatched drivers are
deletable, and the failure mode is an opaque error rather than a clear message.

**Fix** — give `Driver` a `RETIRED`/`ARCHIVED` status and soft-delete it, matching the vehicle model.

### #28 — Eleven unused shadcn components ship in the bundle

**File:** `client/src/components/ui/`

`Glow`, `chart`, `avatar`, `progress`, `scroll-area`, `sheet`, `separator`, `textarea`, `calendar`,
`popover`, `switch` — zero imports across the codebase. Eight files (`alert`, `checkbox`, `dropdown-menu`, `popover`,
`scroll-area`, `separator`, `sheet`, `tooltip`) are `.tsx` while the other fifteen are `.jsx`, an inconsistency from `shadcn add` defaults.

Also unused: `utils/hashPassword.js` (controllers call `bcrypt` directly), and the exported-but-never-called
`getModuleAccess`, `getAccessibleRoutes`, `registerUser`, `getReportCsvUrl`, `getDriverById` and
`getMaintenanceLog`.

### #29 — `mockData.js` mixes live configuration with dead fixtures

**File:** [client/src/data/mockData.js:1](client/src/data/mockData.js:1)

The file is 523 lines. About 30 of them — `ROLE_ACCESS`, `ROLE_LABELS`, `GLOBAL_ROUTES`,
`ASSIGNABLE_ROLES`, `defaultSettings` — are **live application configuration** that the auth system
depends on. The other ~490 are obsolete demo fixtures (`initialVehicles`, `initialTrips`,
`monthlyRevenueData`, …) superseded by the API and imported by nothing.

Worse, the fixtures use a different field vocabulary than the real API — `registrationNumber` vs
`registrationNo`, `odometerKm` vs `odometer`, `plannedDistanceKm` vs `plannedDistance` — so anyone
reading this file for the data shape will get it wrong.

**Fix** — move the live config to `src/config/roles.js` and delete the fixtures.

### #30 — Settings are cosmetic

**File:** [client/src/pages/Settings.jsx:88](client/src/pages/Settings.jsx:88)

`updateSettings` writes to React state only — no endpoint, no localStorage. "Settings saved
successfully" appears, then a refresh discards everything. The currency and distance-unit selectors
are especially misleading: every page hardcodes `₹` and `km` regardless.

The RBAC matrix on the same page is also hand-maintained and already out of sync with the real
`ROLE_ACCESS`: it omits the Admin row entirely, and has no column for Maintenance or User
Management even though both are gated. It should be rendered *from* `ROLE_ACCESS` rather than
duplicated by hand.

---

## 🧭 Ideation & Product-Design Gaps

### #31 — Trips have no time dimension, so dispatch cannot be planned

The deepest conceptual gap. `Trip` has `dispatchedAt`, `completedAt` and `cancelledAt` — all
*records of what happened* — but no `plannedStart` or `plannedEnd`. Availability is therefore
strictly "is this vehicle free **right now**".

A dispatcher cannot answer *"which trucks are free on Thursday?"*, cannot book ahead, and cannot
detect that two planned trips overlap. `plannedDistance` is captured but never turned into an ETA.
Real fleet dispatch is fundamentally a calendar-and-constraint problem; this models a single
present-tense slot per vehicle.

**Direction:** add `plannedStart`/`plannedEnd`, make availability an interval-overlap query, and
present the dispatch board as a timeline rather than four status columns.

### #32 — `safetyScore` is a feature that does nothing

Stored on `Driver`, displayed with colour banding, editable in the form, and named after the Safety
Officer role — but **no code ever changes it and no rule ever reads it**. It is never affected by
fines (`ExpenseType.FINE` exists and is never correlated with a driver), by cancellations, or by
completions. The Safety Officer's entire module is CRUD plus a number nobody computes.

**Direction:** derive it — start at 100, deduct for fines on that driver's trips, for cancellations,
and for driving on a licence within N days of expiry; then use it as a dispatch input ("warn below
60, block below 40"). That would give the Safety Officer role an actual job.

### #33 — Trip revenue is entered by hand at completion, so ROI is unauditable

`Trip.revenue` is a free-text number typed into the completion dialog. There is no rate card, no
customer, no invoice, no validation. Every ROI figure the Analytics page shows rests on whatever
someone typed. There is also no `Customer` entity at all — a fleet management system with no notion
of who the load was for.

**Direction:** add `Customer` and a rate model (per-km, per-tonne-km, or flat per lane), compute
revenue from the trip's own attributes, and let it be overridden with a reason.

### #34 — Vehicles have no maintenance schedule, only reactive work orders

`MaintenanceLog` records repairs that already happened. Nothing schedules the *next* service. The
odometer is tracked precisely and advanced on every trip completion — the exact input a
"service due every 10,000 km" rule needs — and it is never used for that.

Similarly, `pucExpiry` is captured and displayed but, unlike `insuranceExpiry`, is never checked by
the cron and never blocks dispatch. Half a compliance feature.

**Direction:** add a service interval per vehicle, warn as the odometer approaches it, and extend
the expiry cron to PUC.

### #35 — Cost data is captured but never attributed to a decision

Fuel, maintenance and expenses all roll up per vehicle. But nothing computes cost *per trip* or cost
*per km*, and nothing compares actual against planned. `Expense` can link to a trip, and no report
uses that link. The system can say "this truck cost ₹3.2 L" but not "this Mumbai–Delhi lane loses
money" — which is the decision an operator actually needs to make.

**Direction:** add per-trip and per-lane profitability, and a planned-vs-actual variance on distance
and fuel.

### #36 — No audit trail on state changes

Every transition is a mutation with no actor. The system records that a trip was cancelled, but not
who cancelled it; that a driver was suspended, but not by whom or why; that a vehicle's insurance
number changed, but not who changed it or what it was before.

For a system whose entire pitch is compliance and accountability, this is a conspicuous absence —
and it is cheap to fix given that `req.user` is already available on the protected routes.

**Direction:** an `AuditLog` table (`actorId`, `entity`, `entityId`, `action`, `before`, `after`,
`at`), written from the same transaction as the mutation.

### #37 — Drivers are the subject of the system but never users of it

`User.driver` and `Driver.userId` exist, the `DRIVER` role exists in the enum, and
`mockData.js` explicitly excludes it: *"drivers are managed as Driver records, not login users"*.

So the person actually executing the trip has no way to see their assignment, mark themselves
en route, log a fuel fill from the pump, photograph a toll receipt, or report a breakdown. Every
data point about the trip must be re-entered by an office user after the fact — which is precisely
the manual-data-entry problem the AI extraction feature was built to solve, left unsolved at the
most important entry point.

**Direction:** a minimal driver view — my current trip, complete-with-odometer-photo, log fuel, log
expense. This is the highest-leverage missing feature in the product.

### #38 — Notifications are email-only and one-directional

The only channel is Gmail SMTP through a single hardcoded account. There is no in-app notification
centre (the bell in the Topbar is decorative — see #26), no SMS or WhatsApp — the channel Indian
fleet operators actually use — and no delivery record, so nobody can prove a driver was warned about
their licence.

There is also no dedupe window: `checkExpiringLicenses` has no equivalent of the `insuranceExpired`
latch used for vehicles, so **a driver inside the 30-day window is emailed every 30 minutes,
indefinitely** — roughly 1,440 emails per driver per month. This will get the Gmail account rate-limited
or suspended, and is arguably the most user-hostile bug in the codebase.

**Direction:** add a `NotificationLog` with a per-(driver, type) cooldown, persist notifications for
an in-app centre, and abstract the channel so SMS/WhatsApp can be added.

Minor, same file: the startup banner in `startExpiryCron()` announces *"every 10 min + on startup"*
while the schedule is `*/30 * * * *`, and the JSDoc above it says *"then every 10 minutes"*. The
code is right and both messages are stale.

---

## Suggested Fix Order

| # | Fix | Why first |
|---|---|---|
| 1 | **#1** — `import "dotenv/config"` at the top of `index.js` | One line; unbreaks three features |
| 2 | **#38** — cooldown on licence-expiry emails | Prevents the mail account being suspended |
| 3 | **#2** — re-enable `verifyJWT`, add `authorizeRoles` | Closes the unauthenticated data exposure |
| 4 | **#3** — `Promise.allSettled` for uploads | Makes document extraction resilient |
| 5 | **#11** — fix the malformed Tailwind classes | Visible breakage on the main dispatch screen |
| 6 | **#14** — `<Controller>` on the three broken forms | Users currently hit raw backend errors |
| 7 | **#12**, **#13**, **#17** — align the cost, fuel and utilisation formulas | The analytics currently contradict themselves |
| 8 | **#4**, **#19**, **#24**, **#25** — mount the router, delete dead code and debug logs | Quick hygiene |
| 9 | **#9**, **#10**, **#27** — maintenance concurrency, driver reinstatement, soft-delete | Correctness of the state machines |
| 10 | **#15**, **#16** — token refresh and cookie policy | Required before any real deployment |
