"""Read-only database tools for the copilot agent.

These back the "operational records" half of the router — questions about real
drivers, trips, money and incidents — as opposed to the policy/statute corpus
that copilot.retrieval.search serves.

Load-bearing design rules:

* Read-only. Every statement here is a SELECT; nothing writes.
* Parameterised only. Caller values are always bound as %(name)s parameters,
  including enum literals. Where a WHERE clause is assembled conditionally,
  only fixed fragments owned by this module are concatenated — no caller value
  ever reaches the SQL text itself.
* Column allow-lists. Each query names its columns explicitly. PII and secrets
  (licence numbers and scans, email, contact numbers, RC/insurance/PUC numbers,
  password and token columns) are never selected, for any role. Names and ids
  *are* returned: identifying which driver is the whole point.
* Bounded. Every list query carries a server-side row cap the caller cannot
  raise, and returns a JSON-safe dict rather than raw cursor output. List
  results are accompanied by unfiltered aggregate totals, so a truncated page
  can never be miscounted as the whole answer.

Access control is deliberately NOT enforced here. Express gates the endpoint on
the `copilot:query` capability (server/src/config/permissions.js) and that is
the single place row-level scoping belongs. The column allow-list above is
independent of role and applies unconditionally.

Connection style follows copilot/retrieval/search.py: one short-lived psycopg
connection per call, no pool.

Timestamps: Prisma maps DateTime to TIMESTAMP(3) *without* time zone and writes
UTC, so every bound is passed as a naive UTC datetime. Postgres now() is
deliberately unused — it is timestamptz and would be compared in the session's
time zone.
"""

import logging
import math
import os
from datetime import date, datetime, timedelta
from decimal import Decimal
from typing import Any

import psycopg
from psycopg.rows import dict_row

logger = logging.getLogger("copilot.db_tools")

# --------------------------------------------------------------------------
# Mirrors SAFETY_RULES / SAFETY_THRESHOLDS in
# server/src/services/safety.service.js (lines 7-19).
#
# Nothing shared crosses the Node/Python boundary, so these are duplicated by
# hand. If the JS constants change, change them here too — otherwise the
# copilot will confidently explain a score using the wrong weights.
# --------------------------------------------------------------------------
SAFETY_RULES = {
    "BASE": 100,
    "FINE_PENALTY": 8,
    "CANCELLED_TRIP_PENALTY": 3,
    "EXPIRED_LICENSE_PENALTY": 25,
    "LICENSE_EXPIRING_PENALTY": 5,
    "COMPLETION_BONUS": 1,
    "MAX_COMPLETION_BONUS": 15,
    "LOOKBACK_DAYS": 365,
}
SAFETY_THRESHOLDS = {"WARN": 60, "BLOCK": 40}

DEFAULT_ROW_LIMIT = 20
MAX_ROW_LIMIT = 100
MAX_INCIDENT_LIMIT = 50
MAX_NAME_MATCHES = 10
DEFAULT_LIST_LIMIT = 50

TRIP_STATUSES = ("DRAFT", "DISPATCHED", "COMPLETED", "CANCELLED")
EXPENSE_TYPES = ("TOLL", "PARKING", "FINE", "MAINTENANCE", "OTHER")
VEHICLE_STATUSES = ("AVAILABLE", "ON_TRIP", "IN_SHOP", "RETIRED")
DRIVER_STATUSES = ("AVAILABLE", "ON_TRIP", "OFF_DUTY", "SUSPENDED", "ARCHIVED")

# A vehicle or driver is "on trip" precisely when a trip of theirs is dispatched
# and not yet closed, so the roster tools join to that one live trip.
LIVE_TRIP_STATUS = "DISPATCHED"

# Lifecycle actions worth calling "incidents". CREATE/UPDATE are profile-edit
# noise; these four are the disciplinary/status trail written by
# server/src/controllers/driver.controller.js, whose `summary` carries the
# human-entered reason.
INCIDENT_ACTIONS = ("SUSPEND", "REINSTATE", "STATUS_CHANGE", "ARCHIVE")

INCIDENT_DISCLAIMER = (
    "TransitOps has no dedicated incident or violation table. This history is "
    "reconstructed from the audit trail (driver status changes) and from FINE-type "
    "expenses recorded against the driver's trips, so anything not captured by "
    "those two sources will not appear here."
)


# --------------------------------------------------------------------------
# Helpers
# --------------------------------------------------------------------------
def _connect() -> psycopg.Connection:
    """One short-lived connection per call, as in copilot/retrieval/search.py."""
    return psycopg.connect(os.environ["DATABASE_URL"])


def _json_safe(value: Any) -> Any:
    """Make psycopg output JSON-serialisable.

    Decimal and datetime would otherwise survive into the ToolMessage, where
    str() renders them in a form the model reads back as noise.
    """
    if isinstance(value, Decimal):
        return float(value)
    if isinstance(value, (datetime, date)):
        return value.isoformat()
    if isinstance(value, dict):
        return {key: _json_safe(val) for key, val in value.items()}
    if isinstance(value, (list, tuple)):
        return [_json_safe(val) for val in value]
    return value


def _like_pattern(text: str) -> str:
    """Contains-match pattern with LIKE wildcards in the input neutralised.

    The value is bound as a parameter either way, so this guards against a name
    containing '%' matching everything, not against injection.
    """
    escaped = text.strip().replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
    return "%" + escaped + "%"


def _parse_dt(value: Any, field: str) -> tuple:
    """Parse an ISO date/datetime into a naive UTC datetime.

    Returns (value, error). The model supplies these as free text, so a bad
    string must become a clean invalid_params answer rather than a 500.
    """
    if value in (None, ""):
        return None, None
    if isinstance(value, datetime):
        parsed = value
    elif isinstance(value, date):
        parsed = datetime(value.year, value.month, value.day)
    else:
        text = str(value).strip()
        if text.endswith("Z"):
            text = text[:-1] + "+00:00"
        try:
            parsed = datetime.fromisoformat(text)
        except ValueError:
            return None, f"{field} must be an ISO date such as 2026-01-31 (got {value!r})."
    if parsed.tzinfo is not None:
        parsed = parsed.astimezone(tz=None).replace(tzinfo=None)
    return parsed, None


def _range_clauses(column: str, date_from, date_to, params: dict, prefix: str) -> list:
    """Fixed comparison fragments for an optional date window.

    `column` and the fragment text are literals owned by this module; the
    bounds are bound as parameters.
    """
    clauses = []
    if date_from is not None:
        params[prefix + "_from"] = date_from
        clauses.append(column + " >= %(" + prefix + "_from)s")
    if date_to is not None:
        params[prefix + "_to"] = date_to
        clauses.append(column + " <= %(" + prefix + "_to)s")
    return clauses


def _clamp(value: Any, default: int, ceiling: int) -> int:
    try:
        limit = int(value)
    except (TypeError, ValueError):
        return default
    return max(1, min(limit, ceiling))


def _error(message: str) -> dict:
    return {"status": "error", "message": message}


def _invalid(message: str) -> dict:
    return {"status": "invalid_params", "message": message}


def _lookback_start() -> datetime:
    return datetime.utcnow() - timedelta(days=SAFETY_RULES["LOOKBACK_DAYS"])


def _days_to_expiry(expiry) -> int | None:
    """Whole days until a licence expires, matching safety.service.js's Math.ceil."""
    if expiry is None:
        return None
    return math.ceil((expiry - datetime.utcnow()).total_seconds() / 86400)


def _expiry_status(days: int | None) -> str:
    if days is None:
        return "unknown"
    if days < 0:
        return "expired"
    if days <= 30:
        return "expiring_soon"
    return "ok"


def _window(date_from, date_to) -> dict:
    return {
        "from": date_from.isoformat() if date_from else None,
        "to": date_to.isoformat() if date_to else None,
    }


# --------------------------------------------------------------------------
# Identifier resolution
#
# A tool cannot pause mid-flow to ask a follow-up question: the router executes
# it and hands one ToolMessage back for synthesis. So an ambiguous name returns
# the candidate list as data and stops, and the system prompt instructs the
# model to relay it and ask which one rather than guessing.
# --------------------------------------------------------------------------
_DRIVER_IDENTITY = 'id, name, status, "licenseCategory"'
_VEHICLE_IDENTITY = 'id, name, "registrationNo", type, status'


def _resolve_driver(cur, driver_id, driver_name) -> dict:
    if driver_id:
        cur.execute(
            'SELECT ' + _DRIVER_IDENTITY + ' FROM "Driver" WHERE id = %(id)s',
            {"id": str(driver_id).strip()},
        )
        row = cur.fetchone()
        if row:
            return {"status": "ok", "driver": _json_safe(row)}
        return {"status": "not_found", "message": f"No driver exists with id {driver_id!r}."}

    if not driver_name or not str(driver_name).strip():
        return _invalid("Provide either driver_id or driver_name.")

    name = str(driver_name).strip()

    # Exact (case-insensitive) first, so "Asha Verma" is not made ambiguous by
    # the existence of an "Asha Vermani".
    cur.execute(
        'SELECT ' + _DRIVER_IDENTITY + ' FROM "Driver" '
        "WHERE lower(name) = lower(%(name)s) LIMIT %(lim)s",
        {"name": name, "lim": MAX_NAME_MATCHES},
    )
    rows = cur.fetchall()

    if len(rows) != 1:
        cur.execute(
            'SELECT ' + _DRIVER_IDENTITY + ' FROM "Driver" '
            "WHERE name ILIKE %(pat)s ORDER BY name LIMIT %(lim)s",
            {"pat": _like_pattern(name), "lim": MAX_NAME_MATCHES},
        )
        rows = cur.fetchall() or rows

    if not rows:
        return {"status": "not_found", "message": f"No driver matches the name {name!r}."}
    if len(rows) > 1:
        return {
            "status": "ambiguous",
            "message": (
                f"{len(rows)} drivers match {name!r}. Ask the user which one is meant, "
                "then call again with that driver_id."
            ),
            "matches": [_json_safe(row) for row in rows],
        }
    return {"status": "ok", "driver": _json_safe(rows[0])}


def _resolve_vehicle(cur, vehicle_id, registration_no) -> dict:
    if vehicle_id:
        cur.execute(
            'SELECT ' + _VEHICLE_IDENTITY + ' FROM "Vehicle" WHERE id = %(id)s',
            {"id": str(vehicle_id).strip()},
        )
        row = cur.fetchone()
        if row:
            return {"status": "ok", "vehicle": _json_safe(row)}
        return {"status": "not_found", "message": f"No vehicle exists with id {vehicle_id!r}."}

    if not registration_no or not str(registration_no).strip():
        return _invalid("Provide either vehicle_id or vehicle_registration_no.")

    reg = str(registration_no).strip()
    cur.execute(
        'SELECT ' + _VEHICLE_IDENTITY + ' FROM "Vehicle" '
        'WHERE "registrationNo" ILIKE %(pat)s ORDER BY "registrationNo" LIMIT %(lim)s',
        {"pat": _like_pattern(reg), "lim": MAX_NAME_MATCHES},
    )
    rows = cur.fetchall()
    if not rows:
        return {"status": "not_found", "message": f"No vehicle matches {reg!r}."}
    if len(rows) > 1:
        return {
            "status": "ambiguous",
            "message": f"{len(rows)} vehicles match {reg!r}. Ask the user which one is meant.",
            "matches": [_json_safe(row) for row in rows],
        }
    return {"status": "ok", "vehicle": _json_safe(rows[0])}


# --------------------------------------------------------------------------
# Tools
# --------------------------------------------------------------------------
def get_driver_profile(driver_id=None, driver_name=None) -> dict:
    """Current record for one driver: status, licence category/expiry, safety score."""
    try:
        with _connect() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                resolved = _resolve_driver(cur, driver_id, driver_name)
                if resolved["status"] != "ok":
                    return resolved
                cur.execute(
                    'SELECT id, name, status, "licenseCategory", "licenseExpiry", '
                    '"safetyScore", "createdAt", "suspensionReason" FROM "Driver" WHERE id = %(id)s',
                    {"id": resolved["driver"]["id"]},
                )
                row = cur.fetchone()
    except psycopg.Error:
        logger.exception("get_driver_profile failed")
        return _error("The driver record could not be read from the database.")

    if row is None:
        return {"status": "not_found", "message": "The driver record disappeared mid-lookup."}

    days = _days_to_expiry(row["licenseExpiry"])
    driver = _json_safe(row)
    driver["days_to_license_expiry"] = days
    driver["license_status"] = _expiry_status(days)
    return {
        "status": "ok",
        "driver": driver,
        "safety_thresholds": SAFETY_THRESHOLDS,
    }


def get_driver_trip_history(
    driver_id=None,
    driver_name=None,
    status=None,
    date_from=None,
    date_to=None,
    limit=DEFAULT_ROW_LIMIT,
) -> dict:
    """Trips run by one driver, newest first, with unfiltered totals alongside."""
    if status is not None and str(status).strip():
        status = str(status).strip().upper()
        if status not in TRIP_STATUSES:
            return _invalid("status must be one of " + ", ".join(TRIP_STATUSES) + ".")
    else:
        status = None

    parsed_from, err = _parse_dt(date_from, "date_from")
    if err:
        return _invalid(err)
    parsed_to, err = _parse_dt(date_to, "date_to")
    if err:
        return _invalid(err)

    row_limit = _clamp(limit, DEFAULT_ROW_LIMIT, MAX_ROW_LIMIT)

    try:
        with _connect() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                resolved = _resolve_driver(cur, driver_id, driver_name)
                if resolved["status"] != "ok":
                    return resolved
                driver = resolved["driver"]

                params = {"driver_id": driver["id"]}
                clauses = ['"driverId" = %(driver_id)s']
                if status:
                    params["status"] = status
                    clauses.append("status = %(status)s")
                clauses += _range_clauses('"plannedStart"', parsed_from, parsed_to, params, "d")
                where = " AND ".join(clauses)

                # Totals come from the same filter without the row cap, so a
                # truncated page can never be mistaken for the full count.
                cur.execute(
                    'SELECT status, count(*) AS trips, '
                    'COALESCE(sum(revenue), 0) AS revenue, '
                    'COALESCE(sum("plannedDistance"), 0) AS distance_km '
                    'FROM "Trip" WHERE ' + where + " GROUP BY status",
                    params,
                )
                totals = cur.fetchall()

                params["row_limit"] = row_limit
                cur.execute(
                    'SELECT id, source, destination, status, "cargoWeightKg", '
                    '"plannedDistance", "plannedStart", "plannedEnd", "startOdometer", '
                    '"endOdometer", "fuelConsumedL", revenue, "dispatchedAt", '
                    '"completedAt", "cancelledAt" '
                    'FROM "Trip" WHERE ' + where + ' ORDER BY "plannedStart" DESC '
                    "LIMIT %(row_limit)s",
                    params,
                )
                trips = cur.fetchall()
    except psycopg.Error:
        logger.exception("get_driver_trip_history failed")
        return _error("The trip history could not be read from the database.")

    by_status = {row["status"]: int(row["trips"]) for row in totals}
    total_trips = sum(by_status.values())
    return {
        "status": "ok",
        "driver": driver,
        "filters": {"status": status, "period": _window(parsed_from, parsed_to)},
        "totals": {
            "trips": total_trips,
            "by_status": by_status,
            "revenue": float(sum(row["revenue"] for row in totals)),
            "planned_distance_km": float(sum(row["distance_km"] for row in totals)),
        },
        "returned": len(trips),
        "truncated": total_trips > len(trips),
        "trips": [_json_safe(row) for row in trips],
    }


def get_driver_safety_breakdown(driver_id=None, driver_name=None) -> dict:
    """Recompute one driver's safety score and return every contributing component."""
    since = _lookback_start()

    try:
        with _connect() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                resolved = _resolve_driver(cur, driver_id, driver_name)
                if resolved["status"] != "ok":
                    return resolved
                driver = resolved["driver"]
                params = {"id": driver["id"], "since": since}

                cur.execute(
                    'SELECT "licenseExpiry", "safetyScore" FROM "Driver" WHERE id = %(id)s',
                    {"id": driver["id"]},
                )
                record = cur.fetchone()

                cur.execute(
                    'SELECT count(*) AS n FROM "Trip" WHERE "driverId" = %(id)s '
                    "AND status = %(st)s AND \"completedAt\" >= %(since)s",
                    dict(params, st="COMPLETED"),
                )
                completed = int(cur.fetchone()["n"])

                # Only cancellations after dispatch count — cancelling a draft
                # costs nothing (safety.service.js:39-42).
                cur.execute(
                    'SELECT count(*) AS n FROM "Trip" WHERE "driverId" = %(id)s '
                    'AND status = %(st)s AND "dispatchedAt" IS NOT NULL '
                    'AND "cancelledAt" >= %(since)s',
                    dict(params, st="CANCELLED"),
                )
                cancelled = int(cur.fetchone()["n"])

                # Fines reach a driver only through the trip they were incurred on.
                cur.execute(
                    'SELECT count(*) AS n FROM "Expense" e '
                    'JOIN "Trip" t ON t.id = e."tripId" '
                    'WHERE t."driverId" = %(id)s AND e.type = %(st)s '
                    'AND e."incurredAt" >= %(since)s',
                    dict(params, st="FINE"),
                )
                fines = int(cur.fetchone()["n"])
    except psycopg.Error:
        logger.exception("get_driver_safety_breakdown failed")
        return _error("The safety score components could not be read from the database.")

    if record is None:
        return {"status": "not_found", "message": "The driver record disappeared mid-lookup."}

    days = _days_to_expiry(record["licenseExpiry"])
    license_state = _expiry_status(days)
    if license_state == "expired":
        license_penalty = -SAFETY_RULES["EXPIRED_LICENSE_PENALTY"]
    elif license_state == "expiring_soon":
        license_penalty = -SAFETY_RULES["LICENSE_EXPIRING_PENALTY"]
    else:
        license_penalty = 0

    fine_penalty = -fines * SAFETY_RULES["FINE_PENALTY"]
    cancelled_penalty = -cancelled * SAFETY_RULES["CANCELLED_TRIP_PENALTY"]
    bonus = min(
        completed * SAFETY_RULES["COMPLETION_BONUS"], SAFETY_RULES["MAX_COMPLETION_BONUS"]
    )

    raw = SAFETY_RULES["BASE"] + fine_penalty + cancelled_penalty + license_penalty + bonus
    computed = max(0, min(100, round(raw)))
    stored = record["safetyScore"]

    result = {
        "status": "ok",
        "driver": driver,
        "lookback_days": SAFETY_RULES["LOOKBACK_DAYS"],
        "breakdown": {
            "base": SAFETY_RULES["BASE"],
            "fine_count": fines,
            "fine_penalty": fine_penalty,
            "cancelled_after_dispatch_count": cancelled,
            "cancelled_penalty": cancelled_penalty,
            "license_expiry": record["licenseExpiry"].isoformat()
            if record["licenseExpiry"]
            else None,
            "days_to_license_expiry": days,
            "license_status": license_state,
            "license_penalty": license_penalty,
            "completed_trip_count": completed,
            "completion_bonus": bonus,
            "computed_score": computed,
        },
        "safety_score_stored": stored,
        "thresholds": SAFETY_THRESHOLDS,
        "weights": SAFETY_RULES,
    }
    if stored is not None and stored != computed:
        result["note"] = (
            f"The stored score ({stored}) differs from the score recomputed now ({computed}). "
            "TransitOps stores only the number, with no history, and refreshes it when trips "
            "or expenses change — so the stored value is stale relative to today's records."
        )
    return result


def get_vehicle_or_driver_financials(
    vehicle_id=None,
    vehicle_registration_no=None,
    driver_id=None,
    driver_name=None,
    date_from=None,
    date_to=None,
) -> dict:
    """Revenue, fuel, expenses by type and maintenance cost for one vehicle or one driver."""
    wants_vehicle = bool(vehicle_id or vehicle_registration_no)
    wants_driver = bool(driver_id or driver_name)
    if wants_vehicle and wants_driver:
        return _invalid(
            "Provide either a vehicle or a driver, not both — ask which one is meant."
        )
    if not wants_vehicle and not wants_driver:
        return _invalid("Provide a vehicle (id or registration number) or a driver (id or name).")

    parsed_from, err = _parse_dt(date_from, "date_from")
    if err:
        return _invalid(err)
    parsed_to, err = _parse_dt(date_to, "date_to")
    if err:
        return _invalid(err)

    try:
        with _connect() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                if wants_vehicle:
                    resolved = _resolve_vehicle(cur, vehicle_id, vehicle_registration_no)
                    if resolved["status"] != "ok":
                        return resolved
                    subject = resolved["vehicle"]
                    owner = {"type": "vehicle", "id": subject["id"]}
                else:
                    resolved = _resolve_driver(cur, driver_id, driver_name)
                    if resolved["status"] != "ok":
                        return resolved
                    subject = resolved["driver"]
                    owner = {"type": "driver", "id": subject["id"]}

                params = {"id": owner["id"]}

                # Trips carry revenue for both scopes; only the FK differs.
                trip_key = '"vehicleId"' if wants_vehicle else '"driverId"'
                trip_clauses = [trip_key + " = %(id)s"] + _range_clauses(
                    '"plannedStart"', parsed_from, parsed_to, params, "t"
                )
                cur.execute(
                    'SELECT count(*) AS trips, COALESCE(sum(revenue), 0) AS revenue '
                    'FROM "Trip" WHERE ' + " AND ".join(trip_clauses),
                    params,
                )
                trips = cur.fetchone()

                # Fuel and expenses hang off the vehicle directly, but reach a
                # driver only through the trip they were logged against — an
                # inner join, since a tripless fuel log has no driver to bill.
                if wants_vehicle:
                    fuel_from = 'FROM "FuelLog" f'
                    expense_from = 'FROM "Expense" e'
                    fuel_where = ['f."vehicleId" = %(id)s']
                    expense_where = ['e."vehicleId" = %(id)s']
                else:
                    fuel_from = 'FROM "FuelLog" f JOIN "Trip" t ON t.id = f."tripId"'
                    expense_from = 'FROM "Expense" e JOIN "Trip" t ON t.id = e."tripId"'
                    fuel_where = ['t."driverId" = %(id)s']
                    expense_where = ['t."driverId" = %(id)s']

                fuel_clauses = fuel_where + _range_clauses(
                    'f."loggedAt"', parsed_from, parsed_to, params, "f"
                )
                cur.execute(
                    'SELECT COALESCE(sum(f.liters), 0) AS liters, '
                    'COALESCE(sum(f.cost), 0) AS cost, count(*) AS entries '
                    + fuel_from + " WHERE " + " AND ".join(fuel_clauses),
                    params,
                )
                fuel = cur.fetchone()

                expense_clauses = expense_where + _range_clauses(
                    'e."incurredAt"', parsed_from, parsed_to, params, "e"
                )
                cur.execute(
                    'SELECT e.type, COALESCE(sum(e.amount), 0) AS total, count(*) AS entries '
                    + expense_from + " WHERE " + " AND ".join(expense_clauses)
                    + " GROUP BY e.type",
                    params,
                )
                expenses = cur.fetchall()

                # Maintenance is a property of the vehicle; a driver has none.
                maintenance = None
                if wants_vehicle:
                    maint_clauses = ['"vehicleId" = %(id)s'] + _range_clauses(
                        '"startedAt"', parsed_from, parsed_to, params, "m"
                    )
                    cur.execute(
                        'SELECT COALESCE(sum(cost), 0) AS cost, count(*) AS entries '
                        'FROM "MaintenanceLog" WHERE ' + " AND ".join(maint_clauses),
                        params,
                    )
                    maintenance = cur.fetchone()
    except psycopg.Error:
        logger.exception("get_vehicle_or_driver_financials failed")
        return _error("The financial records could not be read from the database.")

    by_type = {row["type"]: float(row["total"]) for row in expenses}
    counts = {row["type"]: int(row["entries"]) for row in expenses}
    expense_total = sum(by_type.values())
    revenue = float(trips["revenue"])
    fuel_cost = float(fuel["cost"])
    maintenance_cost = float(maintenance["cost"]) if maintenance else 0.0

    result = {
        "status": "ok",
        "scope": dict(owner, subject=subject),
        "period": _window(parsed_from, parsed_to),
        "revenue": revenue,
        "trip_count": int(trips["trips"]),
        "fuel": {
            "liters": float(fuel["liters"]),
            "cost": fuel_cost,
            "entries": int(fuel["entries"]),
        },
        "expenses": {
            "total": expense_total,
            "by_type": {kind: by_type.get(kind, 0.0) for kind in EXPENSE_TYPES},
            "counts_by_type": {kind: counts.get(kind, 0) for kind in EXPENSE_TYPES},
        },
        "maintenance": {
            "cost": maintenance_cost,
            "entries": int(maintenance["entries"]),
        }
        if maintenance
        else None,
        "net": round(revenue - fuel_cost - expense_total - maintenance_cost, 2),
    }
    if not wants_vehicle:
        result["note"] = (
            "Driver scope covers only costs recorded against trips this driver ran. "
            "Maintenance is tracked per vehicle and has no driver attribution, so it is "
            "excluded here."
        )
    return result


def get_driver_incident_history(
    driver_id=None,
    driver_name=None,
    date_from=None,
    date_to=None,
    limit=DEFAULT_ROW_LIMIT,
) -> dict:
    """Suspensions, reinstatements and status changes for one driver, plus their fines."""
    parsed_from, err = _parse_dt(date_from, "date_from")
    if err:
        return _invalid(err)
    parsed_to, err = _parse_dt(date_to, "date_to")
    if err:
        return _invalid(err)

    row_limit = _clamp(limit, DEFAULT_ROW_LIMIT, MAX_INCIDENT_LIMIT)

    try:
        with _connect() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                resolved = _resolve_driver(cur, driver_id, driver_name)
                if resolved["status"] != "ok":
                    return resolved
                driver = resolved["driver"]

                audit_params = {
                    "id": driver["id"],
                    "entity": "Driver",
                    "actions": list(INCIDENT_ACTIONS),
                    "row_limit": row_limit,
                }
                audit_clauses = [
                    'entity = %(entity)s',
                    '"entityId" = %(id)s',
                    "action = ANY(%(actions)s)",
                ] + _range_clauses('"createdAt"', parsed_from, parsed_to, audit_params, "a")
                cur.execute(
                    'SELECT id, action, summary, before, after, "createdAt", "actorEmail" '
                    'FROM "AuditLog" WHERE ' + " AND ".join(audit_clauses) +
                    ' ORDER BY "createdAt" DESC LIMIT %(row_limit)s',
                    audit_params,
                )
                events = cur.fetchall()

                fine_params = {"id": driver["id"], "type": "FINE", "row_limit": row_limit}
                fine_clauses = [
                    't."driverId" = %(id)s',
                    "e.type = %(type)s",
                ] + _range_clauses('e."incurredAt"', parsed_from, parsed_to, fine_params, "f")
                cur.execute(
                    'SELECT e.id, e.amount, e.note, e."incurredAt", t.id AS trip_id, '
                    't.source, t.destination '
                    'FROM "Expense" e JOIN "Trip" t ON t.id = e."tripId" '
                    "WHERE " + " AND ".join(fine_clauses) +
                    ' ORDER BY e."incurredAt" DESC LIMIT %(row_limit)s',
                    fine_params,
                )
                fines = cur.fetchall()

                cur.execute(
                    'SELECT count(*) AS n, COALESCE(sum(e.amount), 0) AS total '
                    'FROM "Expense" e JOIN "Trip" t ON t.id = e."tripId" '
                    "WHERE " + " AND ".join(fine_clauses),
                    fine_params,
                )
                fine_totals = cur.fetchone()
    except psycopg.Error:
        logger.exception("get_driver_incident_history failed")
        return _error("The incident history could not be read from the database.")

    return {
        "status": "ok",
        "driver": driver,
        "period": _window(parsed_from, parsed_to),
        "current_status": driver.get("status"),
        "audit_events": [_json_safe(row) for row in events],
        "audit_event_count": len(events),
        "fines": [_json_safe(row) for row in fines],
        "fine_totals": {
            "count": int(fine_totals["n"]),
            "amount": float(fine_totals["total"]),
        },
        "disclaimer": INCIDENT_DISCLAIMER,
    }


# --------------------------------------------------------------------------
# Fleet-wide tools
#
# Everything above answers about one named driver or vehicle. These answer
# "what is the fleet doing right now", which is a different shape: the caller
# names no entity, so each returns whole-fleet counts by status *unfiltered*
# alongside the filtered rows. The counts are what a question like "how many
# are on trip" should be answered from — never the length of a capped page.
# --------------------------------------------------------------------------

# The live trip attached to a vehicle or driver, for roster context. LATERAL so
# it is one row per subject even if several trips somehow qualify.
_LIVE_TRIP_JOIN = """
LEFT JOIN LATERAL (
    SELECT tr.id, tr.source, tr.destination, tr."plannedEnd", tr."driverId", tr."vehicleId"
    FROM "Trip" tr
    WHERE tr.{key} = subject.id AND tr.status = %(live_status)s
    ORDER BY tr."dispatchedAt" DESC NULLS LAST
    LIMIT 1
) live ON true
"""


def _status_counts(cur, table: str) -> dict:
    """Whole-table counts by status, ignoring any filter the caller applied."""
    cur.execute('SELECT status, count(*) AS n FROM "' + table + '" GROUP BY status')
    return {row["status"]: int(row["n"]) for row in cur.fetchall()}


def _trip_summary(row: dict) -> dict | None:
    if not row.get("trip_id"):
        return None
    return {
        "trip_id": row["trip_id"],
        "source": row["trip_source"],
        "destination": row["trip_destination"],
        "planned_end": row["trip_planned_end"].isoformat() if row["trip_planned_end"] else None,
    }


def list_vehicles(status=None, vehicle_type=None, region=None, limit=DEFAULT_LIST_LIMIT) -> dict:
    """The fleet roster: which vehicles are on trip, available, in the shop or retired."""
    if status is not None and str(status).strip():
        status = str(status).strip().upper()
        if status not in VEHICLE_STATUSES:
            return _invalid("status must be one of " + ", ".join(VEHICLE_STATUSES) + ".")
    else:
        status = None

    row_limit = _clamp(limit, DEFAULT_LIST_LIMIT, MAX_ROW_LIMIT)

    try:
        with _connect() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                fleet_totals = _status_counts(cur, "Vehicle")

                params = {"live_status": LIVE_TRIP_STATUS, "row_limit": row_limit}
                clauses = []
                if status:
                    params["status"] = status
                    clauses.append("subject.status = %(status)s")
                if vehicle_type and str(vehicle_type).strip():
                    params["vtype"] = _like_pattern(str(vehicle_type))
                    clauses.append("subject.type ILIKE %(vtype)s")
                if region and str(region).strip():
                    params["region"] = _like_pattern(str(region))
                    clauses.append("subject.region ILIKE %(region)s")
                where = (" WHERE " + " AND ".join(clauses)) if clauses else ""

                cur.execute(
                    'SELECT count(*) AS n FROM "Vehicle" subject' + where, params
                )
                matched = int(cur.fetchone()["n"])

                cur.execute(
                    'SELECT subject.id, subject.name, subject."registrationNo", subject.type, '
                    'subject.status, subject.region, subject.odometer, subject."maxLoadKg", '
                    'subject."insuranceExpiry", subject."pucExpiry", subject."insuranceExpired", '
                    'subject."pucExpired", subject."serviceIntervalKm", '
                    'subject."lastServiceOdometer", '
                    'live.id AS trip_id, live.source AS trip_source, '
                    'live.destination AS trip_destination, live."plannedEnd" AS trip_planned_end, '
                    "driver.name AS driver_name, driver.id AS driver_id "
                    'FROM "Vehicle" subject '
                    + _LIVE_TRIP_JOIN.format(key='"vehicleId"')
                    + 'LEFT JOIN "Driver" driver ON driver.id = live."driverId"'
                    + where
                    + ' ORDER BY subject.status, subject."registrationNo" LIMIT %(row_limit)s',
                    params,
                )
                rows = cur.fetchall()
    except psycopg.Error:
        logger.exception("list_vehicles failed")
        return _error("The vehicle list could not be read from the database.")

    vehicles = []
    for row in rows:
        vehicle = _json_safe(
            {key: row[key] for key in row if not key.startswith(("trip_", "driver_"))}
        )
        vehicle["insurance_status"] = _expiry_status(_days_to_expiry(row["insuranceExpiry"]))
        vehicle["puc_status"] = _expiry_status(_days_to_expiry(row["pucExpiry"]))
        vehicle["current_trip"] = _trip_summary(row)
        vehicle["current_driver"] = (
            {"id": row["driver_id"], "name": row["driver_name"]} if row["driver_id"] else None
        )
        vehicles.append(vehicle)

    return {
        "status": "ok",
        "filters": {"status": status, "type": vehicle_type, "region": region},
        "fleet_totals_by_status": fleet_totals,
        "fleet_size": sum(fleet_totals.values()),
        "matched": matched,
        "returned": len(vehicles),
        "truncated": matched > len(vehicles),
        "vehicles": vehicles,
    }


def list_drivers(status=None, limit=DEFAULT_LIST_LIMIT) -> dict:
    """The driver roster: who is on trip, available, off duty, suspended or archived."""
    if status is not None and str(status).strip():
        status = str(status).strip().upper()
        if status not in DRIVER_STATUSES:
            return _invalid("status must be one of " + ", ".join(DRIVER_STATUSES) + ".")
    else:
        status = None

    row_limit = _clamp(limit, DEFAULT_LIST_LIMIT, MAX_ROW_LIMIT)

    try:
        with _connect() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                totals = _status_counts(cur, "Driver")

                params = {"live_status": LIVE_TRIP_STATUS, "row_limit": row_limit}
                where = ""
                if status:
                    params["status"] = status
                    where = " WHERE subject.status = %(status)s"

                cur.execute('SELECT count(*) AS n FROM "Driver" subject' + where, params)
                matched = int(cur.fetchone()["n"])

                cur.execute(
                    'SELECT subject.id, subject.name, subject.status, subject."licenseCategory", '
                    'subject."licenseExpiry", subject."safetyScore", subject."suspensionReason", '
                    'live.id AS trip_id, live.source AS trip_source, '
                    'live.destination AS trip_destination, live."plannedEnd" AS trip_planned_end, '
                    'vehicle."registrationNo" AS vehicle_reg '
                    'FROM "Driver" subject '
                    + _LIVE_TRIP_JOIN.format(key='"driverId"')
                    + 'LEFT JOIN "Vehicle" vehicle ON vehicle.id = live."vehicleId"'
                    + where
                    + " ORDER BY subject.status, subject.name LIMIT %(row_limit)s",
                    params,
                )
                rows = cur.fetchall()
    except psycopg.Error:
        logger.exception("list_drivers failed")
        return _error("The driver list could not be read from the database.")

    drivers = []
    for row in rows:
        days = _days_to_expiry(row["licenseExpiry"])
        driver = _json_safe(
            {
                key: row[key]
                for key in row
                if not key.startswith("trip_") and key != "vehicle_reg"
            }
        )
        driver["license_status"] = _expiry_status(days)
        driver["days_to_license_expiry"] = days
        driver["current_trip"] = _trip_summary(row)
        driver["current_vehicle"] = row["vehicle_reg"]
        drivers.append(driver)

    return {
        "status": "ok",
        "filters": {"status": status},
        "totals_by_status": totals,
        "driver_count": sum(totals.values()),
        "matched": matched,
        "returned": len(drivers),
        "truncated": matched > len(drivers),
        "safety_thresholds": SAFETY_THRESHOLDS,
        "drivers": drivers,
    }


def get_vehicle_profile(vehicle_id=None, vehicle_registration_no=None) -> dict:
    """One vehicle in depth: status, compliance, service due, live trip, recent maintenance."""
    try:
        with _connect() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                resolved = _resolve_vehicle(cur, vehicle_id, vehicle_registration_no)
                if resolved["status"] != "ok":
                    return resolved
                subject = resolved["vehicle"]
                params = {"id": subject["id"], "live_status": LIVE_TRIP_STATUS}

                cur.execute(
                    'SELECT id, name, "registrationNo", type, status, region, odometer, '
                    '"maxLoadKg", "acquisitionCost", "insuranceExpiry", "pucExpiry", '
                    '"insuranceExpired", "pucExpired", "serviceIntervalKm", '
                    '"lastServiceOdometer" FROM "Vehicle" WHERE id = %(id)s',
                    params,
                )
                vehicle = cur.fetchone()

                cur.execute(
                    'SELECT t.id, t.source, t.destination, t.status, t."plannedStart", '
                    't."plannedEnd", t."dispatchedAt", d.name AS driver_name, d.id AS driver_id '
                    'FROM "Trip" t LEFT JOIN "Driver" d ON d.id = t."driverId" '
                    'WHERE t."vehicleId" = %(id)s AND t.status = %(live_status)s '
                    'ORDER BY t."dispatchedAt" DESC NULLS LAST LIMIT 1',
                    params,
                )
                live_trip = cur.fetchone()

                cur.execute(
                    'SELECT id, description, cost, status, "startedAt", "closedAt" '
                    'FROM "MaintenanceLog" WHERE "vehicleId" = %(id)s '
                    'ORDER BY "startedAt" DESC LIMIT 5',
                    params,
                )
                maintenance = cur.fetchall()

                cur.execute(
                    'SELECT count(*) AS open_jobs FROM "MaintenanceLog" '
                    "WHERE \"vehicleId\" = %(id)s AND status = 'OPEN'",
                    params,
                )
                open_jobs = int(cur.fetchone()["open_jobs"])
    except psycopg.Error:
        logger.exception("get_vehicle_profile failed")
        return _error("The vehicle record could not be read from the database.")

    if vehicle is None:
        return {"status": "not_found", "message": "The vehicle record disappeared mid-lookup."}

    result = _json_safe(vehicle)
    result["insurance_status"] = _expiry_status(_days_to_expiry(vehicle["insuranceExpiry"]))
    result["puc_status"] = _expiry_status(_days_to_expiry(vehicle["pucExpiry"]))

    # Service is tracked by distance, not date: due when the odometer has moved
    # a full interval since the last service.
    interval = vehicle["serviceIntervalKm"]
    since_service = None
    if interval:
        since_service = float(vehicle["odometer"]) - float(vehicle["lastServiceOdometer"] or 0)
        result["service"] = {
            "interval_km": float(interval),
            "km_since_last_service": round(since_service, 1),
            "km_until_due": round(float(interval) - since_service, 1),
            "overdue": since_service >= float(interval),
        }
    else:
        result["service"] = {"interval_km": None, "note": "No service interval is configured."}

    return {
        "status": "ok",
        "vehicle": result,
        "current_trip": _json_safe(live_trip) if live_trip else None,
        "open_maintenance_jobs": open_jobs,
        "recent_maintenance": [_json_safe(row) for row in maintenance],
    }


def list_trips(status=None, date_from=None, date_to=None, limit=DEFAULT_ROW_LIMIT) -> dict:
    """The trip board across the whole fleet, with the vehicle and driver on each trip."""
    if status is not None and str(status).strip():
        status = str(status).strip().upper()
        if status not in TRIP_STATUSES:
            return _invalid("status must be one of " + ", ".join(TRIP_STATUSES) + ".")
    else:
        status = None

    parsed_from, err = _parse_dt(date_from, "date_from")
    if err:
        return _invalid(err)
    parsed_to, err = _parse_dt(date_to, "date_to")
    if err:
        return _invalid(err)

    row_limit = _clamp(limit, DEFAULT_ROW_LIMIT, MAX_ROW_LIMIT)

    try:
        with _connect() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                params = {"row_limit": row_limit}
                clauses = []
                if status:
                    params["status"] = status
                    clauses.append("t.status = %(status)s")
                clauses += _range_clauses('t."plannedStart"', parsed_from, parsed_to, params, "d")
                where = (" WHERE " + " AND ".join(clauses)) if clauses else ""

                cur.execute(
                    'SELECT t.status, count(*) AS n, COALESCE(sum(t.revenue), 0) AS revenue '
                    'FROM "Trip" t' + where + " GROUP BY t.status",
                    params,
                )
                totals = cur.fetchall()

                cur.execute(
                    'SELECT t.id, t.source, t.destination, t.status, t."plannedStart", '
                    't."plannedEnd", t."plannedDistance", t."cargoWeightKg", t.revenue, '
                    't."dispatchedAt", t."completedAt", t."cancelledAt", '
                    'v."registrationNo" AS vehicle_reg, v.id AS vehicle_id, '
                    "d.name AS driver_name, d.id AS driver_id, c.name AS customer_name "
                    'FROM "Trip" t '
                    'JOIN "Vehicle" v ON v.id = t."vehicleId" '
                    'JOIN "Driver" d ON d.id = t."driverId" '
                    'LEFT JOIN "Customer" c ON c.id = t."customerId"'
                    + where
                    + ' ORDER BY t."plannedStart" DESC LIMIT %(row_limit)s',
                    params,
                )
                rows = cur.fetchall()
    except psycopg.Error:
        logger.exception("list_trips failed")
        return _error("The trip list could not be read from the database.")

    by_status = {row["status"]: int(row["n"]) for row in totals}
    total = sum(by_status.values())
    return {
        "status": "ok",
        "filters": {"status": status, "period": _window(parsed_from, parsed_to)},
        "totals": {
            "trips": total,
            "by_status": by_status,
            "revenue": float(sum(row["revenue"] for row in totals)),
        },
        "returned": len(rows),
        "truncated": total > len(rows),
        "trips": [_json_safe(row) for row in rows],
    }
