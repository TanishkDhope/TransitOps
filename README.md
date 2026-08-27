# TransitOps — Fleet Operations Management Platform

> An Odoo-Hackathon project: a full-stack, role-based fleet management system that turns a
> depot's spreadsheets, WhatsApp groups and paper document folders into a single operational
> source of truth — with interval-based scheduling, AI-assisted document entry, derived safety
> scoring, and automated compliance alerts.

**Documentation:** [`TECHNICAL.md`](TECHNICAL.md) (architecture & API) ·
[`ISSUES.md`](ISSUES.md) (audit record) · [`FIXES.md`](FIXES.md) (remediation report)

---

## 1. The Problem

Mid-sized logistics and transport operators (roughly 10–200 vehicles) run their day on a mix of:

- **Spreadsheets** for vehicle registries and driver rosters, edited by several people at once.
- **Phone calls and WhatsApp** for dispatch — *"is truck MH-12-AB-1234 free on Thursday?"*
- **Paper folders** for RC books, insurance policies and PUC certificates.
- **Nothing at all** for cost attribution — fuel bills, tolls and repairs are booked against the
  business as a whole, never against the vehicle or the lane that incurred them.

The consequences are concrete and expensive:

| Failure | Real-world cost |
|---|---|
| Double-booking a vehicle or driver | Cancelled load, penalty, angry customer |
| Dispatching on an expired driving licence | Fine, impounded vehicle, voided insurance |
| Missing an insurance or PUC renewal | Uninsured accident liability |
| Overloading a vehicle beyond its rated capacity | RTO fine, mechanical damage, safety risk |
| Skipping a scheduled service | Breakdown mid-route, far costlier repair |
| No per-lane cost tracking | The loss-making route is never identified, never repriced |

None of these are hard problems technically. They are *bookkeeping discipline* problems — which
is exactly what software is good at enforcing.

---

## 2. The Idea

**TransitOps makes the invalid state impossible to reach.**

Instead of a passive database that records whatever humans typed, the system models the fleet as
a set of **state machines** and refuses transitions that violate operating rules. A dispatcher
literally *cannot* double-book a truck, assign an expired licence, or overload a vehicle — the
API rejects it, and the UI tells the user exactly why.

Four design commitments follow from that:

**1. Status is derived, never hand-edited.**
A vehicle becomes `ON_TRIP` because a trip was dispatched; it becomes `IN_SHOP` because a
maintenance job was opened. Nobody sets a status directly, so statuses cannot drift from reality.

**2. Numbers are computed, not typed.**
Trip revenue comes from the customer's rate card. A driver's safety score is derived from fines,
cancellations and licence validity. Both can be overridden — but the override is visible and
audited, rather than being the only source of truth.

**3. Data entry is the bottleneck, so shrink it — at the point of capture.**
Photograph a driving licence or a vehicle's RC/insurance/PUC papers and a Gemini vision model
pre-fills the form for human review. Drivers log fuel and expenses from the road, so the office
is not re-keying receipts days later.

**4. Compliance should nag, not wait to be asked.**
A background job scans licence, insurance, PUC and service-interval status, and emails the people
who can act — once per issue, not once per scan.

---

## 3. Who Uses It — Roles

Six roles, all assignable to login users:

| Role | What they see | Why |
|---|---|---|
| **Admin** | Everything, plus User Management and the Audit Log | Owns the account, provisions staff |
| **Fleet Manager** | Dashboard, Fleet, Trips, Maintenance, Analytics | Owns the assets and their upkeep |
| **Dispatcher** | Dashboard, Trips, Fleet, Drivers, Customers | Owns scheduling and load assignment |
| **Safety Officer** | Dashboard, Drivers | Owns licence validity and safety scores |
| **Financial Analyst** | Dashboard, Fuel & Expenses, Customers, Analytics | Owns cost, pricing and ROI |
| **Driver** | My Trips | Runs the load; logs fuel, expenses and the closing odometer |

Access is enforced **on the server** by a capability table (`vehicle:write`, `trip:dispatch`,
`audit:read`, …). The client mirrors that table only to decide which buttons to render — it is
never the thing standing between a user and the data.

---

## 4. Core Domain Model

Nine entities:

```
User ──(optional)── Driver ──┐
                             ├── Trip ──┬── FuelLog
Customer ─────────── Trip ───┘          └── Expense
                    Vehicle ─┘
                       │
                       ├── MaintenanceLog
                       ├── FuelLog
                       └── Expense

AuditLog          (who changed what, and when)
NotificationLog   (what was sent to whom, and whether it landed)
```

- **Vehicle** — the asset. Registration, capacity, odometer, acquisition cost, the compliance
  document set (RC / insurance / PUC + Cloudinary images), and a **service interval**.
- **Driver** — the operator. Licence number, category, expiry, contact, and a **derived** safety
  score. Optionally linked to a `User` login for self-service.
- **Customer** — who the load is for, and the **rate card** that prices it.
- **Trip** — the unit of work, with a **planned start and end**, cargo weight, distance, and on
  completion the odometer readings, fuel and revenue.
- **MaintenanceLog** — an open/closed work order that drives the vehicle in and out of the shop.
- **FuelLog / Expense** — the cost ledger, attributable to a vehicle and optionally a trip.
- **AuditLog / NotificationLog** — the accountability record.

---

## 5. The Operating Logic

### 5.1 The Trip lifecycle — the heart of the product

```
          create                dispatch                 complete
  ─────────────────► DRAFT ─────────────────► DISPATCHED ──────────────► COMPLETED
                       │                          │
                       └──────── cancel ──────────┴──────► CANCELLED
```

**On create**, the API validates a cascade — and every failure names the specific thing that is
wrong, which is what the user sees in the toast:

1. The planned window is coherent (`plannedEnd > plannedStart`)
2. Vehicle exists, is not retired, in the shop, or **already booked for that window**
3. Vehicle's insurance is valid
4. `cargoWeightKg` ≤ the vehicle's `maxLoadKg`
5. Driver exists, is not suspended or archived, and is **free for that window**
6. The driver's licence is valid *for the whole trip*, not merely today
7. The driver's safety score is above the dispatch floor

> *"Vehicle MH-12-AB-1234 is already booked: Pune → Surat (10 Sept, 01:30 pm – 11:30 pm)."*

**On dispatch** (an atomic transaction), the checks are re-run — the world may have moved since
the draft was made — then the trip, vehicle and driver all change state together.

**On complete**, with a mandatory odometer reading that cannot go backwards: the vehicle's
odometer advances, both resources are released, the driver's safety score is recomputed, and the
response carries warnings if the actual distance diverged from plan or the vehicle is now due
for service.

**On cancel**, resources are released only if they were actually reserved.

### 5.2 Scheduling

Availability is an **interval-overlap query**, not "is it idle right now". That is what makes
*"which trucks are free on Thursday?"* answerable, and what makes double-booking structurally
impossible rather than merely discouraged.

### 5.3 The Maintenance lifecycle

Opening a job moves the vehicle to `IN_SHOP`; closing it returns the vehicle to `AVAILABLE` —
**unless another job is still open**. Only one open work order per vehicle at a time.

A job can be flagged as a full service, which resets the preventive-maintenance counter against
the vehicle's current odometer.

### 5.4 Retirement and archival, not deletion

Vehicles are retired and drivers are archived; both preserve history so analytics stay truthful.
Neither can be removed while they have scheduled trips, and both can be brought back.

### 5.5 AI-assisted document capture

| Flow | Input | Extracted |
|---|---|---|
| **Driver licence** | Front + back photo | name, licence number, category, expiry |
| **Vehicle documents** | 1–5 photos (RC / insurance / PUC) | RC no., policy no., insurance expiry, PUC no., PUC expiry |

Both upload the images to Cloudinary *and* run extraction, independently — a model failure still
preserves the images, an upload failure still returns the extracted fields, and the response says
which half succeeded. The model never writes to the database; it only pre-fills a form.

### 5.6 Derived safety scoring

Every driver starts at 100. The score is recomputed from primary records — fines on their trips,
cancellations after dispatch, licence validity, and completed trips. It is not editable by hand.

Below **60** dispatch raises a warning; below **40** it is refused.

### 5.7 Automated compliance watch

A `node-cron` job runs at startup and every 30 minutes, covering **licences, insurance, PUC and
service intervals**. Every send is recorded in `NotificationLog`, and a per-(subject, type)
cooldown means an affected person is notified once per issue — not every 30 minutes forever.

---

## 6. Analytics and Reporting

Six reports, computed live from the transactional tables:

| Report | Formula |
|---|---|
| **Fuel efficiency** | trip distance ÷ **trip-linked** litres, per vehicle (unattributed fuel reported separately) |
| **Fleet utilisation** | `onTrip ÷ (available + onTrip) × 100` — in-shop vehicles are not deployable capacity |
| **Operational cost** | fuel + maintenance + **expenses**, per vehicle |
| **Vehicle ROI** | (revenue − total cost) ÷ acquisition cost |
| **Trip profitability** | per-trip margin, cost/km, and planned-vs-actual distance variance |
| **Lane profitability** | trips grouped by route, **worst margin first** |

Each is available as JSON, **CSV** and a server-rendered **PDF**, and all accept an optional
`?from=&to=` range.

---

## 7. Feature Summary

**Fleet Registry** — CRUD with search and filters, AI document capture, insurance/PUC/service
badges, retirement and reinstatement.

**Driver Management** — CRUD, licence-photo AI capture, derived safety scores with thresholds,
suspend / reinstate / off-duty / archive.

**Trip Dispatch** — a four-column board with live counts, a schedule-first create dialog that
only offers genuinely free vehicles and drivers, live rate-card quoting, cargo-capacity checking,
and overdue flagging.

**Customers** — contact details and per-km / per-tonne-km / flat rate cards that price trips.

**Maintenance** — work orders with open/close, one-per-vehicle enforcement, and service-interval
reset.

**Fuel & Expenses** — tabbed ledger; selecting a trip pins its vehicle so cost attribution stays
correct.

**Operations Dashboard** — seven KPIs (honestly scoped to the active filters), a compliance
banner, recent trips and a status chart.

**Analytics** — KPIs, charts, lane profitability, and CSV/PDF export.

**Driver Portal** — the driver's own assignment, licence warnings, and one-tap fuel/expense
logging and trip completion from the road.

**User Management** *(Admin)* — create accounts, change roles, link driver logins.

**Audit Log** *(Admin)* — every state change with actor, action and summary, filterable.

**Platform** — JWT over httpOnly cookies with silent refresh, server-enforced RBAC, toast
notifications throughout, light/dark theme, responsive to mobile.

---

## 8. Is It Practical?

### Where it genuinely holds up

- The constraints solve real, expensive, everyday problems, and they are enforced inside database
  transactions rather than hoped for.
- Scheduling is interval-based, so the system answers the question a dispatcher actually asks.
- Revenue and safety scores are **derived from primary records**, so the analytics can be traced
  back to a receipt or an incident rather than to someone's typing.
- AI capture attacks the real adoption blocker, degrades gracefully, and — via the driver portal —
  now happens at the point the data is created.
- Every state change is attributable.

### Where it is still a prototype

- **No geography.** Source and destination are drawn from a fixed list of 15 Indian cities, and
  distance is entered by hand. No routing, no live ETA, no GPS. Planned-vs-actual variance is
  measured, but only after the fact.
- **Email is the only notification channel.** No SMS or WhatsApp — the channels Indian fleet
  operators actually use — and no in-app inbox; the bell surfaces live compliance state rather
  than a message history.
- **Rate cards are simple.** Per-km, per-tonne-km or flat. No slabs, no seasonal pricing, no
  fuel surcharge, no per-lane contract rates.
- **Settings are per-browser.** Depot name, currency and distance unit persist to `localStorage`
  rather than to the server, and the currency selector does not yet reformat the app.
- **No multi-tenancy.** One depot per deployment.
- **Reports aggregate in JavaScript.** Fine at demo scale; a fleet with years of history wants
  the grouping pushed into SQL.

**Verdict:** the operational core — scheduling integrity, derived status, attributable cost, and
enforced authorisation — is sound and genuinely useful. Geography, richer pricing and additional
notification channels are what stand between this and a product a depot could run on unmodified.

---

## 9. Repository Layout

```
Odoo Hackathon/
├── client/                     React 19 + Vite 7 (Tailwind v4, shadcn/ui, Recharts, Framer Motion)
│   └── src/
│       ├── api/                one axios module per resource + interceptors
│       ├── components/
│       │   ├── layout/         shell, route guard, error boundary
│       │   ├── shared/         KPI card, status badge, dialogs
│       │   └── ui/             shadcn primitives + the toast system
│       ├── config/roles.js     access map mirroring the server's capability table
│       ├── contexts/           Auth · Data · Theme
│       ├── hooks/              useToast · useObjectUrl
│       └── pages/              one page per module
└── server/                     Express 5 + Prisma 6 + PostgreSQL
    ├── prisma/                 schema, migrations, seeds
    └── src/
        ├── config/             env validation · capability table
        ├── controllers/        request handling + business rules
        ├── routes/             URL → auth → capability → controller
        ├── services/           Gemini, Cloudinary, email, cron, scheduling, pricing, safety
        ├── middlewares/        JWT, capability guard, uploads
        └── utils/              typed errors, audit, pagination, validators
```

---

## 10. Running It

**Prerequisites:** Node 18+, PostgreSQL. Gemini, Cloudinary and Gmail credentials are optional —
the server detects which are present and disables just those features, with a clear message.

```bash
cd server && npm install && npx prisma migrate dev
```

```bash
cd server && npm run seed:data && npm run seed:users && npm run dev
```

```bash
cd client && npm install && npm run dev
```

API on `http://localhost:8000`, client on `http://localhost:5173`.

> Run `seed:data` **before** `seed:users` — the driver login links to a seeded driver record.

**Seeded logins** — every password is `Password@123` except Admin:

| Role | Email | Password |
|---|---|---|
| Admin | `admin@transitops.com` | `Admin@12345` |
| Fleet Manager | `fleetmanager@transitops.com` | `Password@123` |
| Dispatcher | `dispatcher@transitops.com` | `Password@123` |
| Safety Officer | `safetyofficer@transitops.com` | `Password@123` |
| Financial Analyst | `financialanalyst@transitops.com` | `Password@123` |
| **Driver** | `rajesh.kumar@transitops-drivers.com` | `Password@123` |

**Worth demoing:** sign in as **Dispatcher** and try to book a vehicle over an existing trip;
as **Driver** to see the self-service portal; as **Admin** to read the audit log.
