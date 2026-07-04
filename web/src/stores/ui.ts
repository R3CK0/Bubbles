import { create } from "zustand";
import { persist } from "zustand/middleware";

export const COMBINED = "combined";

function currentMonth(): string {
  return new Date().toISOString().slice(0, 7);
}

export function shiftMonth(month: string, delta: number): string {
  const [y, m] = month.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return d.toISOString().slice(0, 7);
}

interface UiState {
  lens: string;
  month: string;
  theme: "dark" | "light";
  sidebarOpen: boolean;
  /** Sidebar group labels the user has collapsed. */
  collapsedGroups: string[];
  setLens: (lens: string) => void;
  setMonth: (month: string) => void;
  stepMonth: (delta: number) => void;
  toggleTheme: () => void;
  toggleSidebar: () => void;
  toggleGroup: (label: string) => void;
}

export const useUi = create<UiState>()(
  persist(
    (set) => ({
      lens: COMBINED,
      month: currentMonth(),
      theme: "dark",
      sidebarOpen: true,
      collapsedGroups: [],
      setLens: (lens) => set({ lens }),
      setMonth: (month) => set({ month }),
      stepMonth: (delta) => set((s) => ({ month: shiftMonth(s.month, delta) })),
      toggleTheme: () => set((s) => ({ theme: s.theme === "dark" ? "light" : "dark" })),
      toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),
      toggleGroup: (label) =>
        set((s) => ({
          collapsedGroups: s.collapsedGroups.includes(label)
            ? s.collapsedGroups.filter((l) => l !== label)
            : [...s.collapsedGroups, label],
        })),
    }),
    { name: "bubbles-ui" },
  ),
);
