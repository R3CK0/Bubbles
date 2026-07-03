/**
 * server/routes/persons.ts — household members. DB-only (no vaultGuard):
 * the person lens is needed on every dashboard page, and the onboarding
 * wizard creates/renames members before any bank is linked.
 */
import { Router } from "express";
import { z } from "zod";
import { insertPerson, listPersons } from "../../db/repository.js";

export const personsRouter = Router();

personsRouter.get("/api/persons", (_req, res) => {
  res.json({ persons: listPersons() });
});

const personSchema = z
  .object({
    personId: z
      .string()
      .min(1)
      .regex(/^[a-z0-9_-]+$/, "lowercase slug"),
    displayName: z.string().min(1),
    color: z.string().nullable().optional(),
  })
  .strict();

personsRouter.post("/api/persons", (req, res) => {
  const body = personSchema.parse(req.body);
  const person = insertPerson(body.personId, body.displayName, body.color ?? null);
  res.status(201).json({ person });
});
