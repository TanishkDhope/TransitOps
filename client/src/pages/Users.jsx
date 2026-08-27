import { useState, useEffect, useCallback } from 'react';
import { useForm, Controller } from 'react-hook-form';
import { motion, AnimatePresence } from 'framer-motion';
import { Plus, Users as UsersIcon, Trash2, ShieldCheck } from 'lucide-react';
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

import * as usersApi from '../api/users.js';
import { ASSIGNABLE_ROLES, ROLE_LABELS } from '../config/roles.js';
import { useAuth } from '../contexts/AuthContext';
import { useToast } from '../hooks/useToast.js';
import PageHeader from '../components/shared/PageHeader';
import EmptyState from '../components/shared/EmptyState';
import ConfirmDialog from '../components/shared/ConfirmDialog';

const defaultFormValues = {
  username: '', email: '', password: '', role: 'FLEET_MANAGER', driverId: '',
};

export default function Users() {
  const { user: currentUser } = useAuth();
  const toast = useToast();

  const [users, setUsers] = useState([]);
  const [unlinkedDrivers, setUnlinkedDrivers] = useState([]);
  const [isLoading, setIsLoading] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState(null);

  const form = useForm({ defaultValues: defaultFormValues });
  const selectedRole = form.watch('role');

  const loadUsers = useCallback(async () => {
    setIsLoading(true);
    try {
      const { data } = await usersApi.getUsers({ limit: 'all' });
      setUsers(data.data);
    } catch (err) {
      toast.apiError(err, 'Could not load users');
    } finally {
      setIsLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    loadUsers();
  }, [loadUsers]);

  // ISSUES #37 — a DRIVER login must be attached to a driver record.
  useEffect(() => {
    if (selectedRole !== 'DRIVER') return;
    usersApi
      .getUnlinkedDrivers()
      .then(({ data }) => setUnlinkedDrivers(data.data))
      .catch(() => setUnlinkedDrivers([]));
  }, [selectedRole]);

  function openAddDialog() {
    form.reset(defaultFormValues);
    setDialogOpen(true);
  }

  async function onSubmit(data) {
    setIsSubmitting(true);
    try {
      const payload = {
        username: data.username,
        email: data.email,
        password: data.password,
        role: data.role,
        ...(data.role === 'DRIVER' && data.driverId ? { driverId: data.driverId } : {}),
      };
      const { data: created } = await usersApi.createUser(payload);
      setUsers((prev) => [created.data, ...prev]);
      toast.success(created.message, { description: `${created.data.email} can now sign in.` });
      setDialogOpen(false);
      form.reset(defaultFormValues);
    } catch (err) {
      toast.apiError(err, 'Could not create the account');
    } finally {
      setIsSubmitting(false);
    }
  }

  async function handleRoleChange(user, role) {
    try {
      const { data } = await usersApi.updateUserRole(user.id, role);
      setUsers((prev) => prev.map((u) => (u.id === user.id ? data.data : u)));
      toast.success(data.message, { description: 'They will need to sign in again.' });
    } catch (err) {
      toast.apiError(err, 'Could not change the role');
    }
  }

  async function handleConfirmDelete() {
    if (!deleteTarget) return;
    try {
      const { data } = await usersApi.deleteUser(deleteTarget.id);
      setUsers((prev) => prev.filter((u) => u.id !== deleteTarget.id));
      toast.success(data.message);
    } catch (err) {
      toast.apiError(err, 'Could not delete the account');
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
      <PageHeader title="User Management" subtitle="Create and manage user accounts and roles">
        <Button onClick={openAddDialog} className="bg-[#714B67] text-white hover:bg-[#5A3C52]">
          <Plus className="mr-2 h-4 w-4" />
          Add User
        </Button>
      </PageHeader>

      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.3, delay: 0.1 }}
        className="overflow-hidden rounded-xl border bg-card shadow-sm"
      >
        {users.length === 0 ? (
          <EmptyState
            icon={UsersIcon}
            title="No users found"
            description="Get started by adding your first user account."
            action={
              <Button onClick={openAddDialog} variant="outline" className="border-[#714B67] text-[#714B67] hover:bg-[#714B67]/5">
                <Plus className="mr-2 h-4 w-4" />
                Add User
              </Button>
            }
          />
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow className="bg-muted/80">
                  {['Username', 'Email', 'Role', 'Linked Driver', 'Created'].map((h) => (
                    <TableHead key={h} className="font-semibold text-muted-foreground">{h}</TableHead>
                  ))}
                  <TableHead className="text-right font-semibold text-muted-foreground">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                <AnimatePresence>
                  {users.map((u, idx) => {
                    const isSelf = u.id === currentUser?.id;
                    return (
                      <motion.tr
                        key={u.id}
                        initial={{ opacity: 0, x: -10 }}
                        animate={{ opacity: 1, x: 0 }}
                        exit={{ opacity: 0, x: 10 }}
                        transition={{ duration: 0.2, delay: Math.min(idx * 0.03, 0.3) }}
                        className="border-b transition-colors last:border-b-0 hover:bg-muted/50"
                      >
                        <TableCell className="font-medium text-foreground">
                          {u.username}
                          {isSelf && (
                            <span className="ml-2 rounded-full bg-[#714B67]/10 px-1.5 py-0.5 text-[10px] font-medium text-[#714B67]">
                              you
                            </span>
                          )}
                        </TableCell>
                        <TableCell className="text-muted-foreground">{u.email}</TableCell>
                        <TableCell>
                          {isSelf ? (
                            <span className="inline-flex items-center rounded-full bg-[#714B67]/10 px-2.5 py-0.5 text-xs font-medium text-[#714B67]">
                              {ROLE_LABELS[u.role] || u.role}
                            </span>
                          ) : (
                            <Select value={u.role} onValueChange={(role) => handleRoleChange(u, role)}>
                              <SelectTrigger className="h-8 w-[170px] text-xs">
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                {ASSIGNABLE_ROLES.map((r) => (
                                  <SelectItem
                                    key={r.value}
                                    value={r.value}
                                    disabled={r.value === 'DRIVER' && !u.driver}
                                  >
                                    {r.label}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          )}
                        </TableCell>
                        <TableCell className="text-muted-foreground">
                          {u.driver ? u.driver.name : '—'}
                        </TableCell>
                        <TableCell className="text-muted-foreground">
                          {new Date(u.createdAt).toLocaleDateString('en-IN')}
                        </TableCell>
                        <TableCell className="text-right">
                          <Button
                            variant="ghost" size="icon" disabled={isSelf}
                            className="h-8 w-8 text-muted-foreground/60 hover:bg-[#E46E78]/10 hover:text-[#E46E78] disabled:opacity-30"
                            onClick={() => setDeleteTarget(u)}
                            title={isSelf ? 'You cannot delete your own account' : 'Delete user'}
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
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

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-[500px]">
          <DialogHeader>
            <DialogTitle className="text-lg font-semibold text-foreground">Add New User</DialogTitle>
          </DialogHeader>

          <form onSubmit={form.handleSubmit(onSubmit)} className="mt-2 space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="username">Username <span className="text-[#E46E78]">*</span></Label>
              <Input id="username" placeholder="e.g. jdoe" {...form.register('username', { required: 'Username is required' })} />
              {form.formState.errors.username && (
                <p className="text-xs text-[#E46E78]">{form.formState.errors.username.message}</p>
              )}
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="email">Email <span className="text-[#E46E78]">*</span></Label>
              <Input
                id="email" type="email" placeholder="jdoe@transitops.com"
                {...form.register('email', {
                  required: 'Email is required',
                  pattern: { value: /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/, message: 'Enter a valid email address' },
                })}
              />
              {form.formState.errors.email && (
                <p className="text-xs text-[#E46E78]">{form.formState.errors.email.message}</p>
              )}
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="password">Password <span className="text-[#E46E78]">*</span></Label>
              <Input
                id="password" type="password" placeholder="Min. 8 characters, with a number"
                {...form.register('password', {
                  required: 'Password is required',
                  minLength: { value: 8, message: 'At least 8 characters' },
                  validate: {
                    hasLetter: (v) => /[A-Za-z]/.test(v) || 'Must contain a letter',
                    hasNumber: (v) => /[0-9]/.test(v) || 'Must contain a number',
                  },
                })}
              />
              {form.formState.errors.password && (
                <p className="text-xs text-[#E46E78]">{form.formState.errors.password.message}</p>
              )}
            </div>

            <div className="space-y-1.5">
              <Label>Role <span className="text-[#E46E78]">*</span></Label>
              <Controller
                control={form.control} name="role"
                rules={{ required: 'Please choose a role' }}
                render={({ field }) => (
                  <Select value={field.value} onValueChange={field.onChange}>
                    <SelectTrigger><SelectValue placeholder="Select role" /></SelectTrigger>
                    <SelectContent>
                      {ASSIGNABLE_ROLES.map((r) => (
                        <SelectItem key={r.value} value={r.value}>{r.label}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              />
            </div>

            {selectedRole === 'DRIVER' && (
              <div className="space-y-1.5 rounded-lg border border-dashed border-border p-3">
                <Label className="flex items-center gap-1.5">
                  <ShieldCheck className="h-3.5 w-3.5" />
                  Link to Driver Record <span className="text-[#E46E78]">*</span>
                </Label>
                <Controller
                  control={form.control} name="driverId"
                  rules={{
                    validate: (v) => selectedRole !== 'DRIVER' || Boolean(v) || 'Choose a driver record',
                  }}
                  render={({ field }) => (
                    <Select value={field.value} onValueChange={field.onChange}>
                      <SelectTrigger><SelectValue placeholder="Select a driver" /></SelectTrigger>
                      <SelectContent>
                        {unlinkedDrivers.length === 0 ? (
                          <div className="px-3 py-2 text-sm text-muted-foreground/60">
                            Every driver already has a login
                          </div>
                        ) : (
                          unlinkedDrivers.map((d) => (
                            <SelectItem key={d.id} value={d.id}>
                              {d.name} ({d.licenseNumber})
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
                <p className="text-xs text-muted-foreground/70">
                  Driver accounts see only their own trips and can log fuel and expenses from the road.
                </p>
              </div>
            )}

            <DialogFooter className="pt-2">
              <Button type="button" variant="outline" onClick={() => setDialogOpen(false)}>Cancel</Button>
              <Button type="submit" disabled={isSubmitting} className="bg-[#714B67] text-white hover:bg-[#5A3C52]">
                {isSubmitting ? 'Creating...' : 'Create User'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={Boolean(deleteTarget)}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
        title="Delete User"
        description={`Delete ${deleteTarget?.username || ''}'s account? ${
          deleteTarget?.driver ? 'Their driver record will be kept and simply unlinked.' : 'This cannot be undone.'
        }`}
        confirmLabel="Delete"
        onConfirm={handleConfirmDelete}
        variant="destructive"
      />
    </div>
  );
}
