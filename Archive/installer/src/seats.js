// @ts-check
/**
 * Microsoft 365 Copilot seats assigned in the tenant, which size the install: how long the pipeline's
 * steps may run, and what capacity to recommend. The thresholds come from earlier speed tests.
 */

/** The service plan in every Microsoft 365 Copilot SKU (Microsoft_365_Copilot, M365_Copilot, the EDU and E7 SKUs, ...). */
export const COPILOT_PLAN = 'M365_COPILOT_APPS';

/** More assigned seats than this and a new install starts as a large tenant. */
export const LARGE_TENANT_SEATS = 10_000;

/** From this many assigned seats, a capacity below F64 is likely to run the loads out of time or memory. */
export const BIG_CAPACITY_SEATS = 30_000;

/**
 * The Copilot SKUs in a `subscribedSkus` list, and how many of their seats are assigned.
 * @param {any[]} skus
 */
export function copilotLicences(skus) {
  const copilot = (skus ?? []).filter((s) => (s.servicePlans ?? []).some((/** @type {any} */ p) => p.servicePlanName === COPILOT_PLAN));
  return {
    names: [...new Set(copilot.map((s) => s.skuPartNumber).filter(Boolean))],
    assigned: copilot.reduce((n, s) => n + (s.consumedUnits ?? 0), 0),
    found: copilot.length > 0,
  };
}

/**
 * Assigned Copilot seats, or undefined when they can't be read: sizing then falls back to the capacity.
 * @param {import('./install.js').Apis} api
 * @returns {Promise<number | undefined>}
 */
export async function copilotSeats(api) {
  try {
    return copilotLicences(await api.graph.subscribedSkus()).assigned;
  } catch {
    return undefined;
  }
}

/** @param {number} n */
export const seatCount = (n) => n.toLocaleString('en-US');
