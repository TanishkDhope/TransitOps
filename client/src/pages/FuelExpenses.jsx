import { useState, useMemo } from 'react';
import { useForm, Controller } from 'react-hook-form';
import { motion } from 'framer-motion';
import { Fuel, Plus, Receipt, Wrench, TrendingDown, Info } from 'lucide-react';

import { useData } from '../contexts/DataContext';
import { useAuth } from '../contexts/AuthContext';
import { useToast } from '../hooks/useToast.js';
import { EXPENSE_TYPES } from '../config/roles.js';
import PageHeader from '../components/shared/PageHeader';
import EmptyState from '../components/shared/EmptyState';
import { Button } from '@/components/ui/button';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';

const fuelDefaults = { vehicleId: '', tripId: '', loggedAt: '', liters: '', cost: '' };
const expenseDefaults = { tripId: '', vehicleId: '', type: '', amount: '', note: '' };

export default function FuelExpenses() {
  const { vehicles, trips, maintenance, fuelLogs, expenses, isLoading, addFuelLog, addExpense } =
    useData();
  const { can } = useAuth();
  const toast = useToast();

  const [fuelDialogOpen, setFuelDialogOpen] = useState(false);
  const [expenseDialogOpen, setExpenseDialogOpen] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const fuelForm = useForm({ defaultValues: fuelDefaults, mode: 'onChange' });
  const expenseForm = useForm({ defaultValues: expenseDefaults, mode: 'onChange' });

  const expenseTripId = expenseForm.watch('tripId');
  const fuelTripId = fuelForm.watch('tripId');

  const vehicleLabel = (vehicleId, record) => {
    if (record?.vehicle) return `${record.vehicle.name} (${record.vehicle.registrationNo})`;
    const vehicle = vehicles.find((v) => v.id === vehicleId);
    return vehicle ? `${vehicle.name} (${vehicle.registrationNo})` : '—';
  };

  const tripLabel = (tripId, record) => {
    if (record?.trip) return `${record.trip.source} → ${record.trip.destination}`;
    const trip = trips.find((t) => t.id === tripId);
    return trip ? `${trip.source} → ${trip.destination}` : '—';
  };

  /**
   * ISSUES #12 — this total now uses the same definition as the reports API:
   * fuel + maintenance + other expenses. MAINTENANCE-type expenses are rejected
   * server-side, so a repair can no longer be counted twice.
   */
  const costs = useMemo(() => {
    const totalFuelCost = fuelLogs.reduce((sum, fl) => sum + Number(fl.cost), 0);
    const totalMaintenanceCost = maintenance.reduce((sum, m) => sum + Number(m.cost), 0);
    const totalExpenseCost = expenses.reduce((sum, e) => sum + Number(e.amount), 0);
    return {
      totalFuelCost,
      totalMaintenanceCost,
      totalExpenseCost,
      totalOperationalCost: totalFuelCost + totalMaintenanceCost + totalExpenseCost,
    };
  }, [fuelLogs, maintenance, expenses]);

  const onFuelSubmit = async (data) => {
    setIsSubmitting(true);
    try {
      const result = await addFuelLog({
        vehicleId: data.vehicleId,
        liters: Number(data.liters),
        cost: Number(data.cost),
        ...(data.tripId ? { tripId: data.tripId } : {}),
        ...(data.loggedAt ? { loggedAt: data.loggedAt } : {}),
      });
      toast.fromResponse(result, 'Fuel log added');
      fuelForm.reset(fuelDefaults);
      setFuelDialogOpen(false);
    } catch (err) {
      toast.apiError(err, 'Could not add the fuel log');
    } finally {
      setIsSubmitting(false);
    }
  };

  const onExpenseSubmit = async (data) => {
    setIsSubmitting(true);
    try {
      const result = await addExpense({
        vehicleId: data.vehicleId,
        type: data.type,
        amount: Number(data.amount),
        ...(data.tripId ? { tripId: data.tripId } : {}),
        ...(data.note ? { note: data.note } : {}),
      });
      toast.fromResponse(result, 'Expense recorded');
      expenseForm.reset(expenseDefaults);
      setExpenseDialogOpen(false);
    } catch (err) {
      toast.apiError(err, 'Could not record the expense');
    } finally {
      setIsSubmitting(false);
    }
  };

  /** Selecting a trip pins the vehicle — the API rejects a mismatch. */
  const applyTripToForm = (form, tripId) => {
    form.setValue('tripId', tripId);
    const trip = trips.find((t) => t.id === tripId);
    if (trip?.vehicleId) {
      form.setValue('vehicleId', trip.vehicleId, { shouldValidate: true });
    }
  };

  if (isLoading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-border border-t-[#714B67]" />
      </div>
    );
  }

  const canWrite = can('cost:write');

  return (
    <div className="space-y-6">
      <PageHeader title="Fuel & Expenses" subtitle="Track operational costs" />

      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        className="rounded-xl bg-gradient-to-r from-[#714B67] to-[#5A3C52] p-6 text-white shadow-lg"
      >
        <div className="mb-4 flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-white/15">
            <TrendingDown className="h-5 w-5" />
          </div>
          <div>
            <p className="text-sm text-white/70">Total Operational Cost</p>
            <p className="text-3xl font-bold">
              ₹{costs.totalOperationalCost.toLocaleString('en-IN')}
            </p>
          </div>
        </div>
        <div className="grid grid-cols-3 gap-4 border-t border-white/20 pt-4">
          {[
            { icon: Fuel, label: 'Fuel Cost', value: costs.totalFuelCost },
            { icon: Wrench, label: 'Maintenance Cost', value: costs.totalMaintenanceCost },
            { icon: Receipt, label: 'Other Expenses', value: costs.totalExpenseCost },
          ].map(({ icon: Icon, label, value }) => (
            <div key={label}>
              <div className="mb-1 flex items-center gap-2">
                <Icon className="h-4 w-4 text-white/70" />
                <p className="text-xs uppercase tracking-wider text-white/70">{label}</p>
              </div>
              <p className="text-xl font-semibold">₹{value.toLocaleString('en-IN')}</p>
            </div>
          ))}
        </div>
        <p className="mt-3 flex items-center gap-1.5 text-xs text-white/60">
          <Info className="h-3.5 w-3.5" />
          Matches the Operational Cost report exactly.
        </p>
      </motion.div>

      <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.15 }}>
        <Tabs defaultValue="fuel" className="space-y-4">
          <TabsList className="bg-muted/80">
            <TabsTrigger value="fuel" className="data-[state=active]:bg-card data-[state=active]:text-[#714B67]">
              <Fuel className="mr-2 h-4 w-4" />
              Fuel Logs
            </TabsTrigger>
            <TabsTrigger value="expenses" className="data-[state=active]:bg-card data-[state=active]:text-[#714B67]">
              <Receipt className="mr-2 h-4 w-4" />
              Expenses
            </TabsTrigger>
          </TabsList>

          {/* ---------- Fuel ---------- */}
          <TabsContent value="fuel" className="space-y-4">
            {canWrite && (
              <div className="flex justify-end">
                <Button
                  onClick={() => {
                    fuelForm.reset(fuelDefaults);
                    setFuelDialogOpen(true);
                  }}
                  className="bg-[#714B67] text-white hover:bg-[#5A3C52]"
                >
                  <Plus className="mr-2 h-4 w-4" />
                  Add Fuel Log
                </Button>
              </div>
            )}

            <div className="overflow-hidden rounded-xl border bg-card shadow-sm">
              {fuelLogs.length === 0 ? (
                <EmptyState
                  icon={Fuel}
                  title="No fuel logs"
                  description="Start tracking fuel consumption by adding your first fuel log."
                />
              ) : (
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow className="bg-muted/80">
                        {['Vehicle', 'Trip', 'Date', 'Liters', 'Cost'].map((h) => (
                          <TableHead key={h} className="font-semibold text-muted-foreground">{h}</TableHead>
                        ))}
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {fuelLogs.map((log, index) => (
                        <motion.tr
                          key={log.id}
                          initial={{ opacity: 0, x: -10 }}
                          animate={{ opacity: 1, x: 0 }}
                          transition={{ delay: Math.min(index * 0.03, 0.3) }}
                          className="border-b transition-colors last:border-b-0 hover:bg-muted/50"
                        >
                          <TableCell className="font-medium">{vehicleLabel(log.vehicleId, log)}</TableCell>
                          <TableCell className="text-muted-foreground">{tripLabel(log.tripId, log)}</TableCell>
                          <TableCell className="text-muted-foreground">
                            {new Date(log.loggedAt).toLocaleDateString('en-IN', {
                              day: '2-digit', month: 'short', year: 'numeric',
                            })}
                          </TableCell>
                          <TableCell>{log.liters} L</TableCell>
                          <TableCell className="font-medium">
                            ₹{Number(log.cost).toLocaleString('en-IN')}
                          </TableCell>
                        </motion.tr>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </div>
          </TabsContent>

          {/* ---------- Expenses ---------- */}
          <TabsContent value="expenses" className="space-y-4">
            {canWrite && (
              <div className="flex justify-end">
                <Button
                  onClick={() => {
                    expenseForm.reset(expenseDefaults);
                    setExpenseDialogOpen(true);
                  }}
                  className="bg-[#714B67] text-white hover:bg-[#5A3C52]"
                >
                  <Plus className="mr-2 h-4 w-4" />
                  Add Expense
                </Button>
              </div>
            )}

            <div className="overflow-hidden rounded-xl border bg-card shadow-sm">
              {expenses.length === 0 ? (
                <EmptyState
                  icon={Receipt}
                  title="No expenses recorded"
                  description="Track trip-related expenses like tolls, parking and fines."
                />
              ) : (
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow className="bg-muted/80">
                        {['Trip', 'Vehicle', 'Type', 'Note', 'Amount'].map((h) => (
                          <TableHead key={h} className="font-semibold text-muted-foreground">{h}</TableHead>
                        ))}
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {expenses.map((exp, index) => (
                        <motion.tr
                          key={exp.id}
                          initial={{ opacity: 0, x: -10 }}
                          animate={{ opacity: 1, x: 0 }}
                          transition={{ delay: Math.min(index * 0.03, 0.3) }}
                          className="border-b transition-colors last:border-b-0 hover:bg-muted/50"
                        >
                          <TableCell className="font-medium">{tripLabel(exp.tripId, exp)}</TableCell>
                          <TableCell>{vehicleLabel(exp.vehicleId, exp)}</TableCell>
                          <TableCell>
                            <span
                              className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${
                                exp.type === 'FINE'
                                  ? 'bg-[#E46E78]/10 text-[#E46E78]'
                                  : 'bg-muted/80 text-muted-foreground'
                              }`}
                            >
                              {exp.type}
                            </span>
                          </TableCell>
                          <TableCell className="max-w-[220px] truncate text-muted-foreground">
                            {exp.note || '—'}
                          </TableCell>
                          <TableCell className="font-medium">
                            ₹{Number(exp.amount).toLocaleString('en-IN')}
                          </TableCell>
                        </motion.tr>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </div>
          </TabsContent>
        </Tabs>
      </motion.div>

      {/* ---------- Fuel dialog ---------- */}
      <Dialog open={fuelDialogOpen} onOpenChange={setFuelDialogOpen}>
        <DialogContent className="sm:max-w-[460px]">
          <DialogHeader>
            <DialogTitle>Add Fuel Log</DialogTitle>
          </DialogHeader>

          <form onSubmit={fuelForm.handleSubmit(onFuelSubmit)} className="mt-2 space-y-4">
            <div className="space-y-2">
              <Label>Trip (optional)</Label>
              <Controller
                control={fuelForm.control}
                name="tripId"
                render={({ field }) => (
                  <Select
                    value={field.value}
                    onValueChange={(val) => applyTripToForm(fuelForm, val)}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="Attribute to a trip" />
                    </SelectTrigger>
                    <SelectContent>
                      {trips.filter((t) => t.status !== 'CANCELLED').map((t) => (
                        <SelectItem key={t.id} value={t.id}>
                          {t.source} → {t.destination}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              />
              <p className="text-xs text-muted-foreground/70">
                Linking fuel to a trip is what makes the efficiency report accurate.
              </p>
            </div>

            {/* ISSUES #14 — registered with rules, so an empty vehicle is caught here. */}
            <div className="space-y-2">
              <Label>
                Vehicle <span className="text-[#E46E78]">*</span>
              </Label>
              <Controller
                control={fuelForm.control}
                name="vehicleId"
                rules={{ required: 'Please choose a vehicle' }}
                render={({ field }) => (
                  <Select value={field.value} onValueChange={field.onChange} disabled={Boolean(fuelTripId)}>
                    <SelectTrigger aria-invalid={Boolean(fuelForm.formState.errors.vehicleId)}>
                      <SelectValue placeholder="Select vehicle" />
                    </SelectTrigger>
                    <SelectContent>
                      {vehicles.map((v) => (
                        <SelectItem key={v.id} value={v.id}>
                          {v.name} ({v.registrationNo})
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              />
              {fuelForm.formState.errors.vehicleId && (
                <p className="text-xs text-[#E46E78]">{fuelForm.formState.errors.vehicleId.message}</p>
              )}
            </div>

            <div className="space-y-2">
              <Label htmlFor="loggedAt">Date</Label>
              <Input id="loggedAt" type="date" {...fuelForm.register('loggedAt')} />
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="liters">
                  Liters <span className="text-[#E46E78]">*</span>
                </Label>
                <Input
                  id="liters"
                  type="number"
                  step="0.1"
                  min={0.1}
                  placeholder="0"
                  {...fuelForm.register('liters', {
                    required: 'Litres are required',
                    min: { value: 0.1, message: 'Must be greater than 0' },
                  })}
                />
                {fuelForm.formState.errors.liters && (
                  <p className="text-xs text-[#E46E78]">{fuelForm.formState.errors.liters.message}</p>
                )}
              </div>
              <div className="space-y-2">
                <Label htmlFor="fuelCost">
                  Cost (₹) <span className="text-[#E46E78]">*</span>
                </Label>
                <Input
                  id="fuelCost"
                  type="number"
                  min={0}
                  placeholder="0"
                  {...fuelForm.register('cost', {
                    required: 'Cost is required',
                    min: { value: 0, message: 'Cannot be negative' },
                  })}
                />
                {fuelForm.formState.errors.cost && (
                  <p className="text-xs text-[#E46E78]">{fuelForm.formState.errors.cost.message}</p>
                )}
              </div>
            </div>

            <DialogFooter className="pt-2">
              <Button type="button" variant="outline" onClick={() => setFuelDialogOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={isSubmitting} className="bg-[#714B67] text-white hover:bg-[#5A3C52]">
                {isSubmitting ? 'Saving…' : 'Add Fuel Log'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* ---------- Expense dialog ---------- */}
      <Dialog open={expenseDialogOpen} onOpenChange={setExpenseDialogOpen}>
        <DialogContent className="sm:max-w-[460px]">
          <DialogHeader>
            <DialogTitle>Add Expense</DialogTitle>
          </DialogHeader>

          <form onSubmit={expenseForm.handleSubmit(onExpenseSubmit)} className="mt-2 space-y-4">
            <div className="space-y-2">
              <Label>Trip (optional)</Label>
              <Controller
                control={expenseForm.control}
                name="tripId"
                render={({ field }) => (
                  <Select
                    value={field.value}
                    onValueChange={(val) => applyTripToForm(expenseForm, val)}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="Attribute to a trip" />
                    </SelectTrigger>
                    <SelectContent>
                      {trips.filter((t) => t.status !== 'CANCELLED').map((t) => (
                        <SelectItem key={t.id} value={t.id}>
                          {t.source} → {t.destination}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              />
            </div>

            <div className="space-y-2">
              <Label>
                Vehicle <span className="text-[#E46E78]">*</span>
              </Label>
              <Controller
                control={expenseForm.control}
                name="vehicleId"
                rules={{ required: 'Please choose a vehicle' }}
                render={({ field }) => (
                  <Select value={field.value} onValueChange={field.onChange} disabled={Boolean(expenseTripId)}>
                    <SelectTrigger aria-invalid={Boolean(expenseForm.formState.errors.vehicleId)}>
                      <SelectValue placeholder="Select vehicle" />
                    </SelectTrigger>
                    <SelectContent>
                      {vehicles.map((v) => (
                        <SelectItem key={v.id} value={v.id}>
                          {v.name} ({v.registrationNo})
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              />
              {expenseForm.formState.errors.vehicleId && (
                <p className="text-xs text-[#E46E78]">
                  {expenseForm.formState.errors.vehicleId.message}
                </p>
              )}
            </div>

            <div className="space-y-2">
              <Label>
                Type <span className="text-[#E46E78]">*</span>
              </Label>
              <Controller
                control={expenseForm.control}
                name="type"
                rules={{ required: 'Please choose an expense type' }}
                render={({ field }) => (
                  <Select value={field.value} onValueChange={field.onChange}>
                    <SelectTrigger aria-invalid={Boolean(expenseForm.formState.errors.type)}>
                      <SelectValue placeholder="Select type" />
                    </SelectTrigger>
                    <SelectContent>
                      {EXPENSE_TYPES.map((t) => (
                        <SelectItem key={t} value={t}>{t}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              />
              {expenseForm.formState.errors.type && (
                <p className="text-xs text-[#E46E78]">{expenseForm.formState.errors.type.message}</p>
              )}
              <p className="text-xs text-muted-foreground/70">
                Repairs belong in Maintenance — logging them here would double-count them.
              </p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="amount">
                Amount (₹) <span className="text-[#E46E78]">*</span>
              </Label>
              <Input
                id="amount"
                type="number"
                min={0}
                placeholder="0"
                {...expenseForm.register('amount', {
                  required: 'Amount is required',
                  min: { value: 0, message: 'Cannot be negative' },
                })}
              />
              {expenseForm.formState.errors.amount && (
                <p className="text-xs text-[#E46E78]">{expenseForm.formState.errors.amount.message}</p>
              )}
            </div>

            <div className="space-y-2">
              <Label htmlFor="note">Note</Label>
              <Input id="note" placeholder="Optional detail" {...expenseForm.register('note')} />
            </div>

            <DialogFooter className="pt-2">
              <Button type="button" variant="outline" onClick={() => setExpenseDialogOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={isSubmitting} className="bg-[#714B67] text-white hover:bg-[#5A3C52]">
                {isSubmitting ? 'Saving…' : 'Add Expense'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
