import { useEffect, useMemo, useState } from "react";
import { NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import { useAlerts, useAction, useCtx, useOverview, usePersons, useVault } from "../api/hooks";
import { api } from "../api/client";
import { useUi, COMBINED, shiftMonth } from "../stores/ui";
import { monthLabel, monthShort } from "../lib/format";

interface NavItem { to: string; name: string; icon: string }
interface NavGroup { label: string | null; items: NavItem[] }

const NAV_GROUPS: NavGroup[] = [
  {
    label: null,
    items: [{ to: "/", name: "Overview", icon: "M3 12l9-9 9 9M5 10v10h5v-6h4v6h5V10" }],
  },
  {
    label: "Spending",
    items: [
      { to: "/cashflow", name: "Cash Flow", icon: "M3 6h13M3 12h9M3 18h13M19 4v6M16 7l3-3 3 3M19 20v-6M16 17l3 3 3-3" },
      { to: "/transactions", name: "Transactions", icon: "M4 6h16M4 12h16M4 18h10M18 16l3 3-3 3" },
      { to: "/budget", name: "Budget", icon: "M4 5h16v4H4zM4 12h10v4H4zM4 19h7" },
      { to: "/bills", name: "Bills", icon: "M8 2v4M16 2v4M3 8h18M5 4h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z" },
      { to: "/flows", name: "Account Flows", icon: "M17 8H3M13 4l4 4-4 4M7 16h14M11 12l-4 4 4 4" },
    ],
  },
  {
    label: "Debt",
    items: [
      { to: "/debt/short-term", name: "Short-Term", icon: "M2 8h20v11a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1zM2 8V6a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v2M2 12h20" },
      { to: "/debt/long-term", name: "Long-Term", icon: "M3 18l5-6 4 3 6-8 3 4M3 22h18" },
    ],
  },
  {
    label: "Wealth",
    items: [
      { to: "/goals", name: "Goals", icon: "M12 22a10 10 0 1 1 0-20 10 10 0 0 1 0 20zM12 17a5 5 0 1 1 0-10 5 5 0 0 1 0 10zM12 13a1 1 0 1 1 0-2" },
      { to: "/investments", name: "Investments", icon: "M3 20V10M9 20V4M15 20v-9M21 20V7" },
      { to: "/networth", name: "Net Worth", icon: "M3 12h18M6 12V6a6 6 0 0 1 12 0v6M6 12v5a6 6 0 0 0 12 0v-5" },
      { to: "/taxes", name: "Taxes", icon: "M9 14l6-6M9.5 8.5h.01M14.5 13.5h.01M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z" },
    ],
  },
  {
    label: "Insights",
    items: [{ to: "/review", name: "Review", icon: "M4 4h16v12H4zM8 20h8M12 16v4" }],
  },
];

function NavRow({ to, name, icon, open }: { to: string; name: string; icon: string; open: boolean }) {
  return (
    <NavLink to={to} end={to === "/"} title={name} style={{ textDecoration: "none" }}>
      {({ isActive }) => (
        <div className="row" style={{
          height: 42, padding: "0 12px", borderRadius: 12, cursor: "pointer", gap: 12,
          color: isActive ? "var(--ink)" : "var(--ink-muted)",
          background: isActive ? "var(--surface-2)" : "transparent",
          boxShadow: isActive ? "inset 3px 0 0 var(--accent)" : "none",
          transition: "color .2s, background .2s",
        }}>
          <svg width={19} height={19} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" style={{ flex: "none" }}>
            <path d={icon} />
          </svg>
          {open && <span style={{ fontSize: 13.5, fontWeight: 500, whiteSpace: "nowrap", overflow: "hidden" }}>{name}</span>}
        </div>
      )}
    </NavLink>
  );
}

export function Shell() {
  const ui = useUi();
  const { lens, month } = useCtx();
  const persons = usePersons();
  const vault = useVault();
  const overview = useOverview();
  const alerts = useAlerts();
  const nav = useNavigate();
  const loc = useLocation();
  const [bellOpen, setBellOpen] = useState(false);
  const [stripOpen, setStripOpen] = useState(false);

  useEffect(() => {
    document.documentElement.dataset.theme = ui.theme;
  }, [ui.theme]);

  // keyboard: [ ] lens · , . month
  useEffect(() => {
    const lensKeys = [COMBINED, ...(persons.data?.persons.map((p) => p.person_id) ?? [])];
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      if (e.key === ",") ui.stepMonth(-1);
      else if (e.key === ".") ui.stepMonth(1);
      else if (e.key === "[" || e.key === "]") {
        const i = lensKeys.indexOf(lens);
        const next = lensKeys[(i + (e.key === "]" ? 1 : lensKeys.length - 1)) % lensKeys.length];
        ui.setLens(next);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [lens, persons.data, ui]);

  const ack = useAction((alertId: string) => api(`/api/alerts/${alertId}/ack`, { method: "POST", json: {} }), ["alerts", "overview"]);

  const lastSync = overview.data?.lastSync ?? null;
  const syncFresh = lastSync ? Date.now() - new Date(lastSync).getTime() < 24 * 3600_000 : false;
  const vaultLocked = vault.data ? !vault.data.unlocked : false;
  const openAlerts = alerts.data?.alerts ?? [];
  const months = useMemo(() => Array.from({ length: 12 }, (_, i) => shiftMonth(month, i - 11)), [month]);
  const uncat = overview.data?.uncategorized ?? 0;

  return (
    <div style={{ display: "flex", minHeight: "100vh", position: "relative", overflow: "hidden" }}>
      <div style={{ position: "fixed", inset: 0, zIndex: 0, pointerEvents: "none", opacity: loc.pathname === "/" ? 1 : 0.4, background: "radial-gradient(52% 46% at 28% 16%, var(--accent-soft), transparent 70%)", animation: "bb-drift 120s ease-in-out infinite" }} />

      <aside style={{ position: "relative", zIndex: 2, flex: "none", width: ui.sidebarOpen ? 224 : 64, transition: "width .28s cubic-bezier(.4,0,.2,1)", background: "var(--surface)", borderRight: "1px solid var(--line)", display: "flex", flexDirection: "column", padding: "18px 12px", gap: 4, height: "100vh", overflowY: "auto" }}>
        <div className="row" style={{ padding: "4px 8px 16px", gap: 11 }}>
          <div style={{ flex: "none", width: 30, height: 30, borderRadius: "50%", background: "var(--accent)", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--bg)", fontWeight: 700, fontSize: 15 }}>b</div>
          {ui.sidebarOpen && <div style={{ fontWeight: 700, fontSize: 15, letterSpacing: "-.01em" }}>Bubbles</div>}
        </div>
        <nav className="col" style={{ gap: 2 }}>
          {NAV_GROUPS.map((g, gi) => (
            <div key={g.label ?? gi} className="col" style={{ gap: 2 }}>
              {gi > 0 && (
                ui.sidebarOpen && g.label
                  ? <div className="label" style={{ padding: "14px 12px 5px", fontSize: 10.5 }}>{g.label}</div>
                  : <div style={{ margin: "8px 10px", borderTop: "1px solid var(--line)" }} />
              )}
              {g.items.map((n) => <NavRow key={n.to} {...n} open={ui.sidebarOpen} />)}
            </div>
          ))}
        </nav>
        <div style={{ flex: 1 }} />
        <NavRow to="/help" name="Help" icon="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20M9.1 9a3 3 0 0 1 5.8 1c0 2-3 2.6-3 4M12 17h.01" open={ui.sidebarOpen} />
        <NavRow to="/accounts" name="Accounts" icon="M3 9l9-5 9 5M4 9v10h16V9M8 12v5M12 12v5M16 12v5" open={ui.sidebarOpen} />
        <NavRow to="/settings" name="Settings" icon="M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.6 1.6 0 0 0 .3 1.8 2 2 0 1 1-2.9 2.7 1.6 1.6 0 0 0-2.7 1.1V21a2 2 0 1 1-4 0v-.1a1.6 1.6 0 0 0-2.7-1 2 2 0 1 1-2.8-2.9 1.6 1.6 0 0 0-1-2.7H3a2 2 0 1 1 0-4h.1a1.6 1.6 0 0 0 1-2.7 2 2 0 1 1 2.9-2.8 1.6 1.6 0 0 0 2.7-1V3a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 2.7 1 2 2 0 1 1 2.8 2.9 1.6 1.6 0 0 0 1 2.7h.1a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1z" open={ui.sidebarOpen} />
        <div className="row hoverable" style={{ height: 38, padding: "0 12px", cursor: "pointer", color: "var(--ink-muted)", gap: 12 }} onClick={ui.toggleSidebar}>
          <svg width={19} height={19} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" style={{ flex: "none" }}><path d="M4 6h16M4 12h16M4 18h16" /></svg>
          {ui.sidebarOpen && <span style={{ fontSize: 13 }}>Collapse</span>}
        </div>
      </aside>

      <main style={{ position: "relative", zIndex: 1, flex: 1, minWidth: 0, display: "flex", flexDirection: "column", height: "100vh", overflow: "hidden" }}>
        <header style={{ flex: "none", position: "relative", display: "flex", alignItems: "center", gap: 12, padding: "12px 24px", borderBottom: "1px solid var(--line)" }}>
          <div className="seg">
            {[{ key: COMBINED, label: "Both" }, ...(persons.data?.persons ?? []).map((p) => ({ key: p.person_id, label: p.display_name }))].map((l) => (
              <div key={l.key} className={`seg-item ${lens === l.key ? "on" : ""}`} onClick={() => ui.setLens(l.key)}>{l.label}</div>
            ))}
          </div>
          <div className="seg" style={{ alignItems: "center" }}>
            <div className="seg-item" style={{ padding: "6px 9px" }} onClick={() => ui.stepMonth(-1)}>‹</div>
            <div className="seg-item num" style={{ minWidth: 82, textAlign: "center" }} onClick={() => setStripOpen((s) => !s)}>{monthLabel(month)}</div>
            <div className="seg-item" style={{ padding: "6px 9px" }} onClick={() => ui.stepMonth(1)}>›</div>
          </div>
          <div style={{ flex: 1 }} />
          {uncat > 0 && (
            <div className="btn-ghost" onClick={() => nav("/budget?tab=inbox")}>
              <span className="dot" style={{ background: "var(--warn)", width: 7, height: 7 }} />
              {uncat} to categorize
            </div>
          )}
          <div className="row btn-ghost" title={lastSync ? `Last sync ${new Date(lastSync).toLocaleString()}` : "Never synced"} style={{ cursor: "default", gap: 7 }}>
            <span className="dot" style={{ background: vaultLocked ? "var(--ink-muted)" : syncFresh ? "var(--accent)" : "var(--warn)", animation: "bb-breathe 3s ease-in-out infinite" }} />
            <span>{lastSync ? (syncFresh ? "Synced" : "Stale") : "No sync"}</span>
          </div>
          <div style={{ position: "relative" }}>
            <div className="btn-ghost" style={{ padding: 8 }} onClick={() => setBellOpen((s) => !s)}>
              <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round"><path d="M6 8a6 6 0 0 1 12 0c0 7 3 8 3 8H3s3-1 3-8M10 21a2 2 0 0 0 4 0" /></svg>
              {openAlerts.length > 0 && (
                <span style={{ position: "absolute", top: -5, right: -5, minWidth: 16, height: 16, padding: "0 4px", borderRadius: 8, background: "var(--danger)", color: "#fff", fontSize: 10, fontWeight: 700, display: "flex", alignItems: "center", justifyContent: "center", animation: "bb-pop .4s cubic-bezier(.5,1.6,.5,1)" }}>{openAlerts.length}</span>
              )}
            </div>
            {bellOpen && (
              <div className="card" style={{ position: "absolute", top: 42, right: 0, zIndex: 40, width: 320, padding: 8, animation: "bb-popin .16s ease-out" }}>
                <div className="label" style={{ padding: "8px 10px 6px" }}>Alerts</div>
                {openAlerts.length === 0 && <div className="empty">All caught up</div>}
                {openAlerts.map((a) => (
                  <div key={a.alert_id} className="row hoverable" style={{ gap: 10, padding: 10, alignItems: "flex-start" }}>
                    <span className="dot" style={{ marginTop: 4, background: a.severity === "critical" ? "var(--danger)" : a.severity === "warning" ? "var(--warn)" : "var(--accent)" }} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 12.5, fontWeight: 600 }}>{a.title}</div>
                      {a.body && <div className="muted" style={{ fontSize: 11.5, marginTop: 2, lineHeight: 1.4 }}>{a.body}</div>}
                    </div>
                    <div style={{ cursor: "pointer", color: "var(--ink-muted)" }} onClick={() => ack.mutate(a.alert_id)}>×</div>
                  </div>
                ))}
              </div>
            )}
          </div>
          <div className="btn-ghost" style={{ padding: 8, fontSize: 14 }} onClick={ui.toggleTheme}>{ui.theme === "dark" ? "☾" : "☀"}</div>
          {stripOpen && (
            <div className="card" style={{ position: "absolute", top: 58, left: 24, right: 24, zIndex: 30, padding: 12, display: "flex", gap: 6 }}>
              {months.map((m) => (
                <div key={m} className="num" onClick={() => { ui.setMonth(m); setStripOpen(false); }}
                  style={{ flex: 1, textAlign: "center", padding: "10px 4px", borderRadius: 9, fontSize: 12, fontWeight: 600, cursor: "pointer", background: m === month ? "var(--accent)" : "var(--surface-2)", color: m === month ? "var(--bg)" : "var(--ink-muted)" }}>
                  {monthShort(m)}
                </div>
              ))}
            </div>
          )}
        </header>

        {vaultLocked && (
          <div className="row" style={{ flex: "none", gap: 10, padding: "10px 24px", background: "rgba(245,176,76,0.12)", borderBottom: "1px solid rgba(245,176,76,0.28)", color: "var(--warn)", fontSize: 12.5, fontWeight: 600 }}>
            <svg width={15} height={15} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.9} strokeLinecap="round"><rect x={4} y={11} width={16} height={9} rx={2} /><path d="M8 11V7a4 4 0 0 1 8 0v4" /></svg>
            Bank connection locked — unlock the vault on the server to sync. Dashboards stay live from local data.
          </div>
        )}

        <div style={{ flex: 1, overflowY: "auto", overflowX: "hidden" }} onClick={() => { setBellOpen(false); setStripOpen(false); }}>
          <Outlet />
        </div>
      </main>
    </div>
  );
}
