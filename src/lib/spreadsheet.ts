import * as XLSX from 'xlsx';

/**
 * Shared Excel helpers for every bulk upload and template in the app.
 *  - downloadXlsx():  builds a template (.xlsx) with a header row and, optionally, one example row
 *  - readSheetRows(): reads the first sheet of an .xlsx / .xls file into rows of text
 *
 * Dates in the file come back as yyyy-mm-dd, whatever format the cell was shown in, so day and month
 * can never be swapped. Numbers come back as plain digits (no thousands separators).
 */

const pad = (n: number) => String(n).padStart(2, '0');

export function downloadXlsx(
  filename: string,
  headers: string[],
  exampleRow?: (string | number | null | undefined)[],
  sheetName = 'Data',
): void {
  const aoa: (string | number)[][] = [headers];
  if (exampleRow && exampleRow.length) aoa.push(exampleRow.map(v => (v === null || v === undefined ? '' : v)));
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws['!cols'] = headers.map((h, i) => {
    const sample = exampleRow?.[i] !== undefined ? String(exampleRow[i]) : '';
    return { wch: Math.min(40, Math.max(12, h.length + 2, sample.length + 2)) };
  });
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, sheetName);
  XLSX.writeFile(wb, filename.endsWith('.xlsx') ? filename : `${filename}.xlsx`);
}

/** One cell as text. Date cells become yyyy-mm-dd; numbers keep their real value, not the displayed format. */
function cellText(cell: XLSX.CellObject | undefined): string {
  if (!cell || cell.v === undefined || cell.v === null) return '';
  if (cell.t === 'd' && cell.v instanceof Date) {
    const d = cell.v as Date;
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }
  if (cell.t === 'n' && typeof cell.v === 'number') {
    if (cell.z && XLSX.SSF.is_date(String(cell.z))) {
      const p = XLSX.SSF.parse_date_code(cell.v);
      if (p) return `${p.y}-${pad(p.m)}-${pad(p.d)}`;
    }
    return String(cell.v);
  }
  if (cell.t === 'b') return cell.v ? 'true' : 'false';
  return String(cell.v).trim();
}

/** Reads the first sheet of an Excel file. Row 0 is the header row. Completely empty rows are dropped. */
export async function readSheetRows(file: File): Promise<string[][]> {
  const buf = await file.arrayBuffer();
  const wb = XLSX.read(buf, { type: 'array', cellDates: false });
  const ws = wb.Sheets[wb.SheetNames[0]];
  if (!ws || !ws['!ref']) return [];
  const range = XLSX.utils.decode_range(ws['!ref']);
  const rows: string[][] = [];
  for (let r = range.s.r; r <= range.e.r; r++) {
    const row: string[] = [];
    for (let c = range.s.c; c <= range.e.c; c++) {
      row.push(cellText(ws[XLSX.utils.encode_cell({ r, c })]));
    }
    if (row.some(v => v !== '')) rows.push(row);
  }
  return rows;
}

/** True when the file is something the Excel reader can open. */
export function isExcelFile(file: File): boolean {
  return /\.(xlsx|xlsm|xls)$/i.test(file.name);
}
