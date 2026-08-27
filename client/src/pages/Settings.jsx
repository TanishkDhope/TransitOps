import { useState, useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { motion } from 'framer-motion';
import {
  Save, CheckCircle2, Minus, Shield, Building2, Bell, KeyRound, Mail, RefreshCw,
} from 'lucide-react';

import { useData } from '../contexts/DataContext';
import { useAuth } from '../contexts/AuthContext';
import { useToast } from '../hooks/useToast.js';
import * as authApi from '../api/auth.js';
import * as notificationsApi from '../api/notifications.js';
import { buildRbacMatrix, RBAC_MODULES } from '../config/roles.js';
import PageHeader from '../components/shared/PageHeader';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';

const PermissionIcon = ({ allowed }) =>
  allowed ? (
    <CheckCircle2 className="mx-auto h-5 w-5 text-[#21B799]" />
  ) : (
    <Minus className="mx-auto h-5 w-5 text-muted-foreground/30" />
  );

export default function Settings() {
  const { settings, updateSettings } = useData();
  const { user, can } = useAuth();
  const toast = useToast();

  const [notificationStatus, setNotificationStatus] = useState(null);
  const [isChecking, setIsChecking] = useState(false);

  // ISSUES #30 — the matrix is derived from ROLE_ACCESS, not hand-maintained.
  const rbacMatrix = buildRbacMatrix();

  const settingsForm = useForm({
    defaultValues: {
      depotName: settings.depotName || '',
      currency: settings.currency || 'INR',
      distanceUnit: settings.distanceUnit || 'km',
    },
  });

  const passwordForm = useForm({
    defaultValues: { currentPassword: '', newPassword: '', confirmPassword: '' },
  });

  useEffect(() => {
    if (!can('notification:trigger')) return;
    notificationsApi
      .getNotificationStatus()
      .then(({ data }) => setNotificationStatus(data.data))
      .catch(() => setNotificationStatus(null));
  }, [can]);

  const onSaveSettings = (data) => {
    updateSettings(data);
    toast.success('Settings saved', { description: 'Your preferences are stored on this device.' });
  };

  const onChangePassword = async (data) => {
    if (data.newPassword !== data.confirmPassword) {
      toast.warning('Passwords do not match', { description: 'Re-enter the new password.' });
      return;
    }
    try {
      const { data: res } = await authApi.changePassword({
        currentPassword: data.currentPassword,
        newPassword: data.newPassword,
      });
      toast.success(res.message, { description: 'Sign in again on your other devices.' });
      passwordForm.reset();
    } catch (err) {
      toast.apiError(err, 'Could not change your password');
    }
  };

  /** ISSUES #4 — this endpoint exists now that its router is mounted. */
  const runExpiryCheck = async () => {
    setIsChecking(true);
    try {
      const { data } = await notificationsApi.triggerExpiryCheck();
      toast.success(data.message);
      const { data: status } = await notificationsApi.getNotificationStatus();
      setNotificationStatus(status.data);
    } catch (err) {
      toast.apiError(err, 'Could not run the expiry check');
    } finally {
      setIsChecking(false);
    }
  };

  return (
    <div className="space-y-6">
      <PageHeader title="Settings" subtitle="Platform configuration" />

      {/* ---------- General ---------- */}
      <motion.div
        initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }}
        className="overflow-hidden rounded-xl border bg-card shadow-sm"
      >
        <div className="flex items-center gap-3 border-b bg-muted/50 px-6 py-4">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-[#714B67]/10">
            <Building2 className="h-5 w-5 text-[#714B67]" />
          </div>
          <div>
            <h3 className="font-semibold text-foreground">General Settings</h3>
            <p className="text-sm text-muted-foreground/80">Configure your depot and preferences</p>
          </div>
        </div>

        <form onSubmit={settingsForm.handleSubmit(onSaveSettings)} className="space-y-5 p-6">
          <div className="grid grid-cols-1 gap-6 md:grid-cols-3">
            <div className="space-y-2">
              <Label htmlFor="depotName">Depot Name</Label>
              <Input id="depotName" placeholder="Enter depot name" {...settingsForm.register('depotName')} />
            </div>

            <div className="space-y-2">
              <Label>Currency</Label>
              <Select
                value={settingsForm.watch('currency')}
                onValueChange={(val) => settingsForm.setValue('currency', val, { shouldDirty: true })}
              >
                <SelectTrigger><SelectValue placeholder="Select currency" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="INR">INR (₹)</SelectItem>
                  <SelectItem value="USD">USD ($)</SelectItem>
                  <SelectItem value="EUR">EUR (€)</SelectItem>
                  <SelectItem value="GBP">GBP (£)</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label>Distance Unit</Label>
              <Select
                value={settingsForm.watch('distanceUnit')}
                onValueChange={(val) => settingsForm.setValue('distanceUnit', val, { shouldDirty: true })}
              >
                <SelectTrigger><SelectValue placeholder="Select unit" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="km">Kilometers (km)</SelectItem>
                  <SelectItem value="miles">Miles</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="flex items-center gap-3 pt-2">
            <Button type="submit" className="bg-[#714B67] text-white hover:bg-[#5A3C52]">
              <Save className="mr-2 h-4 w-4" />
              Save Settings
            </Button>
            <p className="text-xs text-muted-foreground/70">
              Stored in this browser. Currency and distance display are not yet applied fleet-wide.
            </p>
          </div>
        </form>
      </motion.div>

      {/* ---------- Password ---------- */}
      <motion.div
        initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.1 }}
        className="overflow-hidden rounded-xl border bg-card shadow-sm"
      >
        <div className="flex items-center gap-3 border-b bg-muted/50 px-6 py-4">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-[#E4A900]/10">
            <KeyRound className="h-5 w-5 text-[#E4A900]" />
          </div>
          <div>
            <h3 className="font-semibold text-foreground">Change Password</h3>
            <p className="text-sm text-muted-foreground/80">Signed in as {user?.email}</p>
          </div>
        </div>

        <form onSubmit={passwordForm.handleSubmit(onChangePassword)} className="space-y-5 p-6">
          <div className="grid grid-cols-1 gap-6 md:grid-cols-3">
            <div className="space-y-2">
              <Label htmlFor="currentPassword">Current Password</Label>
              <Input
                id="currentPassword" type="password" autoComplete="current-password"
                {...passwordForm.register('currentPassword', { required: 'Required' })}
              />
              {passwordForm.formState.errors.currentPassword && (
                <p className="text-xs text-[#E46E78]">{passwordForm.formState.errors.currentPassword.message}</p>
              )}
            </div>
            <div className="space-y-2">
              <Label htmlFor="newPassword">New Password</Label>
              <Input
                id="newPassword" type="password" autoComplete="new-password"
                {...passwordForm.register('newPassword', {
                  required: 'Required',
                  minLength: { value: 8, message: 'At least 8 characters' },
                  validate: {
                    hasLetter: (v) => /[A-Za-z]/.test(v) || 'Must contain a letter',
                    hasNumber: (v) => /[0-9]/.test(v) || 'Must contain a number',
                  },
                })}
              />
              {passwordForm.formState.errors.newPassword && (
                <p className="text-xs text-[#E46E78]">{passwordForm.formState.errors.newPassword.message}</p>
              )}
            </div>
            <div className="space-y-2">
              <Label htmlFor="confirmPassword">Confirm New Password</Label>
              <Input
                id="confirmPassword" type="password" autoComplete="new-password"
                {...passwordForm.register('confirmPassword', { required: 'Required' })}
              />
              {passwordForm.formState.errors.confirmPassword && (
                <p className="text-xs text-[#E46E78]">{passwordForm.formState.errors.confirmPassword.message}</p>
              )}
            </div>
          </div>

          <Button type="submit" className="bg-[#714B67] text-white hover:bg-[#5A3C52]">
            <KeyRound className="mr-2 h-4 w-4" />
            Update Password
          </Button>
        </form>
      </motion.div>

      {/* ---------- Notifications ---------- */}
      {can('notification:trigger') && (
        <motion.div
          initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.15 }}
          className="overflow-hidden rounded-xl border bg-card shadow-sm"
        >
          <div className="flex items-center gap-3 border-b bg-muted/50 px-6 py-4">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-[#21B799]/10">
              <Bell className="h-5 w-5 text-[#21B799]" />
            </div>
            <div>
              <h3 className="font-semibold text-foreground">Compliance Notifications</h3>
              <p className="text-sm text-muted-foreground/80">
                Licence, insurance, PUC and service reminders
              </p>
            </div>
          </div>

          <div className="space-y-4 p-6">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
              <div className="rounded-lg border border-border p-3">
                <p className="flex items-center gap-1.5 text-xs uppercase tracking-wider text-muted-foreground">
                  <Mail className="h-3.5 w-3.5" /> Email
                </p>
                <p className={`mt-1 text-sm font-semibold ${notificationStatus?.emailEnabled ? 'text-[#21B799]' : 'text-[#E46E78]'}`}>
                  {notificationStatus?.emailEnabled ? 'Configured' : 'Not configured'}
                </p>
              </div>
              <div className="rounded-lg border border-border p-3">
                <p className="text-xs uppercase tracking-wider text-muted-foreground">Last sent</p>
                <p className="mt-1 text-sm font-semibold text-foreground">
                  {notificationStatus?.lastSentAt
                    ? new Date(notificationStatus.lastSentAt).toLocaleString('en-IN')
                    : 'Never'}
                </p>
              </div>
              <div className="rounded-lg border border-border p-3">
                <p className="text-xs uppercase tracking-wider text-muted-foreground">Failures (24h)</p>
                <p className={`mt-1 text-sm font-semibold ${notificationStatus?.failuresLast24h > 0 ? 'text-[#E46E78]' : 'text-foreground'}`}>
                  {notificationStatus?.failuresLast24h ?? 0}
                </p>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-3">
              <Button
                onClick={runExpiryCheck}
                disabled={isChecking || !notificationStatus?.emailEnabled}
                variant="outline"
                className="border-[#21B799] text-[#21B799] hover:bg-[#21B799]/5"
              >
                <RefreshCw className={`mr-2 h-4 w-4 ${isChecking ? 'animate-spin' : ''}`} />
                {isChecking ? 'Checking…' : 'Run expiry check now'}
              </Button>
              <p className="text-xs text-muted-foreground/70">
                Runs automatically every 30 minutes. Recipients are not re-notified about the same
                item within its cooldown window.
              </p>
            </div>
          </div>
        </motion.div>
      )}

      {/* ---------- RBAC ---------- */}
      <motion.div
        initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.2 }}
        className="overflow-hidden rounded-xl border bg-card shadow-sm"
      >
        <div className="flex items-center gap-3 border-b bg-muted/50 px-6 py-4">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-[#5B899E]/10">
            <Shield className="h-5 w-5 text-[#5B899E]" />
          </div>
          <div>
            <h3 className="font-semibold text-foreground">Role-Based Access Control</h3>
            <p className="text-sm text-muted-foreground/80">
              Generated from the live access configuration — enforced by the API
            </p>
          </div>
        </div>

        <div className="overflow-x-auto p-6">
          <Table>
            <TableHeader>
              <TableRow className="bg-muted/80">
                <TableHead className="w-[160px] font-semibold text-muted-foreground">Role</TableHead>
                {RBAC_MODULES.map((module) => (
                  <TableHead key={module.key} className="text-center font-semibold text-muted-foreground">
                    {module.label}
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {rbacMatrix.map((row, index) => (
                <motion.tr
                  key={row.roleKey}
                  initial={{ opacity: 0, x: -10 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ delay: index * 0.05 }}
                  className={`border-b transition-colors last:border-b-0 hover:bg-muted/50 ${
                    row.roleKey === user?.role ? 'bg-[#714B67]/5' : ''
                  }`}
                >
                  <TableCell className="font-medium text-foreground">
                    {row.role}
                    {row.roleKey === user?.role && (
                      <span className="ml-2 rounded-full bg-[#714B67]/10 px-1.5 py-0.5 text-[10px] font-medium text-[#714B67]">
                        you
                      </span>
                    )}
                  </TableCell>
                  {RBAC_MODULES.map((module) => (
                    <TableCell key={module.key} className="text-center">
                      <PermissionIcon allowed={row.permissions[module.key]} />
                    </TableCell>
                  ))}
                </motion.tr>
              ))}
            </TableBody>
          </Table>
        </div>
      </motion.div>
    </div>
  );
}
