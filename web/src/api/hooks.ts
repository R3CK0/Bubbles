import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, qs } from "./client";
import { useUi } from "../stores/ui";
import type { Person, VaultStatus, Overview, Alert } from "./types";

/** The global lens+month context every engine endpoint accepts. */
export function useCtx() {
  const lens = useUi((s) => s.lens);
  const month = useUi((s) => s.month);
  return { lens, month, q: qs({ lens, month }) };
}

/** Generic GET hook: key prefix convention `family.rest` for invalidation. */
export function useApi<T>(key: readonly unknown[], path: string | null, opts?: { refetchInterval?: number; retry?: boolean }) {
  return useQuery<T>({
    queryKey: key as unknown[],
    queryFn: () => api<T>(path!),
    enabled: path !== null,
    refetchInterval: opts?.refetchInterval,
    retry: opts?.retry === false ? false : 1,
  });
}

/** Invalidate query-key families by first-segment prefix ([] = everything). */
export function useInvalidate() {
  const qc = useQueryClient();
  return (families: string[]) => {
    if (families.length === 0) return qc.invalidateQueries();
    for (const f of families) {
      qc.invalidateQueries({ predicate: (q) => String(q.queryKey[0] ?? "").startsWith(f) });
    }
  };
}

/** Mutation wrapper: runs fn, then invalidates the given families. */
export function useAction<TArgs = void, TOut = unknown>(fn: (args: TArgs) => Promise<TOut>, families: string[]) {
  const invalidate = useInvalidate();
  return useMutation<TOut, Error, TArgs>({
    mutationFn: fn,
    onSuccess: () => void invalidate(families),
  });
}

// ---- shared shell queries ----
export function usePersons() {
  return useApi<{ persons: Person[] }>(["persons"], "/api/persons");
}

export function useVault() {
  return useApi<VaultStatus>(["vault"], "/api/vault/status", { refetchInterval: 60_000 });
}

export function useOverview() {
  const { q } = useCtx();
  const { lens, month } = useCtx();
  return useApi<Overview>(["overview", lens, month], `/api/overview${q}`, { refetchInterval: 300_000 });
}

export function useAlerts() {
  return useApi<{ alerts: Alert[] }>(["alerts"], "/api/alerts");
}
