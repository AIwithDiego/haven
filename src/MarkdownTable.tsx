import type { Toast } from './types';
import { useEffect, useRef, type ReactNode } from 'react';
import { Copy } from 'lucide-react';
import { api } from './types';
import { DropMenu, MenuItem } from './components';

type Position = { start: { offset?: number }; end: { offset?: number } };
export function MarkdownTable({ children, source, position, toast }: { children: ReactNode; source: string; position?: Position; toast: Toast }) {
  const ref = useRef<HTMLTableElement>(null);
  useEffect(() => {
    const table = ref.current; if (!table) return;
    const headers = Array.from(table.tHead?.rows[0]?.cells || []);
    headers.forEach((header, column) => {
      const cells = Array.from(table.tBodies).flatMap(body => Array.from(body.rows).map(row => row.cells[column]).filter(Boolean));
      const numeric = cells.length > 0 && cells.every(cell => /^\(?[-+−]?\p{Sc}?\s*\d[\d,.\s]*(?:%|\p{Sc})?\)?$/u.test(cell.textContent?.trim() || ''));
      const alignment = header.style.textAlign;
      for (const cell of [header, ...cells]) {
        if (!alignment && numeric) cell.style.textAlign = 'right';
        if (numeric) cell.style.fontVariantNumeric = 'tabular-nums';
      }
    });
  }, [children]);
  async function copy(format: 'markdown' | 'tsv' | 'formatted') {
    const table = ref.current; if (!table) return;
    const rows = Array.from(table.rows).map(row => Array.from(row.cells).map(cell => cell.innerText.trim()));
    const quote = (text: string) => /[\t\r\n"]/.test(text) ? '"' + text.replaceAll('"', '""') + '"' : text;
    let text = rows.map(row => row.map(quote).join('\t')).join('\n'), html: string | undefined;
    if (format === 'markdown') {
      const start = position?.start.offset, end = position?.end.offset;
      text = start !== undefined && end !== undefined ? source.slice(start, end) : rows.map((row, index) => '| ' + row.map(cell => cell.replaceAll('|', '\\|')).join(' | ') + ' |' + (index === 0 ? '\n| ' + row.map(() => '---').join(' | ') + ' |' : '')).join('\n');
    }
    if (format === 'formatted') {
      const clone = table.cloneNode(true) as HTMLTableElement;
      clone.style.cssText = 'border-collapse:collapse;width:100%;font-family:Arial,sans-serif;color:#222;background:#fff;';
      clone.querySelectorAll<HTMLElement>('th,td').forEach(cell => { const align = cell.style.textAlign || 'left'; cell.style.cssText = `text-align:${align};font-variant-numeric:tabular-nums;padding:8px 12px;border-bottom:1px solid #ccc;`; });
      html = clone.outerHTML;
    }
    try { await api('clipboard', { text, html }); toast('Table copied'); } catch (error: any) { toast(error.message, 'error'); }
  }
  return <div className="table-block"><div className="table-toolbar"><DropMenu label="Table copy options" trigger={<><Copy size={13} />Copy table</>}><MenuItem onSelect={() => copy('markdown')}>Copy table as Markdown</MenuItem><MenuItem onSelect={() => copy('tsv')}>Copy table as TSV</MenuItem><MenuItem onSelect={() => copy('formatted')}>Copy table with formatting</MenuItem></DropMenu></div><div className="table-wrap" tabIndex={0} role="region" aria-label="Scrollable table"><table ref={ref}>{children}</table></div></div>;
}
