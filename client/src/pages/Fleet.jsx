import { useState, useMemo } from 'react';
import { useForm, Controller } from 'react-hook-form';
import { motion } from 'framer-motion';
import {
  Plus, Search, Eye, Pencil, Ban, Truck, MapPin, Gauge, Weight, IndianRupee,
  Hash, ScanLine, CheckCircle2, ShieldAlert, FileText, RotateCcw, Wrench,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';

import { useData } from '../contexts/DataContext';
import { useAuth } from '../contexts/AuthContext';
import { useToast } from '../hooks/useToast.js';
import * as vehiclesApi from '../api/vehicles.js';
import useObjectUrl from '../hooks/useObjectUrl';
import { VEHICLE_TYPES, REGIONS, VEHICLE_STATUSES } from '../config/roles.js';
import PageHeader from '../components/shared/PageHeader';
import StatusBadge from '../components/shared/StatusBadge';
import EmptyState from '../components/shared/EmptyState';
import ConfirmDialog from '../components/shared/ConfirmDialog';

const ALL_TYPES = ['All', ...VEHICLE_TYPES];
const ALL_STATUSES = ['All', ...VEHICLE_STATUSES];

const fmt = (num) => (num != null ? Number(num).toLocaleString('en-IN') : '—');
const fmtCurrency = (num) => (num != null ? `₹${Number(num).toLocaleString('en-IN')}` : '—');

const isExpired = (date) => Boolean(date) && new Date(date) < new Date();

function DocumentThumb({ file }) {
  const previewUrl = useObjectUrl(file);
  if (!previewUrl) return null;
  return (
    <img
      src={previewUrl}
      alt={file.name}
      className="h-20 w-full rounded-md border border-border object-cover"
    />
  );
}

const defaultFormValues = {
  registrationNo: '', name: '', type: '', maxLoadKg: '', odometer: '', acquisitionCost: '',
  region: '', rcNumber: '', insuranceNumber: '', insuranceExpiry: '', pucNumber: '', pucExpiry: '',
  serviceIntervalKm: '', lastServiceOdometer: '',
};

export default function Fleet() {
  const { vehicles, isLoading, addVehicle, updateVehicle, deleteVehicle, reinstateVehicle } = useData();
  const { can } = useAuth();
  const toast = useToast();

  const [searchQuery, setSearchQuery] = useState('');
  const [typeFilter, setTypeFilter] = useState('All');
  const [statusFilter, setStatusFilter] = useState('All');

  const [formDialogOpen, setFormDialogOpen] = useState(false);
  const [viewDialogOpen, setViewDialogOpen] = useState(false);
  const [editingVehicle, setEditingVehicle] = useState(null);
  const [viewingVehicle, setViewingVehicle] = useState(null);
  const [retireTarget, setRetireTarget] = useState(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const [documentFiles, setDocumentFiles] = useState([]);
  const [documentUrls, setDocumentUrls] = useState([]);
  const [isExtracting, setIsExtracting] = useState(false);
  const [isExtracted, setIsExtracted] = useState(false);

  const { register, handleSubmit, reset, control, setValue, formState: { errors } } = useForm({
    defaultValues: defaultFormValues,
  });

  const canWrite = can('vehicle:write');

  const filteredVehicles = useMemo(() => {
    let result = [...vehicles];

    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      result = result.filter(
        (v) => v.registrationNo?.toLowerCase().includes(q) || v.name?.toLowerCase().includes(q)
      );
    }
    if (typeFilter !== 'All') result = result.filter((v) => v.type === typeFilter);
    if (statusFilter !== 'All') result = result.filter((v) => v.status === statusFilter);

    return result;
  }, [vehicles, searchQuery, typeFilter, statusFilter]);

  const resetDocState = () => {
    setDocumentFiles([]);
    setDocumentUrls([]);
    setIsExtracted(false);
  };

  const handleAdd = () => {
    setEditingVehicle(null);
    resetDocState();
    reset(defaultFormValues);
    setFormDialogOpen(true);
  };

  const handleEdit = (vehicle) => {
    setEditingVehicle(vehicle);
    resetDocState();
    reset({
      registrationNo: vehicle.registrationNo || '',
      name: vehicle.name || '',
      type: vehicle.type || '',
      maxLoadKg: vehicle.maxLoadKg ?? '',
      odometer: vehicle.odometer ?? '',
      acquisitionCost: vehicle.acquisitionCost ?? '',
      region: vehicle.region || '',
      rcNumber: vehicle.rcNumber || '',
      insuranceNumber: vehicle.insuranceNumber || '',
      insuranceExpiry: vehicle.insuranceExpiry ? vehicle.insuranceExpiry.substring(0, 10) : '',
      pucNumber: vehicle.pucNumber || '',
      pucExpiry: vehicle.pucExpiry ? vehicle.pucExpiry.substring(0, 10) : '',
      serviceIntervalKm: vehicle.serviceIntervalKm ?? '',
      lastServiceOdometer: vehicle.lastServiceOdometer ?? '',
    });
    setFormDialogOpen(true);
  };

  const handleExtractDocuments = async () => {
    if (documentFiles.length === 0) return;
    setIsExtracting(true);
    try {
      const { data } = await vehiclesApi.extractVehicleDocuments(documentFiles);
      const extracted = data.data;
      setDocumentUrls(extracted.documentUrls || []);

      if (extracted.rcNumber) setValue('rcNumber', extracted.rcNumber);
      if (extracted.insuranceNumber) setValue('insuranceNumber', extracted.insuranceNumber);
      if (extracted.insuranceExpiry) setValue('insuranceExpiry', extracted.insuranceExpiry);
      if (extracted.pucNumber) setValue('pucNumber', extracted.pucNumber);
      if (extracted.pucExpiry) setValue('pucExpiry', extracted.pucExpiry);

      setIsExtracted(!data.extractionFailed);

      // The API distinguishes "scan failed" from "upload failed" and says which.
      if (data.extractionFailed || data.uploadFailed) {
        toast.warning('Partly completed', { description: data.message });
      } else {
        toast.success('Details extracted', { description: data.message });
      }
    } catch (err) {
      toast.apiError(err, 'Could not scan the documents');
    } finally {
      setIsExtracting(false);
    }
  };

  const handleConfirmRetire = async () => {
    if (!retireTarget) return;
    try {
      const result = await deleteVehicle(retireTarget.id);
      toast.fromResponse(result, 'Vehicle retired');
    } catch (err) {
      toast.apiError(err, 'Could not retire the vehicle');
    } finally {
      setRetireTarget(null);
    }
  };

  const handleReinstate = async (vehicle) => {
    try {
      const result = await reinstateVehicle(vehicle.id);
      toast.fromResponse(result, 'Vehicle reinstated');
    } catch (err) {
      toast.apiError(err, 'Could not reinstate the vehicle');
    }
  };

  const onSubmit = async (data) => {
    setIsSubmitting(true);

    const num = (value) => (value === '' || value == null ? undefined : Number(value));

    const payload = {
      name: data.name,
      type: data.type,
      maxLoadKg: num(data.maxLoadKg),
      odometer: num(data.odometer),
      acquisitionCost: num(data.acquisitionCost),
      region: data.region || undefined,
      rcNumber: data.rcNumber || undefined,
      insuranceNumber: data.insuranceNumber || undefined,
      insuranceExpiry: data.insuranceExpiry || undefined,
      pucNumber: data.pucNumber || undefined,
      pucExpiry: data.pucExpiry || undefined,
      serviceIntervalKm: num(data.serviceIntervalKm),
      lastServiceOdometer: num(data.lastServiceOdometer),
      ...(documentUrls.length > 0 ? { documentUrls } : {}),
    };

    try {
      if (editingVehicle) {
        const result = await updateVehicle(editingVehicle.id, payload);
        toast.fromResponse(result, 'Vehicle updated');
      } else {
        const result = await addVehicle({ ...payload, registrationNo: data.registrationNo });
        toast.fromResponse(result, 'Vehicle added');
      }
      setFormDialogOpen(false);
      setEditingVehicle(null);
      reset(defaultFormValues);
      resetDocState();
    } catch (err) {
      toast.apiError(err, editingVehicle ? 'Could not update the vehicle' : 'Could not add the vehicle');
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

  return (
    <div className="space-y-6">
      <PageHeader title="Fleet Registry" subtitle="Manage your vehicle inventory">
        {canWrite && (
          <Button onClick={handleAdd} className="gap-2 bg-[#714B67] text-white hover:bg-[#5A3C52]">
            <Plus className="h-4 w-4" />
            Add Vehicle
          </Button>
        )}
      </PageHeader>

      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.1 }}
        className="rounded-xl border border-border bg-card p-4 shadow-sm"
      >
        <div className="flex flex-wrap items-center gap-3">
          <div className="relative min-w-[220px] flex-1">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground/60" />
            <Input
              placeholder="Search by registration or name..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="h-9 bg-muted/50 pl-10 text-sm"
            />
          </div>
          <Select value={typeFilter} onValueChange={setTypeFilter}>
            <SelectTrigger className="h-9 w-[140px] text-sm">
              <SelectValue placeholder="Type" />
            </SelectTrigger>
            <SelectContent>
              {ALL_TYPES.map((t) => (
                <SelectItem key={t} value={t}>{t === 'All' ? 'All Types' : t}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger className="h-9 w-[150px] text-sm">
              <SelectValue placeholder="Status" />
            </SelectTrigger>
            <SelectContent>
              {ALL_STATUSES.map((s) => (
                <SelectItem key={s} value={s}>{s === 'All' ? 'All Statuses' : s}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </motion.div>

      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.2 }}
        className="overflow-hidden rounded-xl border border-border bg-card shadow-sm"
      >
        {filteredVehicles.length === 0 ? (
          <div className="p-12">
            <EmptyState
              icon={Truck}
              title="No vehicles found"
              description={
                searchQuery || typeFilter !== 'All' || statusFilter !== 'All'
                  ? 'No vehicles match the current filters. Try adjusting your search.'
                  : 'Get started by adding your first vehicle to the fleet.'
              }
              action={
                canWrite && !searchQuery && typeFilter === 'All' && statusFilter === 'All' ? (
                  <Button onClick={handleAdd} className="bg-[#714B67] text-white hover:bg-[#5A3C52]">
                    <Plus className="mr-2 h-4 w-4" />
                    Add Vehicle
                  </Button>
                ) : undefined
              }
            />
          </div>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow className="bg-muted/50">
                  {['Reg. Number', 'Name', 'Type', 'Max Load', 'Odometer', 'Acq. Cost', 'Status', 'Compliance'].map((h) => (
                    <TableHead key={h} className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                      {h}
                    </TableHead>
                  ))}
                  <TableHead className="text-right text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                    Actions
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredVehicles.map((vehicle) => {
                  const insuranceExpired = isExpired(vehicle.insuranceExpiry);
                  const pucExpired = isExpired(vehicle.pucExpiry);
                  const serviceDue =
                    vehicle.serviceIntervalKm != null &&
                    vehicle.odometer >= vehicle.lastServiceOdometer + vehicle.serviceIntervalKm;

                  return (
                    <TableRow key={vehicle.id} className="transition-colors hover:bg-muted/50">
                      <TableCell className="font-mono text-sm font-medium text-foreground">
                        {vehicle.registrationNo}
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">{vehicle.name}</TableCell>
                      <TableCell className="text-sm text-muted-foreground">{vehicle.type}</TableCell>
                      <TableCell className="text-sm text-muted-foreground">{fmt(vehicle.maxLoadKg)} kg</TableCell>
                      <TableCell className="text-sm text-muted-foreground">{fmt(vehicle.odometer)} km</TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        {fmtCurrency(vehicle.acquisitionCost)}
                      </TableCell>
                      <TableCell><StatusBadge status={vehicle.status} /></TableCell>
                      <TableCell>
                        <div className="flex flex-wrap gap-1">
                          {insuranceExpired && (
                            <span className="inline-flex items-center gap-1 rounded-full bg-[#E46E78]/15 px-2 py-0.5 text-[10px] font-medium text-[#E46E78]">
                              <ShieldAlert className="h-3 w-3" /> Insurance
                            </span>
                          )}
                          {pucExpired && (
                            <span className="inline-flex items-center gap-1 rounded-full bg-[#E46E78]/15 px-2 py-0.5 text-[10px] font-medium text-[#E46E78]">
                              <ShieldAlert className="h-3 w-3" /> PUC
                            </span>
                          )}
                          {serviceDue && (
                            <span className="inline-flex items-center gap-1 rounded-full bg-[#E4A900]/15 px-2 py-0.5 text-[10px] font-medium text-[#E4A900]">
                              <Wrench className="h-3 w-3" /> Service
                            </span>
                          )}
                          {!insuranceExpired && !pucExpired && !serviceDue && (
                            <span className="text-xs text-muted-foreground/60">OK</span>
                          )}
                        </div>
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex items-center justify-end gap-1">
                          <Button
                            variant="ghost" size="icon"
                            className="h-8 w-8 text-muted-foreground/80 hover:bg-[#5B899E]/10 hover:text-[#5B899E]"
                            onClick={() => { setViewingVehicle(vehicle); setViewDialogOpen(true); }}
                            title="View details"
                          >
                            <Eye className="h-4 w-4" />
                          </Button>
                          {canWrite && vehicle.status !== 'RETIRED' && (
                            <Button
                              variant="ghost" size="icon"
                              className="h-8 w-8 text-muted-foreground/80 hover:bg-[#714B67]/10 hover:text-[#714B67]"
                              onClick={() => handleEdit(vehicle)}
                              title="Edit vehicle"
                            >
                              <Pencil className="h-4 w-4" />
                            </Button>
                          )}
                          {can('vehicle:retire') && (
                            vehicle.status === 'RETIRED' ? (
                              <Button
                                variant="ghost" size="icon"
                                className="h-8 w-8 text-muted-foreground/80 hover:bg-[#21B799]/10 hover:text-[#21B799]"
                                onClick={() => handleReinstate(vehicle)}
                                title="Bring back into service"
                              >
                                <RotateCcw className="h-4 w-4" />
                              </Button>
                            ) : (
                              <Button
                                variant="ghost" size="icon"
                                className="h-8 w-8 text-muted-foreground/80 hover:bg-[#E46E78]/10 hover:text-[#E46E78]"
                                onClick={() => setRetireTarget(vehicle)}
                                title="Retire vehicle"
                              >
                                <Ban className="h-4 w-4" />
                              </Button>
                            )
                          )}
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}
      </motion.div>

      {/* ---------- Add / Edit ---------- */}
      <Dialog open={formDialogOpen} onOpenChange={setFormDialogOpen}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-[620px]">
          <DialogHeader>
            <DialogTitle className="text-lg font-semibold text-foreground">
              {editingVehicle ? 'Edit Vehicle' : 'Add New Vehicle'}
            </DialogTitle>
            <DialogDescription className="text-sm text-muted-foreground/80">
              {editingVehicle
                ? 'Update the details for this vehicle.'
                : 'Enter the details for the new vehicle.'}
            </DialogDescription>
          </DialogHeader>

          <form onSubmit={handleSubmit(onSubmit)} className="mt-2 space-y-4">
            {!editingVehicle && (
              <div className="space-y-3 rounded-lg border border-dashed border-border p-3">
                <p className="text-sm font-medium text-muted-foreground">
                  Vehicle Documents{' '}
                  <span className="font-normal text-muted-foreground/60">(optional — RC, Insurance, PUC)</span>
                </p>
                <Input
                  type="file" accept="image/*" multiple className="h-9 text-sm"
                  onChange={(e) => {
                    setDocumentFiles(Array.from(e.target.files || []));
                    setDocumentUrls([]);
                    setIsExtracted(false);
                  }}
                />
                {documentFiles.length > 0 && (
                  <div className="grid grid-cols-3 gap-2">
                    {documentFiles.map((file, idx) => (
                      <DocumentThumb key={`${file.name}-${idx}`} file={file} />
                    ))}
                  </div>
                )}

                {isExtracted && (
                  <p className="flex items-center gap-2 text-sm text-[#21B799]">
                    <CheckCircle2 className="h-4 w-4 shrink-0" />
                    Details extracted — review the fields below before saving.
                  </p>
                )}

                <Button
                  type="button" variant="outline"
                  disabled={documentFiles.length === 0 || isExtracting}
                  onClick={handleExtractDocuments}
                  className="border-[#714B67] text-[#714B67] hover:bg-[#714B67]/5"
                >
                  <ScanLine className="mr-2 h-4 w-4" />
                  {isExtracting ? 'Scanning...' : 'Extract Details from Documents'}
                </Button>
              </div>
            )}

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <Label htmlFor="registrationNo" className="text-sm font-medium">Registration Number *</Label>
                <Input
                  id="registrationNo" placeholder="MH-01-AB-1234" disabled={Boolean(editingVehicle)}
                  className={`h-9 text-sm ${errors.registrationNo ? 'border-red-400' : ''}`}
                  {...register('registrationNo', { required: 'Registration number is required' })}
                />
                {errors.registrationNo && <p className="text-xs text-red-500">{errors.registrationNo.message}</p>}
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="name" className="text-sm font-medium">Vehicle Name *</Label>
                <Input
                  id="name" placeholder="Tata Prima 4928"
                  className={`h-9 text-sm ${errors.name ? 'border-red-400' : ''}`}
                  {...register('name', { required: 'Name is required' })}
                />
                {errors.name && <p className="text-xs text-red-500">{errors.name.message}</p>}
              </div>

              <div className="space-y-1.5">
                <Label className="text-sm font-medium">Type *</Label>
                <Controller
                  name="type" control={control}
                  rules={{ required: 'Vehicle type is required' }}
                  render={({ field }) => (
                    <Select value={field.value} onValueChange={field.onChange}>
                      <SelectTrigger className={`h-9 text-sm ${errors.type ? 'border-red-400' : ''}`}>
                        <SelectValue placeholder="Select type" />
                      </SelectTrigger>
                      <SelectContent>
                        {VEHICLE_TYPES.map((t) => (
                          <SelectItem key={t} value={t}>{t}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                />
                {errors.type && <p className="text-xs text-red-500">{errors.type.message}</p>}
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="maxLoadKg" className="text-sm font-medium">Max Load (kg) *</Label>
                <Input
                  id="maxLoadKg" type="number" min={0} placeholder="5000"
                  className={`h-9 text-sm ${errors.maxLoadKg ? 'border-red-400' : ''}`}
                  {...register('maxLoadKg', {
                    required: 'Max load is required',
                    min: { value: 0, message: 'Cannot be negative' },
                  })}
                />
                {errors.maxLoadKg && <p className="text-xs text-red-500">{errors.maxLoadKg.message}</p>}
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="odometer" className="text-sm font-medium">Odometer (km)</Label>
                <Input
                  id="odometer" type="number" min={0} placeholder="0" className="h-9 text-sm"
                  {...register('odometer', { min: { value: 0, message: 'Cannot be negative' } })}
                />
                {errors.odometer && <p className="text-xs text-red-500">{errors.odometer.message}</p>}
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="acquisitionCost" className="text-sm font-medium">Acquisition Cost (₹) *</Label>
                <Input
                  id="acquisitionCost" type="number" min={0} placeholder="1500000"
                  className={`h-9 text-sm ${errors.acquisitionCost ? 'border-red-400' : ''}`}
                  {...register('acquisitionCost', {
                    required: 'Acquisition cost is required',
                    min: { value: 0, message: 'Cannot be negative' },
                  })}
                />
                {errors.acquisitionCost && <p className="text-xs text-red-500">{errors.acquisitionCost.message}</p>}
              </div>

              <div className="space-y-1.5">
                <Label className="text-sm font-medium">Region</Label>
                <Controller
                  name="region" control={control}
                  render={({ field }) => (
                    <Select value={field.value} onValueChange={field.onChange}>
                      <SelectTrigger className="h-9 text-sm">
                        <SelectValue placeholder="Select region" />
                      </SelectTrigger>
                      <SelectContent>
                        {REGIONS.map((r) => (
                          <SelectItem key={r} value={r}>{r}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="rcNumber" className="text-sm font-medium">RC Number</Label>
                <Input id="rcNumber" placeholder="RC-1234567890" className="h-9 text-sm" {...register('rcNumber')} />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="insuranceNumber" className="text-sm font-medium">Insurance Policy No.</Label>
                <Input id="insuranceNumber" placeholder="POL-9876543210" className="h-9 text-sm" {...register('insuranceNumber')} />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="insuranceExpiry" className="text-sm font-medium">Insurance Expiry</Label>
                <Input id="insuranceExpiry" type="date" className="h-9 text-sm" {...register('insuranceExpiry')} />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="pucNumber" className="text-sm font-medium">PUC Number</Label>
                <Input id="pucNumber" placeholder="PUC-112233" className="h-9 text-sm" {...register('pucNumber')} />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="pucExpiry" className="text-sm font-medium">PUC Expiry</Label>
                <Input id="pucExpiry" type="date" className="h-9 text-sm" {...register('pucExpiry')} />
              </div>

              {/* ISSUES #34 — preventive service scheduling */}
              <div className="space-y-1.5">
                <Label htmlFor="serviceIntervalKm" className="text-sm font-medium">Service Interval (km)</Label>
                <Input
                  id="serviceIntervalKm" type="number" min={1} placeholder="10000" className="h-9 text-sm"
                  {...register('serviceIntervalKm', { min: { value: 1, message: 'Must be at least 1' } })}
                />
                {errors.serviceIntervalKm && <p className="text-xs text-red-500">{errors.serviceIntervalKm.message}</p>}
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="lastServiceOdometer" className="text-sm font-medium">Last Service At (km)</Label>
                <Input
                  id="lastServiceOdometer" type="number" min={0} placeholder="0" className="h-9 text-sm"
                  {...register('lastServiceOdometer', { min: { value: 0, message: 'Cannot be negative' } })}
                />
              </div>
            </div>

            <DialogFooter className="pt-4">
              <Button type="button" variant="outline" onClick={() => setFormDialogOpen(false)}>
                Cancel
              </Button>
              <Button
                type="submit" disabled={isSubmitting}
                className="gap-2 bg-[#714B67] text-white hover:bg-[#5A3C52]"
              >
                {isSubmitting ? 'Saving...' : editingVehicle ? 'Update Vehicle' : 'Add Vehicle'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* ---------- View ---------- */}
      <Dialog open={viewDialogOpen} onOpenChange={setViewDialogOpen}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-[560px]">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-lg font-semibold text-foreground">
              <Truck className="h-5 w-5 text-[#714B67]" />
              Vehicle Details
            </DialogTitle>
          </DialogHeader>

          {viewingVehicle && (
            <div className="mt-4 grid grid-cols-2 gap-4">
              <DetailItem icon={<Hash className="h-4 w-4" />} label="Reg. Number" value={viewingVehicle.registrationNo} />
              <DetailItem icon={<Truck className="h-4 w-4" />} label="Name" value={viewingVehicle.name} />
              <DetailItem icon={<Truck className="h-4 w-4" />} label="Type" value={viewingVehicle.type} />
              <DetailItem icon={<Weight className="h-4 w-4" />} label="Max Load" value={`${fmt(viewingVehicle.maxLoadKg)} kg`} />
              <DetailItem icon={<Gauge className="h-4 w-4" />} label="Odometer" value={`${fmt(viewingVehicle.odometer)} km`} />
              <DetailItem icon={<IndianRupee className="h-4 w-4" />} label="Acq. Cost" value={fmtCurrency(viewingVehicle.acquisitionCost)} />
              <DetailItem icon={<MapPin className="h-4 w-4" />} label="Region" value={viewingVehicle.region || '—'} />
              <DetailItem icon={<FileText className="h-4 w-4" />} label="RC Number" value={viewingVehicle.rcNumber || '—'} />
              <DetailItem icon={<FileText className="h-4 w-4" />} label="Insurance Policy" value={viewingVehicle.insuranceNumber || '—'} />
              <DetailItem
                icon={isExpired(viewingVehicle.insuranceExpiry)
                  ? <ShieldAlert className="h-4 w-4 text-[#E46E78]" />
                  : <FileText className="h-4 w-4" />}
                label="Insurance Expiry"
                value={viewingVehicle.insuranceExpiry
                  ? `${new Date(viewingVehicle.insuranceExpiry).toLocaleDateString('en-IN')}${isExpired(viewingVehicle.insuranceExpiry) ? ' (Expired)' : ''}`
                  : '—'}
              />
              <DetailItem icon={<FileText className="h-4 w-4" />} label="PUC Number" value={viewingVehicle.pucNumber || '—'} />
              <DetailItem
                icon={isExpired(viewingVehicle.pucExpiry)
                  ? <ShieldAlert className="h-4 w-4 text-[#E46E78]" />
                  : <FileText className="h-4 w-4" />}
                label="PUC Expiry"
                value={viewingVehicle.pucExpiry
                  ? `${new Date(viewingVehicle.pucExpiry).toLocaleDateString('en-IN')}${isExpired(viewingVehicle.pucExpiry) ? ' (Expired)' : ''}`
                  : '—'}
              />
              <DetailItem
                icon={<Wrench className="h-4 w-4" />}
                label="Service Interval"
                value={viewingVehicle.serviceIntervalKm ? `${fmt(viewingVehicle.serviceIntervalKm)} km` : 'Not set'}
              />
              <DetailItem
                icon={<Gauge className="h-4 w-4" />}
                label="Next Service At"
                value={viewingVehicle.serviceIntervalKm
                  ? `${fmt(viewingVehicle.lastServiceOdometer + viewingVehicle.serviceIntervalKm)} km`
                  : '—'}
              />

              <div className="col-span-2">
                <span className="mb-1 block text-xs text-muted-foreground/80">Status</span>
                <StatusBadge status={viewingVehicle.status} />
              </div>

              {viewingVehicle.documentUrls?.length > 0 && (
                <div className="col-span-2">
                  <span className="mb-2 block text-xs text-muted-foreground/80">Uploaded Documents</span>
                  <div className="grid grid-cols-3 gap-2">
                    {viewingVehicle.documentUrls.map((url, idx) => (
                      <a key={url} href={url} target="_blank" rel="noopener noreferrer">
                        <img
                          src={url} alt={`Vehicle document ${idx + 1}`}
                          className="h-24 w-full rounded-md border border-border object-cover transition-opacity hover:opacity-80"
                        />
                      </a>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          <DialogFooter className="pt-4">
            <Button variant="outline" onClick={() => setViewDialogOpen(false)}>Close</Button>
            {canWrite && viewingVehicle?.status !== 'RETIRED' && (
              <Button
                className="gap-2 bg-[#714B67] text-white hover:bg-[#5A3C52]"
                onClick={() => { setViewDialogOpen(false); handleEdit(viewingVehicle); }}
              >
                <Pencil className="h-4 w-4" />
                Edit
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={Boolean(retireTarget)}
        onOpenChange={(open) => !open && setRetireTarget(null)}
        title="Retire Vehicle"
        description={`Retire ${retireTarget?.registrationNo || ''}? It will be hidden from dispatch, but all of its trip and cost history is preserved.`}
        confirmLabel="Retire"
        onConfirm={handleConfirmRetire}
        variant="destructive"
      />
    </div>
  );
}

function DetailItem({ icon, label, value }) {
  return (
    <div className="space-y-1">
      <span className="flex items-center gap-1.5 text-xs text-muted-foreground/80">
        {icon && <span className="text-muted-foreground/60">{icon}</span>}
        {label}
      </span>
      <p className="text-sm font-medium text-foreground">{value ?? '—'}</p>
    </div>
  );
}
