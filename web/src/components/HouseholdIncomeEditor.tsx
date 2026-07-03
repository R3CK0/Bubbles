import { useEffect, useState } from "react";
import { useApi, useInvalidate, usePersons } from "../api/hooks";
import { api } from "../api/client";
import type { TaxEstimate, TaxProfile } from "../api/types";
import { Field, Spinner } from "./ui";
import { fmt } from "../lib/format";
import { ExtraIncome, extraGrossAnnual, extraNetAnnual, parseExtra } from "../lib/tax";

const YEAR = new Date().getFullYear();

type PersonEstimate = TaxEstimate["perPerson"][number];

function PayBreakdown({ est, weekly, extra }: { est: PersonEstimate | undefined; weekly: number; extra: ExtraIncome }) {
  if (!est) return null;
  const m = (n: number) => n / 12;
  const extraGrossA = extraGrossAnnual(extra);
  const extraNetA = extraNetAnnual(extra, est.marginalRate);
  // the estimator's net covers ALL income; peel the extra income back out so
  // the paycheque comparison is job-only
  const jobNetM = m(est.totalIncome - est.totalIncomeTax - est.payroll.total - extraNetA);
  const actualM = weekly > 0 ? (weekly * 52) / 12 : null;
  const gapM = actualM !== null ? jobNetM - actualM : null;
  const totalM = (actualM ?? jobNetM) + m(extraNetA);
  return (
    <div className="panel col" style={{ padding: "12px 14px", gap: 6, fontSize: 12.5, animation: "bb-rowin .25s ease-out" }}>
      <div className="spread">
        <span className="muted">Income tax (brackets) <span style={{ fontSize: 11 }}>fed {fmt(m(est.federal.netTax))} · QC {fmt(m(est.quebec.netTax))}</span></span>
        <b className="num" style={{ color: "var(--danger)" }}>−{fmt(m(est.totalIncomeTax))}/mo</b>
      </div>
      <div className="spread">
        <span className="muted">Payroll <span style={{ fontSize: 11 }}>QPP {fmt(m(est.payroll.qpp))} · QPIP {fmt(m(est.payroll.qpip))} · EI {fmt(m(est.payroll.ei))}</span></span>
        <b className="num" style={{ color: "var(--danger)" }}>−{fmt(m(est.payroll.total))}/mo</b>
      </div>
      <div className="spread" style={{ paddingTop: 6, borderTop: "1px solid var(--line)" }}>
        <span>Estimated after-tax pay{extraGrossA > 0 ? " (job only)" : ""}</span>
        <b className="num" style={{ color: "var(--accent)" }}>{fmt(jobNetM)}/mo</b>
      </div>
      {actualM !== null && (
        <div className="spread">
          <span>Actual take-home (weekly × 52 ÷ 12)</span>
          <b className="num">{fmt(actualM)}/mo</b>
        </div>
      )}
      {gapM !== null && gapM > 15 && (
        <div className="spread" style={{ background: "color-mix(in srgb, var(--warn) 10%, transparent)", borderRadius: 8, padding: "7px 9px" }}>
          <span style={{ color: "var(--warn)", fontWeight: 600 }}>Other paycheque deductions <span className="muted" style={{ fontWeight: 400, fontSize: 11 }}>group/health insurance, pension, union dues…</span></span>
          <b className="num" style={{ color: "var(--warn)" }}>≈ {fmt(gapM)}/mo</b>
        </div>
      )}
      {gapM !== null && gapM < -15 && (
        <div className="muted" style={{ fontSize: 11.5, lineHeight: 1.5 }}>
          ⚠ You net <b className="num">{fmt(-gapM)}/mo</b> more than the brackets predict — the salary above may be missing bonuses, or the deposits include reimbursements.
        </div>
      )}
      {extraGrossA > 0 && (
        <>
          <div className="spread">
            <span className="muted">Extra income <span style={{ fontSize: 11 }}>{fmt(m(extraGrossA))}/mo gross, taxed at ~{Math.round(est.marginalRate * 100)}% marginal</span></span>
            <b className="num" style={{ color: "var(--accent)" }}>+{fmt(m(extraNetA))}/mo after tax</b>
          </div>
          <div className="spread" style={{ paddingTop: 6, borderTop: "1px solid var(--line)" }}>
            <span style={{ fontWeight: 600 }}>Total monthly, after tax</span>
            <b className="num" style={{ color: "var(--accent)" }}>{fmt(totalM)}/mo</b>
          </div>
        </>
      )}
    </div>
  );
}

interface IncomeRow {
  gross: string;
  weekly: string;
  extraOpen: boolean;
  rental: string;
  interest: string;
  dividends: string;
  gains: string;
}

const EMPTY_ROW: IncomeRow = { gross: "", weekly: "", extraOpen: false, rental: "", interest: "", dividends: "", gains: "" };

function rowExtra(v: IncomeRow | undefined): ExtraIncome {
  if (!v) return {};
  const n = (s: string) => (Number(s) > 0 ? Number(s) : undefined);
  return { rentalNet: n(v.rental), interest: n(v.interest), eligibleDividends: n(v.dividends), capitalGains: n(v.gains) };
}

const s = (n: number | null | undefined) => (n ? String(n) : "");

function toRow(profile: TaxProfile | undefined): IncomeRow {
  if (!profile) return EMPTY_ROW;
  const extra = parseExtra(profile.other_income_json);
  return {
    gross: s(profile.employment_income),
    weekly: s(profile.weekly_take_home),
    extraOpen: extraGrossAnnual(extra) > 0,
    rental: s(extra.rentalNet),
    interest: s(extra.interest),
    dividends: s(extra.eligibleDividends),
    gains: s(extra.capitalGains),
  };
}

/**
 * The income portion of the setup wizard, shared with Settings: per-person
 * gross salary, weekly take-home, and extra income types, with a live
 * bracket-estimate breakdown. Saves tax profiles (preserving withholding,
 * donations/medical, and carryforwards it doesn't edit).
 */
export function HouseholdIncomeEditor({ submitLabel, onDone }: { submitLabel: string; onDone: () => void }) {
  const persons = usePersons();
  const profiles = useApi<{ profiles: TaxProfile[] }>(["tax.profiles", YEAR], `/api/tax/profile?year=${YEAR}`);
  const [rows, setRows] = useState<Record<string, IncomeRow> | null>(null);
  const [estimate, setEstimate] = useState<TaxEstimate | null>(null);
  const [calculating, setCalculating] = useState(false);
  const [saving, setSaving] = useState(false);
  const invalidate = useInvalidate();

  // prefill from saved profiles once both queries land
  useEffect(() => {
    if (rows !== null || !profiles.data || !persons.data) return;
    const init: Record<string, IncomeRow> = {};
    for (const p of persons.data.persons) {
      init[p.person_id] = toRow(profiles.data.profiles.find((x) => x.person_id === p.person_id));
    }
    setRows(init);
    if (Object.values(init).some((v) => Number(v.gross) > 0)) {
      api<TaxEstimate>(`/api/tax/estimate?year=${YEAR}`).then(setEstimate).catch(() => {});
    }
  }, [rows, profiles.data, persons.data]);

  const saveProfiles = async () => {
    for (const p of persons.data?.persons ?? []) {
      const v = rows?.[p.person_id];
      if (!v) continue;
      const existing = profiles.data?.profiles.find((x) => x.person_id === p.person_id);
      if (!existing && !Number(v.gross) && !Number(v.weekly) && extraGrossAnnual(rowExtra(v)) === 0) continue;
      // merge fields this editor doesn't own so a save never erases them
      const saved = parseExtra(existing?.other_income_json);
      const extra: ExtraIncome = { ...rowExtra(v), donations: saved.donations, medicalExpenses: saved.medicalExpenses };
      await api("/api/tax/profile", {
        method: "PUT",
        json: {
          personId: p.person_id,
          taxYear: YEAR,
          employmentIncome: Number(v.gross) || 0,
          weeklyTakeHome: Number(v.weekly) > 0 ? Number(v.weekly) : null,
          withholdingPaid: existing?.withholding_paid ?? 0,
          otherIncome: extra,
          ...(existing?.carryforwards_json ? { carryforwards: JSON.parse(existing.carryforwards_json) } : {}),
        },
      });
    }
  };

  // live breakdown: debounce, push profiles, pull the bracket estimate
  useEffect(() => {
    if (!rows || !Object.values(rows).some((v) => Number(v.gross) > 0)) return;
    const t = setTimeout(async () => {
      setCalculating(true);
      try {
        await saveProfiles();
        setEstimate(await api<TaxEstimate>(`/api/tax/estimate?year=${YEAR}`));
      } catch {
        /* breakdown is best-effort while typing */
      } finally {
        setCalculating(false);
      }
    }, 700);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows]);

  const setField = (pid: string, field: keyof IncomeRow, value: string | boolean) =>
    setRows((prev) => ({ ...(prev ?? {}), [pid]: { ...(prev?.[pid] ?? EMPTY_ROW), [field]: value } }));

  if (!rows) return <div className="row" style={{ padding: 20, justifyContent: "center" }}><Spinner /></div>;

  return (
    <div className="col" style={{ gap: 18 }}>
      {calculating && <span className="muted row" style={{ fontSize: 11.5, gap: 6, alignSelf: "flex-end" }}><Spinner /> running the brackets…</span>}
      {(persons.data?.persons ?? []).map((p) => {
        const v = rows[p.person_id];
        return (
          <div key={p.person_id} className="col" style={{ gap: 10 }}>
            <div style={{ display: "grid", gridTemplateColumns: "120px 1fr 1fr", gap: 12, alignItems: "end" }}>
              <div style={{ fontSize: 14, fontWeight: 600, paddingBottom: 10 }}>{p.display_name}</div>
              <Field label="Gross salary / yr">
                <input className="input num" type="number" min={0} value={v?.gross ?? ""}
                  onChange={(e) => setField(p.person_id, "gross", e.target.value)} />
              </Field>
              <Field label="Weekly take-home (net deposit)">
                <input className="input num" type="number" min={0} value={v?.weekly ?? ""}
                  onChange={(e) => setField(p.person_id, "weekly", e.target.value)} />
              </Field>
            </div>
            {!v?.extraOpen ? (
              <span className="link" style={{ fontSize: 12, alignSelf: "flex-start" }} onClick={() => setField(p.person_id, "extraOpen", true)}>
                + Extra income (rental, interest, dividends, capital gains)
              </span>
            ) : (
              <div style={{ display: "grid", gridTemplateColumns: "120px 1fr 1fr 1fr 1fr", gap: 12, alignItems: "end" }}>
                <div className="muted" style={{ fontSize: 11.5, fontWeight: 600, paddingBottom: 10 }}>Extra / yr</div>
                <Field label="Rental (net)">
                  <input className="input num" type="number" min={0} value={v.rental} onChange={(e) => setField(p.person_id, "rental", e.target.value)} />
                </Field>
                <Field label="Interest">
                  <input className="input num" type="number" min={0} value={v.interest} onChange={(e) => setField(p.person_id, "interest", e.target.value)} />
                </Field>
                <Field label="Eligible dividends">
                  <input className="input num" type="number" min={0} value={v.dividends} onChange={(e) => setField(p.person_id, "dividends", e.target.value)} />
                </Field>
                <Field label="Capital gains">
                  <input className="input num" type="number" min={0} value={v.gains} onChange={(e) => setField(p.person_id, "gains", e.target.value)} />
                </Field>
              </div>
            )}
            {Number(v?.gross) > 0 && (
              <PayBreakdown est={estimate?.perPerson.find((x) => x.personId === p.person_id)} weekly={Number(v?.weekly) || 0} extra={rowExtra(v)} />
            )}
          </div>
        );
      })}
      <button className="btn" disabled={saving}
        onClick={async () => {
          setSaving(true);
          try {
            await saveProfiles();
            invalidate(["tax", "budget", "overview", "cashflow"]);
            onDone();
          } finally {
            setSaving(false);
          }
        }}>
        {saving ? <Spinner /> : null} {submitLabel}
      </button>
    </div>
  );
}
