import { useState, useMemo, useCallback, useEffect } from 'react';
import { useForm, Controller } from 'react-hook-form';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Plus, MapPin, Truck, User, Weight, Route as RouteIcon, Send, CheckCircle2,
  XCircle, Package, AlertCircle, Calendar, Building2, IndianRupee, ShieldAlert,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';

import { useData } from '../contexts/DataContext';
import { useAuth } from '../contexts/AuthContext';
import { useToast } from '../hooks/useToast.js';
import * as tripsApi from '../api/trips.js';
import * as customersApi from '../api/customers.js';
import { CITIES, SAFETY_THRESHOLDS } from '../config/roles.js';
import PageHeader from '../components/shared/PageHeader';
import StatusBadge from '../components/shared/StatusBadge';
import EmptyState from '../components/shared/EmptyState';
import ConfirmDialog from '../components/shared/ConfirmDialog';

const TAB_CONFIG = [
  { value: 'DISPATCHED', label: 'Active', icon: Send },
  { value: 'DRAFT', label: 'Draft', icon: Package },
  { value: 'COMPLETED', label: 'Completed', icon: CheckCircle2 },
  { value: 'CANCELLED', label: 'Cancelled', icon: XCircle },
];

const EMPTY_MESSAGES = {
  DISPATCHED: { title: 'No active trips', description: 'Dispatched trips will appear here.' },
  DRAFT: { title: 'No draft trips', description: 'Create a new trip to get started.' },
  COMPLETED: { title: 'No completed trips', description: 'Completed trips will appear here.' },
  CANCELLED: { title: 'No cancelled trips', description: 'Cancelled trips will appear here.' },
};

/** Local datetime string for <input type="datetime-local"> */
function toLocalInput(date) {
  const d = new Date(date);
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 16);
}

const defaultValues = () => {
  const start = new Date(Date.now() + 60 * 60 * 1000);
  const end = new Date(start.getTime() + 8 * 60 * 60 * 1000);
  return {
    source: '',
    destination: '',
    vehicleId: '',
    driverId: '',
    customerId: '',
    cargoWeightKg: '',
    plannedDistance: '',
    plannedStart: toLocalInput(start),
    plannedEnd: toLocalInput(end),
  };
};

export default function Trips() {
  // Trips arrive with `vehicle`, `driver` and `customer` already included by the
  // API, so the page no longer needs to join against the full collections.
  const { trips, customers, isLoading, addTrip, dispatchTrip, completeTrip, cancelTrip } = useData();
  const { can } = useAuth();
  const toast = useToast();

  const [dialogOpen, setDialogOpen] = useState(false);
  const [activeTab, setActiveTab] = useState('DISPATCHED');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [availableVehicles, setAvailableVehicles] = useState([]);
  const [availableDrivers, setAvailableDrivers] = useState([]);
  const [loadingAvailability, setLoadingAvailability] = useState(false);
  const [quote, setQuote] = useState(null);

  const [completeDialogOpen, setCompleteDialogOpen] = useState(false);
  const [completingTrip, setCompletingTrip] = useState(null);
  const [cancelTarget, setCancelTarget] = useState(null);
  const [busyTripId, setBusyTripId] = useState(null);

  const form = useForm({ defaultValues: defaultValues(), mode: 'onChange' });
  const completeForm = useForm({ defaultValues: { endOdometer: '', fuelConsumedL: '', revenue: '' } });

  const watchSource = form.watch('source');
  const watchVehicleId = form.watch('vehicleId');
  const watchCargo = form.watch('cargoWeightKg');
  const watchStart = form.watch('plannedStart');
  const watchEnd = form.watch('plannedEnd');
  const watchCustomerId = form.watch('customerId');
  const watchDistance = form.watch('plannedDistance');

  const selectedVehicle = useMemo(
    () => availableVehicles.find((v) => v.id === watchVehicleId),
    [availableVehicles, watchVehicleId]
  );

  const cargoExceedsCapacity = useMemo(() => {
    if (!selectedVehicle || !watchCargo) return false;
    return Number(watchCargo) > selectedVehicle.maxLoadKg;
  }, [selectedVehicle, watchCargo]);

  const windowInvalid = useMemo(() => {
    if (!watchStart || !watchEnd) return false;
    return new Date(watchEnd) <= new Date(watchStart);
  }, [watchStart, watchEnd]);

  const tripsByStatus = useMemo(() => {
    const grouped = { DISPATCHED: [], DRAFT: [], COMPLETED: [], CANCELLED: [] };
    trips.forEach((t) => {
      if (grouped[t.status]) grouped[t.status].push(t);
    });
    return grouped;
  }, [trips]);

  /**
   * ISSUES #31 — availability is re-queried whenever the planned window changes,
   * so the dropdowns show who is genuinely free for *that* window rather than
   * only who is idle right now.
   */
  const loadAvailability = useCallback(
    async (start, end) => {
      if (!start || !end || new Date(end) <= new Date(start)) return;

      setLoadingAvailability(true);
      try {
        const params = {
          plannedStart: new Date(start).toISOString(),
          plannedEnd: new Date(end).toISOString(),
        };
        const [vehiclesRes, driversRes] = await Promise.all([
          tripsApi.getAvailableVehicles(params),
          tripsApi.getAvailableDrivers(params),
        ]);
        setAvailableVehicles(vehiclesRes.data.data);
        setAvailableDrivers(driversRes.data.data);
      } catch (err) {
        toast.apiError(err, 'Could not load availability');
      } finally {
        setLoadingAvailability(false);
      }
    },
    [toast]
  );

  useEffect(() => {
    if (!dialogOpen) return;
    const handle = setTimeout(() => loadAvailability(watchStart, watchEnd), 300);
    return () => clearTimeout(handle);
  }, [dialogOpen, watchStart, watchEnd, loadAvailability]);

  /** ISSUES #33 — live revenue preview from the customer's rate card. */
  useEffect(() => {
    if (!watchCustomerId || !watchDistance) {
      setQuote(null);
      return;
    }
    let cancelled = false;
    customersApi
      .quoteTrip({
        customerId: watchCustomerId,
        plannedDistance: watchDistance,
        cargoWeightKg: watchCargo || 0,
      })
      .then(({ data }) => {
        if (!cancelled) setQuote(data.data);
      })
      .catch(() => {
        if (!cancelled) setQuote(null);
      });
    return () => {
      cancelled = true;
    };
  }, [watchCustomerId, watchDistance, watchCargo]);

  const openCreateDialog = useCallback(() => {
    form.reset(defaultValues());
    setQuote(null);
    setDialogOpen(true);
  }, [form]);

  async function onSubmit(data) {
    setIsSubmitting(true);
    try {
      const payload = {
        source: data.source,
        destination: data.destination,
        vehicleId: data.vehicleId,
        driverId: data.driverId,
        cargoWeightKg: Number(data.cargoWeightKg),
        plannedDistance: Number(data.plannedDistance),
        plannedStart: new Date(data.plannedStart).toISOString(),
        plannedEnd: new Date(data.plannedEnd).toISOString(),
        ...(data.customerId ? { customerId: data.customerId } : {}),
      };
      const result = await addTrip(payload);
      toast.fromResponse(result, 'Trip created');
      setDialogOpen(false);
    } catch (err) {
      toast.apiError(err, 'Could not create the trip');
    } finally {
      setIsSubmitting(false);
    }
  }

  async function handleDispatch(tripId) {
    setBusyTripId(tripId);
    try {
      const result = await dispatchTrip(tripId);
      toast.fromResponse(result, 'Trip dispatched');
    } catch (err) {
      toast.apiError(err, 'Could not dispatch the trip');
    } finally {
      setBusyTripId(null);
    }
  }

  async function handleConfirmCancel() {
    if (!cancelTarget) return;
    setBusyTripId(cancelTarget.id);
    try {
      const result = await cancelTrip(cancelTarget.id);
      toast.fromResponse(result, 'Trip cancelled');
    } catch (err) {
      toast.apiError(err, 'Could not cancel the trip');
    } finally {
      setBusyTripId(null);
      setCancelTarget(null);
    }
  }

  function openCompleteDialog(trip) {
    setCompletingTrip(trip);
    completeForm.reset({
      endOdometer: '',
      fuelConsumedL: '',
      revenue: trip.revenue != null ? String(trip.revenue) : '',
    });
    setCompleteDialogOpen(true);
  }

  async function onCompleteSubmit(data) {
    try {
      const result = await completeTrip(completingTrip.id, {
        endOdometer: Number(data.endOdometer),
        ...(data.fuelConsumedL ? { fuelConsumedL: Number(data.fuelConsumedL) } : {}),
        ...(data.revenue ? { revenue: Number(data.revenue) } : {}),
      });
      toast.fromResponse(result, 'Trip completed');
      setCompleteDialogOpen(false);
      setCompletingTrip(null);
    } catch (err) {
      toast.apiError(err, 'Could not complete the trip');
    }
  }

  const isFormValid = form.formState.isValid && !cargoExceedsCapacity && !windowInvalid;

  if (isLoading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-border border-t-[#714B67]" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader title="Trip Dispatch" subtitle="Schedule, dispatch and close out fleet trips">
        {can('trip:write') && (
          <Button onClick={openCreateDialog} className="bg-[#714B67] text-white hover:bg-[#5A3C52]">
            <Plus className="mr-2 h-4 w-4" />
            Create Trip
          </Button>
        )}
      </PageHeader>

      <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full">
        {/* ISSUES #11 — was `bg-muted/80/80`, a double opacity modifier Tailwind
            cannot parse, so the tab strip rendered with no background at all. */}
        <TabsList className="grid w-full grid-cols-4 rounded-lg bg-muted/80 p-1">
          {TAB_CONFIG.map(({ value, label, icon: Icon }) => (
            <TabsTrigger
              key={value}
              value={value}
              className="rounded-md text-sm font-medium transition-all data-[state=active]:bg-card data-[state=active]:text-[#714B67] data-[state=active]:shadow-sm"
            >
              <Icon className="mr-1.5 h-4 w-4" />
              {label}
              <span className="ml-1.5 inline-flex min-w-[20px] items-center justify-center rounded-full bg-muted-foreground/20 px-1.5 py-0.5 text-[10px] font-bold text-muted-foreground">
                {tripsByStatus[value].length}
              </span>
            </TabsTrigger>
          ))}
        </TabsList>

        {TAB_CONFIG.map(({ value }) => (
          <TabsContent key={value} value={value} className="mt-4">
            {tripsByStatus[value].length === 0 ? (
              <EmptyState
                icon={Package}
                title={EMPTY_MESSAGES[value].title}
                description={EMPTY_MESSAGES[value].description}
                action={
                  value === 'DRAFT' && can('trip:write') ? (
                    <Button
                      onClick={openCreateDialog}
                      variant="outline"
                      className="border-[#714B67] text-[#714B67] hover:bg-[#714B67]/5"
                    >
                      <Plus className="mr-2 h-4 w-4" />
                      Create Trip
                    </Button>
                  ) : null
                }
              />
            ) : (
              <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                <AnimatePresence mode="popLayout">
                  {tripsByStatus[value].map((trip, idx) => (
                    <TripCard
                      key={trip.id}
                      trip={trip}
                      index={idx}
                      busy={busyTripId === trip.id}
                      canDispatch={can('trip:dispatch')}
                      onDispatch={handleDispatch}
                      onComplete={openCompleteDialog}
                      onCancel={setCancelTarget}
                    />
                  ))}
                </AnimatePresence>
              </div>
            )}
          </TabsContent>
        ))}
      </Tabs>

      {/* ---------- Create Trip ---------- */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-[560px]">
          <DialogHeader>
            <DialogTitle className="text-lg font-semibold text-foreground">Create New Trip</DialogTitle>
          </DialogHeader>

          <form onSubmit={form.handleSubmit(onSubmit)} className="mt-2 space-y-4">
            {/* ISSUES #31 — the schedule drives availability, so it comes first. */}
            <div className="rounded-lg border border-dashed border-border p-3">
              <p className="mb-3 flex items-center gap-1.5 text-sm font-medium text-muted-foreground">
                <Calendar className="h-4 w-4" />
                Schedule
              </p>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="plannedStart">
                    Starts <span className="text-[#E46E78]">*</span>
                  </Label>
                  <Input
                    id="plannedStart"
                    type="datetime-local"
                    {...form.register('plannedStart', { required: 'Start time is required' })}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="plannedEnd">
                    Ends <span className="text-[#E46E78]">*</span>
                  </Label>
                  <Input
                    id="plannedEnd"
                    type="datetime-local"
                    {...form.register('plannedEnd', { required: 'End time is required' })}
                  />
                </div>
              </div>
              {windowInvalid && (
                <p className="mt-2 flex items-center gap-1 text-xs font-semibold text-[#E46E78]">
                  <XCircle className="h-3.5 w-3.5" />
                  The trip must end after it starts.
                </p>
              )}
              <p className="mt-2 text-xs text-muted-foreground/70">
                {loadingAvailability
                  ? 'Checking availability…'
                  : `${availableVehicles.length} vehicle(s) and ${availableDrivers.length} driver(s) free for this window.`}
              </p>
            </div>

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label>
                  Source <span className="text-[#E46E78]">*</span>
                </Label>
                <Controller
                  control={form.control}
                  name="source"
                  rules={{ required: 'Source is required' }}
                  render={({ field }) => (
                    <Select value={field.value} onValueChange={field.onChange}>
                      <SelectTrigger>
                        <SelectValue placeholder="Select source city" />
                      </SelectTrigger>
                      <SelectContent>
                        {CITIES.map((city) => (
                          <SelectItem key={city} value={city}>{city}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                />
                {form.formState.errors.source && (
                  <p className="text-xs text-[#E46E78]">{form.formState.errors.source.message}</p>
                )}
              </div>

              <div className="space-y-1.5">
                <Label>
                  Destination <span className="text-[#E46E78]">*</span>
                </Label>
                <Controller
                  control={form.control}
                  name="destination"
                  rules={{
                    required: 'Destination is required',
                    validate: (val) => val !== watchSource || 'Destination must differ from source',
                  }}
                  render={({ field }) => (
                    <Select value={field.value} onValueChange={field.onChange}>
                      <SelectTrigger>
                        <SelectValue placeholder="Select destination city" />
                      </SelectTrigger>
                      <SelectContent>
                        {CITIES.filter((c) => c !== watchSource).map((city) => (
                          <SelectItem key={city} value={city}>{city}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                />
                {form.formState.errors.destination && (
                  <p className="text-xs text-[#E46E78]">{form.formState.errors.destination.message}</p>
                )}
              </div>

              <div className="space-y-1.5 sm:col-span-2">
                <Label>
                  Vehicle <span className="text-[#E46E78]">*</span>
                </Label>
                <Controller
                  control={form.control}
                  name="vehicleId"
                  rules={{ required: 'Vehicle is required' }}
                  render={({ field }) => (
                    <Select value={field.value} onValueChange={field.onChange}>
                      <SelectTrigger>
                        <SelectValue placeholder="Select an available vehicle" />
                      </SelectTrigger>
                      <SelectContent>
                        {availableVehicles.length === 0 ? (
                          <div className="px-3 py-2 text-sm text-muted-foreground/60">
                            No vehicles free for this window
                          </div>
                        ) : (
                          availableVehicles.map((v) => (
                            <SelectItem key={v.id} value={v.id}>
                              {v.name} ({v.registrationNo}) — max {v.maxLoadKg.toLocaleString('en-IN')} kg
                            </SelectItem>
                          ))
                        )}
                      </SelectContent>
                    </Select>
                  )}
                />
                {form.formState.errors.vehicleId && (
                  <p className="text-xs text-[#E46E78]">{form.formState.errors.vehicleId.message}</p>
                )}
              </div>

              <div className="space-y-1.5 sm:col-span-2">
                <Label>
                  Driver <span className="text-[#E46E78]">*</span>
                </Label>
                <Controller
                  control={form.control}
                  name="driverId"
                  rules={{ required: 'Driver is required' }}
                  render={({ field }) => (
                    <Select value={field.value} onValueChange={field.onChange}>
                      <SelectTrigger>
                        <SelectValue placeholder="Select an available driver" />
                      </SelectTrigger>
                      <SelectContent>
                        {availableDrivers.length === 0 ? (
                          <div className="px-3 py-2 text-sm text-muted-foreground/60">
                            No drivers free with a valid licence
                          </div>
                        ) : (
                          availableDrivers.map((d) => (
                            <SelectItem key={d.id} value={d.id}>
                              {d.name} ({d.licenseCategory})
                              {d.safetyScore < SAFETY_THRESHOLDS.WARN ? ` — score ${d.safetyScore}` : ''}
                            </SelectItem>
                          ))
                        )}
                      </SelectContent>
                    </Select>
                  )}
                />
                {form.formState.errors.driverId && (
                  <p className="text-xs text-[#E46E78]">{form.formState.errors.driverId.message}</p>
                )}
              </div>

              {/* ISSUES #33 — customer + rate card */}
              <div className="space-y-1.5 sm:col-span-2">
                <Label className="flex items-center gap-1.5">
                  <Building2 className="h-3.5 w-3.5" />
                  Customer
                </Label>
                <Controller
                  control={form.control}
                  name="customerId"
                  render={({ field }) => (
                    <Select value={field.value} onValueChange={field.onChange}>
                      <SelectTrigger>
                        <SelectValue placeholder="Select a customer (optional)" />
                      </SelectTrigger>
                      <SelectContent>
                        {customers.length === 0 ? (
                          <div className="px-3 py-2 text-sm text-muted-foreground/60">
                            No customers yet
                          </div>
                        ) : (
                          customers.map((c) => (
                            <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>
                          ))
                        )}
                      </SelectContent>
                    </Select>
                  )}
                />
                {quote?.revenue != null && (
                  <p className="flex items-center gap-1.5 rounded-md bg-[#21B799]/10 px-2 py-1.5 text-xs font-medium text-[#21B799]">
                    <IndianRupee className="h-3.5 w-3.5" />
                    Rate card: ₹{quote.revenue.toLocaleString('en-IN')}
                    {quote.basis ? ` (${quote.basis})` : ''}
                  </p>
                )}
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="cargoWeightKg">
                  Cargo Weight (kg) <span className="text-[#E46E78]">*</span>
                </Label>
                <Input
                  id="cargoWeightKg"
                  type="number"
                  min={0}
                  placeholder="e.g. 5000"
                  {...form.register('cargoWeightKg', {
                    required: 'Cargo weight is required',
                    min: { value: 0, message: 'Cannot be negative' },
                  })}
                />
                {form.formState.errors.cargoWeightKg && (
                  <p className="text-xs text-[#E46E78]">{form.formState.errors.cargoWeightKg.message}</p>
                )}
                {cargoExceedsCapacity && (
                  <p className="mt-1 flex items-center gap-1 rounded-md bg-[#E46E78]/10 px-2 py-1.5 text-xs font-semibold text-[#E46E78]">
                    <XCircle className="h-3.5 w-3.5 shrink-0" />
                    Exceeds capacity ({selectedVehicle?.maxLoadKg.toLocaleString('en-IN')} kg)
                  </p>
                )}
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="plannedDistance">
                  Planned Distance (km) <span className="text-[#E46E78]">*</span>
                </Label>
                <Input
                  id="plannedDistance"
                  type="number"
                  min={1}
                  placeholder="e.g. 1200"
                  {...form.register('plannedDistance', {
                    required: 'Planned distance is required',
                    min: { value: 1, message: 'Must be greater than 0' },
                  })}
                />
                {form.formState.errors.plannedDistance && (
                  <p className="text-xs text-[#E46E78]">{form.formState.errors.plannedDistance.message}</p>
                )}
              </div>
            </div>

            <DialogFooter className="pt-2">
              <Button type="button" variant="outline" onClick={() => setDialogOpen(false)}>
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={!isFormValid || isSubmitting}
                className="bg-[#714B67] text-white hover:bg-[#5A3C52] disabled:opacity-50"
              >
                {isSubmitting ? 'Creating...' : 'Create Trip'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* ---------- Complete Trip ---------- */}
      <Dialog open={completeDialogOpen} onOpenChange={setCompleteDialogOpen}>
        <DialogContent className="sm:max-w-[440px]">
          <DialogHeader>
            <DialogTitle className="text-lg font-semibold text-foreground">Complete Trip</DialogTitle>
          </DialogHeader>

          <form onSubmit={completeForm.handleSubmit(onCompleteSubmit)} className="mt-2 space-y-4">
            {completingTrip && (
              <p className="rounded-md bg-muted/60 px-3 py-2 text-sm text-muted-foreground">
                {completingTrip.source} → {completingTrip.destination}
                {completingTrip.startOdometer != null && (
                  <span className="mt-0.5 block text-xs">
                    Started at {completingTrip.startOdometer.toLocaleString('en-IN')} km
                  </span>
                )}
              </p>
            )}

            <div className="space-y-1.5">
              <Label htmlFor="endOdometer">
                Final Odometer (km) <span className="text-[#E46E78]">*</span>
              </Label>
              <Input
                id="endOdometer"
                type="number"
                min={0}
                {...completeForm.register('endOdometer', {
                  required: 'Final odometer is required',
                  min: { value: 0, message: 'Cannot be negative' },
                })}
              />
              {completeForm.formState.errors.endOdometer && (
                <p className="text-xs text-[#E46E78]">
                  {completeForm.formState.errors.endOdometer.message}
                </p>
              )}
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="fuelConsumedL">Fuel Consumed (L)</Label>
              <Input id="fuelConsumedL" type="number" min={0} {...completeForm.register('fuelConsumedL')} />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="revenue">Revenue (₹)</Label>
              <Input id="revenue" type="number" min={0} {...completeForm.register('revenue')} />
              <p className="text-xs text-muted-foreground/70">
                Leave blank to use the customer's rate card.
              </p>
            </div>

            <DialogFooter className="pt-2">
              <Button type="button" variant="outline" onClick={() => setCompleteDialogOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" className="bg-[#21B799] text-white hover:bg-[#1a9a80]">
                Mark Completed
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={Boolean(cancelTarget)}
        onOpenChange={(open) => !open && setCancelTarget(null)}
        title="Cancel Trip"
        description={
          cancelTarget
            ? `Cancel ${cancelTarget.source} → ${cancelTarget.destination}? ${
                cancelTarget.status === 'DISPATCHED'
                  ? 'The vehicle and driver will be released.'
                  : 'This draft will be marked cancelled.'
              }`
            : ''
        }
        confirmLabel="Cancel Trip"
        onConfirm={handleConfirmCancel}
        variant="destructive"
      />
    </div>
  );
}

/* ─── Trip Card ─── */
function TripCard({ trip, index, busy, canDispatch, onDispatch, onComplete, onCancel }) {
  const overdue =
    trip.status === 'DISPATCHED' && trip.plannedEnd && new Date(trip.plannedEnd) < new Date();

  const fmt = (date) =>
    date
      ? new Date(date).toLocaleString('en-IN', {
          day: '2-digit',
          month: 'short',
          hour: '2-digit',
          minute: '2-digit',
        })
      : '—';

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.95 }}
      transition={{ duration: 0.25, delay: index * 0.04 }}
      className="rounded-xl border border-border bg-card p-5 shadow-sm transition-shadow hover:shadow-md"
    >
      <div className="mb-3 flex items-start justify-between">
        <h3 className="text-sm font-bold text-foreground">Trip #{trip.id.slice(0, 8)}</h3>
        <div className="flex items-center gap-1.5">
          {overdue && (
            <span className="inline-flex items-center gap-1 rounded-full bg-[#E46E78]/15 px-2 py-0.5 text-[10px] font-bold uppercase text-[#E46E78]">
              <ShieldAlert className="h-3 w-3" />
              Overdue
            </span>
          )}
          <StatusBadge status={trip.status} />
        </div>
      </div>

      <div className="space-y-2.5 text-sm">
        <div className="flex items-center gap-2 text-muted-foreground">
          <MapPin className="h-4 w-4 shrink-0 text-[#714B67]" />
          <span>
            {trip.source} <span className="mx-1 font-semibold text-[#714B67]">→</span> {trip.destination}
          </span>
        </div>
        <div className="flex items-center gap-2 text-muted-foreground">
          <Calendar className="h-4 w-4 shrink-0 text-[#5B899E]" />
          <span className="text-xs">
            {fmt(trip.plannedStart)} – {fmt(trip.plannedEnd)}
          </span>
        </div>
        <div className="flex items-center gap-2 text-muted-foreground">
          <Truck className="h-4 w-4 shrink-0 text-[#5B899E]" />
          <span>
            {trip.vehicle ? `${trip.vehicle.name} (${trip.vehicle.registrationNo})` : 'Unassigned'}
          </span>
        </div>
        <div className="flex items-center gap-2 text-muted-foreground">
          <User className="h-4 w-4 shrink-0 text-[#5B899E]" />
          <span>{trip.driver?.name ?? 'Unassigned'}</span>
        </div>
        {trip.customer && (
          <div className="flex items-center gap-2 text-muted-foreground">
            <Building2 className="h-4 w-4 shrink-0 text-[#5B899E]" />
            <span>{trip.customer.name}</span>
          </div>
        )}
        <div className="flex items-center gap-2 text-muted-foreground">
          <Weight className="h-4 w-4 shrink-0 text-[#5B899E]" />
          <span>{trip.cargoWeightKg.toLocaleString('en-IN')} kg</span>
        </div>
        <div className="flex items-center gap-2 text-muted-foreground">
          <RouteIcon className="h-4 w-4 shrink-0 text-[#5B899E]" />
          <span>{trip.plannedDistance.toLocaleString('en-IN')} km planned</span>
        </div>
        {trip.revenue != null && (
          <div className="flex items-center gap-2 text-muted-foreground">
            <IndianRupee className="h-4 w-4 shrink-0 text-[#21B799]" />
            <span>₹{Number(trip.revenue).toLocaleString('en-IN')}</span>
          </div>
        )}
      </div>

      {canDispatch && (trip.status === 'DRAFT' || trip.status === 'DISPATCHED') && (
        <div className="mt-4 flex gap-2 border-t border-border/50 pt-3">
          {trip.status === 'DRAFT' ? (
            <>
              <Button
                size="sm"
                disabled={busy}
                onClick={() => onDispatch(trip.id)}
                className="flex-1 bg-[#21B799] text-white hover:bg-[#1a9a80] disabled:opacity-50"
              >
                <Send className="mr-1.5 h-3.5 w-3.5" />
                {busy ? 'Working…' : 'Dispatch'}
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => onCancel(trip)}
                className="flex-1 border-[#E46E78] text-[#E46E78] hover:bg-[#E46E78]/5"
              >
                <XCircle className="mr-1.5 h-3.5 w-3.5" />
                Cancel
              </Button>
            </>
          ) : (
            <>
              <Button
                size="sm"
                disabled={busy}
                onClick={() => onComplete(trip)}
                className="flex-1 bg-[#21B799] text-white hover:bg-[#1a9a80]"
              >
                <CheckCircle2 className="mr-1.5 h-3.5 w-3.5" />
                Complete
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => onCancel(trip)}
                className="flex-1 border-[#E46E78] text-[#E46E78] hover:bg-[#E46E78]/5"
              >
                <XCircle className="mr-1.5 h-3.5 w-3.5" />
                Cancel
              </Button>
            </>
          )}
        </div>
      )}
    </motion.div>
  );
}
