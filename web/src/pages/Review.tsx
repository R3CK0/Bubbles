import { useEffect, useState } from "react";
import { useAction, useApi, useCtx } from "../api/hooks";
import { api } from "../api/client";
import type { CashflowSummary, CategoryAmount, Decision, GoalVerdict, Report, ReviewSlide, VarianceNarrative } from "../api/types";
import { Card, Feasibility, Ring } from "../components/ui";
import { fmt, fmtDelta, monthLabel } from "../lib/format";

export function Review() {
  const { month } = useCtx();
  const [story, setStory] = useState(false);
  const [slide, setSlide] = useState(0);
  const deck = useApi<{ month: string; slides: ReviewSlide[] }>(["review.deck", month], `/api/review/${month}`);
  const decisions = useApi<{ decisions: Decision[] }>(["decisions"], "/api/decisions");
  const reports = useApi<{ reports: Report[] }>(["reports"], "/api/reports?type=monthly");

  const addDecision = useAction(
    (title: string) => api("/api/decisions", { method: "POST", json: { date: new Date().toISOString().slice(0, 10), title } }),
    ["decisions"],
  );
  const archive = useAction(() => api(`/api/reports/monthly/${month}/generate`, { method: "POST", json: {} }), ["reports", "review"]);

  const slides = deck.data?.slides ?? [];

  useEffect(() => {
    if (!story) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowRight") setSlide((s) => Math.min(slides.length - 1, s + 1));
      else if (e.key === "ArrowLeft") setSlide((s) => Math.max(0, s - 1));
      else if (e.key === "Escape") setStory(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [story, slides.length]);

  if (story && slides.length > 0) {
    const s = slides[slide];
    return (
      <div style={{ position: "fixed", inset: 0, zIndex: 200, background: "var(--bg)", display: "flex", flexDirection: "column" }}>
        <div className="spread" style={{ padding: "18px 28px" }}>
          <div className="label">Money date · {monthLabel(month)} · {slide + 1}/{slides.length}</div>
          <div style={{ cursor: "pointer", fontSize: 22, color: "var(--ink-muted)" }} onClick={() => setStory(false)}>×</div>
        </div>
        <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", padding: 40 }}>
          <div key={slide} style={{ maxWidth: 860, width: "100%", animation: "bb-popin .3s ease-out" }}>
            <div style={{ fontSize: 34, fontWeight: 700, letterSpacing: "-.02em", marginBottom: 28 }}>{s.title}</div>
            <SlideBody slide={s} onDecision={(t) => addDecision.mutate(t)} decisions={decisions.data?.decisions ?? []} />
          </div>
        </div>
        <div className="row" style={{ justifyContent: "center", gap: 14, padding: 24 }}>
          <button className="btn-ghost" disabled={slide === 0} onClick={() => setSlide((x) => x - 1)}>← Prev</button>
          {slide < slides.length - 1
            ? <button className="btn" onClick={() => setSlide((x) => x + 1)}>Next →</button>
            : <button className="btn" onClick={() => { archive.mutate(); setStory(false); }}>Finish & archive</button>}
        </div>
      </div>
    );
  }

  return (
    <div className="page col" style={{ gap: 20 }}>
      <Card className="spread" style={{ padding: "26px 28px" }}>
        <div>
          <div style={{ fontSize: 18, fontWeight: 600 }}>Monthly review · {monthLabel(month)}</div>
          <div className="muted" style={{ fontSize: 12.5, marginTop: 4 }}>Full-screen guided walkthrough — cast it to the TV, advance with ← →, capture decisions at the end.</div>
        </div>
        <button className="btn" style={{ fontSize: 14, padding: "12px 20px" }} onClick={() => { setSlide(0); setStory(true); }}>▶ Start story mode</button>
      </Card>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 20 }}>
        <Card style={{ padding: 8 }}>
          <div style={{ padding: "12px 16px 8px", fontSize: 14, fontWeight: 600 }}>Decision log</div>
          {(decisions.data?.decisions ?? []).map((d) => (
            <div key={d.decision_id} className="row" style={{ padding: "9px 16px", gap: 10 }}>
              <span className="dot" style={{ background: "var(--gold)" }} />
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 13, fontWeight: 600 }}>{d.title}</div>
                {d.body && <div className="muted" style={{ fontSize: 12 }}>{d.body}</div>}
              </div>
              <span className="muted num" style={{ fontSize: 11.5 }}>{d.date}</span>
            </div>
          ))}
          {decisions.data?.decisions.length === 0 && <div className="empty">No decisions yet — they're captured at the end of story mode.</div>}
        </Card>

        <Card style={{ padding: 8 }}>
          <div style={{ padding: "12px 16px 8px", fontSize: 14, fontWeight: 600 }}>Past reviews</div>
          {(reports.data?.reports ?? []).map((r) => (
            <div key={r.report_id} className="hoverable spread" style={{ padding: "10px 16px" }}>
              <span style={{ fontSize: 13, fontWeight: 600 }}>{r.title ?? monthLabel(r.period_start.slice(0, 7))}</span>
              <span className="muted num" style={{ fontSize: 11.5 }}>{r.created_at.slice(0, 10)}</span>
            </div>
          ))}
          {reports.data?.reports.length === 0 && <div className="empty">No archived reviews yet.</div>}
        </Card>
      </div>
    </div>
  );
}

function SlideBody({ slide, onDecision, decisions }: { slide: ReviewSlide; onDecision: (t: string) => void; decisions: Decision[] }) {
  const [draft, setDraft] = useState("");
  switch (slide.kind) {
    case "cashflow": {
      const d = slide.data as CashflowSummary;
      return (
        <div className="row" style={{ gap: 40 }}>
          {[{ l: "In", v: d.income, c: "var(--accent)" }, { l: "Out", v: d.spend, c: "var(--ink)" }, { l: "Net", v: d.net, c: d.net >= 0 ? "var(--accent)" : "var(--danger)" }].map((x) => (
            <div key={x.l}>
              <div className="label">{x.l}</div>
              <div className="num" style={{ fontSize: 46, fontWeight: 700, color: x.c }}>{fmt(x.v)}</div>
            </div>
          ))}
        </div>
      );
    }
    case "categories": {
      const cats = (slide.data as CategoryAmount[]).slice(0, 8);
      const max = Math.max(...cats.map((c) => c.amount), 1);
      return (
        <div className="col" style={{ gap: 10 }}>
          {cats.map((c) => (
            <div key={c.name} className="row" style={{ gap: 14 }}>
              <span style={{ width: 160, fontSize: 15, fontWeight: 600 }}>{c.name}</span>
              <div className="bar-track" style={{ flex: 1, height: 14 }}>
                <div className="bar-fill" style={{ width: `${(c.amount / max) * 100}%`, background: "var(--accent)" }} />
              </div>
              <span className="num" style={{ width: 100, textAlign: "right", fontSize: 15, fontWeight: 600 }}>{fmt(c.amount)}</span>
            </div>
          ))}
        </div>
      );
    }
    case "variances": {
      const vars = (slide.data as VarianceNarrative[]).slice(0, 6);
      return (
        <div className="col" style={{ gap: 14 }}>
          {vars.map((v) => (
            <div key={v.categoryId} className="panel" style={{ padding: 16 }}>
              <div className="spread">
                <b style={{ fontSize: 16 }}>{v.name}</b>
                <span className="num" style={{ fontSize: 16, fontWeight: 700, color: v.variance > 0 ? "var(--warn)" : "var(--accent)" }}>{fmtDelta(v.variance)}</span>
              </div>
              {v.drivers.slice(0, 2).map((dr, i) => <div key={i} className="muted" style={{ fontSize: 13, marginTop: 4 }}>{dr.detail}</div>)}
            </div>
          ))}
          {vars.length === 0 && <div className="muted">Nothing worth arguing about. 🎉</div>}
        </div>
      );
    }
    case "goals": {
      const goals = slide.data as { name: string; progress: number; feasible: string }[];
      return (
        <div className="row" style={{ gap: 20, flexWrap: "wrap" }}>
          {goals.map((g) => (
            <div key={g.name} className="col" style={{ alignItems: "center", gap: 8 }}>
              <Ring pct={g.progress} size={90} color={g.feasible === "no" ? "var(--danger)" : g.feasible === "tight" ? "var(--warn)" : "var(--accent)"} />
              <b style={{ fontSize: 13 }}>{g.name}</b>
              <Feasibility verdict={(g.feasible as "yes" | "tight" | "no") ?? "yes"} />
            </div>
          ))}
        </div>
      );
    }
    case "networth": {
      const d = slide.data as { current: number; monthDelta: number | null };
      return (
        <div>
          <div className="num" style={{ fontSize: 64, fontWeight: 700 }}>{fmt(d.current)}</div>
          {d.monthDelta !== null && <div className="num" style={{ fontSize: 22, marginTop: 10, color: d.monthDelta >= 0 ? "var(--accent)" : "var(--danger)" }}>{fmtDelta(d.monthDelta)} this month</div>}
        </div>
      );
    }
    case "ahead": {
      const d = slide.data as { bills: number; alerts: number };
      return (
        <div className="row" style={{ gap: 40 }}>
          <div><div className="label">Bills next month</div><div className="num" style={{ fontSize: 46, fontWeight: 700 }}>{fmt(d.bills)}</div></div>
          <div><div className="label">Open alerts</div><div className="num" style={{ fontSize: 46, fontWeight: 700, color: d.alerts > 0 ? "var(--warn)" : "var(--accent)" }}>{d.alerts}</div></div>
        </div>
      );
    }
    case "decisions":
    default:
      return (
        <div className="col" style={{ gap: 14, maxWidth: 560 }}>
          <div className="row" style={{ gap: 8 }}>
            <input className="input" placeholder="We decided to…" value={draft} onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && draft.trim()) { onDecision(draft.trim()); setDraft(""); } }} />
            <button className="btn" disabled={!draft.trim()} onClick={() => { onDecision(draft.trim()); setDraft(""); }}>Save</button>
          </div>
          <div className="col" style={{ gap: 6 }}>
            {decisions.slice(0, 5).map((d) => (
              <div key={d.decision_id} className="row" style={{ gap: 8, fontSize: 13 }}>
                <span className="dot" style={{ background: "var(--gold)" }} />{d.title}
                <span className="muted num" style={{ fontSize: 11 }}>{d.date}</span>
              </div>
            ))}
          </div>
        </div>
      );
  }
}
