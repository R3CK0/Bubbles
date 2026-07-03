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
  // Axios/Plaid errors carry the real diagnosis in response.data — surface
  // error_code + error_message instead of the useless "status code 400".
  const response = (err as { response?: { status?: number; data?: Record<string, unknown> } }).response;
  if (response?.data && typeof response.data === "object") {
    const d = response.data;
    const code = typeof d.error_code === "string" ? d.error_code : null;
    const msg = typeof d.error_message === "string" ? d.error_message : null;
    if (code || msg) {
      console.error("[api] plaid error:", JSON.stringify(d));
      res.status(response.status && response.status >= 400 ? response.status : 502).json({
        error: `Plaid: ${code ?? "error"} — ${msg ?? message}`,
        plaid: { errorCode: code, errorType: d.error_type ?? null, requestId: d.request_id ?? null },
      });
      return;
    }
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
