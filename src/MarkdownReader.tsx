import { memo, useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { ArrowLeft, ArrowUpRight, BookOpen, Check, ChevronDown, Copy, FileText, Image as ImageIcon, List, Minus, Plus, RefreshCw, X } from 'lucide-react';
import { MarkdownTable } from './MarkdownTable';
import { linkTitle } from './components';
import { api, type Toast } from './types';
import './markdown-reader.css';

export type MarkdownDocument = { kind: 'markdown' | 'text' | 'table' | 'image'; data?: string; width?: number; height?: number; extension?: string; table?: { rows: string[][]; totalRows: number; columns: number; truncated: boolean; warning: string }; path: string; name: string; content: string; size: number; modifiedAt: number; fragment?: string };
type Heading = { id: string; text: string; level: number };
type MarkdownNode = { type: string; value?: string; alt?: string; depth?: number; children?: MarkdownNode[]; position?: { start?: { line?: number } }; data?: { hProperties?: Record<string, unknown> } };
const headingText = (node: MarkdownNode): string => node.value || node.alt || node.children?.map(headingText).join('') || '';

// Generate IDs from the parsed Markdown tree so fenced code and formatted headings
// cannot confuse the outline. No raw HTML is enabled in this renderer.
function readerAnchors() {
  return (tree: MarkdownNode) => {
    const used = new Set<string>();
    const visit = (node: MarkdownNode) => {
      if (node.type === 'heading') {
        const base = headingText(node).trim().toLowerCase().replace(/[^\p{L}\p{N}\p{M}\s_-]/gu, '').replace(/\s/g, '-') || 'section';
        let slug = base, index = 0;
        while (used.has(slug)) slug = `${base}-${++index}`;
        used.add(slug);
        node.data = { ...node.data, hProperties: { ...node.data?.hProperties, id: `reader-${slug}`, tabIndex: -1, 'data-source-line': node.position?.start?.line } };
      }
      node.children?.forEach(visit);
    };
    visit(tree);
  };
}

function moveToAnchor(article: HTMLElement | null, fragment: string) {
  if (!article) return;
  let decoded = fragment.replace(/^#/, '');
  try { decoded = decodeURIComponent(decoded); } catch { /* A literal invalid escape can still be a heading. */ }
  const candidates = Array.from(article.querySelectorAll<HTMLElement>('[id]'));
  let target = candidates.find(element => element.id === `reader-${decoded}` || element.id === decoded);
  const line = decoded.match(/^L(\d+)/i);
  if (!target && line) target = candidates.filter(element => Number(element.dataset.sourceLine) <= Number(line[1])).at(-1);
  if (!target) return;
  target.scrollIntoView({ block: 'start', behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' });
  target.focus({ preventScroll: true });
}

const ReaderImage = memo(function ReaderImage({ src, alt, documentPath, navigate }: { src: string; alt: string; documentPath: string; navigate: (href: string) => void }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [data, setData] = useState<string | null>(null), [failed, setFailed] = useState(false);
  const remote = /^(https?:)?\/\//i.test(src);
  useEffect(() => {
    setData(null); setFailed(false);
    if (remote || !src) return;
    let cancelled = false;
    const observer = new IntersectionObserver(entries => {
      if (!entries.some(entry => entry.isIntersecting)) return;
      observer.disconnect();
      api<string | null>('markdownImage', { documentPath, src }).then(value => { if (!cancelled) { setData(value); setFailed(!value); } }).catch(() => { if (!cancelled) setFailed(true); });
    }, { rootMargin: '200px' });
    if (ref.current) observer.observe(ref.current);
    return () => { cancelled = true; observer.disconnect(); };
  }, [src, documentPath, remote]);
  return <span ref={ref} className={`reader-image ${data ? 'loaded' : ''}`}>
    {data ? <img src={data} alt={alt} loading="lazy" onError={() => { setData(null); setFailed(true); }} /> : <button className="reader-image-link" onClick={() => navigate(src)} title={linkTitle(src)}><ImageIcon size={18} /><span>{alt || 'Image'}<small>{remote ? 'Open image in browser' : failed ? 'Open image in its viewer' : 'Loading local image…'}</small></span><ArrowUpRight size={14} /></button>}
  </span>;
});

function TablePreview({ document: doc }: { document: MarkdownDocument }) {
  const table = doc.table!;
  const [query, setQuery] = useState(''), [page, setPage] = useState(0), [header, setHeader] = useState(true);
  const filtered = useMemo(() => table.rows.map((cells, index) => ({ cells, index })).slice(header ? 1 : 0).filter(row => !query || row.cells.some(cell => cell.toLowerCase().includes(query.toLowerCase()))), [table.rows, header, query]);
  const pageCount = Math.max(1, Math.ceil(filtered.length / 50));
  return <div className="document-table">
    <div className="document-table-controls"><input aria-label="Filter file rows" placeholder="Find in this table…" value={query} onChange={e => { setQuery(e.target.value); setPage(0); }} /><label><input type="checkbox" checked={header} onChange={e => { setHeader(e.target.checked); setPage(0); }} />First row is a header</label><span>{filtered.length.toLocaleString()} rows{query && ' match'}</span></div>
    {(table.truncated || table.warning) && <p className="document-notice">{table.truncated && `Preview limited to ${table.rows.length.toLocaleString()} rows and ${table.columns} columns. The source has ${table.totalRows.toLocaleString()} rows. `}{table.warning}</p>}
    <div className="document-table-scroll" tabIndex={0} role="region" aria-label="File table"><table><thead><tr><th scope="col">Row</th>{Array.from({ length: table.columns }, (_, index) => <th key={index} scope="col">{header ? table.rows[0]?.[index] || `Column ${index + 1}` : `Column ${index + 1}`}</th>)}</tr></thead><tbody>{filtered.slice(page * 50, page * 50 + 50).map(row => <tr key={row.index}><th scope="row">{row.index + 1}</th>{Array.from({ length: table.columns }, (_, index) => <td key={index}>{row.cells[index] || ''}</td>)}</tr>)}</tbody></table></div>
    {!filtered.length && <p className="document-notice">{query ? 'No rows match this search.' : 'This table has no data rows.'}</p>}
    <div className="document-pagination"><button disabled={!page} onClick={() => setPage(value => value - 1)}>Previous rows</button><span>Page {page + 1} of {pageCount}</span><button disabled={page + 1 >= pageCount} onClick={() => setPage(value => value + 1)}>Next rows</button></div>
  </div>;
}

const ReaderContent = memo(function ReaderContent({ document: doc, article, toast, navigate }: { document: MarkdownDocument; article: RefObject<HTMLElement | null>; toast: Toast; navigate: (href: string) => void }) {
  if (doc.kind !== 'markdown') return <article ref={article} className="document-preview" aria-label="File preview">
    {doc.kind === 'table' ? <TablePreview key={doc.path + doc.modifiedAt} document={doc} /> : doc.kind === 'image' ? <img className="document-image" src={doc.data} alt={doc.name} /> : <pre className="document-code" tabIndex={0}>{doc.content.split('\n').slice(0, 10000).map((line, index) => <span className="document-line" id={`reader-L${index + 1}`} key={index} tabIndex={-1}><span aria-hidden="true">{index + 1}</span><code>{line || ' '}</code></span>)}</pre>}
    {doc.kind === 'text' && doc.content.split('\n').length > 10000 && <p className="document-notice">Showing the first 10,000 lines. Copy includes the full file.</p>}
    {doc.kind === 'text' && !doc.content && <p className="document-notice">This file is empty.</p>}
  </article>;
  return <article ref={article} className="markdown reader-prose" aria-label="Markdown document">
    <ReactMarkdown skipHtml remarkPlugins={[remarkGfm, readerAnchors]} urlTransform={url => /^file:/i.test(url) ? url : defaultUrlTransform(url)} components={{
      a: ({ href, children }) => <a href={href} title={href?.startsWith('#') ? undefined : linkTitle(href)} onClick={event => { event.preventDefault(); if (!href) return; if (href.startsWith('#')) moveToAnchor(article.current, href); else navigate(href); }}>{children}</a>,
      img: ({ src, alt }) => <ReaderImage src={typeof src === 'string' ? src : ''} alt={alt || ''} documentPath={doc.path} navigate={navigate} />,
      pre: ({ children }) => <pre tabIndex={0}>{children}</pre>,
      table: ({ children, node }) => <MarkdownTable source={doc.content} position={node?.position} toast={toast}>{children}</MarkdownTable>,
    }}>{doc.content}</ReactMarkdown>
    {!doc.content.trim() && <div className="reader-empty"><FileText size={32} /><p>This document is empty.</p></div>}
  </article>;
});

export function MarkdownReaderHost({ toast }: { toast: Toast }) {
  const [history, setHistory] = useState<MarkdownDocument[]>([]);
  const returnFocus = useRef<HTMLElement | null>(null), isOpen = useRef(false);
  useEffect(() => window.haven.on('markdown', (document: MarkdownDocument) => {
    if (!document || !['markdown', 'text', 'table', 'image'].includes(document.kind) || typeof document.content !== 'string') return;
    if (!isOpen.current) returnFocus.current = window.document.activeElement instanceof HTMLElement ? window.document.activeElement : null;
    isOpen.current = true;
    setHistory(previous => previous.at(-1)?.path === document.path ? [...previous.slice(0, -1), document] : [...previous.slice(-19), document]);
  }), []);
  const doc = history.at(-1);
  if (!doc) return null;
  return <MarkdownReader document={doc} canGoBack={history.length > 1} onBack={() => setHistory(previous => previous.slice(0, -1))} onClose={() => { isOpen.current = false; setHistory([]); }} onRestoreFocus={() => { if (returnFocus.current?.isConnected) returnFocus.current.focus({ preventScroll: true }); }} toast={toast} />;
}

export function MarkdownReader({ document: doc, onClose, onRestoreFocus, onBack, canGoBack = false, toast }: { document: MarkdownDocument; onClose: () => void; onRestoreFocus?: () => void; onBack?: () => void; canGoBack?: boolean; toast: Toast }) {
  const [viewport, setViewport] = useState<HTMLDivElement | null>(null);
  const article = useRef<HTMLElement>(null), outline = useRef<HTMLDetailsElement>(null);
  const [headings, setHeadings] = useState<Heading[]>([]), [progress, setProgress] = useState(0), [activeHeading, setActiveHeading] = useState('');
  const [size, setSize] = useState(17), [copied, setCopied] = useState(false), [refreshing, setRefreshing] = useState(false);
  const words = useMemo(() => doc.content.trim().split(/\s+/u).filter(Boolean).length, [doc.content]);
  const navigate = useMemo(() => (url: string) => { api('openLink', { url, documentPath: doc.path }).catch(error => toast(error.message, 'error')); }, [doc.path, toast]);

  useEffect(() => {
    const content = article.current, scroll = viewport;
    if (!content || !scroll) return;
    const elements = Array.from(content.querySelectorAll<HTMLElement>('h1,h2,h3,h4,h5,h6'));
    setHeadings(elements.map(element => ({ id: element.id, text: element.textContent || 'Untitled section', level: Number(element.tagName[1]) })));
    scroll.scrollTop = 0; setCopied(false); if (outline.current) outline.current.open = false;
    let frame = 0;
    const update = () => {
      frame = 0;
      const distance = scroll.scrollHeight - scroll.clientHeight;
      setProgress(distance <= 1 ? 100 : Math.max(0, Math.min(100, Math.round(scroll.scrollTop / distance * 100))));
      const edge = scroll.getBoundingClientRect().top + 100;
      const current = elements.filter(element => element.getBoundingClientRect().top <= edge).at(-1) || elements[0];
      setActiveHeading(current?.id || '');
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(update); };
    scroll.addEventListener('scroll', schedule, { passive: true });
    const observer = new ResizeObserver(schedule); observer.observe(content); observer.observe(scroll);
    update();
    if (doc.fragment) moveToAnchor(content, doc.fragment);
    return () => { scroll.removeEventListener('scroll', schedule); observer.disconnect(); cancelAnimationFrame(frame); };
  }, [doc.path, doc.content, doc.fragment, viewport]);

  async function copy() {
    try { await api('clipboard', { text: doc.content }); setCopied(true); toast(doc.kind === 'markdown' ? 'Markdown copied' : 'File contents copied'); }
    catch (error: any) { toast(error.message, 'error'); }
  }
  async function refresh() {
    setRefreshing(true);
    try { await api('openLink', { url: doc.path, documentPath: doc.path }); }
    catch (error: any) { toast(error.message, 'error'); }
    finally { setRefreshing(false); }
  }
  return <Dialog.Root open onOpenChange={open => !open && onClose()}><Dialog.Portal>
    <Dialog.Overlay className="reader-overlay" />
    <Dialog.Content className={`markdown-reader document-reader-${doc.kind}`} onCloseAutoFocus={event => { event.preventDefault(); onRestoreFocus?.(); }} onKeyDown={event => {
      if (event.key === 'Escape' && outline.current?.open) { event.preventDefault(); event.stopPropagation(); outline.current.open = false; outline.current.querySelector('summary')?.focus(); }
    }}>
      <header className="reader-header">
        {canGoBack && <button className="reader-icon" aria-label="Back to previous document" title="Back to previous document" onClick={onBack}><ArrowLeft size={18} /></button>}
        <span className="reader-file-icon" aria-hidden="true"><BookOpen size={20} /></span>
        <div className="reader-file"><span className="reader-eyebrow">HAVEN READER</span><Dialog.Title title={doc.name}>{doc.name}</Dialog.Title></div>
        <div className="reader-actions">
          <button className="reader-copy" disabled={doc.kind === 'image'} onClick={copy} title={doc.kind === 'markdown' ? 'Copy Markdown source' : 'Copy file contents'}>{copied ? <Check size={15} /> : <Copy size={15} />}<span>{copied ? 'Copied' : 'Copy'}</span></button>
          <button className="reader-icon" aria-label="Reload document" title="Reload document" disabled={refreshing} onClick={refresh}><RefreshCw size={16} className={refreshing ? 'spin' : ''} /></button>
          <Dialog.Close asChild><button className="reader-icon reader-close" aria-label={doc.kind === 'markdown' ? 'Close Markdown reader' : 'Close file reader'} title="Close reader · Esc"><X size={20} /></button></Dialog.Close>
        </div>
      </header>
      <div className="reader-toolbar">
        <div className="reader-reading-meta">{doc.kind === 'markdown' ? <><span>{words.toLocaleString()} words</span><span aria-hidden="true">·</span><span>{Math.max(1, Math.ceil(words / 220))} min read</span></> : <><span>{doc.kind === 'image' ? `${doc.width} × ${doc.height}` : doc.kind === 'table' ? `${doc.table?.totalRows.toLocaleString()} rows · ${doc.table?.columns} columns` : `${doc.content.split('\n').length.toLocaleString()} lines`}</span><span> · {Math.max(1, Math.round(doc.size / 1024))} KB</span></>}</div>
        {!!headings.length && <details className="reader-outline" ref={outline}><summary aria-label="Document contents"><List size={15} /><span>Contents</span><ChevronDown size={13} /></summary><nav aria-label="Document sections">{headings.map(heading => <button key={heading.id} aria-current={activeHeading === heading.id ? 'location' : undefined} style={{ paddingLeft: 13 + Math.min(heading.level - 1, 3) * 12 }} onClick={() => { if (outline.current) outline.current.open = false; moveToAnchor(article.current, heading.id); }}>{heading.text}</button>)}</nav></details>}
        <div className="reader-text-size" aria-label="Reading text size"><button aria-label="Decrease reading text size" title="Smaller text" disabled={size <= 15} onClick={() => setSize(value => Math.max(15, value - 1))}><Minus size={13} /></button><span aria-hidden="true">Aa</span><button aria-label="Increase reading text size" title="Larger text" disabled={size >= 23} onClick={() => setSize(value => Math.min(23, value + 1))}><Plus size={13} /></button></div>
      </div>
      <div className="reader-progress" role="progressbar" aria-label="Reading progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress}><span style={{ width: `${progress}%` }} /></div>
      <div ref={setViewport} className="reader-viewport" style={{ fontSize: size }}>
        <div className="reader-page">
        <Dialog.Description className="reader-path" title={doc.path}><FileText size={13} aria-hidden="true" /><span>{doc.path}</span></Dialog.Description>
        <ReaderContent document={doc} article={article} toast={toast} navigate={navigate} />
        <div className="reader-end"><span /><BookOpen size={15} /><span /></div>
        </div>
      </div>
      <footer className="reader-footer"><span>Read only<span className="reader-updated"> · Updated {new Date(doc.modifiedAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}</span></span><span>{progress === 100 ? 'End of document' : `${progress}% read`}</span></footer>
    </Dialog.Content>
  </Dialog.Portal></Dialog.Root>;
}
