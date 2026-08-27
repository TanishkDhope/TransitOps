import { useState, useMemo } from 'react';
import { useForm } from 'react-hook-form';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Plus, Search, Pencil, Trash2, Building2, IndianRupee, Phone, Mail, Info, Calculator,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription,
} from '@/components/ui/dialog';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';

import { useData } from '../contexts/DataContext';
import { useAuth } from '../contexts/AuthContext';
import { useToast } from '../hooks/useToast.js';
import PageHeader from '../components/shared/PageHeader';
import EmptyState from '../components/shared/EmptyState';
import ConfirmDialog from '../components/shared/ConfirmDialog';

const defaultFormValues = {
  name: '', email: '', phone: '', ratePerKm: '', ratePerTonneKm: '', flatRate: '',
};

const money = (value) => (value == null ? '—' : `₹${Number(value).toLocaleString('en-IN')}`);

/** Mirrors the server's pricing precedence so the preview matches what will be charged. */
function describeRateCard(customer) {
  if (customer.flatRate != null) return `Flat ${money(customer.flatRate)} per trip`;
  if (customer.ratePerTonneKm != null && customer.ratePerKm != null) {
    return `${money(customer.ratePerKm)}/km + ${money(customer.ratePerTonneKm)}/tonne-km`;
  }
  if (customer.ratePerTonneKm != null) return `${money(customer.ratePerTonneKm)} per tonne-km`;
  if (customer.ratePerKm != null) return `${money(customer.ratePerKm)} per km`;
  return null;
}

export default function Customers() {
  const { customers, isLoading, addCustomer, updateCustomer, deleteCustomer } = useData();
  const { can } = useAuth();
  const toast = useToast();

  const [searchQuery, setSearchQuery] = useState('');
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingCustomer, setEditingCustomer] = useState(null);
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const form = useForm({ defaultValues: defaultFormValues });
  const canWrite = can('customer:write');

  const filtered = useMemo(() => {
    if (!searchQuery.trim()) return customers;
    const q = searchQuery.toLowerCase();
    return customers.filter(
      (c) => c.name.toLowerCase().includes(q) || c.email?.toLowerCase().includes(q)
    );
  }, [customers, searchQuery]);

  function openAddDialog() {
    setEditingCustomer(null);
    form.reset(defaultFormValues);
    setDialogOpen(true);
  }

  function openEditDialog(customer) {
    setEditingCustomer(customer);
    form.reset({
      name: customer.name ?? '',
      email: customer.email ?? '',
      phone: customer.phone ?? '',
      ratePerKm: customer.ratePerKm ?? '',
      ratePerTonneKm: customer.ratePerTonneKm ?? '',
      flatRate: customer.flatRate ?? '',
    });
    setDialogOpen(true);
  }

  async function onSubmit(data) {
    setIsSubmitting(true);

    // Empty strings clear a rate rather than being sent as 0.
    const rate = (value) => (value === '' || value == null ? null : Number(value));

    const payload = {
      name: data.name,
      email: data.email || null,
      phone: data.phone || null,
      ratePerKm: rate(data.ratePerKm),
      ratePerTonneKm: rate(data.ratePerTonneKm),
      flatRate: rate(data.flatRate),
    };

    try {
      if (editingCustomer) {
        const result = await updateCustomer(editingCustomer.id, payload);
        toast.fromResponse(result, 'Customer updated');
      } else {
        const result = await addCustomer(payload);
        toast.fromResponse(result, 'Customer added');
      }
      setDialogOpen(false);
      setEditingCustomer(null);
      form.reset(defaultFormValues);
    } catch (err) {
      toast.apiError(err, editingCustomer ? 'Could not update the customer' : 'Could not add the customer');
    } finally {
      setIsSubmitting(false);
    }
  }

  async function handleConfirmDelete() {
    if (!deleteTarget) return;
    try {
      const result = await deleteCustomer(deleteTarget.id);
      toast.fromResponse(result, 'Customer deleted');
    } catch (err) {
      toast.apiError(err, 'Could not delete the customer');
    } finally {
      setDeleteTarget(null);
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
      <PageHeader title="Customers" subtitle="Who the loads are for, and what they are charged">
        {canWrite && (
          <Button onClick={openAddDialog} className="bg-[#714B67] text-white hover:bg-[#5A3C52]">
            <Plus className="mr-2 h-4 w-4" />
            Add Customer
          </Button>
        )}
      </PageHeader>

      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        className="flex items-start gap-3 rounded-lg border border-[#5B899E]/30 bg-[#5B899E]/5 p-3"
      >
        <Info className="mt-0.5 h-4 w-4 shrink-0 text-[#5B899E]" />
        <p className="text-xs text-muted-foreground">
          A rate card lets trip revenue be computed instead of typed. Precedence: a flat rate wins,
          otherwise per-km and per-tonne-km are added together. Dispatchers can still override the
          figure on an individual trip.
        </p>
      </motion.div>

      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.05 }}
        className="relative max-w-md"
      >
        <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground/60" />
        <Input
          placeholder="Search customers..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="pl-9"
        />
      </motion.div>

      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.3, delay: 0.1 }}
        className="overflow-hidden rounded-xl border bg-card shadow-sm"
      >
        {filtered.length === 0 ? (
          <EmptyState
            icon={Building2}
            title={searchQuery ? 'No matching customers' : 'No customers yet'}
            description={
              searchQuery
                ? 'Try a different search term.'
                : 'Add a customer with a rate card so trip revenue is calculated automatically.'
            }
            action={
              canWrite && !searchQuery ? (
                <Button onClick={openAddDialog} variant="outline" className="border-[#714B67] text-[#714B67] hover:bg-[#714B67]/5">
                  <Plus className="mr-2 h-4 w-4" />
                  Add Customer
                </Button>
              ) : null
            }
          />
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow className="bg-muted/80">
                  {['Customer', 'Contact', 'Rate Card', 'Trips'].map((h) => (
                    <TableHead key={h} className="font-semibold text-muted-foreground">{h}</TableHead>
                  ))}
                  {canWrite && (
                    <TableHead className="text-right font-semibold text-muted-foreground">Actions</TableHead>
                  )}
                </TableRow>
              </TableHeader>
              <TableBody>
                <AnimatePresence>
                  {filtered.map((customer, idx) => {
                    const rateCard = describeRateCard(customer);
                    return (
                      <motion.tr
                        key={customer.id}
                        initial={{ opacity: 0, x: -10 }}
                        animate={{ opacity: 1, x: 0 }}
                        exit={{ opacity: 0, x: 10 }}
                        transition={{ duration: 0.2, delay: Math.min(idx * 0.03, 0.3) }}
                        className="border-b transition-colors last:border-b-0 hover:bg-muted/50"
                      >
                        <TableCell className="font-medium text-foreground">{customer.name}</TableCell>
                        <TableCell>
                          <div className="space-y-0.5 text-sm text-muted-foreground">
                            {customer.email && (
                              <p className="flex items-center gap-1.5">
                                <Mail className="h-3 w-3" />
                                {customer.email}
                              </p>
                            )}
                            {customer.phone && (
                              <p className="flex items-center gap-1.5">
                                <Phone className="h-3 w-3" />
                                {customer.phone}
                              </p>
                            )}
                            {!customer.email && !customer.phone && '—'}
                          </div>
                        </TableCell>
                        <TableCell>
                          {rateCard ? (
                            <span className="inline-flex items-center gap-1.5 rounded-full bg-[#21B799]/10 px-2.5 py-0.5 text-xs font-medium text-[#21B799]">
                              <Calculator className="h-3 w-3" />
                              {rateCard}
                            </span>
                          ) : (
                            <span className="inline-flex items-center rounded-full bg-[#E4A900]/10 px-2.5 py-0.5 text-xs font-medium text-[#E4A900]">
                              No rate card
                            </span>
                          )}
                        </TableCell>
                        <TableCell className="text-muted-foreground">
                          {customer._count?.trips ?? 0}
                        </TableCell>
                        {canWrite && (
                          <TableCell className="text-right">
                            <div className="flex items-center justify-end gap-1">
                              <Button
                                variant="ghost" size="icon"
                                className="h-8 w-8 text-muted-foreground/60 hover:bg-[#714B67]/10 hover:text-[#714B67]"
                                onClick={() => openEditDialog(customer)}
                                title="Edit customer"
                              >
                                <Pencil className="h-4 w-4" />
                              </Button>
                              <Button
                                variant="ghost" size="icon"
                                disabled={(customer._count?.trips ?? 0) > 0}
                                className="h-8 w-8 text-muted-foreground/60 hover:bg-[#E46E78]/10 hover:text-[#E46E78] disabled:opacity-30"
                                onClick={() => setDeleteTarget(customer)}
                                title={
                                  (customer._count?.trips ?? 0) > 0
                                    ? 'Customers with trip history cannot be deleted'
                                    : 'Delete customer'
                                }
                              >
                                <Trash2 className="h-4 w-4" />
                              </Button>
                            </div>
                          </TableCell>
                        )}
                      </motion.tr>
                    );
                  })}
                </AnimatePresence>
              </TableBody>
            </Table>
          </div>
        )}
      </motion.div>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-[520px]">
          <DialogHeader>
            <DialogTitle className="text-lg font-semibold text-foreground">
              {editingCustomer ? 'Edit Customer' : 'Add Customer'}
            </DialogTitle>
            <DialogDescription className="text-sm text-muted-foreground/80">
              Leave every rate blank if this customer is quoted per trip.
            </DialogDescription>
          </DialogHeader>

          <form onSubmit={form.handleSubmit(onSubmit)} className="mt-2 space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="name">Name <span className="text-[#E46E78]">*</span></Label>
              <Input
                id="name" placeholder="e.g. Reliance Retail"
                {...form.register('name', { required: 'Customer name is required' })}
              />
              {form.formState.errors.name && (
                <p className="text-xs text-[#E46E78]">{form.formState.errors.name.message}</p>
              )}
            </div>

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="email">Email</Label>
                <Input
                  id="email" type="email" placeholder="logistics@example.com"
                  {...form.register('email', {
                    pattern: {
                      value: /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/,
                      message: 'Enter a valid email address',
                    },
                  })}
                />
                {form.formState.errors.email && (
                  <p className="text-xs text-[#E46E78]">{form.formState.errors.email.message}</p>
                )}
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="phone">Phone</Label>
                <Input id="phone" placeholder="+91 XXXXX XXXXX" {...form.register('phone')} />
              </div>
            </div>

            <div className="space-y-3 rounded-lg border border-dashed border-border p-3">
              <p className="flex items-center gap-1.5 text-sm font-medium text-muted-foreground">
                <IndianRupee className="h-4 w-4" />
                Rate Card
              </p>

              <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
                <div className="space-y-1.5">
                  <Label htmlFor="ratePerKm">Per km (₹)</Label>
                  <Input
                    id="ratePerKm" type="number" step="0.01" min={0} placeholder="42.50"
                    {...form.register('ratePerKm', { min: { value: 0, message: 'Cannot be negative' } })}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="ratePerTonneKm">Per tonne-km (₹)</Label>
                  <Input
                    id="ratePerTonneKm" type="number" step="0.01" min={0} placeholder="1.80"
                    {...form.register('ratePerTonneKm', { min: { value: 0, message: 'Cannot be negative' } })}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="flatRate">Flat per trip (₹)</Label>
                  <Input
                    id="flatRate" type="number" step="1" min={0} placeholder="95000"
                    {...form.register('flatRate', { min: { value: 0, message: 'Cannot be negative' } })}
                  />
                </div>
              </div>

              <p className="text-xs text-muted-foreground/70">
                A flat rate takes precedence over the per-km rates.
              </p>
            </div>

            <DialogFooter className="pt-2">
              <Button type="button" variant="outline" onClick={() => setDialogOpen(false)}>Cancel</Button>
              <Button type="submit" disabled={isSubmitting} className="bg-[#714B67] text-white hover:bg-[#5A3C52]">
                {isSubmitting ? 'Saving...' : editingCustomer ? 'Update Customer' : 'Add Customer'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={Boolean(deleteTarget)}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
        title="Delete Customer"
        description={`Delete ${deleteTarget?.name || ''}? This cannot be undone.`}
        confirmLabel="Delete"
        onConfirm={handleConfirmDelete}
        variant="destructive"
      />
    </div>
  );
}
