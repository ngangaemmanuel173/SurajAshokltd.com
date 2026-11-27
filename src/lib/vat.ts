/**
 * Revenue amounts are entered ex-VAT and stored VAT-inclusive.
 * Every amount typed (or imported) into Revenue ONLY is multiplied by VAT_MULTIPLIER (116%) and then ADDED
 * to the figure already saved for that truck and month. Insurance / Loans / Driver allowance are NOT multiplied.
 * Change the number here and every form and import follows.
 */
export const VAT_MULTIPLIER = 1.16;

/** amount x 116%, rounded to cents */
export const withVat = (amount: number): number => Math.round(amount * VAT_MULTIPLIER * 100) / 100;
