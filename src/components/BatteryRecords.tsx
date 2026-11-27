import { useCallback, useEffect, useState } from 'react';
import { X, Battery } from 'lucide-react';
import { supabase } from '@/lib/supabase';
import { LoadingSpinner, EmptyState } from '@/components/Shared';

/**
 * 24V TRUCK BATTERIES RECORD: the paper sheet as a form.
 * Saving one sheet also keeps the spare parts list in step: both batteries become "In Use" spares (category Battery)
 * on that truck, each with an "Installed" history entry, and the batteries they replace are taken off the truck.
 */

const CONDITIONS = ['Brand New', 'Good', 'Weak', 'Dead', 'Swollen', 'Leaking'];
const CHECKS = [
  { k: 'terminals_clean', label: 'Terminals Clean' },
  { k: 'terminals_tight', label: 'Terminals Tight' },
  { k: 'no_swelling', label: 'No Swelling / Leakage' },
  { k: 'electrolyte_ok', label: 'Electrolyte Level OK' },
  { k: 'starter_ok', label: 'Starter Cranking OK' },
  { k: 'charging_ok', label: 'Charging OK' },
];
const ACTIONS = [
  { k: 'fitted_new_pair', label: 'Fitted New Pair' },
  { k: 'replaced_1', label: 'Replaced 1 Battery' },
  { k: 'charged', label: 'Charged' },
  { k: 'topped_up_water', label: 'Topped Up Water' },
  { k: 'cleaned_terminals', label: 'Cleaned Terminals' },
  { k: 'scrapped_warranty', label: 'Scrapped / Warranty' },
];

const inputCls = 'w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-800 outline-none focus:border-slate-500';
const labelCls = 'block text-xs font-semibold text-slate-600 mb-1';
const todayStr = () => new Date().toLocaleDateString('en-CA');
const numOrNull = (v: string) => (v !== '' && !isNaN(Number(v)) ? Number(v) : null);
const fmtDate = (d: string | null | undefined) => {
  if (!d) return '—';
  const dt = new Date(d);
  return isNaN(dt.getTime()) ? '—' : dt.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
};
const daysBetween = (a: string, b: string) => Math.max(0, Math.floor((new Date(b).getTime() - new Date(a).getTime()) / 86400000));

type Batt = { brand: string; serial: string; capacity: string; install_date: string; voltage: string; condition: string; part_type: 'new' | 'rebound'; unit_cost: string };
const emptyBatt = (date: string): Batt => ({ brand: '', serial: '', capacity: '', install_date: date, voltage: '', condition: 'Brand New', part_type: 'new', unit_cost: '' });
const emptyForm = () => {
  const d = todayStr();
  return {
    record_date: d, vehicle_id: '', truck_make: '', chassis_no: '', odometer_km: '', driver_name: '', recorded_by: '',
    b1: emptyBatt(d), b2: emptyBatt(d),
    combined_voltage: '', alternator_voltage: '',
    checks: {} as Record<string, boolean>, actions: {} as Record<string, boolean>,
    supplier: '', remarks: '', next_check_due: '', warranty_expiry: '',
  };
};

function Tick({ checked, label, onChange }: { checked: boolean; label: string; onChange: (v: boolean) => void }) {
  return (
    <label className="flex items-center gap-2 text-sm text-slate-700 cursor-pointer">
      <input type="checkbox" checked={checked} onChange={e => onChange(e.target.checked)} className="h-4 w-4 rounded border-slate-300" />
      {label}
    </label>
  );
}

/* ------------------------------------------------------------------ */
/* Form                                                                */
/* ------------------------------------------------------------------ */

export function BatteryRecordModal({ open, onClose, subAccount, vehicles, drivers, performedBy, portalColor, onSaved, toast }: {
  open: boolean; onClose: () => void; subAccount: string; vehicles: any[]; drivers: string[]; performedBy: string;
  portalColor: string; onSaved: () => void; toast: (m: string, t?: 'success' | 'error') => void;
}) {
  const [form, setForm] = useState(emptyForm());
  const [onTruck, setOnTruck] = useState<any[]>([]);
  const [removeOld, setRemoveOld] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) { setForm({ ...emptyForm(), recorded_by: performedBy }); setOnTruck([]); setRemoveOld(true); }
  }, [open, performedBy]);

  // Batteries already on the chosen truck (they get taken off when the new ones are fitted)
  useEffect(() => {
    if (!open || !form.vehicle_id) { setOnTruck([]); return; }
    let alive = true;
    supabase.from('spare_parts_v2').select('id, serial_number, part_name, installed_date')
      .eq('sub_account', subAccount).eq('category', 'battery').eq('status', 'in_use').eq('current_truck_id', form.vehicle_id)
      .then((r: any) => { if (alive) setOnTruck(r.data || []); });
    return () => { alive = false; };
  }, [open, form.vehicle_id, subAccount]);

  if (!open) return null;

  const set = (patch: Partial<typeof form>) => setForm(f => ({ ...f, ...patch }));
  const setB = (key: 'b1' | 'b2', patch: Partial<Batt>) => setForm(f => ({ ...f, [key]: { ...f[key], ...patch } }));
  const setDate = (v: string) => setForm(f => ({
    ...f, record_date: v,
    b1: { ...f.b1, install_date: f.b1.install_date === f.record_date ? v : f.b1.install_date },
    b2: { ...f.b2, install_date: f.b2.install_date === f.record_date ? v : f.b2.install_date },
  }));
  const pickTruck = (id: string) => {
    const v = vehicles.find(x => x.id === id);
    set({ vehicle_id: id, truck_make: v ? `${v.make || ''} ${v.model || ''}`.trim() : '' });
  };

  const save = async () => {
    const s1 = form.b1.serial.trim(), s2 = form.b2.serial.trim();
    if (!form.vehicle_id) { toast('Choose the truck', 'error'); return; }
    if (!s1 || !s2) { toast('Both batteries need a serial number (two batteries per truck)', 'error'); return; }
    if (s1.toLowerCase() === s2.toLowerCase()) { toast('The two batteries cannot have the same serial number', 'error'); return; }

    const truck = vehicles.find(v => v.id === form.vehicle_id);
    setSaving(true);
    try {
      const partIds: string[] = [];
      for (const [i, b] of [form.b1, form.b2].entries()) {
        const serial = i === 0 ? s1 : s2;
        const install = b.install_date || form.record_date;
        const payload: any = {
          category: 'battery', part_type: b.part_type, status: 'in_use',
          part_name: `${b.brand.trim()} ${b.capacity.trim()} Battery`.replace(/\s+/g, ' ').trim(),
          supplier: form.supplier.trim() || null,
          unit_cost: numOrNull(b.unit_cost),
          current_truck_id: form.vehicle_id, installed_date: install, last_changed_date: install,
        };
        const { data: found } = await supabase.from('spare_parts_v2').select('id').eq('sub_account', subAccount).eq('serial_number', serial).limit(1);
        let id = found?.[0]?.id as string | undefined;
        if (id) {
          const { error } = await supabase.from('spare_parts_v2').update(payload).eq('id', id);
          if (error) throw error;
        } else {
          const note = [i === 0 ? 'Left battery' : 'Right battery', b.condition, b.voltage ? `${b.voltage}V` : ''].filter(Boolean).join(' · ');
          const { data, error } = await supabase.from('spare_parts_v2')
            .insert({ ...payload, sub_account: subAccount, serial_number: serial, notes: note }).select('id').single();
          if (error) throw error;
          id = data?.id;
        }
        if (!id) throw new Error('Could not save battery ' + serial);
        partIds.push(id);
        const { error: hErr } = await supabase.from('spare_part_history').insert({
          spare_part_id: id, truck_id: form.vehicle_id, sub_account: subAccount, action: 'installed', action_date: install,
          performed_by: form.recorded_by || performedBy, reason: 'Battery fitting record',
          notes: `${i === 0 ? 'Left' : 'Right'} battery · ${b.condition}`,
        });
        if (hErr) throw hErr;
      }

      // Take the batteries they replace off the truck
      if (removeOld) {
        const scrapped = !!form.actions.scrapped_warranty;
        for (const old of onTruck.filter(o => !partIds.includes(o.id))) {
          const { error } = await supabase.from('spare_parts_v2').update({
            status: scrapped ? 'retired' : 'in_store', current_truck_id: null, installed_date: null, last_changed_date: form.record_date,
          }).eq('id', old.id);
          if (error) throw error;
          await supabase.from('spare_part_history').insert({
            spare_part_id: old.id, truck_id: form.vehicle_id, sub_account: subAccount, action: scrapped ? 'retired' : 'removed',
            action_date: form.record_date, duration_days: old.installed_date ? daysBetween(old.installed_date, form.record_date) : null,
            performed_by: form.recorded_by || performedBy, reason: 'Replaced at battery fitting',
          });
        }
      }

      const { error: recErr } = await supabase.from('battery_records').insert({
        sub_account: subAccount, record_date: form.record_date,
        vehicle_id: form.vehicle_id, truck_reg: truck?.plate_number || null, truck_make: form.truck_make.trim() || null,
        chassis_no: form.chassis_no.trim() || null, odometer_km: numOrNull(form.odometer_km),
        driver_name: form.driver_name.trim() || null, recorded_by: form.recorded_by.trim() || null,
        b1_part_id: partIds[0], b1_brand: form.b1.brand.trim() || null, b1_serial: s1, b1_capacity: form.b1.capacity.trim() || null,
        b1_install_date: form.b1.install_date || form.record_date, b1_voltage: numOrNull(form.b1.voltage), b1_condition: form.b1.condition,
        b2_part_id: partIds[1], b2_brand: form.b2.brand.trim() || null, b2_serial: s2, b2_capacity: form.b2.capacity.trim() || null,
        b2_install_date: form.b2.install_date || form.record_date, b2_voltage: numOrNull(form.b2.voltage), b2_condition: form.b2.condition,
        combined_voltage: numOrNull(form.combined_voltage), alternator_voltage: numOrNull(form.alternator_voltage),
        checks: form.checks, actions: form.actions,
        supplier: form.supplier.trim() || null, remarks: form.remarks.trim() || null,
        next_check_due: form.next_check_due || null, warranty_expiry: form.warranty_expiry || null,
      });
      if (recErr) throw new Error(`${recErr.message} (has the battery_records migration been run?)`);

      toast('Battery record saved');
      onClose();
      onSaved();
    } catch (err: any) {
      console.error('Battery record error:', err);
      toast(err?.message || 'Could not save battery record', 'error');
    } finally {
      setSaving(false);
    }
  };

  const battBlock = (key: 'b1' | 'b2', title: string) => {
    const b = form[key];
    return (
      <div className="overflow-hidden rounded-lg border border-slate-300">
        <div className="bg-slate-800 px-3 py-1.5 text-xs font-bold tracking-wide text-white">{title}</div>
        <div className="grid grid-cols-1 gap-3 p-3 sm:grid-cols-2">
          <div><label className={labelCls}>Brand / Model</label><input value={b.brand} onChange={e => setB(key, { brand: e.target.value })} className={inputCls} /></div>
          <div><label className={labelCls}>Capacity (Ah) e.g. 150Ah / 180Ah</label><input value={b.capacity} onChange={e => setB(key, { capacity: e.target.value })} className={inputCls} /></div>
          <div><label className={labelCls}>Serial No *</label><input value={b.serial} onChange={e => setB(key, { serial: e.target.value })} className={inputCls} /></div>
          <div><label className={labelCls}>Install date</label><input type="date" value={b.install_date} onChange={e => setB(key, { install_date: e.target.value })} className={inputCls} /></div>
          <div><label className={labelCls}>Voltage (V) · Normal 12.4 – 12.7V</label><input type="number" step="0.01" value={b.voltage} onChange={e => setB(key, { voltage: e.target.value })} className={inputCls} /></div>
          <div>
            <label className={labelCls}>Condition</label>
            <select value={b.condition} onChange={e => setB(key, { condition: e.target.value })} className={inputCls}>
              {CONDITIONS.map(c => <option key={c}>{c}</option>)}
            </select>
          </div>
          <div>
            <label className={labelCls}>Type</label>
            <select value={b.part_type} onChange={e => setB(key, { part_type: e.target.value as 'new' | 'rebound' })} className={inputCls}>
              <option value="new">New</option><option value="rebound">Rebound</option>
            </select>
          </div>
          <div><label className={labelCls}>Cost (KES)</label><input type="number" min="0" step="0.01" value={b.unit_cost} onChange={e => setB(key, { unit_cost: e.target.value })} className={inputCls} /></div>
        </div>
      </div>
    );
  };

  const oldOnTruck = onTruck.filter(o => ![form.b1.serial.trim(), form.b2.serial.trim()].includes(o.serial_number));

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div className="max-h-[94vh] w-full max-w-3xl overflow-y-auto rounded-xl bg-white shadow-xl" onClick={e => e.stopPropagation()}>
        <div className="flex items-start justify-between gap-3 bg-slate-800 px-5 py-4 text-white">
          <div>
            <h3 className="text-base font-bold tracking-wide">24V TRUCK BATTERIES RECORD</h3>
            <p className="text-xs text-slate-300">Only 2 batteries per truck | 2 × 12V in series = 24V system</p>
          </div>
          <button onClick={onClose} className="text-slate-300 hover:text-white" aria-label="Close"><X className="h-5 w-5" /></button>
        </div>

        <div className="space-y-4 p-5">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div><label className={labelCls}>Date *</label><input type="date" value={form.record_date} onChange={e => setDate(e.target.value)} className={inputCls} /></div>
            <div>
              <label className={labelCls}>Truck reg. no. *</label>
              <select value={form.vehicle_id} onChange={e => pickTruck(e.target.value)} className={inputCls}>
                <option value="">Select truck…</option>
                {vehicles.map(v => <option key={v.id} value={v.id}>{v.plate_number}</option>)}
              </select>
            </div>
            <div><label className={labelCls}>Truck make / model</label><input value={form.truck_make} onChange={e => set({ truck_make: e.target.value })} className={inputCls} /></div>
            <div><label className={labelCls}>Chassis no.</label><input value={form.chassis_no} onChange={e => set({ chassis_no: e.target.value })} className={inputCls} /></div>
            <div>
              <label className={labelCls}>Driver / operator</label>
              <input list="battery-driver-list" value={form.driver_name} onChange={e => set({ driver_name: e.target.value })} className={inputCls} />
              <datalist id="battery-driver-list">{drivers.map(d => <option key={d} value={d} />)}</datalist>
            </div>
            <div><label className={labelCls}>Odometer (km)</label><input type="number" min="0" value={form.odometer_km} onChange={e => set({ odometer_km: e.target.value })} className={inputCls} /></div>
            <div className="sm:col-span-2"><label className={labelCls}>Recorded by</label><input value={form.recorded_by} onChange={e => set({ recorded_by: e.target.value })} className={inputCls} /></div>
          </div>

          {battBlock('b1', 'BATTERY 1 - LEFT (12V)')}
          {battBlock('b2', 'BATTERY 2 - RIGHT (12V)')}

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div><label className={labelCls}>Combined 24V system voltage (V) · Normal 24.5 – 25.5V</label><input type="number" step="0.01" value={form.combined_voltage} onChange={e => set({ combined_voltage: e.target.value })} className={inputCls} /></div>
            <div><label className={labelCls}>Alternator charging voltage (V) · Normal 27 – 28V</label><input type="number" step="0.01" value={form.alternator_voltage} onChange={e => set({ alternator_voltage: e.target.value })} className={inputCls} /></div>
          </div>

          <div>
            <p className="mb-2 text-sm font-bold text-slate-800">24V system checks <span className="font-normal text-slate-500">(tick if OK)</span></p>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
              {CHECKS.map(c => <Tick key={c.k} label={c.label} checked={!!form.checks[c.k]} onChange={v => set({ checks: { ...form.checks, [c.k]: v } })} />)}
            </div>
          </div>

          <div>
            <p className="mb-2 text-sm font-bold text-slate-800">Action taken <span className="font-normal text-slate-500">(tick)</span></p>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
              {ACTIONS.map(a => <Tick key={a.k} label={a.label} checked={!!form.actions[a.k]} onChange={v => set({ actions: { ...form.actions, [a.k]: v } })} />)}
            </div>
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <div><label className={labelCls}>Supplier</label><input value={form.supplier} onChange={e => set({ supplier: e.target.value })} className={inputCls} /></div>
            <div><label className={labelCls}>Next check due</label><input type="date" value={form.next_check_due} onChange={e => set({ next_check_due: e.target.value })} className={inputCls} /></div>
            <div><label className={labelCls}>Warranty expiry</label><input type="date" value={form.warranty_expiry} onChange={e => set({ warranty_expiry: e.target.value })} className={inputCls} /></div>
            <div className="sm:col-span-3"><label className={labelCls}>Remarks / warranty / cost</label><textarea rows={2} value={form.remarks} onChange={e => set({ remarks: e.target.value })} className={inputCls} /></div>
          </div>

          {oldOnTruck.length > 0 && (
            <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
              <p className="mb-1.5">
                This truck still has {oldOnTruck.length} other battery{oldOnTruck.length > 1 ? ' ' : ' '}marked In Use:{' '}
                <b>{oldOnTruck.map(o => o.serial_number).join(', ')}</b>. A truck only has two.
              </p>
              <Tick
                checked={removeOld}
                onChange={setRemoveOld}
                label={`Take them off the truck (${form.actions.scrapped_warranty ? 'marked Retired, because "Scrapped / Warranty" is ticked' : 'back to In Store'})`}
              />
            </div>
          )}
          <p className="text-xs text-slate-500">Always replace 24V batteries as a pair. Mixing old and new damages the new one.</p>
        </div>

        <div className="flex justify-end gap-2 border-t border-slate-200 px-5 py-3">
          <button onClick={onClose} className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50">Cancel</button>
          <button onClick={save} disabled={saving} className="rounded-lg px-4 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-60" style={{ background: portalColor }}>
            {saving ? 'Saving...' : 'Save record'}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Records list + read-only sheet                                      */
/* ------------------------------------------------------------------ */

export function BatteryRecordsList({ subAccount, refreshKey, okDate }: { subAccount: string; refreshKey: number; okDate: (d: unknown) => boolean }) {
  const [rows, setRows] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [open, setOpen] = useState<any | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const { data, error } = await supabase.from('battery_records').select('*').eq('sub_account', subAccount)
      .order('record_date', { ascending: false }).order('created_at', { ascending: false });
    setError(error ? `${error.message} (has the battery_records migration been run?)` : '');
    setRows(data || []);
    setLoading(false);
  }, [subAccount]);
  useEffect(() => { load(); }, [load, refreshKey]);

  const visible = rows.filter(r => okDate(r.record_date));
  const today = todayStr();

  if (loading) return <LoadingSpinner message="Loading battery records..." />;
  if (error) return <div className="card p-4 text-sm text-red-700">{error}</div>;
  if (visible.length === 0) {
    return <div className="card"><EmptyState icon={<Battery className="h-8 w-8" />} title="No battery records" message="Use “Record Batteries” to add a battery fitting sheet." /></div>;
  }

  const yes = (m: any, list: { k: string; label: string }[]) => list.filter(x => m?.[x.k]).map(x => x.label);

  return (
    <>
      <div className="card table-wrapper overflow-x-auto">
        <table className="data-table">
          <thead>
            <tr><th>Date</th><th>Truck</th><th>Battery 1 (Left)</th><th>Battery 2 (Right)</th><th>Driver</th><th>Recorded by</th><th>Next check</th></tr>
          </thead>
          <tbody>
            {visible.map(r => (
              <tr key={r.id} onClick={() => setOpen(r)} className="cursor-pointer hover:bg-slate-50">
                <td>{fmtDate(r.record_date)}</td>
                <td className="font-bold text-slate-800">{r.truck_reg || '—'}</td>
                <td>{r.b1_serial}<div className="text-xs text-slate-500">{[r.b1_brand, r.b1_capacity, r.b1_condition].filter(Boolean).join(' · ')}</div></td>
                <td>{r.b2_serial}<div className="text-xs text-slate-500">{[r.b2_brand, r.b2_capacity, r.b2_condition].filter(Boolean).join(' · ')}</div></td>
                <td>{r.driver_name || '—'}</td>
                <td>{r.recorded_by || '—'}</td>
                <td>
                  {fmtDate(r.next_check_due)}
                  {r.next_check_due && r.next_check_due < today && <span className="ml-1.5 rounded-full bg-red-100 px-2 py-0.5 text-xs font-semibold text-red-700">Overdue</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={() => setOpen(null)}>
          <div className="max-h-[92vh] w-full max-w-2xl overflow-y-auto rounded-xl bg-white shadow-xl" onClick={e => e.stopPropagation()}>
            <div className="flex items-start justify-between bg-slate-800 px-5 py-4 text-white">
              <div>
                <h3 className="text-base font-bold tracking-wide">24V TRUCK BATTERIES RECORD</h3>
                <p className="text-xs text-slate-300">{open.truck_reg} · {fmtDate(open.record_date)}</p>
              </div>
              <button onClick={() => setOpen(null)} className="text-slate-300 hover:text-white" aria-label="Close"><X className="h-5 w-5" /></button>
            </div>
            <div className="space-y-4 p-5 text-sm">
              <dl className="grid grid-cols-2 gap-x-4 gap-y-2">
                {([
                  ['Truck make / model', open.truck_make], ['Chassis no.', open.chassis_no], ['Driver / operator', open.driver_name],
                  ['Odometer (km)', open.odometer_km], ['Recorded by', open.recorded_by], ['Supplier', open.supplier],
                ] as [string, any][]).map(([k, v]) => (
                  <div key={k}><dt className="text-xs font-semibold text-slate-500">{k}</dt><dd className="text-slate-800">{v ?? '—'}</dd></div>
                ))}
              </dl>
              {(['b1', 'b2'] as const).map((p, i) => (
                <div key={p} className="overflow-hidden rounded-lg border border-slate-300">
                  <div className="bg-slate-800 px-3 py-1.5 text-xs font-bold tracking-wide text-white">BATTERY {i + 1} - {i === 0 ? 'LEFT' : 'RIGHT'} (12V)</div>
                  <dl className="grid grid-cols-2 gap-x-4 gap-y-2 p-3">
                    {([
                      ['Brand / model', open[`${p}_brand`]], ['Capacity (Ah)', open[`${p}_capacity`]], ['Serial no.', open[`${p}_serial`]],
                      ['Install date', fmtDate(open[`${p}_install_date`])], ['Voltage (V)', open[`${p}_voltage`]], ['Condition', open[`${p}_condition`]],
                    ] as [string, any][]).map(([k, v]) => (
                      <div key={k}><dt className="text-xs font-semibold text-slate-500">{k}</dt><dd className="text-slate-800">{v ?? '—'}</dd></div>
                    ))}
                  </dl>
                </div>
              ))}
              <dl className="grid grid-cols-2 gap-x-4 gap-y-2">
                <div><dt className="text-xs font-semibold text-slate-500">Combined 24V system voltage</dt><dd>{open.combined_voltage ?? '—'}</dd></div>
                <div><dt className="text-xs font-semibold text-slate-500">Alternator charging voltage</dt><dd>{open.alternator_voltage ?? '—'}</dd></div>
                <div><dt className="text-xs font-semibold text-slate-500">Next check due</dt><dd>{fmtDate(open.next_check_due)}</dd></div>
                <div><dt className="text-xs font-semibold text-slate-500">Warranty expiry</dt><dd>{fmtDate(open.warranty_expiry)}</dd></div>
              </dl>
              <div><p className="text-xs font-semibold text-slate-500">System checks OK</p><p className="text-slate-800">{yes(open.checks, CHECKS).join(', ') || '—'}</p></div>
              <div><p className="text-xs font-semibold text-slate-500">Action taken</p><p className="text-slate-800">{yes(open.actions, ACTIONS).join(', ') || '—'}</p></div>
              <div><p className="text-xs font-semibold text-slate-500">Remarks</p><p className="whitespace-pre-wrap text-slate-800">{open.remarks || '—'}</p></div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
