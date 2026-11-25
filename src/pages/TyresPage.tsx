import { useEffect, useState, useCallback, useMemo } from 'react';
import { CircleDot, Search, Info } from 'lucide-react';
import { supabase } from '@/lib/supabase';
import { PageHeader } from '@/components/PageHeader';
import { LoadingSpinner, EmptyState } from '@/components/Shared';
import { Modal } from '@/components/Modal';
import { useToast } from '@/components/Toast';
import { MCLArea, SubAccount } from '@/lib/portals';

/**
 * Tyres, read from the Tyre Records app.
 *
 * The person in charge of tyres fits, removes and retreads tyres in the Tyre Records app.
 * This page only READS that data (view `tyres_live`), so nothing is typed in twice.
 * Tyre costs reach the Cost Reports through the `tyre_costs_v` view (see
 * supabase/migrations/20261125120000_tyres_from_tyre_records.sql).
 */

const STATUSES: Record<string, { label: string; cls: string }> = {
  in_store: { label: 'In Store', cls: 'bg-green-100 text-green-700 border-green-200' },
  fitted: { label: 'Fitted', cls: 'bg-blue-100 text-blue-700 border-blue-200' },
  at_rebound: { label: 'At Retreader', cls: 'bg-amber-100 text-amber-700 border-amber-200' },
  disposed: { label: 'Scrapped / Sold', cls: 'bg-red-100 text-red-700 border-red-200' },
};

type ViewKey = 'new' | 'rebound' | 'fitted' | 'at_rebound' | 'disposed';

const VIEWS: { key: ViewKey; label: string }[] = [
  { key: 'new', label: 'New Tyres' },
  { key: 'rebound', label: 'Retreaded Tyres' },
  { key: 'fitted', label: 'Fitted on Trucks' },
  { key: 'at_rebound', label: 'At Retreader' },
  { key: 'disposed', label: 'Scrapped / Sold' },
];

const SUB_OPTIONS = [
  { value: 'all', label: 'All accounts' },
  { value: 'mcl', label: 'MCL' },
  { value: 'csl', label: 'CSL' },
  { value: 'pn_mashru', label: 'PN Mashru' },
  { value: 'tarmal', label: 'Tarmal' },
  { value: 'master', label: 'Not on a truck yet' },
];

const viewOf = (t: any): ViewKey => {
  if (t.status === 'fitted') return 'fitted';
  if (t.status === 'at_rebound') return 'at_rebound';
  if (t.status === 'disposed') return 'disposed';
  return t.tyre_type === 'rebound' ? 'rebound' : 'new';
};

const money = (n: any) => (n === null || n === undefined || n === '' ? '—' : Number(n).toLocaleString());
const inputCls = 'w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-800 outline-none focus:border-slate-500';

export function TyresPage({ portalColor, isMaster = false }: { mclArea?: MCLArea | null; portalColor: string; isMaster?: boolean; forceSubAccount?: SubAccount }) {
  const { showToast } = useToast();
  const [loading, setLoading] = useState(true);
  const [tyres, setTyres] = useState<any[]>([]);
  const [view, setView] = useState<ViewKey>('new');
  const [search, setSearch] = useState('');
  const [sub, setSub] = useState('all');
  const [selected, setSelected] = useState<any | null>(null);
  const [record, setRecord] = useState<any | null>(null);
  const [recordLoading, setRecordLoading] = useState(false);

  const load = useCallback(async () => {
    const all: any[] = [];
    for (let from = 0; ; from += 1000) {
      const { data, error } = await supabase.from('tyres_live').select('*').order('serial_number').range(from, from + 999);
      if (error) {
        (showToast as any)(`Could not load tyres: ${error.message}`, 'error');
        break;
      }
      all.push(...(data || []));
      if (!data || data.length < 1000) break;
    }
    setTyres(all);
    setLoading(false);
  }, [showToast]);

  useEffect(() => { load(); }, [load]);

  // Refresh by itself when the tyre person saves something in the Tyre Records app
  useEffect(() => {
    const ch = supabase.channel('tyres-live-page')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'tyre_records' }, () => { load(); })
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  }, [load]);

  const inScope = useMemo(
    () => (isMaster && sub !== 'all' ? tyres.filter(t => t.sub_account === sub) : tyres),
    [tyres, isMaster, sub],
  );

  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    inScope.forEach(t => { const k = viewOf(t); c[k] = (c[k] || 0) + 1; });
    return c;
  }, [inScope]);

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return inScope.filter(t => {
      if (viewOf(t) !== view) return false;
      if (!q) return true;
      return [t.serial_number, t.brand, t.size, t.plate_number, t.position, t.supplier]
        .some(x => String(x || '').toLowerCase().includes(q));
    });
  }, [inScope, view, search]);

  const totalCost = useMemo(() => visible.reduce((a, t) => a + (Number(t.unit_cost) || 0), 0), [visible]);

  const openTyre = async (t: any) => {
    setSelected(t);
    setRecord(null);
    setRecordLoading(true);
    const { data } = await supabase.from('tyre_records').select('data').eq('id', t.id).maybeSingle();
    setRecord((data as any)?.data || null);
    setRecordLoading(false);
  };

  const moveText = (m: any) => {
    if (m.type === 'fit') return `Fitted${m.temp ? ' (temporary)' : ''}${m.repl ? ` · replacing ${m.repl}` : ''}`;
    if (m.type === 'out') return `Removed → ${m.dest || ''}${m.replBy ? ` · replaced by ${m.replBy}` : ''}`;
    if (m.type === 'ret') return 'Returned from retread';
    return m.type || '';
  };

  return (
    <div className="space-y-5">
      <PageHeader
        title="Tyres"
        subtitle="Read from the Tyre Records app. Fitting, removal and retreads are recorded there."
        icon={<CircleDot className="h-6 w-6" />}
        iconColor={portalColor}
      />

      <div className="flex items-start gap-2 rounded-xl border border-blue-200 bg-blue-50 px-4 py-3 text-xs text-blue-800">
        <Info className="h-4 w-4 mt-0.5 shrink-0" />
        <span>
          This page is read-only and updates by itself. Tyre purchase, retread and repair costs are added to the Cost Reports
          automatically, to the truck the tyre was fitted on.
        </span>
      </div>

      <div className="flex flex-wrap gap-1 border-b border-slate-200">
        {VIEWS.map(v => {
          const active = view === v.key;
          return (
            <button
              key={v.key}
              onClick={() => setView(v.key)}
              className="flex items-center gap-2 px-4 py-2.5 text-sm font-semibold -mb-px border-b-2 transition-colors"
              style={{ borderColor: active ? portalColor : 'transparent', color: active ? portalColor : '#64748b' }}
            >
              {v.label}
              <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-600">{counts[v.key] || 0}</span>
            </button>
          );
        })}
      </div>

      <div className="flex flex-col sm:flex-row gap-2">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400" />
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search by serial number, brand, size or truck..." className={`${inputCls} pl-9`} />
        </div>
        {isMaster && (
          <select value={sub} onChange={e => setSub(e.target.value)} className={`${inputCls} sm:w-52 font-semibold`}>
            {SUB_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        )}
      </div>

      {loading ? (
        <LoadingSpinner message="Loading tyres..." />
      ) : visible.length === 0 ? (
        <div className="card">
          <EmptyState icon={<CircleDot className="h-8 w-8" />} title="No tyres here" message="Nothing matches this section and search." />
        </div>
      ) : (
        <div className="card overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs uppercase text-slate-500 border-b border-slate-200">
                <th className="px-3 py-2">Serial</th>
                <th className="px-3 py-2">Brand / size</th>
                <th className="px-3 py-2">Status</th>
                <th className="px-3 py-2">Truck · position</th>
                <th className="px-3 py-2">Fitted on</th>
                <th className="px-3 py-2 text-right">Cost</th>
              </tr>
            </thead>
            <tbody>
              {visible.map(t => {
                const st = STATUSES[t.status] || STATUSES.in_store;
                return (
                  <tr key={t.id} onClick={() => openTyre(t)} className="border-b border-slate-100 hover:bg-slate-50 cursor-pointer">
                    <td className="px-3 py-2 font-semibold text-slate-800">{t.serial_number}</td>
                    <td className="px-3 py-2">{t.brand || '—'}<div className="text-xs text-slate-500">{t.size || ''}</div></td>
                    <td className="px-3 py-2"><span className={`inline-block rounded-full border px-2 py-0.5 text-xs font-medium ${st.cls}`}>{st.label}</span></td>
                    <td className="px-3 py-2">{t.status === 'fitted' ? <>{t.plate_number}<div className="text-xs text-slate-500">{t.position}</div></> : '—'}</td>
                    <td className="px-3 py-2">{t.fitted_date || '—'}</td>
                    <td className="px-3 py-2 text-right">{money(t.unit_cost)}</td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot>
              <tr className="text-xs text-slate-600">
                <td className="px-3 py-2 font-semibold" colSpan={5}>{visible.length} tyres · purchase cost</td>
                <td className="px-3 py-2 text-right font-semibold">{money(totalCost)}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}

      <Modal open={!!selected} onClose={() => setSelected(null)} title={selected ? `Tyre ${selected.serial_number}` : ''} size="xl">
        {selected && (
          <div className="space-y-4 text-sm">
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
              {[
                ['Brand', selected.brand], ['Size', selected.size], ['Supplier', selected.supplier],
                ['Invoice', selected.invoice_number], ['Received', selected.date_in], ['Purchase cost', money(selected.unit_cost)],
                ['Status', (STATUSES[selected.status] || STATUSES.in_store).label],
                ['Truck', selected.status === 'fitted' ? selected.plate_number : '—'],
                ['Position', selected.status === 'fitted' ? selected.position : '—'],
                ['Retreads', selected.rebound_count],
              ].map(([k, v]) => (
                <div key={String(k)}><div className="text-xs font-semibold text-slate-500">{k}</div><div className="text-slate-800">{v || '—'}</div></div>
              ))}
            </div>

            {recordLoading ? <LoadingSpinner message="Loading history..." /> : record && (
              <>
                <div>
                  <h3 className="text-xs font-bold uppercase text-slate-500 mb-1">Movement history</h3>
                  <div className="overflow-x-auto">
                    <table className="w-full text-xs">
                      <thead><tr className="text-left text-slate-500 border-b"><th className="py-1 pr-3">Date</th><th className="pr-3">Movement</th><th className="pr-3">Truck · position</th><th className="pr-3">Odometer</th><th className="pr-3">Tread</th><th>By</th></tr></thead>
                      <tbody>
                        {(record.moves || []).map((m: any, i: number) => (
                          <tr key={i} className="border-b border-slate-100">
                            <td className="py-1 pr-3">{m.date}</td><td className="pr-3">{moveText(m)}</td>
                            <td className="pr-3">{m.plate ? `${m.plate}, ${m.pos || ''}` : ''}</td>
                            <td className="pr-3">{m.odo}</td><td className="pr-3">{m.tread}</td><td>{m.by}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
                {(record.events || []).length > 0 && (
                  <div>
                    <h3 className="text-xs font-bold uppercase text-slate-500 mb-1">Inspections and repairs</h3>
                    <table className="w-full text-xs">
                      <thead><tr className="text-left text-slate-500 border-b"><th className="py-1 pr-3">Date</th><th className="pr-3">Event</th><th className="pr-3">Pressure</th><th className="pr-3">Tread</th><th className="pr-3">Cost</th><th>Notes</th></tr></thead>
                      <tbody>
                        {record.events.map((e: any, i: number) => (
                          <tr key={i} className="border-b border-slate-100">
                            <td className="py-1 pr-3">{e.date}</td><td className="pr-3">{e.evt}</td><td className="pr-3">{e.psi}</td>
                            <td className="pr-3">{e.tread}</td><td className="pr-3">{e.cost}</td><td>{e.note}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </>
            )}
          </div>
        )}
      </Modal>
    </div>
  );
}
