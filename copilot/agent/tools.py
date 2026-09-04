"""Tool surface the router binds to the model.

Each function's signature and docstring ARE the tool schema: bind_tools turns
them into the JSON schema the model routes on. The docstring is the whole
description, so routing errors are usually fixed by rewriting a description
string here, not by changing models or prompts.

The document tool is a declaration only — router.py executes retrieval itself.
The database tools are thin wrappers that delegate to copilot.agent.db_tools,
which owns every SQL statement, the column allow-list and the row caps.

There is deliberately no general "run a SQL query" tool. The database surface
is exactly these five fixed, parameterised questions; anything outside them is
answered by saying it is not supported rather than by assembling SQL from the
model's output.
"""

from typing import Any

from copilot.agent import db_tools


def search_policy_documents(query: str) -> dict[str, Any]:
    """Search internal company policy documents, Indian transport statutes and rules, and commercial vehicle insurance policy wordings. Use for questions about rules, procedures, entitlements, definitions, requirements, coverage, deadlines, thresholds and what a document says. Not for questions about specific trips, drivers, vehicles or records in the operational database.
    """
    # Note: Routing errors are usually fixed by rewriting this description string,
    # not by changing models or prompts.
    pass


def get_driver_profile(driver_id: str | None = None, driver_name: str | None = None) -> dict[str, Any]:
    """Look up one driver's current record: their name, status (AVAILABLE, ON_TRIP, OFF_DUTY, SUSPENDED or ARCHIVED), licence category, licence expiry date and current safety score. Use this for "who is driver X", "is driver X suspended", "what is X's safety score", "when does X's licence expire". Identify the driver with driver_name (their full or partial name) or, if you already know it, driver_id. Use get_driver_incident_history instead for WHY a driver was suspended, and get_driver_safety_breakdown instead for WHY a safety score is what it is.
    """
    return db_tools.get_driver_profile(driver_id=driver_id, driver_name=driver_name)


def get_driver_trip_history(
    driver_id: str | None = None,
    driver_name: str | None = None,
    status: str | None = None,
    date_from: str | None = None,
    date_to: str | None = None,
    limit: int = 20,
) -> dict[str, Any]:
    """List the trips one driver has run, newest first, with exact totals alongside the returned rows. Each trip includes its route, status, planned dates, distance, fuel consumed and revenue. Use this for "how many trips has driver X completed", "what trips did X run last month", "show X's trip history". Identify the driver with driver_name or driver_id. Optionally filter with status (one of DRAFT, DISPATCHED, COMPLETED or CANCELLED) and with date_from / date_to as ISO dates such as 2026-01-31, which bound the trip's planned start. limit caps how many trip rows come back (default 20, maximum 100); the totals returned alongside always cover every matching trip, so use those for counts rather than counting the rows.
    """
    return db_tools.get_driver_trip_history(
        driver_id=driver_id,
        driver_name=driver_name,
        status=status,
        date_from=date_from,
        date_to=date_to,
        limit=limit,
    )


def get_driver_safety_breakdown(driver_id: str | None = None, driver_name: str | None = None) -> dict[str, Any]:
    """Explain how one driver's safety score is arrived at, by recomputing it and returning every component: the base score, the number of traffic fines and the penalty they carry, the number of trips cancelled after dispatch and their penalty, the driver's licence expiry status and its penalty, the number of completed trips and the bonus they earn, and the resulting score. Use this for "why is driver X's safety score 62", "what is dragging down X's score", "explain X's safety rating". Identify the driver with driver_name or driver_id. Returns both the score stored on the driver record and the score recomputed from current records, so a stale stored value is visible.
    """
    return db_tools.get_driver_safety_breakdown(driver_id=driver_id, driver_name=driver_name)


def get_vehicle_or_driver_financials(
    vehicle_id: str | None = None,
    vehicle_registration_no: str | None = None,
    driver_id: str | None = None,
    driver_name: str | None = None,
    date_from: str | None = None,
    date_to: str | None = None,
) -> dict[str, Any]:
    """Summarise the money for ONE vehicle or ONE driver: total trip revenue, total fuel litres and cost, total expenses broken down by type (TOLL, PARKING, FINE, MAINTENANCE, OTHER), maintenance cost, and the resulting net. Use this for "how much did vehicle KA01AB1234 cost last quarter", "what has driver X earned this year", "break down the expenses on this truck". Name the subject with exactly one of vehicle_registration_no, vehicle_id, driver_name or driver_id — never a vehicle and a driver in the same call. Optionally bound the period with date_from / date_to as ISO dates such as 2026-01-31. Maintenance is tracked per vehicle only, so a driver-scoped call returns no maintenance figure.
    """
    return db_tools.get_vehicle_or_driver_financials(
        vehicle_id=vehicle_id,
        vehicle_registration_no=vehicle_registration_no,
        driver_id=driver_id,
        driver_name=driver_name,
        date_from=date_from,
        date_to=date_to,
    )


def get_driver_incident_history(
    driver_id: str | None = None,
    driver_name: str | None = None,
    date_from: str | None = None,
    date_to: str | None = None,
    limit: int = 20,
) -> dict[str, Any]:
    """Retrieve one driver's disciplinary and incident history: every suspension, reinstatement, status change and archival recorded in the audit trail, each with the date, the reason entered at the time and who did it, plus every traffic fine charged against that driver's trips with its amount and the trip it happened on. Use this for "why was driver X suspended", "has X been suspended before", "what happened with driver X", "what fines does X have". Identify the driver with driver_name or driver_id, and optionally bound the period with date_from / date_to as ISO dates such as 2026-01-31. Note that TransitOps has no dedicated incident table, so this is reconstructed from the audit trail and fine expenses; the result carries a disclaimer that you must repeat to the user.
    """
    return db_tools.get_driver_incident_history(
        driver_id=driver_id,
        driver_name=driver_name,
        date_from=date_from,
        date_to=date_to,
        limit=limit,
    )


def list_vehicles(
    status: str | None = None,
    vehicle_type: str | None = None,
    region: str | None = None,
    limit: int = 50,
) -> dict[str, Any]:
    """List the vehicle fleet and what each vehicle is doing right now. Every vehicle comes back with its registration number, type, status (AVAILABLE, ON_TRIP, IN_SHOP or RETIRED), region, odometer, insurance and PUC expiry state, and — for anything currently out — the trip it is on and the driver driving it. Use this for "which vehicles are on trip right now", "what trucks are available", "what is in the shop", "how big is the fleet", "which vehicles have expired insurance". Filter with status, vehicle_type (e.g. truck, tanker) or region; leave all of them empty to see the whole fleet. The reply always carries fleet-wide counts by status covering every vehicle, so answer "how many" from those counts rather than by counting the listed rows, which are capped at limit (default 50, maximum 100).
    """
    return db_tools.list_vehicles(
        status=status, vehicle_type=vehicle_type, region=region, limit=limit
    )


def list_drivers(status: str | None = None, limit: int = 50) -> dict[str, Any]:
    """List the drivers on the books and what each is doing right now: status (AVAILABLE, ON_TRIP, OFF_DUTY, SUSPENDED or ARCHIVED), licence category and expiry, safety score, and — for anyone currently out — the trip they are on and the vehicle they are driving. Use this for "who is available today", "which drivers are on the road", "who is suspended", "whose licence expires soon", "which drivers have a low safety score". Filter with status, or leave it empty for everyone. The reply always carries counts by status covering every driver, so answer "how many" from those counts rather than by counting the listed rows, which are capped at limit (default 50, maximum 100). For one named driver use get_driver_profile instead.
    """
    return db_tools.list_drivers(status=status, limit=limit)


def get_vehicle_profile(
    vehicle_id: str | None = None, vehicle_registration_no: str | None = None
) -> dict[str, Any]:
    """Look up one vehicle in depth: its status, type, region, odometer and load capacity; whether its insurance and PUC certificate are valid, expiring or expired; how far it is past or short of its next service by distance; the trip it is on right now with the driver; how many maintenance jobs are open; and its five most recent maintenance jobs with cost. Use this for "tell me about vehicle KA01AB1234", "is this truck due a service", "is its insurance still valid", "what is this vehicle doing right now", "what maintenance has it had". Identify it with vehicle_registration_no (full or partial) or vehicle_id. For costs and revenue use get_vehicle_or_driver_financials instead; for the whole fleet at once use list_vehicles.
    """
    return db_tools.get_vehicle_profile(
        vehicle_id=vehicle_id, vehicle_registration_no=vehicle_registration_no
    )


def list_trips(
    status: str | None = None,
    date_from: str | None = None,
    date_to: str | None = None,
    limit: int = 20,
) -> dict[str, Any]:
    """List trips across the whole fleet, newest first, each with its route, status, planned dates, distance, cargo weight, revenue, and the vehicle, driver and customer on it. Use this for "what trips are running right now" (status DISPATCHED), "what is scheduled next week", "what was cancelled this month", "how much revenue did we book in August". Filter with status (DRAFT, DISPATCHED, COMPLETED or CANCELLED) and with date_from / date_to as ISO dates such as 2026-01-31, which bound the planned start. The reply carries counts and total revenue for everything matching the filter, so answer "how many" and "how much" from those totals rather than from the listed rows, which are capped at limit (default 20, maximum 100). For the trips of one named driver use get_driver_trip_history instead.
    """
    return db_tools.list_trips(
        status=status, date_from=date_from, date_to=date_to, limit=limit
    )


# The database tools, in the order they are bound. search_policy_documents is
# kept separate because router.py executes it specially (retrieval + the
# refusal threshold) rather than by calling it.
DATABASE_TOOLS = (
    get_driver_profile,
    get_driver_trip_history,
    get_driver_safety_breakdown,
    get_vehicle_or_driver_financials,
    get_driver_incident_history,
    list_vehicles,
    list_drivers,
    get_vehicle_profile,
    list_trips,
)

DATABASE_TOOLS_BY_NAME = {tool.__name__: tool for tool in DATABASE_TOOLS}
