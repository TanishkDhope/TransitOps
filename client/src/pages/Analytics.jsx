import { useState, useEffect, useMemo } from 'react';
import { motion } from 'framer-motion';
import { Download, Loader2, Fuel, Truck, IndianRupee, TrendingUp, FileSpreadsheet, Info } from 'lucide-react';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  PieChart, Pie, Cell, Legend,
} from 'recharts';
import {
  Select, SelectTrigger, SelectValue, SelectContent, SelectItem,
} from '@/components/ui/select';
import { Button } from '@/components/ui/button';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';

import { useData } from '../contexts/DataContext';
import { useToast } from '../hooks/useToast.js';
import * as reportsApi from '../api/reports.js';
import PageHeader from '../components/shared/PageHeader';
import KpiCard from '../components/shared/KpiCard';
import EmptyState from '../components/shared/EmptyState';

const STATUS_COLORS = {
  AVAILABLE: '#21B799',
  ON_TRIP: '#714B67',
  IN_SHOP: '#E4A900',
  RETIRED: '#9CA3AF',
};

const REPORTS = [
  { value: 'fuel-efficiency', label: 'Fuel Efficiency' },
  { value: 'fleet-utilization', label: 'Fleet Utilization' },
  { value: 'operational-cost', label: 'Operational Cost' },
  { value: 'vehicle-roi', label: 'Vehicle ROI' },
  { value: 'trip-profitability', label: 'Trip Profitability' },
  { value: 'lane-profitability', label: 'Lane Profitability' },
];

const CustomTooltip = ({ active, payload, label, prefix = '₹' }) => {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-lg border bg-card px-4 py-3 text-sm shadow-lg">
      <p className="font-medium text-foreground">{label}</p>
      {payload.map((entry, i) => (
        <p key={i} style={{ color: entry.color || entry.fill }} className="mt-1">
          {prefix}
          {Number(entry.value).toLocaleString('en-IN')}
        </p>
      ))}
    </div>
  );
};

export default function Analytics() {
  const { vehicles } = useData();
  const toast = useToast();

  const [fuelEfficiency, setFuelEfficiency] = useState([]);
  const [fleetUtilization, setFleetUtilization] = useState(null);
  const [operationalCost, setOperationalCost] = useState([]);
  const [vehicleRoi, setVehicleRoi] = useState([]);
  const [laneProfitability, setLaneProfitability] = useState([]);
  const [isLoading, setIsLoading] = useState(true);

  const [selectedReport, setSelectedReport] = useState('fuel-efficiency');
  const [exporting, setExporting] = useState(null);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      setIsLoading(true);
      try {
        const [fe, fu, oc, roi, lane] = await Promise.all([
          reportsApi.getFuelEfficiencyReport(),
          reportsApi.getFleetUtilizationReport(),
          reportsApi.getOperationalCostReport(),
          reportsApi.getVehicleRoiReport(),
          reportsApi.getLaneProfitabilityReport(),
        ]);
        if (cancelled) return;
        setFuelEfficiency(fe.data.data);
        setFleetUtilization(fu.data.data);
        setOperationalCost(oc.data.data);
        setVehicleRoi(roi.data.data);
        setLaneProfitability(lane.data.data);
      } catch (err) {
        if (!cancelled) toast.apiError(err, 'Could not load analytics');
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [toast]);

  const handleExport = async (format) => {
    setExporting(format);
    try {
      if (format === 'pdf') {
        await reportsApi.downloadReportPdf(selectedReport);
      } else {
        await reportsApi.downloadReportCsv(selectedReport);
      }
      const label = REPORTS.find((r) => r.value === selectedReport)?.label;
      toast.success(`${label} exported`, { description: `Saved as ${selectedReport}.${format}` });
    } catch (err) {
      toast.apiError(err, 'Export failed');
    } finally {
      setExporting(null);
    }
  };

  const avgFuelEfficiency = useMemo(() => {
    const totalDistance = fuelEfficiency.reduce((s, v) => s + (v.totalDistance || 0), 0);
    const totalLiters = fuelEfficiency.reduce((s, v) => s + (v.totalFuelLiters || 0), 0);
    return totalLiters > 0 ? Number((totalDistance / totalLiters).toFixed(1)) : 0;
  }, [fuelEfficiency]);

  const totalOperationalCost = useMemo(
    () => operationalCost.reduce((s, v) => s + (v.totalOperationalCost || 0), 0),
    [operationalCost]
  );

  const avgVehicleRoi = useMemo(() => {
    const withRoi = vehicleRoi.filter((v) => v.roi != null);
    if (withRoi.length === 0) return 0;
    return Number(((withRoi.reduce((s, v) => s + v.roi, 0) / withRoi.length) * 100).toFixed(1));
  }, [vehicleRoi]);

  const kpis = [
    { title: 'Fuel Efficiency', value: avgFuelEfficiency, suffix: 'km/L', icon: Fuel, color: '#017E84' },
    { title: 'Fleet Utilization', value: fleetUtilization?.fleetUtilizationPercent ?? 0, suffix: '%', icon: Truck, color: '#714B67' },
    { title: 'Operational Cost', value: Math.round(totalOperationalCost / 1000), suffix: 'K ₹', icon: IndianRupee, color: '#E4A900' },
    { title: 'Avg. Vehicle ROI', value: avgVehicleRoi, suffix: '%', icon: TrendingUp, color: '#21B799' },
  ];

  const fuelChartData = useMemo(
    () =>
      fuelEfficiency
        .filter((v) => v.fuelEfficiencyKmPerL != null)
        .map((v) => ({ name: v.registrationNo, value: v.fuelEfficiencyKmPerL })),
    [fuelEfficiency]
  );

  const costliestVehicles = useMemo(
    () =>
      [...operationalCost]
        .sort((a, b) => b.totalOperationalCost - a.totalOperationalCost)
        .slice(0, 5)
        .map((v) => ({ name: v.registrationNo, cost: v.totalOperationalCost })),
    [operationalCost]
  );

  const statusDistData = useMemo(() => {
    const counts = { AVAILABLE: 0, ON_TRIP: 0, IN_SHOP: 0, RETIRED: 0 };
    vehicles.forEach((v) => {
      if (counts[v.status] != null) counts[v.status] += 1;
    });
    return Object.entries(counts)
      .filter(([, value]) => value > 0)
      .map(([name, value]) => ({ name, value, fill: STATUS_COLORS[name] || '#9CA3AF' }));
  }, [vehicles]);

  if (isLoading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-border border-t-[#714B67]" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader title="Analytics" subtitle="Fleet performance insights">
        <Select value={selectedReport} onValueChange={setSelectedReport}>
          <SelectTrigger className="w-[200px]">
            <SelectValue placeholder="Select report" />
          </SelectTrigger>
          <SelectContent>
            {REPORTS.map((r) => (
              <SelectItem key={r.value} value={r.value}>{r.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button variant="outline" onClick={() => handleExport('csv')} disabled={Boolean(exporting)}>
          {exporting === 'csv' ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <FileSpreadsheet className="mr-2 h-4 w-4" />}
          CSV
        </Button>
        <Button onClick={() => handleExport('pdf')} disabled={Boolean(exporting)} className="bg-[#714B67] text-white hover:bg-[#5A3C52]">
          {exporting === 'pdf' ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Download className="mr-2 h-4 w-4" />}
          PDF
        </Button>
      </PageHeader>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {kpis.map((kpi, index) => (
          <KpiCard key={kpi.title} {...kpi} index={index} />
        ))}
      </div>

      <p className="flex items-center gap-1.5 text-xs text-muted-foreground/70">
        <Info className="h-3.5 w-3.5" />
        Operational cost includes fuel, maintenance and all other expenses. Utilisation is
        measured against deployable vehicles (available + on trip).
      </p>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <motion.div
          initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.2 }}
          className="rounded-xl border bg-card p-6 shadow-sm"
        >
          <h3 className="mb-1 text-lg font-semibold text-foreground">Fuel Efficiency</h3>
          <p className="mb-4 text-sm text-muted-foreground/80">Distance per litre, by vehicle</p>
          {fuelChartData.length === 0 ? (
            <EmptyState icon={Fuel} title="No fuel data" description="Link fuel logs to completed trips to see efficiency." />
          ) : (
            <ResponsiveContainer width="100%" height={300}>
              <BarChart data={fuelChartData} margin={{ top: 5, right: 10, left: 10, bottom: 5 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                <XAxis dataKey="name" tick={{ fontSize: 12, fill: '#6B7280' }} axisLine={{ stroke: 'var(--border)' }} />
                <YAxis tick={{ fontSize: 12, fill: '#6B7280' }} axisLine={{ stroke: 'var(--border)' }} tickFormatter={(v) => `${v}`} />
                <Tooltip content={<CustomTooltip prefix="" />} />
                <Bar dataKey="value" fill="#017E84" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          )}
        </motion.div>

        <motion.div
          initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.3 }}
          className="rounded-xl border bg-card p-6 shadow-sm"
        >
          <h3 className="mb-1 text-lg font-semibold text-foreground">Top Costliest Vehicles</h3>
          <p className="mb-4 text-sm text-muted-foreground/80">Highest total operational cost</p>
          {costliestVehicles.length === 0 ? (
            <EmptyState icon={IndianRupee} title="No cost data" description="Log fuel, maintenance or expenses to see costs." />
          ) : (
            <ResponsiveContainer width="100%" height={300}>
              <BarChart data={costliestVehicles} layout="vertical" margin={{ top: 5, right: 20, left: 20, bottom: 5 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" horizontal={false} />
                <XAxis type="number" tick={{ fontSize: 12, fill: '#6B7280' }} tickFormatter={(v) => `₹${(v / 1000).toFixed(0)}k`} />
                <YAxis dataKey="name" type="category" tick={{ fontSize: 12, fill: '#6B7280' }} width={100} />
                <Tooltip content={<CustomTooltip />} />
                <Bar dataKey="cost" fill="#E46E78" radius={[0, 4, 4, 0]} />
              </BarChart>
            </ResponsiveContainer>
          )}
        </motion.div>
      </div>

      {/* ISSUES #35 — lane profitability, worst first */}
      <motion.div
        initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.35 }}
        className="overflow-hidden rounded-xl border bg-card shadow-sm"
      >
        <div className="border-b border-border/50 px-6 py-4">
          <h3 className="text-lg font-semibold text-foreground">Lane Profitability</h3>
          <p className="mt-0.5 text-sm text-muted-foreground/80">
            Completed trips grouped by route — least profitable first
          </p>
        </div>
        {laneProfitability.length === 0 ? (
          <div className="p-8">
            <EmptyState icon={TrendingUp} title="No completed trips" description="Complete some trips with revenue to see lane margins." />
          </div>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow className="bg-muted/50">
                  {['Lane', 'Trips', 'Revenue', 'Cost', 'Margin', 'Margin %', '₹/km'].map((h) => (
                    <TableHead key={h} className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                      {h}
                    </TableHead>
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {laneProfitability.map((lane) => (
                  <TableRow key={lane.route} className="hover:bg-muted/50">
                    <TableCell className="font-medium text-foreground">{lane.route}</TableCell>
                    <TableCell className="text-muted-foreground">{lane.trips}</TableCell>
                    <TableCell className="text-muted-foreground">₹{lane.revenue.toLocaleString('en-IN')}</TableCell>
                    <TableCell className="text-muted-foreground">₹{lane.totalCost.toLocaleString('en-IN')}</TableCell>
                    <TableCell className={`font-semibold ${lane.margin >= 0 ? 'text-[#21B799]' : 'text-[#E46E78]'}`}>
                      ₹{lane.margin.toLocaleString('en-IN')}
                    </TableCell>
                    <TableCell className={lane.marginPercent >= 0 ? 'text-[#21B799]' : 'text-[#E46E78]'}>
                      {lane.marginPercent != null ? `${lane.marginPercent}%` : '—'}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {lane.avgCostPerKm != null ? `₹${lane.avgCostPerKm}` : '—'}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </motion.div>

      <motion.div
        initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.4 }}
        className="rounded-xl border bg-card p-6 shadow-sm"
      >
        <h3 className="mb-1 text-lg font-semibold text-foreground">Vehicle Status Distribution</h3>
        <p className="mb-4 text-sm text-muted-foreground/80">Current status breakdown of fleet vehicles</p>
        <ResponsiveContainer width="100%" height={300}>
          <PieChart>
            <Pie
              data={statusDistData} cx="50%" cy="50%" innerRadius={60} outerRadius={110}
              paddingAngle={3} dataKey="value" nameKey="name"
              label={({ name, percent }) => `${name} (${(percent * 100).toFixed(0)}%)`}
            >
              {statusDistData.map((entry) => (
                <Cell key={entry.name} fill={entry.fill} />
              ))}
            </Pie>
            <Tooltip
              formatter={(value, name) => [value, name]}
              contentStyle={{ borderRadius: '8px', border: '1px solid var(--border)', background: 'var(--card)' }}
            />
            <Legend verticalAlign="bottom" iconType="circle" wrapperStyle={{ fontSize: '13px', paddingTop: '12px' }} />
          </PieChart>
        </ResponsiveContainer>
      </motion.div>
    </div>
  );
}
