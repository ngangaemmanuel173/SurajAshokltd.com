// One trip = one mcl_trips record (its own driver, weight, material source and From/To).
// There is no limit on trips per truck per day: add as many records as the day needs.
//
// Storage of a single-trip record (compatible with every report that already reads mcl_trips):
//   trip_1 = weight in KG (trip_2..trip_13 = 0), notes = "Trip1=<source>[; free notes]",
//   trip_legs = {"1": {from, to}} (only when typed), driver_id = this trip's driver.
// Older records that hold several trips in trip_1..trip_13 are still read correctly (rowTrips) and are
// split into one record per trip by splitLegacyRows (or by the SQL migration).

import { supabase } from '@/lib/supabase';
import { TRIP_NUMS, McRate, rateFor, parseSources, freeNotes } from '@/lib/mclGrid';

export type McTrip = {
  id?: string;
  vehicle_id: string;
  driver_id: string | null;
  trip_date: string;      // yyyy-mm-dd
  kg: number;
  source: string;         // material source code
  from: string;           // typed From ('' = default from the source)
  to: string;             // typed To
  notes: string;          // free notes
};

/** Every trip stored in one DB record (normally one; several for old multi-trip records). */
export function rowTrips(t: any): (McTrip & { slot: number })[] {
  const src = parseSources(t.notes);
  const legs = (t.trip_legs && typeof t.trip_legs === 'object') ? t.trip_legs : {};
  const free = freeNotes(t.notes);
  const out: (McTrip & { slot: number })[] = [];
  let first = true;
  for (const n of TRIP_NUMS) {
    const kg = Number(t[`trip_${n}`]) || 0;
    if (kg <= 0) continue;
    out.push({
      id: t.id, slot: n,
      vehicle_id: t.vehicle_id, driver_id: t.driver_id ?? null,
      trip_date: String(t.trip_date).slice(0, 10),
      kg, source: src[n] || 'M',
      from: legs[String(n)]?.from || '', to: legs[String(n)]?.to || '',
      notes: first ? free : '',
    });
    first = false;
  }
  return out;
}

/** The DB payload for one trip (used for both insert and update, so trip_2..13 are always cleared). */
export function tripPayload(t: McTrip, rates: McRate[]) {
  const r = rateFor(rates, t.source || 'M', t.trip_date);
  const from = t.from.trim() || r?.name || '';
  const to = t.to.trim() || r?.destination || '';
  const payload: any = {
    vehicle_id: t.vehicle_id,
    driver_id: t.driver_id || null,
    trip_date: t.trip_date,
    status: 'completed',
    net_tallage: Number((t.kg / 1000).toFixed(3)),
    notes: `Trip1=${t.source || 'M'}` + (t.notes.trim() ? `; ${t.notes.trim()}` : ''),
    departure_point: from || null,
    destination: to || null,
    trip_legs: (t.from.trim() || t.to.trim()) ? { '1': { from: t.from.trim(), to: t.to.trim() } } : {},
  };
  TRIP_NUMS.forEach(n => { payload[`trip_${n}`] = n === 1 ? t.kg : 0; });
  return payload;
}

/**
 * Splits old records that hold several trips into one record per trip (same driver, same date).
 * Returns true when something was changed, so the caller can reload.
 */
export async function splitLegacyRows(rows: any[], rates: McRate[]): Promise<boolean> {
  let changed = false;
  for (const row of rows) {
    const trips = rowTrips(row);
    if (trips.length <= 1) continue;
    const [head, ...rest] = trips;
    const ins = await supabase.from('mcl_trips').insert(rest.map(t => tripPayload(t, rates)));
    if (ins.error) throw ins.error;
    const up = await supabase.from('mcl_trips').update(tripPayload(head, rates)).eq('id', row.id);
    if (up.error) throw up.error;
    changed = true;
  }
  return changed;
}
