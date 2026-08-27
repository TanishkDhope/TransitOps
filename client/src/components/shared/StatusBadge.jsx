import { cn } from '@/lib/utils';

const statusConfig = {
  // Vehicle
  AVAILABLE: { label: 'Available', className: 'badge-success' },
  ON_TRIP: { label: 'On Trip', className: 'badge-info' },
  IN_SHOP: { label: 'In Shop', className: 'badge-warning' },
  RETIRED: { label: 'Retired', className: 'badge-danger' },
  // Driver
  OFF_DUTY: { label: 'Off Duty', className: 'badge-warning' },
  SUSPENDED: { label: 'Suspended', className: 'badge-danger' },
  ARCHIVED: { label: 'Archived', className: 'badge-neutral' },
  // Trip
  DRAFT: { label: 'Draft', className: 'badge-warning' },
  DISPATCHED: { label: 'Dispatched', className: 'badge-info' },
  COMPLETED: { label: 'Completed', className: 'badge-success' },
  CANCELLED: { label: 'Cancelled', className: 'badge-danger' },
  // Maintenance
  OPEN: { label: 'Open', className: 'badge-warning' },
  CLOSED: { label: 'Closed', className: 'badge-success' },
};

export default function StatusBadge({ status, className: extraClass }) {
  const config = statusConfig[status] || { label: status, className: 'badge-info' };

  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium',
        config.className,
        extraClass
      )}
    >
      {config.label}
    </span>
  );
}
