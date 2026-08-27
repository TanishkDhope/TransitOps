// ISSUES #37 — Driver self-service.
//
// The person actually running the trip previously had no way to see their
// assignment, close it out, or log a fuel fill from the pump — every data point
// had to be re-entered by an office user afterwards.

import { useState, useEffect, useCallback } from 'react';
import { useForm, Controller } from 'react-hook-form';
import { motion } from 'framer-motion';
import {
  MapPin, Truck, Calendar, Weight, Route as RouteIcon, Fuel, Receipt,
  CheckCircle2, ShieldAlert, Gauge, Building2, Phone, ClipboardList, IndianRupee,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription,
} from '@/components/ui/dialog';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';

import * as meApi from '../api/me.js';
import { useAuth } from '../contexts/AuthContext';
import { useToast } from '../hooks/useToast.js';
import PageHeader from '../components/shared/PageHeader';
import StatusBadge from '../components/shared/StatusBadge';
import EmptyState from '../components/shared/EmptyState';

const DRIVER_EXPENSE_TYPES = ['TOLL', 'PARKING', 'FINE', 'OTHER'];

const fmtDateTime = (date) =>
  date
    ? new Date(date).toLocaleString('en-IN', {
        day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit',
      })
    : '—';

export default function MyTrips() {
  const { user } = useAuth();
  const toast = useToast();

  const [profile, setProfile] = useState(null);
  const [currentTrip, setCurrentTrip] = useState(null);
  const [trips, setTrips] = useState([]);
  const [isLoading, setIsLoading] = useState(true);
  const [notADriver, setNotADriver] = useState(false);

  const [fuelOpen, setFuelOpen] = useState(false);
  const [expenseOpen, setExpenseOpen] = useState(false);
  const [completeOpen, setCompleteOpen] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const fuelForm = useForm({ defaultValues: { liters: '', cost: '' } });
  const expenseForm = useForm({ defaultValues: { type: '', amount: '', note: '' } });
  const completeForm = useForm({ defaultValues: { endOdometer: '', fuelConsumedL: '' } });

  const load = useCallback(async () => {
    setIsLoading(true);
    try {
      const [profileRes, currentRes, tripsRes] = await Promise.all([
        meApi.getMyProfile(),
        meApi.getMyCurrentTrip(),
        meApi.getMyTrips(),
      ]);
      setProfile(profileRes.data.data);
      setCurrentTrip(currentRes.data.data);
      setTrips(tripsRes.data.data);
      setNotADriver(false);
    } catch (err) {
      // A non-driver account reaching this page gets an explanation, not an error toast.
      if (err.response?.status === 403) {
        setNotADriver(true);
      } else {
        toast.apiError(err, 'Could not load your trips');
      }
    } finally {
      setIsLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    load();
  }, [load]);

  const onLogFuel = async (data) => {
    setIsSubmitting(true);
    try {
      const { data: res } = await meApi.logMyFuel({
        tripId: currentTrip.id,
        liters: Number(data.liters),
        cost: Number(data.cost),
      });
      toast.success(res.message);
      fuelForm.reset();
      setFuelOpen(false);
      await load();
    } catch (err) {
      toast.apiError(err, 'Could not log the fuel');
    } finally {
      setIsSubmitting(false);
    }
  };

  const onLogExpense = async (data) => {
    setIsSubmitting(true);
    try {
      const { data: res } = await meApi.logMyExpense({
        tripId: currentTrip.id,
        type: data.type,
        amount: Number(data.amount),
        ...(data.note ? { note: data.note } : {}),
      });
      toast.success(res.message);
      expenseForm.reset();
      setExpenseOpen(false);
      await load();
    } catch (err) {
      toast.apiError(err, 'Could not log the expense');
    } finally {
      setIsSubmitting(false);
    }
  };

  const onComplete = async (data) => {
    setIsSubmitting(true);
    try {
      const { data: res } = await meApi.completeMyTrip(currentTrip.id, {
        endOdometer: Number(data.endOdometer),
        ...(data.fuelConsumedL ? { fuelConsumedL: Number(data.fuelConsumedL) } : {}),
      });
      toast.success(res.message);
      completeForm.reset();
      setCompleteOpen(false);
      await load();
    } catch (err) {
      toast.apiError(err, 'Could not complete the trip');
    } finally {
      setIsSubmitting(false);
    }
  };

  if (isLoading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-border border-t-[#714B67]" />
      </div>
    );
  }

  if (notADriver) {
    return (
      <div className="space-y-6">
        <PageHeader title="My Trips" subtitle="Driver self-service" />
        <EmptyState
          icon={ClipboardList}
          title="Not a driver account"
          description={`${user?.name ?? 'This account'} is not linked to a driver record, so there are no assigned trips to show. An administrator can link it from User Management.`}
        />
      </div>
    );
  }

  const upcoming = trips.filter((t) => t.status === 'DRAFT');
  const history = trips.filter((t) => ['COMPLETED', 'CANCELLED'].includes(t.status));

  return (
    <div className="space-y-6">
      <PageHeader
        title={`Hello, ${profile?.name?.split(' ')[0] ?? 'driver'}`}
        subtitle="Your assignments, fuel and expenses"
      />

      {/* Licence status */}
      {profile?.licence && (profile.licence.expired || profile.licence.expiringSoon) && (
        <motion.div
          initial={{ opacity: 0, y: -6 }}
          animate={{ opacity: 1, y: 0 }}
          className={`flex items-start gap-3 rounded-lg border p-4 ${
            profile.licence.expired
              ? 'border-[#E46E78]/30 bg-[#E46E78]/5'
              : 'border-[#E4A900]/30 bg-[#E4A900]/5'
          }`}
        >
          <ShieldAlert
            className={`mt-0.5 h-5 w-5 shrink-0 ${
              profile.licence.expired ? 'text-[#E46E78]' : 'text-[#E4A900]'
            }`}
          />
          <div className="text-sm text-muted-foreground">
            <p
              className={`mb-0.5 font-medium ${
                profile.licence.expired ? 'text-[#E46E78]' : 'text-[#E4A900]'
              }`}
            >
              {profile.licence.expired ? 'Your licence has expired' : 'Your licence expires soon'}
            </p>
            <p>
              {profile.licence.expired
                ? `It expired ${Math.abs(profile.licence.daysToExpiry)} day(s) ago. You cannot be assigned new trips until it is renewed.`
                : `${profile.licence.daysToExpiry} day(s) remaining. Please renew it soon.`}
            </p>
          </div>
        </motion.div>
      )}

      {/* Stats */}
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        {[
          { label: 'Safety Score', value: profile?.safetyScore ?? '—', accent: '#21B799' },
          { label: 'Completed Trips', value: profile?.stats?.completedTrips ?? 0, accent: '#714B67' },
          { label: 'Upcoming', value: profile?.stats?.upcomingTrips ?? 0, accent: '#5B899E' },
          { label: 'Licence', value: profile?.licenseCategory ?? '—', accent: '#E4A900' },
        ].map((stat) => (
          <div
            key={stat.label}
            className="rounded-xl border border-border bg-card p-4 shadow-sm"
            style={{ borderTopColor: stat.accent, borderTopWidth: 3 }}
          >
            <p className="text-xs uppercase tracking-wider text-muted-foreground/80">{stat.label}</p>
            <p className="mt-1 text-2xl font-bold text-foreground">{stat.value}</p>
          </div>
        ))}
      </div>

      {/* Current trip */}
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        className="overflow-hidden rounded-xl border border-border bg-card shadow-sm"
      >
        <div className="border-b border-border/50 px-5 py-4">
          <h3 className="text-base font-semibold text-foreground">Current Trip</h3>
          <p className="mt-0.5 text-sm text-muted-foreground/80">
            What you are running right now
          </p>
        </div>

        {!currentTrip ? (
          <div className="p-8">
            <EmptyState
              icon={RouteIcon}
              title="No active trip"
              description="You have nothing dispatched at the moment. Upcoming assignments appear below."
            />
          </div>
        ) : (
          <div className="space-y-5 p-5">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="flex items-center gap-2 text-lg font-semibold text-foreground">
                <MapPin className="h-5 w-5 text-[#714B67]" />
                {currentTrip.source}
                <span className="text-[#714B67]">→</span>
                {currentTrip.destination}
              </div>
              <StatusBadge status={currentTrip.status} />
            </div>

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
              <Detail icon={Truck} label="Vehicle" value={`${currentTrip.vehicle.name} (${currentTrip.vehicle.registrationNo})`} />
              <Detail icon={Gauge} label="Odometer at start" value={`${(currentTrip.startOdometer ?? currentTrip.vehicle.odometer).toLocaleString('en-IN')} km`} />
              <Detail icon={Weight} label="Cargo" value={`${currentTrip.cargoWeightKg.toLocaleString('en-IN')} kg`} />
              <Detail icon={RouteIcon} label="Planned distance" value={`${currentTrip.plannedDistance.toLocaleString('en-IN')} km`} />
              <Detail icon={Calendar} label="Due by" value={fmtDateTime(currentTrip.plannedEnd)} />
              {currentTrip.customer && (
                <Detail
                  icon={Building2}
                  label="Customer"
                  value={currentTrip.customer.name}
                  sub={currentTrip.customer.phone}
                />
              )}
            </div>

            {/* Logged so far */}
            <div className="grid grid-cols-2 gap-4 rounded-lg bg-muted/50 p-3">
              <div>
                <p className="text-xs uppercase tracking-wider text-muted-foreground/80">Fuel logged</p>
                <p className="mt-0.5 text-sm font-semibold text-foreground">
                  {currentTrip.fuelLogs.reduce((s, f) => s + f.liters, 0).toFixed(1)} L
                  <span className="ml-2 font-normal text-muted-foreground">
                    ₹{currentTrip.fuelLogs.reduce((s, f) => s + Number(f.cost), 0).toLocaleString('en-IN')}
                  </span>
                </p>
              </div>
              <div>
                <p className="text-xs uppercase tracking-wider text-muted-foreground/80">Expenses logged</p>
                <p className="mt-0.5 text-sm font-semibold text-foreground">
                  ₹{currentTrip.expenses.reduce((s, e) => s + Number(e.amount), 0).toLocaleString('en-IN')}
                  <span className="ml-2 font-normal text-muted-foreground">
                    {currentTrip.expenses.length} item(s)
                  </span>
                </p>
              </div>
            </div>

            <div className="flex flex-wrap gap-2 border-t border-border/50 pt-4">
              <Button
                variant="outline"
                onClick={() => { fuelForm.reset(); setFuelOpen(true); }}
                className="border-[#017E84] text-[#017E84] hover:bg-[#017E84]/5"
              >
                <Fuel className="mr-2 h-4 w-4" />
                Log Fuel
              </Button>
              <Button
                variant="outline"
                onClick={() => { expenseForm.reset(); setExpenseOpen(true); }}
                className="border-[#5B899E] text-[#5B899E] hover:bg-[#5B899E]/5"
              >
                <Receipt className="mr-2 h-4 w-4" />
                Log Expense
              </Button>
              <Button
                onClick={() => {
                  completeForm.reset({ endOdometer: '', fuelConsumedL: '' });
                  setCompleteOpen(true);
                }}
                className="bg-[#21B799] text-white hover:bg-[#1a9a80]"
              >
                <CheckCircle2 className="mr-2 h-4 w-4" />
                Complete Trip
              </Button>
            </div>
          </div>
        )}
      </motion.div>

      {/* Upcoming + history */}
      <Tabs defaultValue="upcoming" className="w-full">
        <TabsList className="bg-muted/80">
          <TabsTrigger value="upcoming" className="data-[state=active]:bg-card data-[state=active]:text-[#714B67]">
            Upcoming ({upcoming.length})
          </TabsTrigger>
          <TabsTrigger value="history" className="data-[state=active]:bg-card data-[state=active]:text-[#714B67]">
            History ({history.length})
          </TabsTrigger>
        </TabsList>

        <TabsContent value="upcoming" className="mt-4 space-y-3">
          {upcoming.length === 0 ? (
            <EmptyState icon={Calendar} title="Nothing scheduled" description="New assignments will appear here." />
          ) : (
            upcoming.map((trip) => <TripRow key={trip.id} trip={trip} />)
          )}
        </TabsContent>

        <TabsContent value="history" className="mt-4 space-y-3">
          {history.length === 0 ? (
            <EmptyState icon={ClipboardList} title="No past trips" description="Completed trips will be listed here." />
          ) : (
            history.map((trip) => <TripRow key={trip.id} trip={trip} showDistance />)
          )}
        </TabsContent>
      </Tabs>

      {/* ---------- Log fuel ---------- */}
      <Dialog open={fuelOpen} onOpenChange={setFuelOpen}>
        <DialogContent className="sm:max-w-[400px]">
          <DialogHeader>
            <DialogTitle>Log Fuel</DialogTitle>
            <DialogDescription>
              Recorded against {currentTrip?.source} → {currentTrip?.destination}
            </DialogDescription>
          </DialogHeader>

          <form onSubmit={fuelForm.handleSubmit(onLogFuel)} className="mt-2 space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="liters">Litres <span className="text-[#E46E78]">*</span></Label>
              <Input
                id="liters" type="number" step="0.1" min={0.1} placeholder="0"
                {...fuelForm.register('liters', {
                  required: 'Litres are required',
                  min: { value: 0.1, message: 'Must be greater than 0' },
                })}
              />
              {fuelForm.formState.errors.liters && (
                <p className="text-xs text-[#E46E78]">{fuelForm.formState.errors.liters.message}</p>
              )}
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="fuelCost">Amount paid (₹) <span className="text-[#E46E78]">*</span></Label>
              <Input
                id="fuelCost" type="number" min={0} placeholder="0"
                {...fuelForm.register('cost', {
                  required: 'Amount is required',
                  min: { value: 0, message: 'Cannot be negative' },
                })}
              />
              {fuelForm.formState.errors.cost && (
                <p className="text-xs text-[#E46E78]">{fuelForm.formState.errors.cost.message}</p>
              )}
            </div>

            <DialogFooter className="pt-2">
              <Button type="button" variant="outline" onClick={() => setFuelOpen(false)}>Cancel</Button>
              <Button type="submit" disabled={isSubmitting} className="bg-[#017E84] text-white hover:bg-[#016066]">
                {isSubmitting ? 'Saving…' : 'Log Fuel'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* ---------- Log expense ---------- */}
      <Dialog open={expenseOpen} onOpenChange={setExpenseOpen}>
        <DialogContent className="sm:max-w-[400px]">
          <DialogHeader>
            <DialogTitle>Log Expense</DialogTitle>
            <DialogDescription>
              Recorded against {currentTrip?.source} → {currentTrip?.destination}
            </DialogDescription>
          </DialogHeader>

          <form onSubmit={expenseForm.handleSubmit(onLogExpense)} className="mt-2 space-y-4">
            <div className="space-y-1.5">
              <Label>Type <span className="text-[#E46E78]">*</span></Label>
              <Controller
                control={expenseForm.control}
                name="type"
                rules={{ required: 'Please choose a type' }}
                render={({ field }) => (
                  <Select value={field.value} onValueChange={field.onChange}>
                    <SelectTrigger><SelectValue placeholder="Select type" /></SelectTrigger>
                    <SelectContent>
                      {DRIVER_EXPENSE_TYPES.map((t) => (
                        <SelectItem key={t} value={t}>{t}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              />
              {expenseForm.formState.errors.type && (
                <p className="text-xs text-[#E46E78]">{expenseForm.formState.errors.type.message}</p>
              )}
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="amount">Amount (₹) <span className="text-[#E46E78]">*</span></Label>
              <Input
                id="amount" type="number" min={0} placeholder="0"
                {...expenseForm.register('amount', {
                  required: 'Amount is required',
                  min: { value: 0, message: 'Cannot be negative' },
                })}
              />
              {expenseForm.formState.errors.amount && (
                <p className="text-xs text-[#E46E78]">{expenseForm.formState.errors.amount.message}</p>
              )}
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="note">Note</Label>
              <Input id="note" placeholder="Optional detail" {...expenseForm.register('note')} />
            </div>

            <DialogFooter className="pt-2">
              <Button type="button" variant="outline" onClick={() => setExpenseOpen(false)}>Cancel</Button>
              <Button type="submit" disabled={isSubmitting} className="bg-[#5B899E] text-white hover:bg-[#4a7182]">
                {isSubmitting ? 'Saving…' : 'Log Expense'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* ---------- Complete ---------- */}
      <Dialog open={completeOpen} onOpenChange={setCompleteOpen}>
        <DialogContent className="sm:max-w-[400px]">
          <DialogHeader>
            <DialogTitle>Complete Trip</DialogTitle>
            <DialogDescription>
              {currentTrip?.source} → {currentTrip?.destination}
            </DialogDescription>
          </DialogHeader>

          <form onSubmit={completeForm.handleSubmit(onComplete)} className="mt-2 space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="endOdometer">Final odometer (km) <span className="text-[#E46E78]">*</span></Label>
              <Input
                id="endOdometer" type="number" min={0}
                placeholder={currentTrip ? String(currentTrip.vehicle.odometer) : '0'}
                {...completeForm.register('endOdometer', {
                  required: 'The final reading is required',
                  min: {
                    value: currentTrip?.vehicle.odometer ?? 0,
                    message: `Must be at least ${(currentTrip?.vehicle.odometer ?? 0).toLocaleString('en-IN')} km`,
                  },
                })}
              />
              {completeForm.formState.errors.endOdometer && (
                <p className="text-xs text-[#E46E78]">{completeForm.formState.errors.endOdometer.message}</p>
              )}
              <p className="text-xs text-muted-foreground/70">
                Read it straight off the dashboard before you leave the vehicle.
              </p>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="fuelConsumedL">Fuel used (L)</Label>
              <Input id="fuelConsumedL" type="number" step="0.1" min={0} {...completeForm.register('fuelConsumedL')} />
            </div>

            <DialogFooter className="pt-2">
              <Button type="button" variant="outline" onClick={() => setCompleteOpen(false)}>Cancel</Button>
              <Button type="submit" disabled={isSubmitting} className="bg-[#21B799] text-white hover:bg-[#1a9a80]">
                {isSubmitting ? 'Saving…' : 'Complete Trip'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function Detail({ icon: Icon, label, value, sub }) {
  return (
    <div>
      <p className="flex items-center gap-1.5 text-xs uppercase tracking-wider text-muted-foreground/80">
        <Icon className="h-3.5 w-3.5" />
        {label}
      </p>
      <p className="mt-0.5 text-sm font-medium text-foreground">{value}</p>
      {sub && (
        <p className="mt-0.5 flex items-center gap-1 text-xs text-muted-foreground">
          <Phone className="h-3 w-3" />
          {sub}
        </p>
      )}
    </div>
  );
}

function TripRow({ trip, showDistance }) {
  const distance =
    trip.endOdometer != null && trip.startOdometer != null
      ? trip.endOdometer - trip.startOdometer
      : null;

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-card p-4 shadow-sm"
    >
      <div className="min-w-0">
        <p className="flex items-center gap-1.5 text-sm font-medium text-foreground">
          <MapPin className="h-4 w-4 shrink-0 text-[#714B67]" />
          {trip.source} <span className="text-[#714B67]">→</span> {trip.destination}
        </p>
        <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
          <span className="flex items-center gap-1">
            <Truck className="h-3 w-3" />
            {trip.vehicle?.registrationNo ?? '—'}
          </span>
          <span className="flex items-center gap-1">
            <Calendar className="h-3 w-3" />
            {fmtDateTime(trip.plannedStart)}
          </span>
          {showDistance && distance != null && (
            <span className="flex items-center gap-1">
              <RouteIcon className="h-3 w-3" />
              {distance.toLocaleString('en-IN')} km
            </span>
          )}
          {trip.customer && (
            <span className="flex items-center gap-1">
              <Building2 className="h-3 w-3" />
              {trip.customer.name}
            </span>
          )}
        </p>
      </div>
      <StatusBadge status={trip.status} />
    </motion.div>
  );
}
