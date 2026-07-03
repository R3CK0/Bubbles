/**
 * analytics/index.ts — barrel export: the deterministic API of the platform.
 * Nothing here may import from db/, plaid/, server/, engine/ — this boundary
 * keeps the layer unit-testable and (in the final phase) MCP-exposable.
 * Modules land as their build step implements them (see docs/ENGINE_STRUCTURE.md).
 */
export * from "./types.js";
export * from "./calendar.js";
export * from "./money.js";
export * from "./categorize.js";
export * from "./cashflow.js";
export * from "./variance.js";
export * from "./recurring.js";
export * from "./projection.js";
export * from "./debt.js";
export * from "./goals.js";
export * from "./affordability.js";
export * from "./portfolio.js";
export * from "./networth.js";
export * from "./tax/types.js";
export * from "./tax/payroll.js";
export * from "./tax/federal.js";
export * from "./tax/quebec.js";
export * from "./tax/estimator.js";
export * from "./tax/optimizer.js";
export * from "./tax/couple.js";
