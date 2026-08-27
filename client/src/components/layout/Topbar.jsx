import { useState, useMemo, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { Search, Bell, Menu, LogOut, User, Sun, Moon, Truck, Users as UsersIcon, Route, X } from 'lucide-react';

import { useAuth } from '../../contexts/AuthContext';
import { useTheme } from '../../contexts/ThemeContext';
import { useData } from '../../contexts/DataContext';
import { useToast } from '../../hooks/useToast.js';
import * as dashboardApi from '../../api/dashboard.js';
import { Badge } from '@/components/ui/badge';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';

const ROLE_BADGE = {
  ADMIN: 'bg-violet-100 text-violet-700 border-violet-200 dark:bg-violet-500/15 dark:text-violet-300 dark:border-violet-500/30',
  FLEET_MANAGER: 'bg-violet-100 text-violet-700 border-violet-200 dark:bg-violet-500/15 dark:text-violet-300 dark:border-violet-500/30',
  DISPATCHER: 'bg-blue-100 text-blue-700 border-blue-200 dark:bg-blue-500/15 dark:text-blue-300 dark:border-blue-500/30',
  SAFETY_OFFICER: 'bg-emerald-100 text-emerald-700 border-emerald-200 dark:bg-emerald-500/15 dark:text-emerald-300 dark:border-emerald-500/30',
  FINANCIAL_ANALYST: 'bg-amber-100 text-amber-700 border-amber-200 dark:bg-amber-500/15 dark:text-amber-300 dark:border-amber-500/30',
  DRIVER: 'bg-teal-100 text-teal-700 border-teal-200 dark:bg-teal-500/15 dark:text-teal-300 dark:border-teal-500/30',
};

export default function Topbar({ onMenuToggle }) {
  const { user, logout, can } = useAuth();
  const { vehicles, drivers, trips } = useData();
  const { theme, toggleTheme } = useTheme();
  const navigate = useNavigate();
  const toast = useToast();

  const [query, setQuery] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const [alerts, setAlerts] = useState(null);
  const searchRef = useRef(null);

  /**
   * ISSUES #26 — the search box used to hold state and filter nothing, while
   * promising "Search vehicles, drivers, trips…". It now actually searches them.
   */
  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (q.length < 2) return [];

    const matches = [];

    if (can('vehicle:read')) {
      for (const v of vehicles) {
        if (
          v.registrationNo?.toLowerCase().includes(q) ||
          v.name?.toLowerCase().includes(q)
        ) {
          matches.push({
            type: 'Vehicle',
            icon: Truck,
            label: v.registrationNo,
            sublabel: v.name,
            to: '/fleet',
          });
        }
      }
    }

    if (can('driver:read')) {
      for (const d of drivers) {
        if (
          d.name?.toLowerCase().includes(q) ||
          d.licenseNumber?.toLowerCase().includes(q) ||
          d.email?.toLowerCase().includes(q)
        ) {
          matches.push({
            type: 'Driver',
            icon: UsersIcon,
            label: d.name,
            sublabel: d.licenseNumber,
            to: '/drivers',
          });
        }
      }
    }

    if (can('trip:read')) {
      for (const t of trips) {
        if (
          t.source?.toLowerCase().includes(q) ||
          t.destination?.toLowerCase().includes(q)
        ) {
          matches.push({
            type: 'Trip',
            icon: Route,
            label: `${t.source} → ${t.destination}`,
            sublabel: t.status,
            to: '/trips',
          });
        }
      }
    }

    return matches.slice(0, 8);
  }, [query, vehicles, drivers, trips, can]);

  /** ISSUES #26 — the bell had a permanently lit dot and no handler. */
  useEffect(() => {
    let cancelled = false;
    dashboardApi
      .getAlerts()
      .then(({ data }) => {
        if (!cancelled) setAlerts(data.data);
      })
      .catch(() => {
        if (!cancelled) setAlerts(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Close the search dropdown on outside click.
  useEffect(() => {
    function onClickOutside(event) {
      if (searchRef.current && !searchRef.current.contains(event.target)) {
        setSearchOpen(false);
      }
    }
    document.addEventListener('mousedown', onClickOutside);
    return () => document.removeEventListener('mousedown', onClickOutside);
  }, []);

  const alertCount = alerts?.total ?? 0;

  const handleLogout = async () => {
    await logout();
    navigate('/login');
  };

  const showAlerts = () => {
    if (!alerts || alertCount === 0) {
      toast.info('Nothing needs attention', {
        description: 'No expiring licences, compliance issues or overdue trips.',
      });
      return;
    }

    const lines = [];
    if (alerts.expiredInsurance.length) lines.push(`${alerts.expiredInsurance.length} vehicle(s) with expired insurance`);
    if (alerts.expiredPuc.length) lines.push(`${alerts.expiredPuc.length} vehicle(s) with expired PUC`);
    if (alerts.expiringLicenses.length) lines.push(`${alerts.expiringLicenses.length} licence(s) expiring within 30 days`);
    if (alerts.dueForService.length) lines.push(`${alerts.dueForService.length} vehicle(s) due for service`);
    if (alerts.overdueTrips.length) lines.push(`${alerts.overdueTrips.length} trip(s) past their planned end`);

    toast.warning(`${alertCount} item(s) need attention`, {
      description: lines.join(' · '),
      duration: 10000,
    });
  };

  return (
    <header className="sticky top-0 z-30 flex h-16 items-center justify-between border-b border-border bg-card px-4 transition-colors duration-200 lg:px-6">
      <div className="flex items-center gap-4">
        <button
          onClick={onMenuToggle}
          aria-label="Open navigation"
          className="rounded-lg p-2 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground lg:hidden"
        >
          <Menu className="h-5 w-5" />
        </button>

        <div className="relative hidden sm:block" ref={searchRef}>
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground/60" />
          <input
            type="text"
            placeholder="Search vehicles, drivers, trips..."
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setSearchOpen(true);
            }}
            onFocus={() => setSearchOpen(true)}
            className="w-64 rounded-lg border border-border bg-background py-2 pl-10 pr-8 text-sm text-foreground transition-all placeholder:text-muted-foreground focus:border-ring focus:outline-none focus:ring-2 focus:ring-ring/20 lg:w-80"
          />
          {query && (
            <button
              onClick={() => {
                setQuery('');
                setSearchOpen(false);
              }}
              aria-label="Clear search"
              className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-muted-foreground/60 hover:text-foreground"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}

          {searchOpen && query.trim().length >= 2 && (
            <div className="absolute left-0 right-0 top-full mt-2 overflow-hidden rounded-lg border border-border bg-card shadow-lg">
              {results.length === 0 ? (
                <p className="px-4 py-3 text-sm text-muted-foreground">
                  No matches for “{query}”.
                </p>
              ) : (
                results.map((result, index) => {
                  const Icon = result.icon;
                  return (
                    <button
                      key={`${result.type}-${result.label}-${index}`}
                      onClick={() => {
                        navigate(result.to);
                        setSearchOpen(false);
                        setQuery('');
                      }}
                      className="flex w-full items-center gap-3 px-4 py-2.5 text-left transition-colors hover:bg-muted"
                    >
                      <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium text-foreground">
                          {result.label}
                        </span>
                        <span className="block truncate text-xs text-muted-foreground">
                          {result.type} · {result.sublabel}
                        </span>
                      </span>
                    </button>
                  );
                })
              )}
            </div>
          )}
        </div>
      </div>

      <div className="flex items-center gap-3">
        <button
          onClick={toggleTheme}
          aria-label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
          className="rounded-lg p-2 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          {theme === 'dark' ? <Sun className="h-5 w-5" /> : <Moon className="h-5 w-5" />}
        </button>

        <button
          onClick={showAlerts}
          aria-label={alertCount > 0 ? `${alertCount} alerts` : 'No alerts'}
          className="relative rounded-lg p-2 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <Bell className="h-5 w-5" />
          {/* Only lit when something actually needs attention. */}
          {alertCount > 0 && (
            <span className="absolute right-0.5 top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-[#E46E78] px-1 text-[10px] font-bold text-white">
              {alertCount > 9 ? '9+' : alertCount}
            </span>
          )}
        </button>

        <Badge
          variant="outline"
          className={cn(
            'hidden rounded-full px-2.5 py-0.5 text-xs font-medium md:inline-flex',
            ROLE_BADGE[user?.role] || 'border-border bg-muted/80 text-muted-foreground'
          )}
        >
          {user?.roleLabel}
        </Badge>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button className="flex items-center gap-2.5 rounded-lg py-1.5 pl-3 pr-2 transition-colors hover:bg-muted">
              <div className="flex h-8 w-8 items-center justify-center rounded-full bg-gradient-to-br from-[#714B67] to-[#5A3C52] text-xs font-semibold text-white">
                {user?.avatar || 'U'}
              </div>
              <span className="hidden text-sm font-medium text-muted-foreground lg:block">
                {user?.name || 'User'}
              </span>
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56 border-border bg-card">
            <div className="px-2 py-1.5">
              <p className="text-sm font-medium text-foreground">{user?.name}</p>
              <p className="text-xs text-muted-foreground">{user?.email}</p>
              <p className="mt-1 text-xs text-muted-foreground/70">{user?.roleLabel}</p>
            </div>
            <DropdownMenuSeparator />
            <DropdownMenuItem className="cursor-pointer gap-2" onClick={() => navigate('/settings')}>
              <User className="h-4 w-4" />
              Account settings
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onClick={handleLogout}
              className="cursor-pointer gap-2 text-red-600 focus:text-red-600"
            >
              <LogOut className="h-4 w-4" />
              Log out
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  );
}
