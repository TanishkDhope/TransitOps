import { createContext, useContext, useState, useCallback, useEffect } from 'react';
import { defaultSettings } from '../config/roles.js';
import { useAuth } from './AuthContext';
import { useToast } from '../hooks/useToast.js';
import * as vehiclesApi from '../api/vehicles.js';
import * as driversApi from '../api/drivers.js';
import * as tripsApi from '../api/trips.js';
import * as maintenanceApi from '../api/maintenance.js';
import * as fuelApi from '../api/fuel.js';
import * as expensesApi from '../api/expenses.js';
import * as customersApi from '../api/customers.js';

const DataContext = createContext(null);

const SETTINGS_KEY = 'transitops.settings';

// Every collection is fetched unpaged for the in-memory store the pages read
// from; the API still paginates by default for direct callers (ISSUES #21).
// Module scope so it is a stable reference across renders.
const ALL = { limit: 'all' };

const upsert = (list, item) => {
  const exists = list.some((x) => x.id === item.id);
  return exists ? list.map((x) => (x.id === item.id ? item : x)) : [item, ...list];
};

/** Loads persisted settings — ISSUES #30, they used to vanish on refresh. */
function loadSettings() {
  try {
    const stored = localStorage.getItem(SETTINGS_KEY);
    return stored ? { ...defaultSettings, ...JSON.parse(stored) } : defaultSettings;
  } catch {
    return defaultSettings;
  }
}

export function DataProvider({ children }) {
  const { isAuthenticated, can, isDriver } = useAuth();
  const toast = useToast();

  const [vehicles, setVehicles] = useState([]);
  const [drivers, setDrivers] = useState([]);
  const [trips, setTrips] = useState([]);
  const [maintenance, setMaintenance] = useState([]);
  const [fuelLogs, setFuelLogs] = useState([]);
  const [expenses, setExpenses] = useState([]);
  const [customers, setCustomers] = useState([]);
  const [settings, setSettings] = useState(loadSettings);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState(null);

  const refreshVehicles = useCallback(async () => {
    const { data } = await vehiclesApi.getVehicles(ALL);
    setVehicles(data.data);
  }, []);

  const refreshDrivers = useCallback(async () => {
    const { data } = await driversApi.getDrivers(ALL);
    setDrivers(data.data);
  }, []);

  const refreshTrips = useCallback(async () => {
    const { data } = await tripsApi.getTrips(ALL);
    setTrips(data.data);
  }, []);

  const refreshMaintenance = useCallback(async () => {
    const { data } = await maintenanceApi.getMaintenanceLogs(ALL);
    setMaintenance(data.data);
  }, []);

  const refreshFuelLogs = useCallback(async () => {
    const { data } = await fuelApi.getFuelLogs(ALL);
    setFuelLogs(data.data);
  }, []);

  const refreshExpenses = useCallback(async () => {
    const { data } = await expensesApi.getExpenses(ALL);
    setExpenses(data.data);
  }, []);

  const refreshCustomers = useCallback(async () => {
    const { data } = await customersApi.getCustomers(ALL);
    setCustomers(data.data);
  }, []);

  /**
   * Only fetch what this role may actually read. Previously every collection was
   * requested for every user, so a Safety Officer generated a burst of 403s on
   * login and the page showed "Failed to load fleet data".
   */
  useEffect(() => {
    // Signed-out is not a loading state — it is derived below rather than set
    // here, so the effect never calls setState synchronously.
    if (!isAuthenticated) return;

    (async () => {
      setIsLoading(true);

      const tasks = [];
      if (can('vehicle:read')) tasks.push(['vehicles', refreshVehicles]);
      if (can('driver:read')) tasks.push(['drivers', refreshDrivers]);
      if (can('trip:read')) tasks.push(['trips', refreshTrips]);
      if (can('maintenance:read')) tasks.push(['maintenance', refreshMaintenance]);
      if (can('cost:read')) tasks.push(['fuel logs', refreshFuelLogs]);
      if (can('cost:read')) tasks.push(['expenses', refreshExpenses]);
      if (can('customer:read')) tasks.push(['customers', refreshCustomers]);

      const results = await Promise.allSettled(tasks.map(([, fn]) => fn()));

      // One partial failure must not blank the whole app.
      const failed = results
        .map((result, index) => (result.status === 'rejected' ? tasks[index][0] : null))
        .filter(Boolean);

      if (failed.length === 0) {
        setError(null);
      } else if (failed.length === tasks.length) {
        setError('Could not load fleet data. Please refresh the page.');
        toast.error('Could not load fleet data', {
          description: 'Check that the server is running, then refresh.',
          dedupeKey: 'load',
        });
      } else {
        setError(null);
        toast.warning('Some data could not be loaded', {
          description: `Failed: ${failed.join(', ')}.`,
          dedupeKey: 'load',
        });
      }

      setIsLoading(false);
    })();
  }, [
    isAuthenticated,
    can,
    refreshVehicles,
    refreshDrivers,
    refreshTrips,
    refreshMaintenance,
    refreshFuelLogs,
    refreshExpenses,
    refreshCustomers,
    toast,
  ]);

  // ========== VEHICLES ==========
  const addVehicle = useCallback(async (payload) => {
    const { data } = await vehiclesApi.createVehicle(payload);
    setVehicles((prev) => [data.data, ...prev]);
    return data;
  }, []);

  const updateVehicle = useCallback(async (id, payload) => {
    const { data } = await vehiclesApi.updateVehicle(id, payload);
    setVehicles((prev) => upsert(prev, data.data));
    return data;
  }, []);

  const deleteVehicle = useCallback(async (id) => {
    const { data } = await vehiclesApi.deleteVehicle(id);
    setVehicles((prev) => upsert(prev, data.data));
    return data;
  }, []);

  const reinstateVehicle = useCallback(async (id) => {
    const { data } = await vehiclesApi.reinstateVehicle(id);
    setVehicles((prev) => upsert(prev, data.data));
    return data;
  }, []);

  // ========== DRIVERS ==========
  const addDriver = useCallback(async (payload) => {
    const { data } = await driversApi.createDriver(payload);
    setDrivers((prev) => [data.data, ...prev]);
    return data;
  }, []);

  const updateDriver = useCallback(async (id, payload) => {
    const { data } = await driversApi.updateDriver(id, payload);
    setDrivers((prev) => upsert(prev, data.data));
    return data;
  }, []);

  const deleteDriver = useCallback(async (id) => {
    const { data } = await driversApi.deleteDriver(id);
    // Archived drivers come back as a record; genuinely deleted ones do not.
    if (data.data?.deleted) {
      setDrivers((prev) => prev.filter((d) => d.id !== id));
    } else {
      setDrivers((prev) => prev.filter((d) => d.id !== id));
    }
    return data;
  }, []);

  const suspendDriver = useCallback(async (id) => {
    const { data } = await driversApi.suspendDriver(id);
    setDrivers((prev) => upsert(prev, data.data));
    return data;
  }, []);

  const setDriverStatus = useCallback(async (id, status) => {
    const { data } = await driversApi.updateDriverStatus(id, status);
    setDrivers((prev) => upsert(prev, data.data));
    return data;
  }, []);

  // ========== TRIPS ==========
  const addTrip = useCallback(
    async (payload) => {
      const { data } = await tripsApi.createTrip(payload);
      setTrips((prev) => [data.data, ...prev]);
      await Promise.allSettled([refreshVehicles(), refreshDrivers()]);
      return data;
    },
    [refreshVehicles, refreshDrivers]
  );

  const dispatchTrip = useCallback(
    async (tripId) => {
      const { data } = await tripsApi.dispatchTrip(tripId);
      setTrips((prev) => upsert(prev, data.data));
      await Promise.allSettled([refreshVehicles(), refreshDrivers()]);
      return data;
    },
    [refreshVehicles, refreshDrivers]
  );

  const completeTrip = useCallback(
    async (tripId, payload) => {
      const { data } = await tripsApi.completeTrip(tripId, payload);
      setTrips((prev) => upsert(prev, data.data));
      await Promise.allSettled([refreshVehicles(), refreshDrivers()]);
      return data;
    },
    [refreshVehicles, refreshDrivers]
  );

  const cancelTrip = useCallback(
    async (tripId, reason) => {
      const { data } = await tripsApi.cancelTrip(tripId, reason);
      setTrips((prev) => upsert(prev, data.data));
      await Promise.allSettled([refreshVehicles(), refreshDrivers()]);
      return data;
    },
    [refreshVehicles, refreshDrivers]
  );

  // ========== MAINTENANCE ==========
  const addMaintenance = useCallback(
    async (payload) => {
      const { data } = await maintenanceApi.createMaintenanceLog(payload);
      setMaintenance((prev) => [data.data, ...prev]);
      await refreshVehicles();
      return data;
    },
    [refreshVehicles]
  );

  const closeMaintenance = useCallback(
    async (id, payload) => {
      const { data } = await maintenanceApi.closeMaintenanceLog(id, payload);
      setMaintenance((prev) => upsert(prev, data.data));
      await refreshVehicles();
      return data;
    },
    [refreshVehicles]
  );

  // ========== COSTS ==========
  const addFuelLog = useCallback(async (payload) => {
    const { data } = await fuelApi.createFuelLog(payload);
    setFuelLogs((prev) => [data.data, ...prev]);
    return data;
  }, []);

  const addExpense = useCallback(
    async (payload) => {
      const { data } = await expensesApi.createExpense(payload);
      setExpenses((prev) => [data.data, ...prev]);
      // A fine changes the driver's safety score server-side.
      if (payload.type === 'FINE') await refreshDrivers();
      return data;
    },
    [refreshDrivers]
  );

  // ========== CUSTOMERS ==========
  const addCustomer = useCallback(async (payload) => {
    const { data } = await customersApi.createCustomer(payload);
    setCustomers((prev) => [data.data, ...prev]);
    return data;
  }, []);

  const updateCustomer = useCallback(async (id, payload) => {
    const { data } = await customersApi.updateCustomer(id, payload);
    setCustomers((prev) => upsert(prev, data.data));
    return data;
  }, []);

  const deleteCustomer = useCallback(async (id) => {
    const { data } = await customersApi.deleteCustomer(id);
    setCustomers((prev) => prev.filter((c) => c.id !== id));
    return data;
  }, []);

  /** ISSUES #30 — settings now persist across reloads. */
  const updateSettings = useCallback((payload) => {
    setSettings((prev) => {
      const next = { ...prev, ...payload };
      try {
        localStorage.setItem(SETTINGS_KEY, JSON.stringify(next));
      } catch {
        // Private browsing / storage disabled — the in-memory value still applies.
      }
      return next;
    });
  }, []);

  const value = {
    vehicles, drivers, trips, maintenance, fuelLogs, expenses, customers, settings,
    // Nothing is loading when nobody is signed in.
    isLoading: isAuthenticated ? isLoading : false,
    error, isDriver,
    refreshVehicles, refreshDrivers, refreshTrips, refreshMaintenance,
    refreshFuelLogs, refreshExpenses, refreshCustomers,
    addVehicle, updateVehicle, deleteVehicle, reinstateVehicle,
    addDriver, updateDriver, deleteDriver, suspendDriver, setDriverStatus,
    addTrip, dispatchTrip, completeTrip, cancelTrip,
    addMaintenance, closeMaintenance,
    addFuelLog, addExpense,
    addCustomer, updateCustomer, deleteCustomer,
    updateSettings,
  };

  return <DataContext.Provider value={value}>{children}</DataContext.Provider>;
}

export function useData() {
  const context = useContext(DataContext);
  if (!context) {
    throw new Error('useData must be used within a DataProvider');
  }
  return context;
}

export default DataContext;
