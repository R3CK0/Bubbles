import type { NextFunction, Request, Response } from "express";
import { ZodError } from "zod";
import { BadRequestError } from "../params.js";

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function errorHandler(err: unknown, req: Request, res: Response, next: NextFunction): void {
  const message = err instanceof Error ? err.message : String(err);
  // eslint-disable-next-line no-console
  console.error("[api]", message);
  if (res.headersSent) return;

  if (err instanceof ZodError || err instanceof BadRequestError) {
    res.status(400).json({ error: message });
    return;
  }
  // Domain errors can advertise an HTTP status without the middleware needing
  // to import them (keeps the server layer decoupled from the plaid layer).
  const status = (err as { status?: unknown }).status;
  if (typeof status === "number" && status >= 400 && status < 600) {
    res.status(status).json({ error: message });
    return;
  }
  res.status(500).json({ error: message });
}
