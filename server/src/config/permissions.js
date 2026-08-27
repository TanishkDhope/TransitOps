// ISSUES #2 — Single source of truth for role-based access.
//
// The client mirrors this table in client/src/config/roles.js. Both files must
// agree; the server table is the one that is actually enforced.

export const ROLES = {
  ADMIN: "ADMIN",
  FLEET_MANAGER: "FLEET_MANAGER",
  DISPATCHER: "DISPATCHER",
  SAFETY_OFFICER: "SAFETY_OFFICER",
  FINANCIAL_ANALYST: "FINANCIAL_ANALYST",
  DRIVER: "DRIVER",
};

const { ADMIN, FLEET_MANAGER, DISPATCHER, SAFETY_OFFICER, FINANCIAL_ANALYST, DRIVER } = ROLES;

/**
 * Capability → roles allowed to exercise it.
 * Read capabilities are deliberately broader than write capabilities: a Dispatcher
 * must be able to read the fleet to choose a vehicle, but must not be able to edit it.
 */
export const CAPABILITIES = {
  // Fleet
  "vehicle:read": [ADMIN, FLEET_MANAGER, DISPATCHER, SAFETY_OFFICER, FINANCIAL_ANALYST],
  "vehicle:write": [ADMIN, FLEET_MANAGER],
  "vehicle:retire": [ADMIN, FLEET_MANAGER],

  // Drivers
  "driver:read": [ADMIN, FLEET_MANAGER, DISPATCHER, SAFETY_OFFICER],
  "driver:write": [ADMIN, SAFETY_OFFICER],
  "driver:suspend": [ADMIN, SAFETY_OFFICER],
  "driver:archive": [ADMIN, SAFETY_OFFICER],

  // Trips
  "trip:read": [ADMIN, FLEET_MANAGER, DISPATCHER, FINANCIAL_ANALYST, SAFETY_OFFICER],
  "trip:write": [ADMIN, DISPATCHER],
  "trip:dispatch": [ADMIN, DISPATCHER],

  // Maintenance
  "maintenance:read": [ADMIN, FLEET_MANAGER, DISPATCHER, FINANCIAL_ANALYST],
  "maintenance:write": [ADMIN, FLEET_MANAGER],

  // Costs
  "cost:read": [ADMIN, FLEET_MANAGER, FINANCIAL_ANALYST, DISPATCHER],
  "cost:write": [ADMIN, FINANCIAL_ANALYST, FLEET_MANAGER, DISPATCHER],

  // Customers
  "customer:read": [ADMIN, DISPATCHER, FINANCIAL_ANALYST, FLEET_MANAGER],
  "customer:write": [ADMIN, FINANCIAL_ANALYST],

  // Analytics
  "report:read": [ADMIN, FLEET_MANAGER, FINANCIAL_ANALYST],

  // Dashboard — everyone with a login
  "dashboard:read": [ADMIN, FLEET_MANAGER, DISPATCHER, SAFETY_OFFICER, FINANCIAL_ANALYST, DRIVER],

  // Administration
  "user:read": [ADMIN],
  "user:write": [ADMIN],
  "audit:read": [ADMIN],
  "notification:trigger": [ADMIN, FLEET_MANAGER, SAFETY_OFFICER],

  // Driver self-service (ISSUES #37)
  "self:driver": [DRIVER],
};

/** Roles an Admin may assign when creating a user. */
export const ASSIGNABLE_ROLES = [
  ADMIN,
  FLEET_MANAGER,
  DISPATCHER,
  SAFETY_OFFICER,
  FINANCIAL_ANALYST,
  DRIVER,
];

export function rolesFor(capability) {
  const roles = CAPABILITIES[capability];
  if (!roles) throw new Error(`Unknown capability: ${capability}`);
  return roles;
}

export function roleHasCapability(role, capability) {
  return rolesFor(capability).includes(role);
}

export default CAPABILITIES;
