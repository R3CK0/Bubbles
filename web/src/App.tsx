import { createBrowserRouter, Navigate, RouterProvider } from "react-router-dom";
import { usePersons } from "./api/hooks";
import { Shell } from "./shell/Shell";
import { Overview } from "./pages/Overview";
import { CashFlow } from "./pages/CashFlow";
import { Transactions } from "./pages/Transactions";
import { AccountFlows } from "./pages/AccountFlows";
import { Budget } from "./pages/Budget";
import { Bills } from "./pages/Bills";
import { Goals } from "./pages/Goals";
import { DebtShortTermPage } from "./pages/DebtShortTerm";
import { DebtLongTermPage } from "./pages/DebtLongTerm";
import { Investments } from "./pages/Investments";
import { NetWorth } from "./pages/NetWorth";
import { Taxes } from "./pages/Taxes";
import { Review } from "./pages/Review";
import { Accounts } from "./pages/Accounts";
import { SettingsPage } from "./pages/Settings";
import { Help } from "./pages/Help";
import { Onboarding } from "./onboarding/Onboarding";

export function onboarded(): boolean {
  return localStorage.getItem("bubbles.onboarded") === "1";
}

function Gate({ children }: { children: JSX.Element }) {
  const persons = usePersons();
  if (!onboarded()) return <Navigate to="/onboarding" replace />;
  // a clean database has no household yet — setup is not skippable then
  if (persons.data && persons.data.persons.length === 0) return <Navigate to="/onboarding" replace />;
  return children;
}

const router = createBrowserRouter([
  { path: "/onboarding", element: <Onboarding /> },
  {
    path: "/",
    element: (
      <Gate>
        <Shell />
      </Gate>
    ),
    children: [
      { index: true, element: <Overview /> },
      { path: "cashflow", element: <CashFlow /> },
      { path: "transactions", element: <Transactions /> },
      { path: "flows", element: <AccountFlows /> },
      { path: "budget", element: <Budget /> },
      { path: "bills", element: <Bills /> },
      { path: "goals", element: <Goals /> },
      { path: "debt", element: <Navigate to="/debt/short-term" replace /> },
      { path: "debt/short-term", element: <DebtShortTermPage /> },
      { path: "debt/long-term", element: <DebtLongTermPage /> },
      { path: "investments", element: <Investments /> },
      { path: "networth", element: <NetWorth /> },
      { path: "taxes", element: <Taxes /> },
      { path: "review", element: <Review /> },
      { path: "accounts", element: <Accounts /> },
      { path: "settings", element: <SettingsPage /> },
      { path: "help", element: <Help /> },
      { path: "*", element: <Navigate to="/" replace /> },
    ],
  },
]);

export function App() {
  return <RouterProvider router={router} />;
}
