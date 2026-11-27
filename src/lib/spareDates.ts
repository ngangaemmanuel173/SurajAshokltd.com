/**
 * The one date a spare part is filed under, for the Spare Parts page filters AND every monthly report,
 * so the page and the reports always agree on which month a spare belongs to.
 *
 *   purchase date  →  installed date  →  last changed date  →  the day it was added to the system
 *
 * Returns "YYYY-MM-DD", or '' if the row has no usable date at all.
 */
export function spareDate(p: any): string {
  const pick = (v: unknown) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : '');
  return pick(p?.purchase_date) || pick(p?.installed_date) || pick(p?.last_changed_date) || pick(p?.created_at);
}

/** true when the spare belongs to the period [from, to] (both "YYYY-MM-DD", inclusive) */
export const spareInPeriod = (p: any, from: string, to: string): boolean => {
  const d = spareDate(p);
  return !!d && d >= from && d <= to;
};
