import { useMemo, useState } from 'react';

/**
 * Shared Month + Week filter used on every trip-related list (Trips, Tallies, Fuel, Allowances).
 *
 * - Month options come from the dates actually present in the data (newest first), plus the current month.
 * - Week options belong to the chosen month (Monday → Sunday, clipped to the month). With "All months"
 *   the weeks that appear in the data are listed instead (most recent first).
 * - Dates are compared as "YYYY-MM-DD" strings, so there are no time-zone surprises.
 */

const pad = (n: number) => String(n).padStart(2, '0');
const toStr = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parseStr = (s: string) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const addDays = (s: string, n: number) => { const d = parseStr(s); d.setDate(d.getDate() + n); return toStr(d); };
/** Monday of the week the date falls in */
const weekStartOf = (s: string) => addDays(s, -((parseStr(s).getDay() + 6) % 7));
const monthEnd = (ym: string) => { const [y, m] = ym.split('-').map(Number); return toStr(new Date(y, m, 0)); };
const dayOnly = (v: unknown): string => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : '');

const monthLabel = (ym: string) => {
  const [y, m] = ym.split('-').map(Number);
  return new Date(y, m - 1, 1).toLocaleString('en-GB', { month: 'long', year: 'numeric' });
};
const short = (s: string) => parseStr(s).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });

export interface PeriodOption { value: string; label: string }

export function usePeriodFilter(dates: unknown[]) {
  const [month, setMonthState] = useState('all');   // 'all' | 'YYYY-MM'
  const [week, setWeek] = useState('all');          // 'all' | Monday 'YYYY-MM-DD'

  const days = useMemo(() => {
    const set = new Set<string>();
    dates.forEach(d => { const s = dayOnly(d); if (s) set.add(s); });
    return Array.from(set);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dates]);

  const monthOptions = useMemo<PeriodOption[]>(() => {
    const set = new Set<string>(days.map(d => d.slice(0, 7)));
    set.add(toStr(new Date()).slice(0, 7));
    return Array.from(set).sort().reverse().map(m => ({ value: m, label: monthLabel(m) }));
  }, [days]);

  const weekOptions = useMemo<PeriodOption[]>(() => {
    const label = (start: string, clipStart?: string, clipEnd?: string, n?: number) => {
      let a = start, b = addDays(start, 6);
      if (clipStart && a < clipStart) a = clipStart;
      if (clipEnd && b > clipEnd) b = clipEnd;
      return `${n ? `Week ${n} · ` : ''}${short(a)} – ${short(b)}`;
    };
    if (month !== 'all') {
      const first = `${month}-01`, last = monthEnd(month);
      const out: PeriodOption[] = [];
      let n = 1;
      for (let w = weekStartOf(first); w <= last; w = addDays(w, 7), n++) {
        out.push({ value: w, label: label(w, first, last, n) });
      }
      return out;
    }
    const starts: string[] = Array.from(new Set<string>(days.map((d: string) => weekStartOf(d)))).sort().reverse().slice(0, 30);
    return starts.map(w => ({ value: w, label: label(w) }));
  }, [month, days]);

  const setMonth = (m: string) => { setMonthState(m); setWeek('all'); };
  const clear = () => { setMonthState('all'); setWeek('all'); };

  /** true when a date (YYYY-MM-DD or ISO timestamp) passes the month + week filter */
  const okDate = (value: unknown): boolean => {
    if (month === 'all' && week === 'all') return true;
    const d = dayOnly(value);
    if (!d) return false;
    if (month !== 'all' && d.slice(0, 7) !== month) return false;
    if (week !== 'all' && (d < week || d > addDays(week, 6))) return false;
    return true;
  };

  const active = month !== 'all' || week !== 'all';
  const periodLabel = week !== 'all'
    ? (weekOptions.find(w => w.value === week)?.label ?? 'Selected week')
    : month !== 'all' ? monthLabel(month) : 'All dates';

  return { month, week, setMonth, setWeek, monthOptions, weekOptions, okDate, active, clear, periodLabel };
}

export type PeriodFilterState = ReturnType<typeof usePeriodFilter>;

const selCls = 'rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-800 outline-none focus:border-slate-500';

export function PeriodBar({ f }: { f: PeriodFilterState }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <select value={f.month} onChange={e => f.setMonth(e.target.value)} className={`${selCls} min-w-[10rem]`} aria-label="Filter by month">
        <option value="all">All months</option>
        {f.monthOptions.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
      <select value={f.week} onChange={e => f.setWeek(e.target.value)} className={`${selCls} min-w-[10rem]`} aria-label="Filter by week">
        <option value="all">All weeks</option>
        {f.weekOptions.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
      {f.active && <button onClick={f.clear} className="text-xs font-medium text-slate-500 underline">Clear dates</button>}
    </div>
  );
}

/* ---------- week-only helpers for pages that already have their own month picker (MCL sheets, Allowances) ---------- */

/** Weeks (Monday → Sunday, clipped to the month) that overlap a "YYYY-MM" month */
export function weekOptionsForMonth(ym: string): PeriodOption[] {
  const first = `${ym}-01`, last = monthEnd(ym);
  const out: PeriodOption[] = [];
  let n = 1;
  for (let w = weekStartOf(first); w <= last; w = addDays(w, 7), n++) {
    const a = w < first ? first : w;
    const e = addDays(w, 6);
    const b = e > last ? last : e;
    out.push({ value: w, label: `Week ${n} · ${short(a)} – ${short(b)}` });
  }
  return out;
}

/** true when `date` is inside the Monday-start week `weekStart` (or no week is chosen) */
export const inWeek = (date: string, weekStart: string) => weekStart === 'all' || (date >= weekStart && date <= addDays(weekStart, 6));

export function WeekSelect({ month, value, onChange, className }: { month: string; value: string; onChange: (v: string) => void; className?: string }) {
  const opts = weekOptionsForMonth(month);
  return (
    <select value={value} onChange={e => onChange(e.target.value)} className={className ?? 'input w-full lg:w-52'} aria-label="Filter by week">
      <option value="all">All weeks</option>
      {opts.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  );
}
