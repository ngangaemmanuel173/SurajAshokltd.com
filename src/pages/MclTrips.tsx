import { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import { WeekSelect, inWeek } from '@/components/PeriodFilter';
import { Route as RouteIcon, Save, Settings2, Trash2, Plus, Download, Upload, Undo2 } from 'lucide-react';
import { supabase } from '@/lib/supabase';
import { PageHeader } from '@/components/PageHeader';
import { Modal } from '@/components/Modal';
import { LoadingSpinner } from '@/components/Shared';
import { MclImportModal, downloadMclTemplate } from '@/components/MclImportModal';
import { syncFuelMirror } from '@/lib/mclFuelSync';
import { rowTrips, tripPayload, splitLegacyRows, McTrip } from '@/lib/mclTripRows';
import { useToast } from '@/components/Toast';
import {
  SOURCE_CODES, McRate, FuelOverride, rateFor, dayTotals, daysOfMonth, monthStart, currentMonth, shortDay, fmt,
} from '@/lib/mclGrid';

// One line of the sheet = ONE trip, with its own driver. A day can have any number of trips.
type Line = {
  key: string;            // stable React key
  id?: string;            // mcl_trips record (absent = not saved yet)
  date: string;
  driver_id: string;
  kg: string;             // kept as a string while typing
  src: string;
  from: string;
  to: string;
  notes: string;          // free notes carried over from the saved record
  dirty: boolean;
  removed: boolean;       // saved trip marked for deletion (applied on Save)
};

let keySeq = 0;
const newKey = () => `n${++keySeq}`;
const num = (s: string | undefined) => Number(s) || 0;
const blankLine = (date: string, driver_id = '', src = 'M'): Line => ({
  key: newKey(), date, driver_id, kg: '', src, from: '', to: '', notes: '', dirty: true, removed: false,
});

const toTrip = (l: Line, vehicle_id: string): McTrip => ({
  id: l.id, vehicle_id, driver_id: l.driver_id || null, trip_date: l.date,
  kg: num(l.kg), source: l.src || 'M', from: l.from, to: l.to, notes: l.notes,
});

export function MclTrips({ portalColor }: { portalColor: string }) {
  const { showToast } = useToast();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [vehicles, setVehicles] = useState<any[]>([]);
  const [drivers, setDrivers] = useState<any[]>([]);
  const [rates, setRates] = useState<McRate[]>([]);
  const ratesRef = useRef<McRate[]>([]);
  const [ready, setReady] = useState(false); // trucks, drivers and rates loaded
  const [override, setOverride] = useState<FuelOverride>({});
  const [vehicleId, setVehicleId] = useState('');
  const [month, setMonth] = useState(currentMonth());
  const [driverFilter, setDriverFilter] = useState('');
  const [week, setWeek] = useState('all'); // 'all' | Saturday of the chosen week
  const [lines, setLines] = useState<Line[]>([]);
  const [ratesOpen, setRatesOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);

  // "Add Trips" form: one date + truck, then any number of trips, each with its own driver
  type NewTrip = { driver: string; kg: string; src: string; from: string; to: string };
  const blankTrip = (driver = '', src = 'M'): NewTrip => ({ driver, kg: '', src, from: '', to: '' });
  const [addOpen, setAddOpen] = useState(false);
  const [addSaving, setAddSaving] = useState(false);
  const [addDate, setAddDate] = useState('');
  const [addVehicle, setAddVehicle] = useState('');
  const [addTrips, setAddTrips] = useState<NewTrip[]>([blankTrip()]);

  const days = useMemo(() => daysOfMonth(month), [month]);
  const dirtyCount = useMemo(() => lines.filter(l => l.dirty && !(l.removed && !l.id) && (l.id || num(l.kg) > 0)).length, [lines]);

  // --- lookups (trucks, drivers, rates) ------------------------------------------------
  const loadLookups = useCallback(async () => {
    const [veh, drv, rt] = await Promise.all([
      supabase.from('vehicles').select('id, plate_number').order('plate_number'),
      supabase.from('drivers').select('id, name').order('name'),
      supabase.from('mcl_rates').select('*').order('effective_from').order('code'),
    ]);
    setVehicles(veh.data || []);
    setDrivers(drv.data || []);
    const parsed = (rt.data || []).map((r: any) => ({ ...r, rate_per_ton: Number(r.rate_per_ton), fuel_litres: Number(r.fuel_litres) })) as McRate[];
    ratesRef.current = parsed;
    setRates(parsed);
    if (rt.error) showToast('Could not load MCL rates (run the MCL migration): ' + rt.error.message, 'error');
  }, [showToast]);

  // --- the month's trips for the selected truck -----------------------------------------
  const loadMonth = useCallback(async () => {
    if (!vehicleId) { setLines([]); return; }
    setLoading(true);
    const al = await supabase.from('mcl_truck_fuel_alloc').select('code, fuel_litres').eq('vehicle_id', vehicleId);
    setOverride(Object.fromEntries((al.data || []).map((a: any) => [a.code, Number(a.fuel_litres)])));

    const fetchRows = () => supabase
      .from('mcl_trips')
      .select('*')
      .eq('vehicle_id', vehicleId)
      .gte('trip_date', monthStart(month))
      .lte('trip_date', days[days.length - 1])
      .order('trip_date')
      .order('created_at');

    let { data, error } = await fetchRows();
    if (error) showToast('Failed to load trips: ' + error.message, 'error');

    // old records that hold several trips are split into one record per trip (same driver on each)
    try {
      if (await splitLegacyRows(data || [], ratesRef.current)) ({ data, error } = await fetchRows());
    } catch (e: any) {
      showToast('Could not split an older multi-trip record: ' + (e?.message || e), 'error');
    }

    const next: Line[] = [];
    for (const rec of data || []) {
      for (const t of rowTrips(rec)) {
        next.push({
          key: newKey(), id: rec.id, date: t.trip_date, driver_id: t.driver_id || '', kg: String(t.kg),
          src: t.source, from: t.from, to: t.to, notes: t.notes, dirty: false, removed: false,
        });
      }
    }
    setLines(next);
    setLoading(false);
  }, [vehicleId, month, days, showToast]);

  useEffect(() => { loadLookups().then(() => { setReady(true); setLoading(false); }); }, [loadLookups]);
  // wait for the lookups so splitting old records can use the rates; changing rates later does not reload (keeps unsaved edits)
  useEffect(() => { if (ready) loadMonth(); }, [ready, loadMonth]);

  const guard = (go: () => void) => {
    if (dirtyCount > 0 && !window.confirm(`You have ${dirtyCount} unsaved trip(s). Discard them?`)) return;
    go();
  };

  // --- editing -------------------------------------------------------------------------
  const patch = (key: string, p: Partial<Line>) =>
    setLines(prev => prev.map(l => (l.key === key ? { ...l, ...p, dirty: true } : l)));

  // add an empty trip line to a day (it takes that day's last driver and source)
  const addLine = (date: string) =>
    setLines(prev => {
      const same = prev.filter(l => l.date === date && !l.removed);
      const last = same[same.length - 1];
      const fresh = blankLine(date, last?.driver_id ?? driverFilter, last?.src ?? 'M');
      // insert after the day's last line so the sheet stays in date order
      const idx = prev.map(l => l.date).lastIndexOf(date);
      if (idx === -1) {
        const at = prev.findIndex(l => l.date > date);
        return at === -1 ? [...prev, fresh] : [...prev.slice(0, at), fresh, ...prev.slice(at)];
      }
      return [...prev.slice(0, idx + 1), fresh, ...prev.slice(idx + 1)];
    });

  const removeLine = (l: Line) => {
    if (!l.id) setLines(prev => prev.filter(x => x.key !== l.key)); // never saved: just drop it
    else patch(l.key, { removed: true });                            // saved: deleted when you press Save
  };

  // --- save ----------------------------------------------------------------------------
  const saveAll = async () => {
    if (!vehicleId) return;
    setSaving(true);
    let failed = 0;

    const toDelete = lines.filter(l => l.id && (l.removed || (l.dirty && num(l.kg) <= 0)));
    const toUpdate = lines.filter(l => l.id && l.dirty && !l.removed && num(l.kg) > 0);
    const toInsert = lines.filter(l => !l.id && l.dirty && !l.removed && num(l.kg) > 0);

    if (toInsert.length) {
      const { error } = await supabase.from('mcl_trips').insert(toInsert.map(l => tripPayload(toTrip(l, vehicleId), rates)));
      if (error) { failed++; showToast('New trips: ' + error.message, 'error'); }
    }
    for (let i = 0; i < toUpdate.length; i += 10) {
      const res = await Promise.all(toUpdate.slice(i, i + 10).map(l =>
        supabase.from('mcl_trips').update(tripPayload(toTrip(l, vehicleId), rates)).eq('id', l.id!)));
      res.forEach((r, j) => { if (r.error) { failed++; showToast(`${toUpdate[i + j].date}: ${r.error.message}`, 'error'); } });
    }
    if (toDelete.length) {
      const { error } = await supabase.from('mcl_trips').delete().in('id', toDelete.map(l => l.id!));
      if (error) { failed++; showToast('Delete: ' + error.message, 'error'); }
    }

    // keep the fuel cost records (planned litres per day) in step with these trips
    try { await syncFuelMirror(vehicleId, month); } catch { /* fuel tables not set up yet: ignore */ }
    setSaving(false);
    if (failed === 0) showToast('Trips saved', 'success');
    loadMonth();
  };

  // --- "Add Trips" form ------------------------------------------------------------------
  const openAdd = () => {
    setAddDate(new Date().toISOString().slice(0, 10));
    setAddVehicle(vehicleId);
    setAddTrips([blankTrip(driverFilter)]);
    setAddOpen(true);
  };

  const patchNew = (i: number, p: Partial<NewTrip>) =>
    setAddTrips(list => list.map((t, idx) => (idx === i ? { ...t, ...p } : t)));

  const saveNewTrips = async () => {
    const entries = addTrips.map(t => ({ ...t, w: Number(t.kg) || 0 })).filter(t => t.w > 0);
    if (!addDate || !addVehicle) { showToast('Pick a date and a truck', 'error'); return; }
    if (entries.length === 0) { showToast('Enter the weight (KG) of at least one trip', 'error'); return; }
    setAddSaving(true);
    try {
      const payloads = entries.map(e => tripPayload({
        vehicle_id: addVehicle, driver_id: e.driver || null, trip_date: addDate,
        kg: e.w, source: e.src || 'M', from: e.from, to: e.to, notes: '',
      }, rates));
      const { error } = await supabase.from('mcl_trips').insert(payloads);
      if (error) throw error;

      try { await syncFuelMirror(addVehicle, addDate.slice(0, 7)); } catch { /* fuel tables not set up yet: ignore */ }
      showToast(`${entries.length} trip${entries.length > 1 ? 's' : ''} saved`, 'success');
      setAddOpen(false);

      // show what was just saved (unless there are unsaved edits in the sheet)
      if (dirtyCount === 0) { setVehicleId(addVehicle); setMonth(addDate.slice(0, 7)); }
      loadMonth();
    } catch (e: any) {
      showToast('Failed to save: ' + (e?.message || e), 'error');
    } finally {
      setAddSaving(false);
    }
  };

  // --- totals ----------------------------------------------------------------------------
  const calc = useCallback((l: Line) =>
    dayTotals({ weights: { 1: num(l.kg) }, sources: { 1: l.src || 'M' } }, l.date, rates, override), [rates, override]);

  const visible = useMemo(
    () => lines.filter(l => !l.removed && (!driverFilter || l.driver_id === driverFilter) && inWeek(l.date, week)),
    [lines, driverFilter, week],
  );

  const summary = useMemo(() => {
    let trips = 0, tons = 0, revenue = 0, litres = 0;
    const bySource: Record<string, number> = {};
    const byDriver: Record<string, { trips: number; tons: number; revenue: number }> = {};
    for (const l of visible) {
      if (num(l.kg) <= 0) continue;
      const t = calc(l);
      trips += t.trips; tons += t.tons; revenue += t.revenue; litres += t.plannedLitres;
      for (const [k, v] of Object.entries(t.bySource)) bySource[k] = (bySource[k] || 0) + v;
      const dk = l.driver_id || '';
      const d = byDriver[dk] || (byDriver[dk] = { trips: 0, tons: 0, revenue: 0 });
      d.trips += t.trips; d.tons += t.tons; d.revenue += t.revenue;
    }
    return { trips, tons, revenue, litres, bySource, byDriver };
  }, [visible, calc]);

  const truck = vehicles.find(v => v.id === vehicleId)?.plate_number;
  const driverName = (id: string) => drivers.find(d => d.id === id)?.name || 'No driver';

  // default route of a trip = the route of its material source (M -> MCL MINES to CRUSHER)
  const defFrom = (l: Line) => rateFor(rates, l.src || 'M', l.date)?.name || 'From';
  const defTo = (l: Line) => rateFor(rates, l.src || 'M', l.date)?.destination || 'To';

  // places used before, offered as suggestions while typing
  const placeSuggestions = useMemo(() => {
    const set = new Set<string>();
    rates.forEach(r => { if (r.name) set.add(r.name); if (r.destination) set.add(r.destination); });
    lines.forEach(l => { if (l.from) set.add(l.from); if (l.to) set.add(l.to); });
    return Array.from(set).sort();
  }, [rates, lines]);

  // sheet rows: every day of the month; a day shows all its trips (or one empty line with an add button)
  const byDate = useMemo(() => {
    const m = new Map<string, Line[]>();
    // removed-but-unsaved lines stay in view (struck through) until Save so they can be restored
    lines.filter(l => !driverFilter || l.driver_id === driverFilter || !l.id).forEach(l => {
      const arr = m.get(l.date) || [];
      arr.push(l);
      m.set(l.date, arr);
    });
    return m;
  }, [lines, driverFilter]);

  return (
    <div className="space-y-5 animate-fade-in">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <PageHeader
          title="MCL Daily Trip Sheet"
          subtitle="One line per trip: its own driver, weight (KG) and material source. Add as many trips per day as needed"
          icon={<RouteIcon className="h-6 w-6" />}
          iconColor={portalColor}
        />
      </div>

      {/* controls */}
      <div className="card flex flex-col lg:flex-row lg:items-end gap-3 p-4">
        <div>
          <label className="label">Truck *</label>
          <select className="input w-full lg:w-48" value={vehicleId} onChange={e => guard(() => setVehicleId(e.target.value))}>
            <option value="">Select truck</option>
            {vehicles.map(v => <option key={v.id} value={v.id}>{v.plate_number}</option>)}
          </select>
        </div>
        <div>
          <label className="label">Month</label>
          <input type="month" className="input" value={month} onChange={e => e.target.value && guard(() => { setMonth(e.target.value); setWeek('all'); })} />
        </div>
        <div>
          <label className="label">Week</label>
          <WeekSelect month={month} value={week} onChange={setWeek} />
        </div>
        <div>
          <label className="label">Driver</label>
          <select className="input w-full lg:w-48" value={driverFilter} onChange={e => setDriverFilter(e.target.value)}>
            <option value="">All drivers</option>
            {drivers.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select>
        </div>
        <div className="flex-1" />
        <button onClick={openAdd} className="btn-primary flex items-center gap-2" style={{ background: portalColor }}>
          <Plus className="h-4 w-4" /> Add Trips
        </button>
        <button onClick={() => downloadMclTemplate('trips', { vehicles, drivers, rates })} className="btn-secondary flex items-center gap-2">
          <Download className="h-4 w-4" /> Download Template
        </button>
        <button onClick={() => setImportOpen(true)} className="btn-secondary flex items-center gap-2">
          <Upload className="h-4 w-4" /> Bulk Import
        </button>
        <button onClick={() => setRatesOpen(true)} className="btn-secondary flex items-center gap-2">
          <Settings2 className="h-4 w-4" /> Rates &amp; fuel allocation
        </button>
        <button
          onClick={saveAll}
          disabled={saving || dirtyCount === 0}
          className="btn-primary flex items-center gap-2 disabled:opacity-50"
          style={{ background: portalColor }}
        >
          <Save className="h-4 w-4" /> {saving ? 'Saving…' : dirtyCount ? `Save ${dirtyCount} trip${dirtyCount > 1 ? 's' : ''}` : 'Saved'}
        </button>
      </div>

      {!vehicleId ? (
        <div className="card p-10 text-center text-sm text-slate-500">Select a truck to enter its trips for the month.</div>
      ) : loading ? (
        <LoadingSpinner message="Loading trip sheet..." />
      ) : (
        <>
          <datalist id="mcl-places">
            {placeSuggestions.map(p => <option key={p} value={p} />)}
          </datalist>

          <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
            <Stat label="Trips" value={fmt(summary.trips)} />
            <Stat label="Tons" value={fmt(summary.tons, 2)} />
            <Stat label="Revenue (KSh)" value={fmt(summary.revenue)} />
            <Stat label="Planned fuel (L)" value={fmt(summary.litres, 1)} />
            <div className="card p-4">
              <p className="text-xs text-slate-400">Trips by material source</p>
              <p className="text-sm font-semibold text-slate-800 mt-1">
                {SOURCE_CODES.map(c => `${c}: ${summary.bySource[c] || 0}`).join('  ·  ')}
              </p>
            </div>
          </div>

          {Object.keys(summary.byDriver).length > 0 && (
            <div className="card p-4">
              <p className="text-xs font-semibold uppercase tracking-wider text-slate-500 mb-2">Trips by driver</p>
              <div className="flex flex-wrap gap-2">
                {Object.entries(summary.byDriver)
                  .sort((a, b) => b[1].trips - a[1].trips)
                  .map(([id, d]) => (
                    <button
                      key={id || 'none'} type="button"
                      onClick={() => setDriverFilter(driverFilter === id ? '' : id)}
                      className={`rounded-lg border px-3 py-1.5 text-xs text-left ${driverFilter === id && id ? 'border-blue-400 bg-blue-50' : 'border-slate-200 bg-white hover:bg-slate-50'}`}
                    >
                      <span className="font-semibold text-slate-800">{driverName(id)}</span>
                      <span className="text-slate-500"> · {d.trips} trip{d.trips === 1 ? '' : 's'} · {fmt(d.tons, 2)} t · KSh {fmt(d.revenue)}</span>
                    </button>
                  ))}
              </div>
            </div>
          )}

          <div className="card overflow-x-auto">
            <table className="data-table text-xs">
              <thead>
                <tr>
                  <th className="sticky left-0 bg-white z-10">Date</th>
                  <th>Driver</th>
                  <th className="text-right">KG</th>
                  <th>Source</th>
                  <th>From</th>
                  <th>To</th>
                  <th className="text-right">Tons</th>
                  <th className="text-right">Revenue (KSh)</th>
                  <th className="text-right">Fuel plan (L)</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {days.filter(d => inWeek(d, week)).map(date => {
                  const dayLines = byDate.get(date) || [];
                  const live = dayLines.filter(l => !l.removed);
                  if (dayLines.length === 0) {
                    return (
                      <tr key={date}>
                        <td className="sticky left-0 bg-white font-medium text-slate-400 whitespace-nowrap">{shortDay(date)}</td>
                        <td colSpan={8} className="text-slate-300">—</td>
                        <td className="text-right">
                          <button type="button" onClick={() => addLine(date)} title="Add a trip on this day" className="text-blue-600 hover:text-blue-800 px-1">
                            <Plus className="h-4 w-4" />
                          </button>
                        </td>
                      </tr>
                    );
                  }
                  return dayLines.map((l, i) => {
                    const t = calc(l);
                    const isLastLive = live.length > 0 && l.key === live[live.length - 1].key;
                    return (
                      <tr key={l.key} className={l.removed ? 'bg-red-50 opacity-60' : l.dirty ? 'bg-amber-50' : ''}>
                        <td className="sticky left-0 bg-inherit font-medium text-slate-700 whitespace-nowrap">
                          {i === 0 ? shortDay(date) : <span className="text-slate-300 pl-3">↳</span>}
                          {i === 0 && live.length > 1 && <span className="ml-1 text-[9px] text-blue-600 font-bold">{live.length} trips</span>}
                        </td>
                        <td>
                          <select
                            className="text-[11px] border border-slate-300 rounded px-1 py-1 w-32 bg-white"
                            value={l.driver_id} disabled={l.removed}
                            onChange={e => patch(l.key, { driver_id: e.target.value })}
                          >
                            <option value="">— driver —</option>
                            {drivers.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
                          </select>
                        </td>
                        <td className="px-1">
                          <input
                            type="number" inputMode="numeric" min={0} disabled={l.removed}
                            className="w-24 border border-slate-300 rounded px-1 py-1 text-[11px] text-right"
                            value={l.kg} onChange={e => patch(l.key, { kg: e.target.value })}
                          />
                        </td>
                        <td className="px-1">
                          <select
                            className="w-14 border border-slate-300 rounded px-0.5 py-1 text-[11px] bg-white"
                            value={l.src || 'M'} disabled={l.removed}
                            onChange={e => patch(l.key, { src: e.target.value })}
                          >
                            {SOURCE_CODES.map(c => {
                              const rt = rateFor(rates, c, date);
                              return <option key={c} value={c} title={rt ? `${rt.name} → ${rt.destination}` : c}>{c}</option>;
                            })}
                          </select>
                        </td>
                        <td className="px-1">
                          <input list="mcl-places" disabled={l.removed} className="w-36 border border-slate-300 rounded px-1 py-1 text-[11px]"
                            placeholder={defFrom(l)} value={l.from} onChange={e => patch(l.key, { from: e.target.value })} />
                        </td>
                        <td className="px-1">
                          <input list="mcl-places" disabled={l.removed} className="w-36 border border-slate-300 rounded px-1 py-1 text-[11px]"
                            placeholder={defTo(l)} value={l.to} onChange={e => patch(l.key, { to: e.target.value })} />
                        </td>
                        <td className="text-right font-semibold text-emerald-700">{num(l.kg) ? fmt(t.tons, 2) : ''}</td>
                        <td className="text-right">{num(l.kg) ? fmt(t.revenue) : ''}</td>
                        <td className="text-right text-slate-600">{num(l.kg) ? fmt(t.plannedLitres, 1) : ''}</td>
                        <td className="whitespace-nowrap text-right">
                          {l.removed ? (
                            <button type="button" title="Undo delete" className="text-slate-500 hover:text-slate-800 px-1"
                              onClick={() => setLines(prev => prev.map(x => (x.key === l.key ? { ...x, removed: false } : x)))}>
                              <Undo2 className="h-4 w-4" />
                            </button>
                          ) : (
                            <>
                              {isLastLive && (
                                <button type="button" onClick={() => addLine(date)} title="Add another trip on this day" className="text-blue-600 hover:text-blue-800 px-1">
                                  <Plus className="h-4 w-4" />
                                </button>
                              )}
                              <button type="button" onClick={() => removeLine(l)} title="Delete this trip" className="text-red-500 hover:text-red-700 px-1">
                                <Trash2 className="h-4 w-4" />
                              </button>
                            </>
                          )}
                        </td>
                      </tr>
                    );
                  });
                })}
              </tbody>
              <tfoot>
                <tr className="font-bold bg-slate-50">
                  <td className="sticky left-0 bg-slate-50">{truck} {week === 'all' ? 'month' : 'week'} total{driverFilter ? ` · ${driverName(driverFilter)}` : ''}</td>
                  <td colSpan={5} className="text-blue-700">{summary.trips} trip{summary.trips === 1 ? '' : 's'}</td>
                  <td className="text-right text-emerald-700">{fmt(summary.tons, 2)}</td>
                  <td className="text-right">{fmt(summary.revenue)}</td>
                  <td className="text-right">{fmt(summary.litres, 1)}</td>
                  <td />
                </tr>
              </tfoot>
            </table>
          </div>
          <p className="text-[11px] text-slate-500 px-1">
            Each line is one trip with its own driver. Use <b>+</b> to add another trip to a day (there is no limit) and the bin to delete one.
            Revenue = weight (tons) × the source's shipping rate for that date. Fuel plan = the source's litres per trip.
            Grey text in From / To is the usual route for the material source; type to use a different place. Press Save to keep your changes.
          </p>
        </>
      )}

      <Modal open={addOpen} onClose={() => setAddOpen(false)} title="Add Trips" size="xl">
        <datalist id="mcl-add-places">
          {placeSuggestions.map(pl => <option key={pl} value={pl} />)}
        </datalist>
        <div className="space-y-5 max-h-[70vh] overflow-y-auto p-1">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <label className="label">Date *</label>
              <input type="date" className="input" value={addDate} onChange={e => setAddDate(e.target.value)} />
            </div>
            <div>
              <label className="label">Truck *</label>
              <select className="input" value={addVehicle} onChange={e => setAddVehicle(e.target.value)}>
                <option value="">Select Truck</option>
                {vehicles.map(v => <option key={v.id} value={v.id}>{v.plate_number}</option>)}
              </select>
            </div>
          </div>

          <div>
            <h4 className="text-xs font-semibold uppercase tracking-wider text-slate-500 mb-2">Trips (each with its own driver)</h4>
            <div className="space-y-3">
              {addTrips.map((t, i) => {
                const rt = rateFor(rates, t.src || 'M', addDate);
                return (
                  <div key={i} className="rounded-xl border border-slate-200 bg-slate-50 p-3">
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-xs font-bold text-slate-700">Trip {i + 1}</span>
                      {addTrips.length > 1 && (
                        <button type="button" className="text-red-500" title="Remove this trip"
                          onClick={() => setAddTrips(list => list.filter((_, idx) => idx !== i))}>
                          <Trash2 className="h-4 w-4" />
                        </button>
                      )}
                    </div>
                    <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
                      <div>
                        <label className="label">Driver</label>
                        <select className="input" value={t.driver} onChange={e => patchNew(i, { driver: e.target.value })}>
                          <option value="">Select Driver</option>
                          {drivers.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
                        </select>
                      </div>
                      <div>
                        <label className="label">Weight (KG) *</label>
                        <input type="number" min={0} inputMode="numeric" className="input" placeholder="e.g. 31200"
                          value={t.kg} onChange={e => patchNew(i, { kg: e.target.value })} />
                      </div>
                      <div>
                        <label className="label">Material source</label>
                        <select className="input" value={t.src} onChange={e => patchNew(i, { src: e.target.value })}>
                          {SOURCE_CODES.map(c => {
                            const r2 = rateFor(rates, c, addDate);
                            return <option key={c} value={c}>{c}{r2?.name ? ` – ${r2.name}` : ''}</option>;
                          })}
                        </select>
                      </div>
                      <div>
                        <label className="label">From (Origin)</label>
                        <input list="mcl-add-places" className="input" placeholder={rt?.name || 'Origin'}
                          value={t.from} onChange={e => patchNew(i, { from: e.target.value })} />
                      </div>
                      <div>
                        <label className="label">To (Destination)</label>
                        <input list="mcl-add-places" className="input" placeholder={rt?.destination || 'Destination'}
                          value={t.to} onChange={e => patchNew(i, { to: e.target.value })} />
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
            <div className="flex flex-wrap items-center justify-between mt-3 gap-2">
              <button type="button" className="btn-secondary flex items-center gap-2 text-xs"
                onClick={() => setAddTrips(list => [...list, blankTrip(list[list.length - 1]?.driver || '', list[list.length - 1]?.src || 'M')])}>
                <Plus className="h-4 w-4" /> Add another trip
              </button>
              <span className="text-xs font-semibold text-slate-700">
                {addTrips.filter(t => Number(t.kg) > 0).length} trip(s) ·{' '}
                <span className="text-emerald-700">
                  {(addTrips.reduce((a, t) => a + (Number(t.kg) || 0), 0) / 1000).toFixed(2)} Tons
                </span>
              </span>
            </div>
            <p className="text-[11px] text-slate-500 mt-2">
              Every trip is saved as its own record with the driver you pick on it. A new trip starts with the driver and source of the one above it.
              Trips are added after any the truck already has on this date.
            </p>
          </div>
        </div>

        <div className="mt-5 flex justify-end gap-2 border-t pt-3">
          <button onClick={() => setAddOpen(false)} className="btn-secondary">Cancel</button>
          <button onClick={saveNewTrips} disabled={addSaving} className="btn-primary" style={{ background: portalColor }}>
            {addSaving ? 'Saving...' : 'Save Trips'}
          </button>
        </div>
      </Modal>

      <MclImportModal open={importOpen} onClose={() => setImportOpen(false)} kind="trips" lookup={{ vehicles, drivers, rates }} onDone={loadMonth} />
      <RatesModal open={ratesOpen} onClose={() => setRatesOpen(false)} rates={rates} onChanged={loadLookups} />
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="card p-4">
      <p className="text-xs text-slate-400">{label}</p>
      <p className="text-2xl font-bold text-slate-800">{value}</p>
    </div>
  );
}

// ---------------------------------------------------------------- rates editor
function RatesModal({ open, onClose, rates, onChanged }: { open: boolean; onClose: () => void; rates: McRate[]; onChanged: () => void }) {
  const { showToast } = useToast();
  const blank = { code: 'M', name: '', destination: '', rate_per_ton: '', fuel_litres: '', effective_from: new Date().toISOString().slice(0, 8) + '01' };
  const [form, setForm] = useState(blank);
  const [busy, setBusy] = useState(false);

  const sorted = useMemo(
    () => [...rates].sort((a, b) => b.effective_from.localeCompare(a.effective_from) || a.code.localeCompare(b.code)),
    [rates],
  );

  const save = async () => {
    if (!form.code || !form.effective_from) return;
    setBusy(true);
    const { error } = await supabase.from('mcl_rates').upsert(
      [{
        sub_account: 'mcl',
        code: form.code.toUpperCase(),
        name: form.name || null,
        destination: form.destination || null,
        rate_per_ton: Number(form.rate_per_ton) || 0,
        fuel_litres: Number(form.fuel_litres) || 0,
        effective_from: form.effective_from,
      }],
      { onConflict: 'sub_account,code,effective_from' },
    );
    setBusy(false);
    if (error) return showToast('Failed: ' + error.message, 'error');
    showToast('Rate saved', 'success');
    onChanged();
  };

  const remove = async (id?: string) => {
    if (!id || !window.confirm('Delete this rate?')) return;
    const { error } = await supabase.from('mcl_rates').delete().eq('id', id);
    if (error) return showToast('Failed: ' + error.message, 'error');
    onChanged();
  };

  const edit = (r: McRate) =>
    setForm({
      code: r.code, name: r.name || '', destination: r.destination || '',
      rate_per_ton: String(r.rate_per_ton), fuel_litres: String(r.fuel_litres), effective_from: r.effective_from,
    });

  return (
    <Modal open={open} onClose={onClose} title="MCL rates & fuel allocation" size="xl">
      <p className="text-xs text-slate-500 mb-3">
        A rate applies from its “effective from” date until a newer one for the same code. To change prices mid-month,
        add the same code again with the new date (this replaces the workbook's “Rate 2” block).
      </p>
      <div className="overflow-x-auto max-h-64 overflow-y-auto border border-slate-200 rounded-lg">
        <table className="data-table text-xs">
          <thead><tr><th>Code</th><th>Material</th><th>To</th><th className="text-right">Rate / ton</th><th className="text-right">Fuel L / trip</th><th>From</th><th /></tr></thead>
          <tbody>
            {sorted.map(r => (
              <tr key={r.id ?? r.code + r.effective_from}>
                <td className="font-bold">{r.code}</td><td>{r.name}</td><td>{r.destination}</td>
                <td className="text-right">{fmt(r.rate_per_ton, 2)}</td><td className="text-right">{fmt(r.fuel_litres, 1)}</td>
                <td>{r.effective_from}</td>
                <td className="whitespace-nowrap">
                  <button onClick={() => edit(r)} className="text-blue-600 text-xs mr-3">Edit</button>
                  <button onClick={() => remove(r.id)} className="text-red-500"><Trash2 className="h-3.5 w-3.5 inline" /></button>
                </td>
              </tr>
            ))}
            {sorted.length === 0 && <tr><td colSpan={7} className="text-center text-slate-400 py-4">No rates yet. Add one below.</td></tr>}
          </tbody>
        </table>
      </div>

      <h4 className="text-xs font-semibold uppercase tracking-wider text-slate-500 mt-4 mb-2">Add / update a rate</h4>
      <div className="grid grid-cols-2 sm:grid-cols-6 gap-2">
        <div><label className="label">Code</label>
          <select className="input" value={form.code} onChange={e => setForm({ ...form, code: e.target.value })}>
            {SOURCE_CODES.map(c => <option key={c}>{c}</option>)}
          </select></div>
        <div><label className="label">Material</label><input className="input" value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} /></div>
        <div><label className="label">To</label><input className="input" value={form.destination} onChange={e => setForm({ ...form, destination: e.target.value })} /></div>
        <div><label className="label">Rate / ton</label><input type="number" step="0.01" className="input" value={form.rate_per_ton} onChange={e => setForm({ ...form, rate_per_ton: e.target.value })} /></div>
        <div><label className="label">Fuel L / trip</label><input type="number" step="0.1" className="input" value={form.fuel_litres} onChange={e => setForm({ ...form, fuel_litres: e.target.value })} /></div>
        <div><label className="label">Effective from</label><input type="date" className="input" value={form.effective_from} onChange={e => setForm({ ...form, effective_from: e.target.value })} /></div>
      </div>
      <div className="mt-4 flex justify-end gap-2">
        <button onClick={onClose} className="btn-secondary">Close</button>
        <button onClick={save} disabled={busy} className="btn-primary flex items-center gap-2"><Plus className="h-4 w-4" /> Save rate</button>
      </div>
    </Modal>
  );
}
