// ISSUES #36 — the audit trail, previously absent entirely: the system knew a trip
// was cancelled but not who cancelled it, or a driver suspended but not by whom.

import { useState, useEffect, useCallback } from 'react';
import { motion } from 'framer-motion';
import {
  ScrollText, Filter, ChevronLeft, ChevronRight, User, Clock, RefreshCw,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';

import * as auditApi from '../api/audit.js';
import { useToast } from '../hooks/useToast.js';
import PageHeader from '../components/shared/PageHeader';
import EmptyState from '../components/shared/EmptyState';

const ENTITIES = ['ALL', 'Trip', 'Vehicle', 'Driver', 'MaintenanceLog', 'FuelLog', 'Expense', 'Customer', 'User'];

const ACTIONS = [
  'ALL', 'CREATE', 'UPDATE', 'DELETE', 'DISPATCH', 'COMPLETE', 'CANCEL',
  'OPEN', 'CLOSE', 'SUSPEND', 'RESTORE', 'RETIRE', 'LOGIN', 'LOGOUT',
];

const ACTION_STYLES = {
  CREATE: 'bg-[#21B799]/10 text-[#21B799]',
  UPDATE: 'bg-[#5B899E]/10 text-[#5B899E]',
  DELETE: 'bg-[#E46E78]/10 text-[#E46E78]',
  DISPATCH: 'bg-[#714B67]/10 text-[#714B67]',
  COMPLETE: 'bg-[#21B799]/10 text-[#21B799]',
  CANCEL: 'bg-[#E46E78]/10 text-[#E46E78]',
  OPEN: 'bg-[#E4A900]/10 text-[#E4A900]',
  CLOSE: 'bg-[#21B799]/10 text-[#21B799]',
  SUSPEND: 'bg-[#E46E78]/10 text-[#E46E78]',
  RESTORE: 'bg-[#21B799]/10 text-[#21B799]',
  RETIRE: 'bg-[#E46E78]/10 text-[#E46E78]',
};

const PAGE_SIZE = 25;

export default function AuditLog() {
  const toast = useToast();

  const [logs, setLogs] = useState([]);
  const [meta, setMeta] = useState(null);
  const [isLoading, setIsLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [entityFilter, setEntityFilter] = useState('ALL');
  const [actionFilter, setActionFilter] = useState('ALL');

  const load = useCallback(async () => {
    setIsLoading(true);
    try {
      const { data } = await auditApi.getAuditLogs({
        page,
        limit: PAGE_SIZE,
        ...(entityFilter !== 'ALL' && { entity: entityFilter }),
        ...(actionFilter !== 'ALL' && { action: actionFilter }),
      });
      setLogs(data.data);
      setMeta(data.meta);
    } catch (err) {
      toast.apiError(err, 'Could not load the audit log');
    } finally {
      setIsLoading(false);
    }
  }, [page, entityFilter, actionFilter, toast]);

  useEffect(() => {
    load();
  }, [load]);

  // Changing a filter always returns to the first page.
  useEffect(() => {
    setPage(1);
  }, [entityFilter, actionFilter]);

  const totalPages = meta?.totalPages ?? 1;

  return (
    <div className="space-y-6">
      <PageHeader title="Audit Log" subtitle="Every state change, and who made it">
        <Button variant="outline" onClick={load} disabled={isLoading}>
          <RefreshCw className={`mr-2 h-4 w-4 ${isLoading ? 'animate-spin' : ''}`} />
          Refresh
        </Button>
      </PageHeader>

      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        className="flex flex-wrap items-center gap-3 rounded-xl border border-border bg-card p-4 shadow-sm"
      >
        <div className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
          <Filter className="h-4 w-4" />
          Filters
        </div>

        <Select value={entityFilter} onValueChange={setEntityFilter}>
          <SelectTrigger className="h-9 w-[180px] text-sm">
            <SelectValue placeholder="Entity" />
          </SelectTrigger>
          <SelectContent>
            {ENTITIES.map((entity) => (
              <SelectItem key={entity} value={entity}>
                {entity === 'ALL' ? 'All Entities' : entity}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select value={actionFilter} onValueChange={setActionFilter}>
          <SelectTrigger className="h-9 w-[160px] text-sm">
            <SelectValue placeholder="Action" />
          </SelectTrigger>
          <SelectContent>
            {ACTIONS.map((action) => (
              <SelectItem key={action} value={action}>
                {action === 'ALL' ? 'All Actions' : action}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        {meta && (
          <span className="ml-auto text-xs text-muted-foreground/70">
            {meta.total.toLocaleString('en-IN')} entr{meta.total === 1 ? 'y' : 'ies'}
          </span>
        )}
      </motion.div>

      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.1 }}
        className="overflow-hidden rounded-xl border bg-card shadow-sm"
      >
        {isLoading ? (
          <div className="flex h-64 items-center justify-center">
            <div className="h-8 w-8 animate-spin rounded-full border-2 border-border border-t-[#714B67]" />
          </div>
        ) : logs.length === 0 ? (
          <EmptyState
            icon={ScrollText}
            title="No audit entries"
            description={
              entityFilter !== 'ALL' || actionFilter !== 'ALL'
                ? 'No entries match the selected filters.'
                : 'Actions taken in the system will be recorded here.'
            }
          />
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow className="bg-muted/80">
                  {['When', 'Who', 'Action', 'Entity', 'Summary'].map((h) => (
                    <TableHead key={h} className="font-semibold text-muted-foreground">{h}</TableHead>
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {logs.map((log, idx) => (
                  <motion.tr
                    key={log.id}
                    initial={{ opacity: 0, x: -8 }}
                    animate={{ opacity: 1, x: 0 }}
                    transition={{ duration: 0.2, delay: Math.min(idx * 0.015, 0.25) }}
                    className="border-b transition-colors last:border-b-0 hover:bg-muted/50"
                  >
                    <TableCell className="whitespace-nowrap text-sm text-muted-foreground">
                      <span className="flex items-center gap-1.5">
                        <Clock className="h-3 w-3 shrink-0 text-muted-foreground/60" />
                        {new Date(log.createdAt).toLocaleString('en-IN', {
                          day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit',
                        })}
                      </span>
                    </TableCell>
                    <TableCell className="text-sm">
                      <span className="flex items-center gap-1.5 text-muted-foreground">
                        <User className="h-3 w-3 shrink-0 text-muted-foreground/60" />
                        {/* actorEmail is denormalised so history survives account deletion */}
                        {log.actor?.username ?? log.actorEmail ?? 'system'}
                      </span>
                    </TableCell>
                    <TableCell>
                      <span
                        className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${
                          ACTION_STYLES[log.action] || 'bg-muted text-muted-foreground'
                        }`}
                      >
                        {log.action}
                      </span>
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">{log.entity}</TableCell>
                    <TableCell className="max-w-md text-sm text-foreground">{log.summary}</TableCell>
                  </motion.tr>
                ))}
              </TableBody>
            </Table>
          </div>
        )}

        {meta && totalPages > 1 && (
          <div className="flex items-center justify-between border-t border-border/50 px-4 py-3">
            <p className="text-xs text-muted-foreground">
              Page {meta.page} of {totalPages}
            </p>
            <div className="flex gap-2">
              <Button
                variant="outline" size="sm"
                disabled={page <= 1 || isLoading}
                onClick={() => setPage((p) => Math.max(1, p - 1))}
              >
                <ChevronLeft className="mr-1 h-4 w-4" />
                Previous
              </Button>
              <Button
                variant="outline" size="sm"
                disabled={page >= totalPages || isLoading}
                onClick={() => setPage((p) => p + 1)}
              >
                Next
                <ChevronRight className="ml-1 h-4 w-4" />
              </Button>
            </div>
          </div>
        )}
      </motion.div>
    </div>
  );
}
