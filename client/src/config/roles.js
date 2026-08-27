// ISSUES #29 — live access configuration, extracted from the 523-line mockData.js
// where it sat alongside ~490 lines of obsolete demo fixtures that used a
// different field vocabulary than the real API.
//
// ISSUES #2 — this MIRRORS server/src/config/permissions.js. The server table is
// the one that is enforced; this one only decides what the UI offers, so the two
// must be kept in step.

/** Backend Role enum → human label. */
export const ROLE_LABELS = {
  ADMIN: 'Admin',
  FLEET_MANAGER: 'Fleet Manager',
  DISPATCHER: 'Dispatcher',
  SAFETY_OFFICER: 'Safety Officer',
  FINANCIAL_ANALYST: 'Financial Analyst',
  DRIVER: 'Driver',
};

/** Routes any authenticated user can reach. */
export const GLOBAL_ROUTES = ['/dashboard', '/settings'];

/**
 * Keyed by the backend enum value (not the label), so a label change cannot
 * silently break access control.
 */
export const ROLE_ACCESS = {
  ADMIN: {
    label: 'Admin',
    routes: [
      '/dashboard',
      '/fleet',
      '/drivers',
      '/trips',
      '/customers',
      '/maintenance',
      '/fuel-expenses',
      '/analytics',
      '/settings',
      '/users',
      '/audit',
    ],
  },
  FLEET_MANAGER: {
    label: 'Fleet Manager',
    routes: ['/dashboard', '/fleet', '/trips', '/maintenance', '/analytics', '/settings'],
  },
  DISPATCHER: {
    label: 'Dispatcher',
    routes: ['/dashboard', '/trips', '/fleet', '/drivers', '/customers', '/settings'],
  },
  SAFETY_OFFICER: {
    label: 'Safety Officer',
    routes: ['/dashboard', '/drivers', '/settings'],
  },
  FINANCIAL_ANALYST: {
    label: 'Financial Analyst',
    routes: ['/dashboard', '/fuel-expenses', '/customers', '/analytics', '/settings'],
  },
  // ISSUES #37 — drivers now have their own view of the system.
  DRIVER: {
    label: 'Driver',
    routes: ['/dashboard', '/my-trips', '/settings'],
  },
};

/**
 * Capability → roles. Mirrors the server table; used to hide actions the API
 * would reject anyway, so users are not shown buttons that always fail.
 */
export const CAPABILITIES = {
  'vehicle:read': ['ADMIN', 'FLEET_MANAGER', 'DISPATCHER', 'SAFETY_OFFICER', 'FINANCIAL_ANALYST'],
  'vehicle:write': ['ADMIN', 'FLEET_MANAGER'],
  'vehicle:retire': ['ADMIN', 'FLEET_MANAGER'],
  'driver:read': ['ADMIN', 'FLEET_MANAGER', 'DISPATCHER', 'SAFETY_OFFICER'],
  'driver:write': ['ADMIN', 'SAFETY_OFFICER'],
  'driver:suspend': ['ADMIN', 'SAFETY_OFFICER'],
  'driver:archive': ['ADMIN', 'SAFETY_OFFICER'],
  'trip:read': ['ADMIN', 'FLEET_MANAGER', 'DISPATCHER', 'FINANCIAL_ANALYST', 'SAFETY_OFFICER'],
  'trip:write': ['ADMIN', 'DISPATCHER'],
  'trip:dispatch': ['ADMIN', 'DISPATCHER'],
  'maintenance:read': ['ADMIN', 'FLEET_MANAGER', 'DISPATCHER', 'FINANCIAL_ANALYST'],
  'maintenance:write': ['ADMIN', 'FLEET_MANAGER'],
  'cost:read': ['ADMIN', 'FLEET_MANAGER', 'FINANCIAL_ANALYST', 'DISPATCHER'],
  'cost:write': ['ADMIN', 'FINANCIAL_ANALYST', 'FLEET_MANAGER', 'DISPATCHER'],
  'customer:read': ['ADMIN', 'DISPATCHER', 'FINANCIAL_ANALYST', 'FLEET_MANAGER'],
  'customer:write': ['ADMIN', 'FINANCIAL_ANALYST'],
  'report:read': ['ADMIN', 'FLEET_MANAGER', 'FINANCIAL_ANALYST'],
  'user:read': ['ADMIN'],
  'user:write': ['ADMIN'],
  'audit:read': ['ADMIN'],
  'notification:trigger': ['ADMIN', 'FLEET_MANAGER', 'SAFETY_OFFICER'],
  'self:driver': ['DRIVER'],
};

/** Roles an Admin may assign. */
export const ASSIGNABLE_ROLES = Object.entries(ROLE_LABELS).map(([value, label]) => ({
  value,
  label,
}));

/**
 * ISSUES #30 — the Settings RBAC matrix used to be hand-maintained, omitted the
 * Admin row entirely, and had no column for Maintenance or User Management even
 * though both are gated. It is now derived from ROLE_ACCESS above.
 */
export const RBAC_MODULES = [
  { key: '/fleet', label: 'Fleet' },
  { key: '/drivers', label: 'Drivers' },
  { key: '/trips', label: 'Trips' },
  { key: '/customers', label: 'Customers' },
  { key: '/maintenance', label: 'Maintenance' },
  { key: '/fuel-expenses', label: 'Fuel & Expenses' },
  { key: '/analytics', label: 'Analytics' },
  { key: '/users', label: 'Users' },
];

export function buildRbacMatrix() {
  return Object.entries(ROLE_ACCESS).map(([roleKey, config]) => ({
    role: config.label,
    roleKey,
    permissions: Object.fromEntries(
      RBAC_MODULES.map((module) => [module.key, config.routes.includes(module.key)])
    ),
  }));
}

export const VEHICLE_TYPES = ['Truck', 'Bus', 'Van', 'Car'];
export const REGIONS = ['North', 'South', 'East', 'West', 'Central'];
export const LICENSE_CATEGORIES = ['HMV', 'LMV', 'Transport'];
export const SERVICE_TYPES = [
  'Oil Change',
  'Brake Service',
  'Tire Replacement',
  'Engine Overhaul',
  'General Service',
  'Transmission Repair',
];
// MAINTENANCE is deliberately absent — the API rejects it to prevent
// double-counting against maintenance logs (ISSUES #12).
export const EXPENSE_TYPES = ['TOLL', 'PARKING', 'FINE', 'OTHER'];
export const VEHICLE_STATUSES = ['AVAILABLE', 'ON_TRIP', 'IN_SHOP', 'RETIRED'];
export const DRIVER_STATUSES = ['AVAILABLE', 'ON_TRIP', 'OFF_DUTY', 'SUSPENDED', 'ARCHIVED'];
export const TRIP_STATUSES = ['DRAFT', 'DISPATCHED', 'COMPLETED', 'CANCELLED'];
export const MAINTENANCE_STATUSES = ['OPEN', 'CLOSED'];

export const CITIES = [
  'Mumbai', 'Delhi', 'Bangalore', 'Chennai', 'Kolkata',
  'Hyderabad', 'Pune', 'Ahmedabad', 'Jaipur', 'Lucknow',
  'Surat', 'Nagpur', 'Indore', 'Bhopal', 'Chandigarh',
];

export const defaultSettings = {
  depotName: 'TransitOps Central Depot',
  currency: 'INR',
  distanceUnit: 'km',
};

/** Safety thresholds, mirroring server/src/services/safety.service.js. */
export const SAFETY_THRESHOLDS = { WARN: 60, BLOCK: 40 };
