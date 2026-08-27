import { useState, useMemo } from 'react';
import { useForm, Controller } from 'react-hook-form';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Plus, Search, Pencil, ShieldCheck, ShieldOff, Filter, ScanLine, CheckCircle2,
  RefreshCw, Archive, UserCheck, Info,
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
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

import { useData } from '../contexts/DataContext';
import { useAuth } from '../contexts/AuthContext';
import { useToast } from '../hooks/useToast.js';
import * as driversApi from '../api/drivers.js';
import useObjectUrl from '../hooks/useObjectUrl';
import { LICENSE_CATEGORIES, SAFETY_THRESHOLDS } from '../config/roles.js';
import PageHeader from '../components/shared/PageHeader';
import StatusBadge from '../components/shared/StatusBadge';
import EmptyState from '../components/shared/EmptyState';
import ConfirmDialog from '../components/shared/ConfirmDialog';

const STATUS_FILTERS = [
  { value: 'ALL', label: 'All Statuses' },
  { value: 'AVAILABLE', label: 'Available' },
  { value: 'ON_TRIP', label: 'On Trip' },
  { value: 'OFF_DUTY', label: 'Off Duty' },
  { value: 'SUSPENDED', label: 'Suspended' },
];

const LICENSE_FILTERS = [
  { value: 'ALL', label: 'All Categories' },
  ...LICENSE_CATEGORIES.map((c) => ({ value: c, label: c })),
];

const isLicenseExpired = (date) => new Date(date) < new Date();

function scoreColor(score) {
  if (score >= 80) return 'text-[#21B799]';
  if (score >= SAFETY_THRESHOLDS.WARN) return 'text-[#E4A900]';
  return 'text-[#E46E78]';
}

const defaultFormValues = {
  name: '', email: '', licenseNumber: '', licenseCategory: 'LMV',
  licenseExpiry: '', contactNumber: '',
};

export default function Drivers() {
  const { drivers, isLoading, addDriver, updateDriver, suspendDriver, setDriverStatus, deleteDriver, refreshDrivers } =
    useData();
  const { can } = useAuth();
  const toast = useToast();

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingDriver, setEditingDriver] = useState(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState('ALL');
  const [licenseFilter, setLicenseFilter] = useState('ALL');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isRecalculating, setIsRecalculating] = useState(false);

  const [suspendTarget, setSuspendTarget] = useState(null);
  const [archiveTarget, setArchiveTarget] = useState(null);

  const [frontImageFile, setFrontImageFile] = useState(null);
  const [backImageFile, setBackImageFile] = useState(null);
  const [licenseUrls, setLicenseUrls] = useState({ front: null, back: null });
  const [isExtracted, setIsExtracted] = useState(false);
  const [isExtracting, setIsExtracting] = useState(false);

  const form = useForm({ defaultValues: defaultFormValues });
  const frontPreview = useObjectUrl(frontImageFile);
  const backPreview = useObjectUrl(backImageFile);

  const canWrite = can('driver:write');
  const canSuspend = can('driver:suspend');

  const filteredDrivers = useMemo(() => {
    return drivers.filter((d) => {
      const q = searchQuery.toLowerCase();
      const matchesSearch =
        !searchQuery ||
        d.name.toLowerCase().includes(q) ||
        d.email?.toLowerCase().includes(q) ||
        d.licenseNumber.toLowerCase().includes(q);
      const matchesStatus = statusFilter === 'ALL' || d.status === statusFilter;
      const matchesLicense = licenseFilter === 'ALL' || d.licenseCategory === licenseFilter;
      return matchesSearch && matchesStatus && matchesLicense;
    });
  }, [drivers, searchQuery, statusFilter, licenseFilter]);

  const resetImages = () => {
    setFrontImageFile(null);
    setBackImageFile(null);
    setLicenseUrls({ front: null, back: null });
    setIsExtracted(false);
  };

  function openAddDialog() {
    setEditingDriver(null);
    resetImages();
    form.reset(defaultFormValues);
    setDialogOpen(true);
  }

  function openEditDialog(driver) {
    setEditingDriver(driver);
    resetImages();
    form.reset({
      name: driver.name,
      email: driver.email,
      licenseNumber: driver.licenseNumber,
      licenseCategory: driver.licenseCategory,
      licenseExpiry: driver.licenseExpiry ? driver.licenseExpiry.substring(0, 10) : '',
      contactNumber: driver.contactNumber,
    });
    setDialogOpen(true);
  }

  /**
   * ISSUES #5 — the licence images are now uploaded and their URLs stored on the
   * driver, so licenseFrontUrl / licenseBackUrl are actually populated.
   */
  async function handleExtractLicense() {
    if (!frontImageFile || !backImageFile) return;
    setIsExtracting(true);
    try {
      const { data } = await driversApi.extractLicense(frontImageFile, backImageFile);
      const extracted = data.data;

      if (extracted.name) form.setValue('name', extracted.name);
      if (extracted.licenseNumber) form.setValue('licenseNumber', extracted.licenseNumber);
      if (extracted.licenseCategory) form.setValue('licenseCategory', extracted.licenseCategory);
      if (extracted.licenseExpiry) form.setValue('licenseExpiry', extracted.licenseExpiry);

      setLicenseUrls({ front: extracted.licenseFrontUrl, back: extracted.licenseBackUrl });
      setIsExtracted(!data.extractionFailed);

      if (data.extractionFailed || data.uploadFailed) {
        toast.warning('Partly completed', { description: data.message });
      } else {
        toast.success('Details extracted', { description: data.message });
      }
    } catch (err) {
      toast.apiError(err, 'Could not scan the licence');
    } finally {
      setIsExtracting(false);
    }
  }

  async function onSubmit(data) {
    setIsSubmitting(true);
    const payload = {
      ...data,
      ...(licenseUrls.front ? { licenseFrontUrl: licenseUrls.front } : {}),
      ...(licenseUrls.back ? { licenseBackUrl: licenseUrls.back } : {}),
    };

    try {
      if (editingDriver) {
        const result = await updateDriver(editingDriver.id, payload);
        toast.fromResponse(result, 'Driver updated');
      } else {
        const result = await addDriver(payload);
        toast.fromResponse(result, 'Driver added');
      }
      setDialogOpen(false);
      setEditingDriver(null);
      form.reset(defaultFormValues);
      resetImages();
    } catch (err) {
      toast.apiError(err, editingDriver ? 'Could not update the driver' : 'Could not add the driver');
    } finally {
      setIsSubmitting(false);
    }
  }

  async function handleConfirmSuspend() {
    if (!suspendTarget) return;
    try {
      const result = await suspendDriver(suspendTarget.id);
      toast.fromResponse(result, 'Driver suspended');
    } catch (err) {
      toast.apiError(err, 'Could not suspend the driver');
    } finally {
      setSuspendTarget(null);
    }
  }

  /** ISSUES #10 — reinstatement and off-duty were previously impossible. */
  async function handleStatusChange(driver, status) {
    try {
      const result = await setDriverStatus(driver.id, status);
      toast.fromResponse(result, 'Driver status updated');
    } catch (err) {
      toast.apiError(err, 'Could not change the status');
    }
  }

  async function handleConfirmArchive() {
    if (!archiveTarget) return;
    try {
      const result = await deleteDriver(archiveTarget.id);
      toast.fromResponse(result, 'Driver archived');
    } catch (err) {
      toast.apiError(err, 'Could not archive the driver');
    } finally {
      setArchiveTarget(null);
    }
  }

  /** ISSUES #32 — recompute derived scores from primary records. */
  async function handleRecalculate() {
    setIsRecalculating(true);
    try {
      const { data } = await driversApi.recalculateSafetyScores();
      await refreshDrivers();
      toast.success(data.message);
    } catch (err) {
      toast.apiError(err, 'Could not recalculate scores');
    } finally {
      setIsRecalculating(false);
    }
  }

  if (isLoading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-border border-t-[#714B67]" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader title="Driver Management" subtitle="Track driver safety and assignments">
        {canWrite && (
          <>
            <Button
              variant="outline" onClick={handleRecalculate} disabled={isRecalculating}
              className="border-[#5B899E] text-[#5B899E] hover:bg-[#5B899E]/5"
            >
              <RefreshCw className={`mr-2 h-4 w-4 ${isRecalculating ? 'animate-spin' : ''}`} />
              Recalculate Scores
            </Button>
            <Button onClick={openAddDialog} className="bg-[#714B67] text-white hover:bg-[#5A3C52]">
              <Plus className="mr-2 h-4 w-4" />
              Add Driver
            </Button>
          </>
        )}
      </PageHeader>

      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        className="flex items-start gap-3 rounded-lg border border-[#5B899E]/30 bg-[#5B899E]/5 p-3"
      >
        <Info className="mt-0.5 h-4 w-4 shrink-0 text-[#5B899E]" />
        <p className="text-xs text-muted-foreground">
          Safety scores are derived from fines, post-dispatch cancellations, licence validity and
          completed trips. Drivers below {SAFETY_THRESHOLDS.BLOCK} cannot be dispatched;
          below {SAFETY_THRESHOLDS.WARN} raises a warning.
        </p>
      </motion.div>

      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.25 }}
        className="flex flex-col gap-3 sm:flex-row"
      >
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground/60" />
          <Input
            placeholder="Search by name, email or licence..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-9"
          />
        </div>
        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger className="w-full sm:w-[180px]">
            <Filter className="mr-2 h-4 w-4 text-muted-foreground/60" />
            <SelectValue placeholder="Status" />
          </SelectTrigger>
          <SelectContent>
            {STATUS_FILTERS.map((o) => (
              <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={licenseFilter} onValueChange={setLicenseFilter}>
          <SelectTrigger className="w-full sm:w-[180px]">
            <Filter className="mr-2 h-4 w-4 text-muted-foreground/60" />
            <SelectValue placeholder="Category" />
          </SelectTrigger>
          <SelectContent>
            {LICENSE_FILTERS.map((o) => (
              <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </motion.div>

      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.3, delay: 0.1 }}
        className="overflow-hidden rounded-xl border bg-card shadow-sm"
      >
        {filteredDrivers.length === 0 ? (
          <EmptyState
            icon={ShieldCheck}
            title="No drivers found"
            description="No drivers match your current search or filter criteria."
            action={
              canWrite ? (
                <Button onClick={openAddDialog} variant="outline" className="border-[#714B67] text-[#714B67] hover:bg-[#714B67]/5">
                  <Plus className="mr-2 h-4 w-4" />
                  Add Driver
                </Button>
              ) : null
            }
          />
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow className="bg-muted/80">
                  {['Name', 'Email', 'Licence No.', 'Category', 'Expiry', 'Contact', 'Safety', 'Status'].map((h) => (
                    <TableHead key={h} className="font-semibold text-muted-foreground">{h}</TableHead>
                  ))}
                  <TableHead className="text-right font-semibold text-muted-foreground">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                <AnimatePresence>
                  {filteredDrivers.map((driver, idx) => {
                    const expired = isLicenseExpired(driver.licenseExpiry);
                    const suspended = driver.status === 'SUSPENDED';

                    return (
                      <motion.tr
                        key={driver.id}
                        initial={{ opacity: 0, x: -10 }}
                        animate={{ opacity: 1, x: 0 }}
                        exit={{ opacity: 0, x: 10 }}
                        transition={{ duration: 0.2, delay: Math.min(idx * 0.03, 0.3) }}
                        className={`border-b transition-colors last:border-b-0 hover:bg-muted/50 ${
                          suspended ? 'bg-red-50/60 dark:bg-red-500/5' : ''
                        }`}
                      >
                        <TableCell className="font-medium text-foreground">{driver.name}</TableCell>
                        <TableCell className="text-muted-foreground">{driver.email}</TableCell>
                        <TableCell className="font-mono text-sm text-muted-foreground">
                          {driver.licenseNumber}
                        </TableCell>
                        <TableCell>
                          <span className="inline-flex items-center rounded-full bg-[#714B67]/10 px-2.5 py-0.5 text-xs font-medium text-[#714B67]">
                            {driver.licenseCategory}
                          </span>
                        </TableCell>
                        <TableCell>
                          <div className="flex items-center gap-2">
                            <span className={expired ? 'font-semibold text-[#E46E78]' : 'text-muted-foreground'}>
                              {new Date(driver.licenseExpiry).toLocaleDateString('en-IN')}
                            </span>
                            {expired && (
                              <span className="inline-flex items-center rounded bg-[#E46E78]/15 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-[#E46E78]">
                                Expired
                              </span>
                            )}
                          </div>
                        </TableCell>
                        <TableCell className="text-muted-foreground">{driver.contactNumber}</TableCell>
                        <TableCell>
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <span className={`text-sm font-bold ${scoreColor(driver.safetyScore)}`}>
                                {driver.safetyScore}
                              </span>
                            </TooltipTrigger>
                            <TooltipContent>
                              <p>
                                {driver.safetyScore < SAFETY_THRESHOLDS.BLOCK
                                  ? 'Below the dispatch threshold'
                                  : driver.safetyScore < SAFETY_THRESHOLDS.WARN
                                    ? 'Dispatch raises a warning'
                                    : 'Good standing'}
                              </p>
                            </TooltipContent>
                          </Tooltip>
                        </TableCell>
                        <TableCell><StatusBadge status={driver.status} /></TableCell>
                        <TableCell className="text-right">
                          <div className="flex items-center justify-end gap-1">
                            {canWrite && (
                              <Button
                                variant="ghost" size="icon"
                                className="h-8 w-8 text-muted-foreground/60 hover:bg-[#714B67]/10 hover:text-[#714B67]"
                                onClick={() => openEditDialog(driver)}
                                title="Edit driver"
                              >
                                <Pencil className="h-4 w-4" />
                              </Button>
                            )}

                            {canSuspend && driver.status !== 'ON_TRIP' && (
                              suspended ? (
                                <Button
                                  variant="ghost" size="icon"
                                  className="h-8 w-8 text-muted-foreground/60 hover:bg-[#21B799]/10 hover:text-[#21B799]"
                                  onClick={() => handleStatusChange(driver, 'AVAILABLE')}
                                  title="Reinstate driver"
                                >
                                  <UserCheck className="h-4 w-4" />
                                </Button>
                              ) : (
                                <>
                                  <Button
                                    variant="ghost" size="icon"
                                    className="h-8 w-8 text-muted-foreground/60 hover:bg-[#E4A900]/10 hover:text-[#E4A900]"
                                    onClick={() =>
                                      handleStatusChange(driver, driver.status === 'OFF_DUTY' ? 'AVAILABLE' : 'OFF_DUTY')
                                    }
                                    title={driver.status === 'OFF_DUTY' ? 'Return to duty' : 'Mark off duty'}
                                  >
                                    <UserCheck className="h-4 w-4" />
                                  </Button>
                                  <Button
                                    variant="ghost" size="icon"
                                    className="h-8 w-8 text-muted-foreground/60 hover:bg-[#E46E78]/10 hover:text-[#E46E78]"
                                    onClick={() => setSuspendTarget(driver)}
                                    title="Suspend driver"
                                  >
                                    <ShieldOff className="h-4 w-4" />
                                  </Button>
                                </>
                              )
                            )}

                            {can('driver:archive') && driver.status !== 'ON_TRIP' && (
                              <Button
                                variant="ghost" size="icon"
                                className="h-8 w-8 text-muted-foreground/60 hover:bg-muted hover:text-foreground"
                                onClick={() => setArchiveTarget(driver)}
                                title="Archive driver"
                              >
                                <Archive className="h-4 w-4" />
                              </Button>
                            )}
                          </div>
                        </TableCell>
                      </motion.tr>
                    );
                  })}
                </AnimatePresence>
              </TableBody>
            </Table>
          </div>
        )}
      </motion.div>

      {/* ---------- Add / Edit ---------- */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-[540px]">
          <DialogHeader>
            <DialogTitle className="text-lg font-semibold text-foreground">
              {editingDriver ? 'Edit Driver' : 'Add New Driver'}
            </DialogTitle>
          </DialogHeader>

          <form onSubmit={form.handleSubmit(onSubmit)} className="mt-2 space-y-4">
            {!editingDriver && (
              <div className="space-y-3 rounded-lg border border-dashed border-border p-3">
                <p className="text-sm font-medium text-muted-foreground">
                  Licence Images <span className="font-normal text-muted-foreground/60">(optional)</span>
                </p>
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  <div className="space-y-1.5">
                    <Label htmlFor="licenseFrontImage">Front Side</Label>
                    <Input
                      id="licenseFrontImage" type="file" accept="image/*"
                      onChange={(e) => {
                        setFrontImageFile(e.target.files?.[0] || null);
                        setIsExtracted(false);
                      }}
                    />
                    {frontPreview && (
                      <img src={frontPreview} alt="Licence front preview" className="mt-1 h-28 w-full rounded-md border border-border object-cover" />
                    )}
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="licenseBackImage">Back Side</Label>
                    <Input
                      id="licenseBackImage" type="file" accept="image/*"
                      onChange={(e) => {
                        setBackImageFile(e.target.files?.[0] || null);
                        setIsExtracted(false);
                      }}
                    />
                    {backPreview && (
                      <img src={backPreview} alt="Licence back preview" className="mt-1 h-28 w-full rounded-md border border-border object-cover" />
                    )}
                  </div>
                </div>

                {isExtracted ? (
                  <p className="flex items-center gap-2 text-sm text-[#21B799]">
                    <CheckCircle2 className="h-4 w-4 shrink-0" />
                    Details extracted — review the fields below before saving.
                  </p>
                ) : (
                  <Button
                    type="button" variant="outline"
                    disabled={!frontImageFile || !backImageFile || isExtracting}
                    onClick={handleExtractLicense}
                    className="border-[#714B67] text-[#714B67] hover:bg-[#714B67]/5"
                  >
                    <ScanLine className="mr-2 h-4 w-4" />
                    {isExtracting ? 'Scanning...' : 'Extract Details from Licence'}
                  </Button>
                )}
              </div>
            )}

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div className="space-y-1.5 sm:col-span-2">
                <Label htmlFor="name">Full Name <span className="text-[#E46E78]">*</span></Label>
                <Input id="name" placeholder="Enter the driver's full name" {...form.register('name', { required: 'Name is required' })} />
                {form.formState.errors.name && <p className="text-xs text-[#E46E78]">{form.formState.errors.name.message}</p>}
              </div>

              <div className="space-y-1.5 sm:col-span-2">
                <Label htmlFor="email">Email <span className="text-[#E46E78]">*</span></Label>
                <Input
                  id="email" type="email" placeholder="driver@example.com"
                  {...form.register('email', {
                    required: 'Email is required',
                    pattern: { value: /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/, message: 'Enter a valid email address' },
                  })}
                />
                {form.formState.errors.email && <p className="text-xs text-[#E46E78]">{form.formState.errors.email.message}</p>}
                <p className="text-xs text-muted-foreground/70">Licence expiry notices are sent here.</p>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="licenseNumber">Licence Number <span className="text-[#E46E78]">*</span></Label>
                <Input id="licenseNumber" placeholder="DL-1234567890" {...form.register('licenseNumber', { required: 'Licence number is required' })} />
                {form.formState.errors.licenseNumber && <p className="text-xs text-[#E46E78]">{form.formState.errors.licenseNumber.message}</p>}
              </div>

              <div className="space-y-1.5">
                <Label>Licence Category <span className="text-[#E46E78]">*</span></Label>
                <Controller
                  control={form.control} name="licenseCategory"
                  rules={{ required: 'Please choose a category' }}
                  render={({ field }) => (
                    <Select value={field.value} onValueChange={field.onChange}>
                      <SelectTrigger><SelectValue placeholder="Select category" /></SelectTrigger>
                      <SelectContent>
                        {LICENSE_CATEGORIES.map((cat) => (
                          <SelectItem key={cat} value={cat}>{cat}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="licenseExpiry">Licence Expiry <span className="text-[#E46E78]">*</span></Label>
                <Input id="licenseExpiry" type="date" {...form.register('licenseExpiry', { required: 'Expiry date is required' })} />
                {form.formState.errors.licenseExpiry && <p className="text-xs text-[#E46E78]">{form.formState.errors.licenseExpiry.message}</p>}
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="contactNumber">Contact Number <span className="text-[#E46E78]">*</span></Label>
                <Input id="contactNumber" placeholder="+91 XXXXX XXXXX" {...form.register('contactNumber', { required: 'Contact number is required' })} />
                {form.formState.errors.contactNumber && <p className="text-xs text-[#E46E78]">{form.formState.errors.contactNumber.message}</p>}
              </div>
            </div>

            {/* ISSUES #32 — the score is derived, so it is no longer an editable field. */}
            <p className="rounded-md bg-muted/60 px-3 py-2 text-xs text-muted-foreground">
              The safety score is calculated automatically and cannot be set by hand.
            </p>

            <DialogFooter className="pt-2">
              <Button type="button" variant="outline" onClick={() => setDialogOpen(false)}>Cancel</Button>
              <Button type="submit" disabled={isSubmitting} className="bg-[#714B67] text-white hover:bg-[#5A3C52]">
                {isSubmitting ? 'Saving...' : editingDriver ? 'Update Driver' : 'Add Driver'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={Boolean(suspendTarget)}
        onOpenChange={(open) => !open && setSuspendTarget(null)}
        title="Suspend Driver"
        description={`Suspend ${suspendTarget?.name || ''}? They will not be assignable to new trips until reinstated.`}
        confirmLabel="Suspend"
        onConfirm={handleConfirmSuspend}
        variant="destructive"
      />

      <ConfirmDialog
        open={Boolean(archiveTarget)}
        onOpenChange={(open) => !open && setArchiveTarget(null)}
        title="Archive Driver"
        description={`Archive ${archiveTarget?.name || ''}? Their trip history is preserved and they can be restored later.`}
        confirmLabel="Archive"
        onConfirm={handleConfirmArchive}
        variant="destructive"
      />
    </div>
  );
}
