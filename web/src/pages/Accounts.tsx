import { useState } from "react";
import { useAction, useApi, useInvalidate, usePersons, useVault } from "../api/hooks";
import { api, ApiError } from "../api/client";
import type { ApiAccount, Item } from "../api/types";
import { Card, EmptyState, Modal, Spinner } from "../components/ui";
import { fmt } from "../lib/format";
import { openPlaidLink } from "../lib/plaid";
import { AddBankWizard } from "./AddBankWizard";

/** Turn a raw Plaid error code into a one-line, user-facing explanation. */
function friendlySyncError(code: string): string {
  if (/ITEM_LOGIN_REQUIRED/i.test(code)) return "Your bank needs you to sign in again (including any 2-factor code).";
  if (/PENDING_EXPIRATION|PENDING_DISCONNECT/i.test(code)) return "This connection is about to expire — reconnect to keep it syncing.";
  if (/INVALID_CREDENTIALS/i.test(code)) return "Your saved bank credentials no longer work — reconnect to update them.";
  if (/INSUFFICIENT_CREDENTIALS|MFA/i.test(code)) return "Your bank is asking for more login info — reconnect to provide it.";
  return code;
}

export const REGISTERED_TYPES = ["FHSA", "TFSA", "RRSP", "RESP", "NONREG"] as const;

export function Accounts() {
  const vault = useVault();
  const persons = usePersons();
  const locked = vault.data ? !vault.data.unlocked : false;
  const items = useApi<{ items: Item[] }>(["items"], locked ? null : "/api/items", { retry: false });
  const [wizardOpen, setWizardOpen] = useState(false);
  const [unlink, setUnlink] = useState<Item | null>(null);
  const [unlinkName, setUnlinkName] = useState("");
  const [syncing, setSyncing] = useState<string | null>(null);
  const [syncMsg, setSyncMsg] = useState<string | null>(null);

  const syncItem = useAction(async (itemId: string) => {
    setSyncing(itemId);
    try {
      const r = await api<Record<string, number>>(`/api/items/${itemId}/sync`, { method: "POST", json: {} });
      const n = (r.added ?? 0) + (r.modified ?? 0);
      setSyncMsg(`Synced — ${n} transaction${n === 1 ? "" : "s"} updated`);
      setTimeout(() => setSyncMsg(null), 4000);
      return r;
    } finally {
      setSyncing(null);
    }
  }, []);
  const doUnlink = useAction((itemId: string) => api(`/api/items/${itemId}`, { method: "DELETE" }), [""]);

  const personName = (id: string | null) => (id === null ? "Joint" : persons.data?.persons.find((p) => p.person_id === id)?.display_name ?? id);

  if (locked) {
    return (
      <div className="page">
        <Card style={{ maxWidth: 560, margin: "60px auto", textAlign: "center", padding: 40 }}>
          <div style={{ fontSize: 34 }}>🔒</div>
          <div style={{ fontSize: 17, fontWeight: 600, marginTop: 12 }}>Bank connections are locked</div>
          <div className="muted" style={{ fontSize: 13, marginTop: 8, lineHeight: 1.6 }}>
            Touch the YubiKey once on the host to issue a session grant:
            <code style={{ background: "var(--surface-2)", padding: "2px 6px", borderRadius: 5, display: "inline-block", margin: "4px 0" }}>npm run vault -- grant-session</code>
            <br />(add <code style={{ background: "var(--surface-2)", padding: "1px 5px", borderRadius: 5 }}>--portable</code> if the server runs in Docker).
            This page unlocks by itself within a minute — no restart. Every dashboard keeps working from local data meanwhile.
          </div>
        </Card>
      </div>
    );
  }

  return (
    <div className="page">
      <div style={{ marginBottom: 20 }}>
        <div className="h1">Accounts & Connections</div>
        <div className="muted" style={{ fontSize: 13, marginTop: 3 }}>Link banks, choose accounts, and tell Bubbles what each one means.</div>
      </div>
      {syncMsg && <div className="chip chip-accent" style={{ marginBottom: 14, fontSize: 12, padding: "6px 12px" }}>{syncMsg}</div>}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(340px,1fr))", gap: 16 }}>
        {(items.data?.items ?? []).map((item) => (
          <InstitutionCard key={item.item_id} item={item} personName={personName}
            syncing={syncing === item.item_id}
            onSync={() => syncItem.mutate(item.item_id)}
            onUnlink={() => { setUnlink(item); setUnlinkName(""); }} />
        ))}
        <div onClick={() => setWizardOpen(true)}
          style={{ border: "1.5px dashed var(--line)", borderRadius: 16, padding: 18, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 10, cursor: "pointer", minHeight: 170, color: "var(--ink-muted)" }}>
          <div style={{ width: 42, height: 42, borderRadius: 12, border: "1.5px dashed currentColor", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 22 }}>+</div>
          <div style={{ fontSize: 13.5, fontWeight: 600 }}>Add bank</div>
        </div>
      </div>

      {wizardOpen && <AddBankWizard onClose={() => setWizardOpen(false)} />}

      {unlink && (
        <Modal title={`Unlink ${unlink.institution_name ?? "bank"}`} onClose={() => setUnlink(null)}>
          <div className="col" style={{ gap: 13 }}>
            <div className="muted" style={{ fontSize: 12.5, lineHeight: 1.6 }}>
              This revokes access at Plaid and <b style={{ color: "var(--danger)" }}>deletes all local accounts and transactions</b> for this bank.
              Re-linking restores whatever Plaid still has. Type the institution name to confirm.
            </div>
            <input className="input" value={unlinkName} onChange={(e) => setUnlinkName(e.target.value)} placeholder={unlink.institution_name ?? ""} />
            <button className="btn btn-danger" disabled={unlinkName !== (unlink.institution_name ?? "")}
              onClick={() => { doUnlink.mutate(unlink.item_id); setUnlink(null); }}>
              Unlink permanently
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}

function InstitutionCard({ item, personName, syncing, onSync, onUnlink }: {
  item: Item; personName: (id: string | null) => string; syncing: boolean; onSync: () => void; onUnlink: () => void;
}) {
  const accounts = useApi<{ accounts: ApiAccount[] }>(["items.accounts", item.item_id], `/api/items/${item.item_id}/accounts`, { retry: false });
  const invalidate = useInvalidate();
  const [editing, setEditing] = useState<ApiAccount | null>(null);
  const [reconnecting, setReconnecting] = useState(false);
  const [reconnectErr, setReconnectErr] = useState<string | null>(null);
  const fresh = item.last_synced_at ? Date.now() - new Date(item.last_synced_at).getTime() < 24 * 3600_000 : false;
  const needsReconnect = !!item.last_sync_error;
  const visible = (accounts.data?.accounts ?? []).filter((a) => a.tracked && !a.isClosed);
  const hidden = (accounts.data?.accounts ?? []).length - visible.length;

  /** Repair this bank via Plaid Link update mode (same item — no duplicates). */
  const reconnect = async () => {
    setReconnecting(true);
    setReconnectErr(null);
    try {
      const { linkToken } = await api<{ linkToken: string }>(`/api/items/${item.item_id}/reconnect`, { method: "POST", json: {} });
      const outcome = await openPlaidLink(linkToken); // null = user closed without finishing
      if (outcome !== null) {
        // Repaired in place: a normal sync now succeeds and clears the error flag.
        await api(`/api/items/${item.item_id}/sync`, { method: "POST", json: {} }).catch(() => undefined);
        invalidate(["items", "overview", "cashflow", "budget", "transactions", "bills"]);
      }
    } catch (err) {
      setReconnectErr(err instanceof Error ? err.message : String(err));
    } finally {
      setReconnecting(false);
    }
  };

  return (
    <Card style={{ padding: "18px 20px" }}>
      <div className="row" style={{ gap: 12 }}>
        <div style={{ flex: "none", width: 38, height: 38, borderRadius: 10, background: "var(--surface-2)", display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 700, fontSize: 13 }}>
          {(item.institution_name ?? "??").slice(0, 2).toUpperCase()}
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 14, fontWeight: 600 }}>{item.institution_name ?? item.item_id}</div>
          <div className="muted row" style={{ fontSize: 11.5, gap: 6, marginTop: 2 }}>
            <span className="dot" style={{ width: 7, height: 7, background: fresh ? "var(--accent)" : "var(--warn)", animation: "bb-breathe 3s ease-in-out infinite" }} />
            {item.last_synced_at ? `synced ${new Date(item.last_synced_at).toLocaleDateString()}` : "never synced"}
          </div>
        </div>
        <div className="btn-ghost" title="Reconnect (re-authenticate with your bank)" style={{ padding: 8, color: needsReconnect ? "var(--danger)" : undefined }} onClick={reconnect}>
          {reconnecting ? <Spinner /> : <svg width={15} height={15} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round"><path d="M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1" /></svg>}
        </div>
        <div className="btn-ghost" title="Sync now" style={{ padding: 8 }} onClick={onSync}>
          {syncing ? <Spinner /> : <svg width={15} height={15} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round"><path d="M21 12a9 9 0 1 1-3-6.7M21 4v4h-4" /></svg>}
        </div>
        <div className="btn-ghost" title="Unlink" style={{ padding: 8 }} onClick={onUnlink}>×</div>
      </div>
      {(needsReconnect || reconnectErr) && (
        <div className="row" style={{ marginTop: 12, gap: 10, padding: "10px 12px", borderRadius: 10, alignItems: "center", background: "color-mix(in srgb, var(--danger) 10%, transparent)", border: "1px solid color-mix(in srgb, var(--danger) 32%, transparent)" }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 12.5, fontWeight: 600, color: "var(--danger)" }}>Reconnect needed</div>
            <div className="muted" style={{ fontSize: 11, marginTop: 2, lineHeight: 1.4 }}>
              {reconnectErr ? `Reconnect failed: ${reconnectErr}` : friendlySyncError(item.last_sync_error!)}
            </div>
          </div>
          <button className="btn" style={{ background: "var(--danger)", color: "#fff", flex: "none" }} disabled={reconnecting} onClick={reconnect}>
            {reconnecting ? "Opening…" : "Reconnect"}
          </button>
        </div>
      )}
      <div className="col" style={{ marginTop: 14, gap: 8 }}>
        {visible.map((a) => (
          <div key={a.accountId} className="panel row" style={{ gap: 10, padding: "10px 12px" }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 13, fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                {a.name ?? "Account"} <span className="muted" style={{ fontWeight: 400 }}>••{a.mask ?? "????"}</span>
              </div>
              <div className="row" style={{ gap: 5, marginTop: 5, flexWrap: "wrap", cursor: "pointer" }} onClick={() => setEditing(a)} title="Edit classification">
                <span className="chip">{personName(a.personId)}</span>
                <span className="chip chip-accent">{a.registeredType ?? a.subtype ?? a.type ?? "?"}</span>
                {a.purpose && <span className="chip" style={{ background: "color-mix(in srgb, var(--gold) 14%, transparent)", color: "var(--gold)" }}>{a.purpose}</span>}
                {!a.classifiedAt && <span className="chip" style={{ color: "var(--warn)" }}>unclassified — click</span>}
              </div>
            </div>
            <div className="num" style={{ fontSize: 13.5, fontWeight: 600, color: (a.currentBalance ?? 0) < 0 || a.type === "credit" ? "var(--danger)" : "var(--ink)" }}>
              {fmt(a.currentBalance)}
            </div>
          </div>
        ))}
        {hidden > 0 && <div className="muted" style={{ fontSize: 11.5, textAlign: "center" }}>{hidden} hidden</div>}
        {accounts.error instanceof ApiError && <EmptyState text="Couldn't load accounts." />}
      </div>
      {editing && <ClassifyModal account={editing} onClose={() => setEditing(null)} />}
    </Card>
  );
}

export function ClassifyModal({ account, onClose }: { account: ApiAccount; onClose: () => void }) {
  const persons = usePersons();
  const [personId, setPersonId] = useState<string | null>(account.personId);
  const [regType, setRegType] = useState<string | null>(account.registeredType);
  const [purpose, setPurpose] = useState(account.purpose ?? "");
  const [tracked, setTracked] = useState(account.tracked);
  const save = useAction(
    () => api(`/api/accounts/${account.accountId}`, { method: "PATCH", json: { personId, registeredType: regType, purpose: purpose || null, tracked } }),
    [""],
  );
  return (
    <Modal title={`${account.name ?? "Account"} ••${account.mask ?? ""}`} onClose={onClose}>
      <div className="col" style={{ gap: 16 }}>
        <div>
          <div className="label" style={{ marginBottom: 8 }}>Whose is it?</div>
          <div className="row" style={{ gap: 8 }}>
            {[{ id: null as string | null, name: "Joint" }, ...(persons.data?.persons ?? []).map((p) => ({ id: p.person_id as string | null, name: p.display_name }))].map((p) => (
              <button key={p.name} className={personId === p.id ? "btn" : "btn-ghost"} onClick={() => setPersonId(p.id)}>{p.name}</button>
            ))}
          </div>
        </div>
        <div>
          <div className="label" style={{ marginBottom: 8 }}>What is it?</div>
          <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
            {[null, ...REGISTERED_TYPES].map((t) => (
              <button key={t ?? "cash"} className={regType === t ? "btn" : "btn-ghost"} onClick={() => setRegType(t)}>
                {t ?? (account.type === "credit" ? "Credit card" : account.type === "loan" ? "Loan/LOC" : "Cash / spending")}
              </button>
            ))}
          </div>
        </div>
        <div>
          <div className="label" style={{ marginBottom: 8 }}>Purpose (optional)</div>
          <input className="input" list="bb-purposes" value={purpose} onChange={(e) => setPurpose(e.target.value)} placeholder="e.g. Emergency fund" />
          <datalist id="bb-purposes">
            {["Emergency fund", "Vacation sinking fund", "House down payment", "Bills account", "Wedding"].map((p) => <option key={p} value={p} />)}
          </datalist>
        </div>
        <label className="row muted" style={{ fontSize: 12.5, gap: 8, cursor: "pointer" }}>
          <input type="checkbox" checked={tracked} onChange={(e) => setTracked(e.target.checked)} style={{ accentColor: "var(--accent)" }} />
          include in dashboards
        </label>
        <button className="btn" onClick={() => { save.mutate(); onClose(); }}>Save</button>
      </div>
    </Modal>
  );
}
