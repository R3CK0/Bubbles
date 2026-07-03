/**
 * engine/context.ts — per-request engine context: lens/month/range resolution.
 * Every dashboard route accepts ?lens=&month= (or from/to); this is the one
 * place they're parsed, validated, and defaulted.
 */
import { z } from "zod";
import { listPersons, type PersonRow } from "../db/repository.js";
import { COMBINED, type DateRange, type Lens, type MonthISO } from "../analytics/types.js";
import { monthOf, monthWindow } from "../analytics/calendar.js";

export interface EngineContext {
  lens: Lens;
  month: MonthISO;
  range: DateRange;
  persons: PersonRow[];
  personNames: Map<string, string>;
  today: string;
}

export const contextQuerySchema = z.object({
  lens: z.string().min(1).optional(),
  month: z
    .string()
    .regex(/^\d{4}-\d{2}$/)
    .optional(),
  from: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  to: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
});

export type ContextQuery = z.infer<typeof contextQuerySchema>;

export function buildContext(rawQuery: unknown): EngineContext {
  const q = contextQuerySchema.parse(rawQuery);
  const persons = listPersons();
  const personNames = new Map(persons.map((p) => [p.person_id, p.display_name]));

  const lens = q.lens ?? COMBINED;
  if (lens !== COMBINED && !personNames.has(lens)) {
    throw Object.assign(new Error(`unknown lens '${lens}'`), { status: 400 });
  }

  const today = new Date().toISOString().slice(0, 10);
  const month = q.month ?? monthOf(today);
  const range: DateRange = q.from && q.to ? { start: q.from, end: q.to } : monthWindow(month);

  return { lens, month, range, persons, personNames, today };
}
