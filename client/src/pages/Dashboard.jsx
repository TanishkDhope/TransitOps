import { useState, useMemo, useEffect } from 'react';
import { motion } from 'framer-motion';
import {
  Truck, CircleCheck, Wrench, Route, Clock, Users, BarChart3,
  SlidersHorizontal, ShieldAlert, Info,
} from 'lucide-react';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import { PieChart, Pie, Cell, Tooltip, Legend, ResponsiveContainer } from 'recharts';

import { useData } from '../contexts/DataContext';
import { useAuth } from '../contexts/AuthContext';
import { useToast } from '../hooks/useToast.js';
import * as dashboardApi from '../api/dashboard.js';
import { VEHICLE_TYPES, TRIP_STATUSES } from '../config/roles.js';
import PageHeader from '../components/shared/PageHeader';
import KpiCard from '../components/shared/KpiCard';
import StatusBadge from '../components/shared/StatusBadge';
import EmptyState from '../components/shared/EmptyState';

const TYPE_OPTIONS = ['All', ...VEHICLE_TYPES];
const STATUS_OPTIONS = ['All', ...TRIP_STATUSES];

const STATUS_COLORS = {
  AVAILABLE: '#21B799',
  ON_TRIP: '#5B899E',
  IN_SHOP: '#E4A900',
  RETIRED: '#9CA3AF',
};

export default function Dashboard() {
  const { vehicles, drivers, trips, isLoading } = useData();
  const { user } = useAuth();
  const toast = useToast();

  const [typeFilter, setTypeFilter] = useState('All');
  const [statusFilter, setStatusFilter] = useState('All');
  const [regionFilter, setRegionFilter] = useState('All');
  const [kpis, setKpis] = useState(null);
  const [meta, setMeta] = useState(null);

  const regions = useMemo(() => {
    const set = new Set(vehicles.map((v) => v.region).filter(Boolean));
    return ['All', ...Array.from(set).sort()];
  }, [vehicles]);

  useEffect(() => {
    let cancelled = false;

    dashboardApi
      .getKpis({
        ...(typeFilter !== 'All' && { type: typeFilter }),
        ...(regionFilter !== 'All' && { region: regionFilter }),
      })
      .then(({ data }) => {
        if (cancelled) return;
        setKpis(data.data);
        setMeta(data.meta);
      })
      .catch((err) => {
        if (cancelled) return;
        setKpis(null);
        toast.apiError(err, 'Could not load dashboard figures');
      });

    return () => {
      cancelled = true;
    };
  }, [typeFilter, regionFilter, toast]);

  /**
   * ISSUES #18 — the vehicle filters are now applied server-side to the trip and
   * driver counts too, so the KPI strip, the table and the chart all describe the
   * same slice of the fleet instead of three different scopes.
   */
  const filteredTrips = useMemo(() => {
    let result = [...trips];

    if (typeFilter !== 'All') {
      const ids = new Set(vehicles.filter((v) => v.type === typeFilter).map((v) => v.id));
      result = result.filter((t) => ids.has(t.vehicleId));
    }
    if (regionFilter !== 'All') {
      const ids = new Set(vehicles.filter((v) => v.region === regionFilter).map((v) => v.id));
      result = result.filter((t) => ids.has(t.vehicleId));
    }
    if (statusFilter !== 'All') {
      result = result.filter((t) => t.status === statusFilter);
    }

    return result
      .sort((a, b) => new Date(b.plannedStart ?? b.createdAt) - new Date(a.plannedStart ?? a.createdAt))
      .slice(0, 8);
  }, [trips, vehicles, typeFilter, statusFilter, regionFilter]);

  const vehicleMap = useMemo(() => new Map(vehicles.map((v) => [v.id, v])), [vehicles]);
  const driverMap = useMemo(() => new Map(drivers.map((d) => [d.id, d])), [drivers]);

  const pieData = useMemo(() => {
    const counts = { AVAILABLE: 0, ON_TRIP: 0, IN_SHOP: 0, RETIRED: 0 };
    const scoped = vehicles.filter(
      (v) =>
        (typeFilter === 'All' || v.type === typeFilter) &&
        (regionFilter === 'All' || v.region === regionFilter)
    );
    scoped.forEach((v) => {
      if (counts[v.status] != null) counts[v.status] += 1;
    });
    return Object.entries(counts)
      .filter(([, value]) => value > 0)
      .map(([name, value]) => ({ name, value }));
  }, [vehicles, typeFilter, regionFilter]);

  const kpiCards = [
    { title: 'Active Vehicles', value: kpis?.activeVehicles ?? 0, icon: Truck, color: '#714B67' },
    { title: 'Available', value: kpis?.availableVehicles ?? 0, icon: CircleCheck, color: '#21B799' },
    { title: 'In Maintenance', value: kpis?.vehiclesInMaintenance ?? 0, icon: Wrench, color: '#E4A900' },
    { title: 'Active Trips', value: kpis?.activeTrips ?? 0, icon: Route, color: '#5B899E' },
    { title: 'Pending Trips', value: kpis?.pendingTrips ?? 0, icon: Clock, color: '#E4A900' },
    { title: 'Drivers On Duty', value: kpis?.driversOnDuty ?? 0, icon: Users, color: '#017E84' },
    {
      title: 'Fleet Utilization',
      value: kpis?.fleetUtilization ?? 0,
      suffix: '%',
      icon: BarChart3,
      color: '#714B67',
    },
  ];

  const formatDate = (date) => {
    if (!date) return '—';
    return new Date(date).toLocaleDateString('en-IN', {
      day: '2-digit',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
    });
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
      <PageHeader
        title="Operations Dashboard"
        subtitle={`Welcome back, ${user?.name ?? 'there'} — real-time fleet overview`}
      />

      {/* Compliance banner — ISSUES #34, surfaces what the cron is tracking */}
      {(kpis?.complianceIssues > 0 || kpis?.licensesExpiringSoon > 0) && (
        <motion.div
          initial={{ opacity: 0, y: -6 }}
          animate={{ opacity: 1, y: 0 }}
          className="flex items-start gap-3 rounded-lg border border-[#E4A900]/30 bg-[#E4A900]/5 p-4"
        >
          <ShieldAlert className="mt-0.5 h-5 w-5 shrink-0 text-[#E4A900]" />
          <div className="text-sm text-muted-foreground">
            <p className="mb-0.5 font-medium text-[#E4A900]">Compliance needs attention</p>
            <p>
              {kpis.complianceIssues > 0 && `${kpis.complianceIssues} vehicle(s) with expired insurance or PUC. `}
              {kpis.licensesExpiringSoon > 0 && `${kpis.licensesExpiringSoon} licence(s) expiring within 30 days.`}
            </p>
          </div>
        </motion.div>
      )}

      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-7">
        {kpiCards.map((kpi, index) => (
          <KpiCard key={kpi.title} {...kpi} index={index} />
        ))}
      </div>

      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.2 }}
        className="rounded-xl border border-border bg-card p-4 shadow-sm"
      >
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
            <SlidersHorizontal className="h-4 w-4" />
            Filters
          </div>

          <Select value={typeFilter} onValueChange={setTypeFilter}>
            <SelectTrigger className="h-9 w-[150px] text-sm">
              <SelectValue placeholder="Vehicle Type" />
            </SelectTrigger>
            <SelectContent>
              {TYPE_OPTIONS.map((type) => (
                <SelectItem key={type} value={type}>
                  {type === 'All' ? 'All Types' : type}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger className="h-9 w-[160px] text-sm">
              <SelectValue placeholder="Trip Status" />
            </SelectTrigger>
            <SelectContent>
              {STATUS_OPTIONS.map((status) => (
                <SelectItem key={status} value={status}>
                  {status === 'All' ? 'All Trip Statuses' : status}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Select value={regionFilter} onValueChange={setRegionFilter}>
            <SelectTrigger className="h-9 w-[160px] text-sm">
              <SelectValue placeholder="Region" />
            </SelectTrigger>
            <SelectContent>
              {regions.map((region) => (
                <SelectItem key={region} value={region}>
                  {region === 'All' ? 'All Regions' : region}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          {meta?.filtered && (
            <span className="flex items-center gap-1.5 text-xs text-muted-foreground/80">
              <Info className="h-3.5 w-3.5" />
              KPIs scoped to the selected vehicles
            </span>
          )}
        </div>
      </motion.div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.3 }}
          className="overflow-hidden rounded-xl border border-border bg-card shadow-sm lg:col-span-2"
        >
          <div className="border-b border-border/50 px-5 py-4">
            <h3 className="text-base font-semibold text-foreground">Recent Trips</h3>
            <p className="mt-0.5 text-sm text-muted-foreground/80">Latest 8 trips from the fleet</p>
          </div>

          {filteredTrips.length === 0 ? (
            <div className="p-8">
              <EmptyState
                icon={Route}
                title="No trips found"
                description="No trips match the selected filters."
              />
            </div>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow className="bg-muted/50">
                    {['Route', 'Vehicle', 'Driver', 'Status', 'Scheduled'].map((h) => (
                      <TableHead
                        key={h}
                        className="text-xs font-semibold uppercase tracking-wider text-muted-foreground"
                      >
                        {h}
                      </TableHead>
                    ))}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredTrips.map((trip) => (
                    <TableRow key={trip.id} className="transition-colors hover:bg-muted/50">
                      <TableCell className="text-sm text-muted-foreground">
                        {trip.source} → {trip.destination}
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        {trip.vehicle?.registrationNo ?? vehicleMap.get(trip.vehicleId)?.registrationNo ?? '—'}
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        {trip.driver?.name ?? driverMap.get(trip.driverId)?.name ?? '—'}
                      </TableCell>
                      <TableCell>
                        <StatusBadge status={trip.status} />
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground/80">
                        {formatDate(trip.plannedStart ?? trip.createdAt)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </motion.div>

        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.4 }}
          className="overflow-hidden rounded-xl border border-border bg-card shadow-sm"
        >
          <div className="border-b border-border/50 px-5 py-4">
            <h3 className="text-base font-semibold text-foreground">Vehicle Distribution</h3>
            <p className="mt-0.5 text-sm text-muted-foreground/80">Status breakdown across fleet</p>
          </div>

          <div className="h-[320px] p-4">
            {pieData.length === 0 ? (
              <div className="flex h-full items-center justify-center">
                <EmptyState
                  icon={BarChart3}
                  title="No data"
                  description="No vehicles match the selected filters."
                />
              </div>
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie
                    data={pieData}
                    cx="50%"
                    cy="50%"
                    innerRadius={60}
                    outerRadius={95}
                    paddingAngle={3}
                    dataKey="value"
                    nameKey="name"
                    stroke="none"
                  >
                    {pieData.map((entry) => (
                      <Cell key={entry.name} fill={STATUS_COLORS[entry.name] || '#9CA3AF'} />
                    ))}
                  </Pie>
                  <Tooltip
                    contentStyle={{
                      borderRadius: '8px',
                      border: '1px solid var(--border)',
                      background: 'var(--card)',
                      fontSize: '13px',
                    }}
                    formatter={(value, name) => [`${value} vehicles`, name]}
                  />
                  <Legend
                    verticalAlign="bottom"
                    height={36}
                    iconType="circle"
                    iconSize={8}
                    formatter={(value) => (
                      <span className="text-xs text-muted-foreground">{value}</span>
                    )}
                  />
                </PieChart>
              </ResponsiveContainer>
            )}
          </div>
        </motion.div>
      </div>
    </div>
  );
}
