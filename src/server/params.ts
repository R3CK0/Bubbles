import type { Request } from "express";

export class BadRequestError extends Error {}

/** Route params are always present for a matched pattern; this just satisfies noUncheckedIndexedAccess. */
export function requireParam(req: Request, name: string): string {
  const value = req.params[name];
  if (!value) throw new BadRequestError(`Missing route parameter: ${name}`);
  return value;
}
