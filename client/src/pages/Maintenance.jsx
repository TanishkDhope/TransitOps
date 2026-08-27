import { useState, useMemo } from 'react';
import { useForm, Controller } from 'react-hook-form';
import { motion } from 'framer-motion';
import { Wrench, Plus, CheckCircle2, ArrowRightLeft, AlertCircle, Gauge } from 'lucide-react';

import { useData } from '../contexts/DataContext';
import { useAuth } from '../contexts/AuthContext';
import { useToast } from '../hooks/useToast.js';
import { SERVICE_TYPES } from '../config/roles.js';
import PageHeader from '../components/shared/PageHeader';
import StatusBadge from '../components/shared/StatusBadge';
import EmptyState from '../components/shared/EmptyState';
import { Button } from '@/components/ui/button';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

const defaultValues = { vehicleId: '', description: '', cost: '', resetServiceCounter: false };

export default function Maintenance() {
  const { vehicles, maintenance, isLoading, addMaintenance, closeMaintenance } = useData();
  const { can } = useAuth();
  const toast = useToast();

  const [dialogOpen, setDialogOpen] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [busyId, setBusyId] = useState(null);

  const form = useForm({ defaultValues, mode: 'onChange' });

  // A vehicle already IN_SHOP is excluded — the API now refuses a second
  // concurrent open job on the same vehicle (ISSUES #9).
  const selectableVehicles = useMemo(
    () => vehicles.filter((v) => v.status === 'AVAILABLE'),
    [vehicles]
  );

  const sortedMaintenance = useMemo(
    () => [...maintenance].sort((a, b) => new Date(b.startedAt) - new Date(a.startedAt)),
    [maintenance]
  );

  const openJobsByVehicle = useMemo(() => {
    const set = new Set();
    maintenance.forEach((m) => {
      if (m.status === 'OPEN') set.add(m.vehicleId);
    });
    return set;
  }, [maintenance]);

  const getVehicleLabel = (vehicleId, record) => {
    if (record?.vehicle) return `${record.vehicle.name} (${record.vehicle.registrationNo})`;
    const vehicle = vehicles.find((v) => v.id === vehicleId);
    return vehicle ? `${vehicle.name} (${vehicle.registrationNo})` : vehicleId;
  };

  const onSubmit = async (data) => {
    setIsSubmitting(true);
    try {
      const result = await addMaintenance({
        vehicleId: data.vehicleId,
        description: data.description,
        cost: data.cost ? Number(data.cost) : 0,
        resetServiceCounter: data.resetServiceCounter,
      });
      toast.fromResponse(result, 'Maintenance job opened');
      form.reset(defaultValues);
      setDialogOpen(false);
    } catch (err) {
      toast.apiError(err, 'Could not open the maintenance job');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleClose = async (record) => {
    setBusyId(record.id);
    try {
      const result = await closeMaintenance(record.id, {});
      toast.fromResponse(result, 'Maintenance job closed');
    } catch (err) {
      toast.apiError(err, 'Could not close the job');
    } finally {
      setBusyId(null);
    }
  };

  if (isLoading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-border border-t-[#714B67]" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader title="Maintenance" subtitle="Vehicle service management">
        {can('maintenance:write') && (
          <Button
            onClick={() => {
              form.reset(defaultValues);
              setDialogOpen(true);
            }}
            className="bg-[#714B67] text-white hover:bg-[#5A3C52]"
          >
            <Plus className="mr-2 h-4 w-4" />
            Create Maintenance
          </Button>
        )}
      </PageHeader>

      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.1 }}
        className="flex items-start gap-3 rounded-lg border border-[#5B899E]/30 bg-[#5B899E]/5 p-4"
      >
        <ArrowRightLeft className="mt-0.5 h-5 w-5 shrink-0 text-[#5B899E]" />
        <div className="text-sm text-muted-foreground">
          <p className="mb-1 font-medium text-[#5B899E]">Vehicle Status Transitions</p>
          <p>
            Opening a job moves the vehicle to <span className="font-semibold">IN_SHOP</span>.
            Closing it returns the vehicle to <span className="font-semibold">AVAILABLE</span>,
            unless another job is still open on the same vehicle.
          </p>
        </div>
      </motion.div>

      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.2 }}
        className="overflow-hidden rounded-xl border bg-card shadow-sm"
      >
        {sortedMaintenance.length === 0 ? (
          <EmptyState
            icon={Wrench}
            title="No maintenance records"
            description="Create your first maintenance record to start tracking vehicle services."
            action={
              can('maintenance:write') ? (
                <Button onClick={() => setDialogOpen(true)} className="bg-[#714B67] text-white hover:bg-[#5A3C52]">
                  <Plus className="mr-2 h-4 w-4" />
                  Create Maintenance
                </Button>
              ) : null
            }
          />
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow className="bg-muted/80">
                  {['Vehicle', 'Service Type', 'Cost', 'Started', 'Status', ''].map((h, i) => (
                    <TableHead
                      key={h || i}
                      className={`font-semibold text-muted-foreground ${i === 5 ? 'text-right' : ''}`}
                    >
                      {h}
                    </TableHead>
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {sortedMaintenance.map((record, index) => (
                  <motion.tr
                    key={record.id}
                    initial={{ opacity: 0, x: -10 }}
                    animate={{ opacity: 1, x: 0 }}
                    transition={{ delay: Math.min(index * 0.03, 0.3) }}
                    className="border-b transition-colors last:border-b-0 hover:bg-muted/50"
                  >
                    <TableCell className="font-medium">
                      {getVehicleLabel(record.vehicleId, record)}
                    </TableCell>
                    <TableCell>{record.description}</TableCell>
                    <TableCell className="font-medium">
                      ₹{Number(record.cost).toLocaleString('en-IN')}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {new Date(record.startedAt).toLocaleDateString('en-IN', {
                        day: '2-digit',
                        month: 'short',
                        year: 'numeric',
                      })}
                    </TableCell>
                    <TableCell>
                      <StatusBadge status={record.status} />
                    </TableCell>
                    <TableCell className="text-right">
                      {record.status === 'OPEN' && can('maintenance:write') ? (
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={busyId === record.id}
                              onClick={() => handleClose(record)}
                              className="border-[#21B799] text-[#21B799] hover:bg-[#21B799]/10"
                            >
                              <CheckCircle2 className="mr-1 h-4 w-4" />
                              {busyId === record.id ? 'Closing…' : 'Close'}
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent>
                            <p>Closing returns the vehicle to AVAILABLE</p>
                          </TooltipContent>
                        </Tooltip>
                      ) : record.status === 'CLOSED' ? (
                        <CheckCircle2 className="ml-auto h-4 w-4 text-[#21B799]" />
                      ) : null}
                    </TableCell>
                  </motion.tr>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </motion.div>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="sm:max-w-[480px]">
          <DialogHeader>
            <DialogTitle className="text-lg font-semibold">Create Maintenance Record</DialogTitle>
          </DialogHeader>

          <form onSubmit={form.handleSubmit(onSubmit)} className="mt-2 space-y-4">
            {selectableVehicles.length === 0 && (
              <div className="flex items-start gap-2 rounded-lg border border-[#E4A900]/30 bg-[#E4A900]/5 px-3 py-2 text-sm text-muted-foreground">
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-[#E4A900]" />
                No vehicles are currently available. A vehicle must not be on a trip
                or already in the shop.
              </div>
            )}

            {/*
              ISSUES #14 — these selects previously used setValue + watch, which
              never registered the field, so `handleSubmit` treated an empty
              vehicle/service as valid and the user got a raw backend error.
            */}
            <div className="space-y-2">
              <Label>
                Vehicle <span className="text-[#E46E78]">*</span>
              </Label>
              <Controller
                control={form.control}
                name="vehicleId"
                rules={{ required: 'Please choose a vehicle' }}
                render={({ field }) => (
                  <Select value={field.value} onValueChange={field.onChange}>
                    <SelectTrigger aria-invalid={Boolean(form.formState.errors.vehicleId)}>
                      <SelectValue placeholder="Select vehicle" />
                    </SelectTrigger>
                    <SelectContent>
                      {selectableVehicles.map((v) => (
                        <SelectItem key={v.id} value={v.id} disabled={openJobsByVehicle.has(v.id)}>
                          {v.name} — {v.registrationNo}
                          {openJobsByVehicle.has(v.id) ? ' (job already open)' : ''}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              />
              {form.formState.errors.vehicleId && (
                <p className="text-xs text-[#E46E78]">{form.formState.errors.vehicleId.message}</p>
              )}
            </div>

            <div className="space-y-2">
              <Label>
                Service Type <span className="text-[#E46E78]">*</span>
              </Label>
              <Controller
                control={form.control}
                name="description"
                rules={{ required: 'Please choose a service type' }}
                render={({ field }) => (
                  <Select value={field.value} onValueChange={field.onChange}>
                    <SelectTrigger aria-invalid={Boolean(form.formState.errors.description)}>
                      <SelectValue placeholder="Select service type" />
                    </SelectTrigger>
                    <SelectContent>
                      {SERVICE_TYPES.map((st) => (
                        <SelectItem key={st} value={st}>{st}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              />
              {form.formState.errors.description && (
                <p className="text-xs text-[#E46E78]">{form.formState.errors.description.message}</p>
              )}
            </div>

            <div className="space-y-2">
              <Label htmlFor="cost">Cost (₹)</Label>
              <Input
                id="cost"
                type="number"
                min={0}
                placeholder="0"
                {...form.register('cost', { min: { value: 0, message: 'Cannot be negative' } })}
              />
              {form.formState.errors.cost && (
                <p className="text-xs text-[#E46E78]">{form.formState.errors.cost.message}</p>
              )}
            </div>

            {/* ISSUES #34 — a full service resets the preventive-maintenance counter. */}
            <div className="flex items-start gap-2.5 rounded-lg border border-border p-3">
              <Controller
                control={form.control}
                name="resetServiceCounter"
                render={({ field }) => (
                  <Checkbox
                    id="resetServiceCounter"
                    checked={field.value}
                    onCheckedChange={field.onChange}
                    className="mt-0.5 data-[state=checked]:border-[#714B67] data-[state=checked]:bg-[#714B67]"
                  />
                )}
              />
              <Label htmlFor="resetServiceCounter" className="cursor-pointer font-normal">
                <span className="flex items-center gap-1.5 font-medium text-foreground">
                  <Gauge className="h-3.5 w-3.5" />
                  Reset service interval
                </span>
                <span className="mt-0.5 block text-xs text-muted-foreground">
                  Tick for a full service — the next service is then counted from the
                  vehicle's current odometer.
                </span>
              </Label>
            </div>

            <DialogFooter className="pt-2">
              <Button type="button" variant="outline" onClick={() => setDialogOpen(false)}>
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={isSubmitting || selectableVehicles.length === 0}
                className="bg-[#714B67] text-white hover:bg-[#5A3C52]"
              >
                {isSubmitting ? 'Creating...' : 'Create Record'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
