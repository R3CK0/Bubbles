import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAction, useApi, usePersons, useVault } from "../api/hooks";
import { api } from "../api/client";
import type { Settings, TaxEstimate, TaxProfile } from "../api/types";
import { Card, Field, Modal, Spinner } from "../components/ui";
import { HouseholdIncomeEditor } from "../components/HouseholdIncomeEditor";
import { fmt } from "../lib/format";
import { extraGrossAnnual, extraNetAnnual, parseExtra } from "../lib/tax";
import { useUi } from "../stores/ui";

const YEAR = new Date().getFullYear();

/**
 * Monthly after-tax income the budget runs on — same math as the wizard's
 * breakdown and the backend derivation: weekly take-home (else the bracket
 * estimate's job net), plus extra income net at the marginal rate.
 */
function monthlyAfterTax(profile: TaxProfile | undefined, est: TaxEstimate["perPerson"][number] | undefined): number {
  if (!profile) return 0;
  const extra = parseExtra(profile.other_income_json);
  const marginal = est?.marginalRate ?? 0;
  const extraNetA = extraNetAnnual(extra, marginal);
  const weekly = profile.weekly_take_home ?? 0;
  const jobNetA = est
    ? est.totalIncome - est.totalIncomeTax - est.payroll.total - extraNetA
    : (profile.employment_income ?? 0);
  const baseM = weekly > 0 ? (weekly * 52) / 12 : jobNetA / 12;
  return baseM + extraNetA / 12;
}

export function SettingsPage() {
  const nav = useNavigate();
  const ui = useUi();
  const vault = useVault();
  const persons = usePersons();
  const settings = useApi<{ settings: Settings }>(["settings"], "/api/settings");
  const profiles = useApi<{ profiles: TaxProfile[] }>(["tax.profiles", YEAR], `/api/tax/profile?year=${YEAR}`);
  const estimate = useApi<TaxEstimate>(["tax.estimate", "combined", YEAR], `/api/tax/estimate?year=${YEAR}`);
  const [incomeOpen, setIncomeOpen] = useState(false);
  const [bufferFloor, setBufferFloor] = useState("");
  const [bufferTarget, setBufferTarget] = useState("");
  const [nightlyResult, setNightlyResult] = useState<string | null>(null);
  const [newPerson, setNewPerson] = useState("");

  useEffect(() => {
    const s = settings.data?.settings;
    if (s) {
      setBufferFloor(s.buffer_floor ?? "");
      setBufferTarget(s.buffer_target ?? "");
    }
  }, [settings.data]);

  const save = useAction(
    () => api("/api/settings", { method: "PUT", json: { buffer_floor: Number(bufferFloor) || 0, buffer_target: Number(bufferTarget) || 0 } }),
    [""],
  );
  const runNightly = useAction(async () => {
    const r = await api<Record<string, unknown>>("/api/jobs/nightly/run", { method: "POST", json: {} });
    setNightlyResult(JSON.stringify(r, null, 2));
    return r;
  }, [""]);
  const addPerson = useAction(
    (name: string) => api("/api/persons", { method: "POST", json: { personId: name.toLowerCase().replace(/[^a-z0-9]+/g, "-"), displayName: name } }),
    ["persons"],
  );

  return (
    <div className="page col" style={{ gap: 20, maxWidth: 760 }}>
      <div className="h1">Settings</div>

      <Card>
        <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 14 }}>Household numbers</div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
          <Field label="Buffer floor" hint="the bills ribbon glows amber below this">
            <input className="input num" type="number" min={0} value={bufferFloor} onChange={(e) => setBufferFloor(e.target.value)} />
          </Field>
          <Field label="Buffer target" hint="the solver funds this cushion before goals">
            <input className="input num" type="number" min={0} value={bufferTarget} onChange={(e) => setBufferTarget(e.target.value)} />
          </Field>
        </div>
        <div className="row" style={{ marginTop: 14, gap: 10 }}>
          <button className="btn" onClick={() => save.mutate()}>{save.isSuccess ? "✓ Saved" : "Save"}</button>
          <span className="muted" style={{ fontSize: 11.5 }}>base currency: {settings.data?.settings.base_currency ?? "CAD"}</span>
        </div>
      </Card>

      <Card>
        <div className="spread" style={{ marginBottom: 4 }}>
          <div style={{ fontSize: 14, fontWeight: 600 }}>Household income · {YEAR}</div>
          <button className="btn" onClick={() => setIncomeOpen(true)}>Edit household income</button>
        </div>
        <div className="muted" style={{ fontSize: 12, marginBottom: 14, lineHeight: 1.5 }}>
          Salaries, weekly take-home, and extra income types (rental, interest, dividends, capital gains) — the same step as the setup wizard, with the live bracket breakdown. The budget's income line derives from these: weekly take-home plus extra income after tax at each person's marginal rate.
        </div>
        <div className="col" style={{ gap: 10 }}>
          {!profiles.data && <Spinner />}
          {profiles.data && (persons.data?.persons ?? []).map((p) => {
            const profile = profiles.data.profiles.find((x) => x.person_id === p.person_id);
            const est = estimate.data?.perPerson.find((x) => x.personId === p.person_id);
            const extra = parseExtra(profile?.other_income_json);
            const extraGross = extraGrossAnnual(extra);
            const total = monthlyAfterTax(profile, est);
            return (
              <div key={p.person_id} className="panel spread" style={{ padding: "10px 14px", flexWrap: "wrap", gap: 8 }}>
                <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
                  <span style={{ fontSize: 13, fontWeight: 600, minWidth: 90 }}>{p.display_name}</span>
                  {profile?.employment_income ? <span className="chip">salary <b className="num">{fmt(profile.employment_income)}</b>/yr</span> : <span className="chip muted">no income set</span>}
                  {profile?.weekly_take_home ? <span className="chip">take-home <b className="num">{fmt(profile.weekly_take_home)}</b>/wk</span> : null}
                  {extraGross > 0 && <span className="chip">extra <b className="num">{fmt(extraGross)}</b>/yr</span>}
                </div>
                <div className="num" style={{ fontSize: 13, fontWeight: 600, color: "var(--accent)" }} title="after-tax monthly income the budget uses: take-home + extra income net at the marginal rate">
                  {total > 0 ? `${fmt(total)}/mo` : "—"}
                </div>
              </div>
            );
          })}
          {profiles.data && (persons.data?.persons.length ?? 0) > 0 && (
            <div className="spread" style={{ padding: "4px 14px 0" }}>
              <span className="muted" style={{ fontSize: 12 }}>Household total — the budget's income line</span>
              <b className="num" style={{ fontSize: 14, color: "var(--accent)" }}>
                {fmt((persons.data?.persons ?? []).reduce((t, p) => t + monthlyAfterTax(
                  profiles.data.profiles.find((x) => x.person_id === p.person_id),
                  estimate.data?.perPerson.find((x) => x.personId === p.person_id),
                ), 0))}/mo
              </b>
            </div>
          )}
          {profiles.data && (persons.data?.persons.length ?? 0) === 0 && <div className="empty">Add household members below first.</div>}
        </div>
      </Card>

      <Card>
        <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 12 }}>Household members</div>
        <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
          {(persons.data?.persons ?? []).map((p) => (
            <span key={p.person_id} className="chip chip-accent" style={{ fontSize: 12.5, padding: "6px 12px" }}>{p.display_name}</span>
          ))}
          <input className="input" style={{ width: 160 }} placeholder="Add member…" value={newPerson}
            onChange={(e) => setNewPerson(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && newPerson.trim()) { addPerson.mutate(newPerson.trim()); setNewPerson(""); } }} />
        </div>
      </Card>

      <Card>
        <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 12 }}>Data & jobs</div>
        <div className="row" style={{ gap: 10, flexWrap: "wrap" }}>
          <button className="btn-ghost" disabled={runNightly.isPending} onClick={() => runNightly.mutate()}>
            {runNightly.isPending ? <Spinner /> : "▶"} Run nightly pipeline now
          </button>
          <span className="chip" style={{ padding: "6px 12px" }}>
            vault {vault.data?.unlocked ? <b style={{ color: "var(--accent)" }}>unlocked</b> : <b style={{ color: "var(--warn)" }}>locked</b>}
          </span>
          <button className="btn-ghost" onClick={() => { localStorage.removeItem("bubbles.onboarded"); nav("/onboarding"); }}>Re-run setup wizard</button>
          <button className="btn-ghost" onClick={ui.toggleTheme}>Theme: {ui.theme}</button>
        </div>
        {nightlyResult && (
          <pre className="panel" style={{ marginTop: 12, padding: 12, fontSize: 11, overflow: "auto", maxHeight: 240 }}>{nightlyResult}</pre>
        )}
      </Card>

      <Card>
        <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 8 }}>Keyboard</div>
        <div className="muted" style={{ fontSize: 12.5, lineHeight: 1.8 }}>
          <b>[</b> / <b>]</b> switch person lens · <b>,</b> / <b>.</b> step month · <b>← →</b> advance review slides · <b>Esc</b> close dialogs
        </div>
      </Card>

      {incomeOpen && (
        <Modal title={`Household income · ${YEAR}`} onClose={() => setIncomeOpen(false)} width={680}>
          <HouseholdIncomeEditor submitLabel="Save income" onDone={() => setIncomeOpen(false)} />
        </Modal>
      )}
    </div>
  );
}
