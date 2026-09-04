import { BrowserRouter as Router, Routes, Route, Navigate } from "react-router-dom";
import { ThemeProvider } from "./contexts/ThemeContext";
import { ToastProvider } from "./components/ui/toast.jsx";
import { AuthProvider } from "./contexts/AuthContext";
import { DataProvider } from "./contexts/DataContext";
import { TooltipProvider } from "@/components/ui/tooltip";
import AppLayout from "./components/layout/AppLayout";
import ProtectedRoute from "./components/layout/ProtectedRoute";
import ErrorBoundary from "./components/layout/ErrorBoundary";
import Login from "./pages/Login";
import Dashboard from "./pages/Dashboard";
import Fleet from "./pages/Fleet";
import Drivers from "./pages/Drivers";
import Trips from "./pages/Trips";
import Customers from "./pages/Customers";
import Maintenance from "./pages/Maintenance";
import FuelExpenses from "./pages/FuelExpenses";
import Analytics from "./pages/Analytics";
import Copilot from "./pages/Copilot";
import Settings from "./pages/Settings";
import Users from "./pages/Users";
import AuditLog from "./pages/AuditLog";
import MyTrips from "./pages/MyTrips";

function App() {
  return (
    <ErrorBoundary>
      <ThemeProvider>
        {/* ToastProvider sits above Auth/Data so both can raise toasts. */}
        <ToastProvider>
          <AuthProvider>
            <DataProvider>
              <TooltipProvider delayDuration={200}>
                <Router>
                  <Routes>
                    {/* Public */}
                    <Route path="/login" element={<Login />} />

                    {/*
                      The layout route already enforces auth and per-path access,
                      so the children no longer repeat a redundant ProtectedRoute.
                    */}
                    <Route
                      element={
                        <ProtectedRoute>
                          <AppLayout />
                        </ProtectedRoute>
                      }
                    >
                      <Route path="/dashboard" element={<Dashboard />} />
                      <Route path="/fleet" element={<Fleet />} />
                      <Route path="/drivers" element={<Drivers />} />
                      <Route path="/trips" element={<Trips />} />
                      <Route path="/customers" element={<Customers />} />
                      <Route path="/maintenance" element={<Maintenance />} />
                      <Route path="/fuel-expenses" element={<FuelExpenses />} />
                      <Route path="/analytics" element={<Analytics />} />
                      <Route path="/copilot" element={<Copilot />} />
                      <Route path="/users" element={<Users />} />
                      <Route path="/audit" element={<AuditLog />} />
                      {/* ISSUES #37 — driver self-service */}
                      <Route path="/my-trips" element={<MyTrips />} />
                      <Route path="/settings" element={<Settings />} />
                    </Route>

                    <Route path="/" element={<Navigate to="/dashboard" replace />} />
                    <Route path="*" element={<Navigate to="/dashboard" replace />} />
                  </Routes>
                </Router>
              </TooltipProvider>
            </DataProvider>
          </AuthProvider>
        </ToastProvider>
      </ThemeProvider>
    </ErrorBoundary>
  );
}

export default App;
