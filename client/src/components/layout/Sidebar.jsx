import { NavLink, useLocation } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import { motion } from 'framer-motion';
import {
  LayoutDashboard, Truck, Users, Route, Wrench, Building2,
  Fuel, BarChart3, Settings, ChevronLeft, ChevronRight, X, UserCog, ScrollText, ClipboardList,
} from 'lucide-react';
import { cn } from '@/lib/utils';

const navItems = [
  { path: '/dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { path: '/my-trips', label: 'My Trips', icon: ClipboardList },
  { path: '/fleet', label: 'Fleet', icon: Truck },
  { path: '/drivers', label: 'Drivers', icon: Users },
  { path: '/trips', label: 'Trips', icon: Route },
  { path: '/customers', label: 'Customers', icon: Building2 },
  { path: '/maintenance', label: 'Maintenance', icon: Wrench },
  { path: '/fuel-expenses', label: 'Fuel & Expenses', icon: Fuel },
  { path: '/analytics', label: 'Analytics', icon: BarChart3 },
  { path: '/users', label: 'User Management', icon: UserCog },
  { path: '/audit', label: 'Audit Log', icon: ScrollText },
  { path: '/settings', label: 'Settings', icon: Settings },
];

export default function Sidebar({ collapsed, setCollapsed, mobileOpen, setMobileOpen }) {
  const { hasAccess } = useAuth();
  const location = useLocation();

  const filteredNav = navItems.filter((item) => hasAccess(item.path));

  return (
    <>
      {mobileOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/50 lg:hidden"
          onClick={() => setMobileOpen(false)}
        />
      )}

      <motion.aside
        initial={false}
        animate={{ width: collapsed ? 72 : 256 }}
        transition={{ duration: 0.2, ease: 'easeInOut' }}
        className={cn(
          'sidebar-gradient fixed left-0 top-0 z-50 flex h-screen flex-col border-r border-white/[0.06]',
          'lg:relative lg:translate-x-0',
          mobileOpen ? 'translate-x-0' : '-translate-x-full lg:translate-x-0'
        )}
      >
        <div className="flex h-16 items-center border-b border-white/[0.06] px-4">
          <div className="flex items-center gap-3 overflow-hidden">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-violet-400 to-purple-600">
              <Route className="h-5 w-5 text-white" />
            </div>
            {!collapsed && (
              <motion.span
                initial={{ opacity: 0, x: -10 }}
                animate={{ opacity: 1, x: 0 }}
                className="whitespace-nowrap text-lg font-bold tracking-tight text-white"
              >
                TransitOps
              </motion.span>
            )}
          </div>

          <button
            onClick={() => setMobileOpen(false)}
            aria-label="Close navigation"
            className="ml-auto p-1 text-white/60 hover:text-white lg:hidden"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <nav className="flex-1 space-y-1 overflow-y-auto px-3 py-4">
          {filteredNav.map((item) => {
            const isActive = location.pathname === item.path;
            const Icon = item.icon;

            return (
              <NavLink
                key={item.path}
                to={item.path}
                onClick={() => setMobileOpen(false)}
                title={collapsed ? item.label : undefined}
                className={cn(
                  'group relative flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-all duration-200',
                  isActive
                    ? 'bg-white/[0.1] text-white shadow-lg shadow-purple-500/10'
                    : 'text-white/60 hover:bg-white/[0.05] hover:text-white'
                )}
              >
                {isActive && (
                  <motion.div
                    layoutId="sidebar-indicator"
                    className="absolute left-0 top-1/2 h-5 w-[3px] -translate-y-1/2 rounded-r-full bg-violet-400"
                    transition={{ type: 'spring', stiffness: 400, damping: 30 }}
                  />
                )}
                <Icon
                  className={cn(
                    'h-5 w-5 shrink-0',
                    isActive ? 'text-violet-300' : 'text-white/50 group-hover:text-white/80'
                  )}
                />
                {!collapsed && (
                  <motion.span initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="whitespace-nowrap">
                    {item.label}
                  </motion.span>
                )}
              </NavLink>
            );
          })}
        </nav>

        <div className="hidden border-t border-white/[0.06] p-3 lg:flex">
          <button
            onClick={() => setCollapsed(!collapsed)}
            aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            className="flex w-full items-center justify-center rounded-lg py-2 text-white/40 transition-all duration-200 hover:bg-white/[0.05] hover:text-white"
          >
            {collapsed ? <ChevronRight className="h-4 w-4" /> : <ChevronLeft className="h-4 w-4" />}
          </button>
        </div>
      </motion.aside>
    </>
  );
}
