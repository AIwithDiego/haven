import type { Toast } from './types';
import { ProfileAvatar } from './ProfileSettings';
import { memo, useEffect, useRef, useState, type ReactNode, type MouseEventHandler } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import * as Dropdown from '@radix-ui/react-dropdown-menu';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import '@xterm/xterm/css/xterm.css';
import { X, Check, ArrowUpRight, ChevronDown, Copy, Type, Undo2, MessageSquare, Square, Pencil, Search, FileText } from 'lucide-react';
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { MarkdownTable } from './MarkdownTable';
import { api, type Attachment, type Session, type Message, type Approval, type ApprovalField } from './types';

export const IconButton = ({ label, children, onClick, className = '', disabled = false }: { label: string; children: ReactNode; onClick?: MouseEventHandler<HTMLButtonElement>; className?: string; disabled?: boolean }) => <button className={`icon-button ${className}`} title={label} aria-label={label} onClick={onClick} disabled={disabled}>{children}</button>;
export function Modal({ open, onOpenChange, title, description, children, wide = false }: { open: boolean; onOpenChange: (open: boolean) => void; title: string; description?: string; children: ReactNode; wide?: boolean }) {
  return <Dialog.Root open={open} onOpenChange={onOpenChange}><Dialog.Portal><Dialog.Overlay className="modal-overlay" /><Dialog.Content className={`modal ${wide ? 'wide' : ''}`}><div className="modal-heading"><div><Dialog.Title>{title}</Dialog.Title><Dialog.Description>{description || 'Make this space work for you.'}</Dialog.Description></div><Dialog.Close asChild><button className="icon-button" aria-label="Close dialog"><X size={18} /></button></Dialog.Close></div>{children}</Dialog.Content></Dialog.Portal></Dialog.Root>;
}
export function DropMenu({ label, children, trigger, className = '' }: { label: string; children: ReactNode; trigger: ReactNode; className?: string }) {
  return <Dropdown.Root><Dropdown.Trigger asChild><button className={`menu-trigger ${className}`} aria-label={label}>{trigger}</button></Dropdown.Trigger><Dropdown.Portal><Dropdown.Content className="dropdown" sideOffset={8} align="end">{children}</Dropdown.Content></Dropdown.Portal></Dropdown.Root>;
}
export function MenuItem({ children, onSelect, danger = false }: { children: ReactNode; onSelect: () => void; danger?: boolean }) { return <Dropdown.Item className={`dropdown-item ${danger ? 'danger' : ''}`} onSelect={onSelect}>{children}</Dropdown.Item>; }
export const MenuSeparator = () => <Dropdown.Separator className="dropdown-separator" />;
export function AgentMark({ engine, size = 20 }: { engine: string; size?: number }) {
  if (engine === 'claude') return <span className="agent-mark claude" style={{ fontSize: size + 4 }} aria-hidden="true">✳</span>;
  if (engine === 'codex') return <span className="agent-mark codex" style={{ fontSize: size - 2 }} aria-hidden="true">⌘</span>;
  return <span className="agent-mark shell-mark" style={{ fontSize: size - 2 }} aria-hidden="true">›_</span>;
}
export function Landscape({ small = false }: { small?: boolean }) {
  return <div className={`landscape ${small ? 'small' : ''}`} aria-hidden="true"><div className="landscape-sun" /><div className="cloud cloud-one" /><div className="cloud cloud-two" /><div className="hill hill-back" /><div className="hill hill-mid" /><div className="hill hill-front" /><span className="landscape-spark">✦</span></div>;
}
export function AttachmentThumbnail({ attachment, sessionId }: { attachment: Attachment; sessionId: string }) {
  const [preview, setPreview] = useState<string | null>(null);
  useEffect(() => {
    if (!attachment.mime.startsWith('image/')) return;
    let cancelled = false;
    api<string | null>('attachmentData', { id: sessionId, attachmentId: attachment.id }).then(value => { if (!cancelled) setPreview(value); }).catch(() => {});
    return () => { cancelled = true; };
  }, [sessionId, attachment.id, attachment.size, attachment.updatedAt]);
  return preview ? <img src={preview} alt={attachment.name} /> : <FileText size={24} />;
}
export const MessageView = memo(function MessageView({ message: m, engine, sessionId, onReuse, toast, profileName, profilePhoto }: { message: Message; sessionId: string; engine: string; profileName?: string; profilePhoto?: string; onReuse: (text: string) => void; toast: Toast }) {
  const ref = useRef<HTMLDivElement>(null);
  async function copy(format: string) {
    const el = ref.current;
    let text = m.text;
    if (format !== 'markdown' && el) {
      const plain = el.cloneNode(true) as HTMLElement;
      plain.querySelectorAll('button').forEach(button => button.remove());
      plain.style.cssText = `position:fixed;left:-10000px;width:${el.clientWidth}px;`;
      plain.setAttribute('aria-hidden', 'true'); document.body.appendChild(plain);
      text = plain.innerText; plain.remove();
    }
    let html;
    if (format === 'formatted' && el) {
      const clone = el.cloneNode(true) as HTMLElement;
      clone.querySelectorAll('button').forEach(e => e.remove());
      clone.querySelectorAll('p').forEach(e => e.setAttribute('style', 'white-space:pre-line;'));
      clone.querySelectorAll('pre').forEach(e => e.setAttribute('style', 'white-space:pre-wrap;font-family:monospace;background:#f3f3f3;padding:12px;'));
      clone.querySelectorAll('td,th').forEach(e => e.setAttribute('style', 'border:1px solid #ccc;padding:6px;text-align:left;'));
      html = `<div style="font-family:-apple-system,Arial,sans-serif;font-size:15px;line-height:1.6">${clone.innerHTML}</div>`;
    }
    try { await api('clipboard', { text, html }); toast(`Copied ${format === 'plain' ? 'plain text' : format === 'markdown' ? 'Markdown' : 'with formatting'}`); } catch (error: any) { toast(error.message, 'error'); }
  }
  if (m.role === 'activity') return <details className="activity-message" id={`message-${m.id}`}><summary><span className={m.complete ? 'activity-dot done' : 'activity-dot'} />{m.title || 'Working'}<ChevronDown size={13} /></summary><pre>{m.text}</pre></details>;
  if (m.role === 'system') return <details className="system-message" id={`message-${m.id}`}><summary>{m.text.startsWith('[Haven workspace') ? 'Shared workspace update' : 'Task notice'}<ChevronDown size={13} /></summary><p>{m.text}</p></details>;
  return <article id={`message-${m.id}`} className={`message ${m.role}`}>
    <div className="message-meta">{m.role === 'user' ? <ProfileAvatar name={profileName} photo={profilePhoto} className="user-avatar" /> : <AgentMark engine={engine} />}<strong>{m.role === 'user' ? 'You' : engine === 'claude' ? 'Claude' : 'Codex'}</strong><time>{new Date(m.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time>{m.delivery && <span className="message-delivery">{({ queued: 'Queued', paused: 'Queue paused', unconfirmed: 'Delivery unconfirmed', withdrawn: 'Returned to draft', 'sent-during-run': 'Sent during run', sent: 'Sent from queue' } as Record<string, string>)[m.delivery]}</span>}<div className="message-actions"><IconButton label="Copy plain text" onClick={() => copy('plain')}><Copy size={14} /></IconButton><DropMenu label="More copy options" trigger={<ChevronDown size={13} />}><MenuItem onSelect={() => copy('plain')}>Copy plain text</MenuItem><MenuItem onSelect={() => copy('markdown')}>Copy Markdown</MenuItem><MenuItem onSelect={() => copy('formatted')}>Copy with formatting</MenuItem>{m.role === 'user' && <MenuItem onSelect={() => onReuse(m.text)}>Edit a copy in the composer</MenuItem>}</DropMenu></div></div>
    <div ref={ref} className={`markdown ${m.role === 'user' ? 'user-text' : ''}`}>
      {m.role === 'user' ? m.text : <ReactMarkdown remarkPlugins={[remarkGfm]} urlTransform={url => /^file:/i.test(url) ? url : defaultUrlTransform(url)} components={{
        a: ({ href, children }) => <a href={href} title={linkTitle(href)} onClick={e => { if (href?.startsWith('#')) return; e.preventDefault(); if (href) api('openLink', { url: href, id: sessionId }).catch(e => toast(e.message, 'error')); }}>{children}</a>,
        img: ({ alt, src }) => <a href={src} title={linkTitle(src)} onClick={e => { e.preventDefault(); if (src) api('openLink', { url: src, id: sessionId }).catch(e => toast(e.message, 'error')); }}>Image: {alt || 'Open image'} <ArrowUpRight size={12} /></a>,
        pre: ({ children }) => <pre>{children}</pre>,
        table: ({ children, node }) => <MarkdownTable source={m.text} position={node?.position} toast={toast}>{children}</MarkdownTable>,
      }}>{m.text}</ReactMarkdown>}
    </div>
    {m.role === 'assistant' && /```/.test(m.text) && <div className="code-copies">{[...m.text.matchAll(/```([^\n]*)\n([\s\S]*?)```/g)].map((match, i) => <button key={i} onClick={() => { api('clipboard', { text: match[2].replace(/\n$/, '') }).then(() => toast('Code copied')).catch(e => toast(e.message, 'error')); }}><Copy size={12} />Copy {match[1] || 'code'}{i > 0 ? ` ${i + 1}` : ''}</button>)}</div>}
    {!!m.attachments?.length && <div className="sent-attachments">{m.attachments.map(a => <span key={a.id}>{a.name}{a.expired && <small> · temporary file cleared</small>}</span>)}</div>}
  </article>;
});
export function TerminalView({ session: s, theme, onError }: { session: Session; theme: string; onError: (message: string) => void }) {
  const container = useRef<HTMLDivElement>(null), term = useRef<Terminal | null>(null), search = useRef<SearchAddon | null>(null), resizeTerminal = useRef<(() => void) | null>(null);
  const [needle, setNeedle] = useState('');
  useEffect(() => {
    const terminal = new Terminal({ fontFamily: 'Menlo, Monaco, monospace', fontSize: s.fontSize, lineHeight: 1.35, cursorBlink: true, scrollback: 10000, allowProposedApi: false, theme: { background: theme === 'dark' ? '#202526' : '#fcfbf8', foreground: theme === 'dark' ? '#f1f0e8' : '#273532', cursor: '#60ab92', selectionBackground: '#438f7b55' } });
    term.current = terminal; const fit = new FitAddon(), finder = new SearchAddon(); terminal.loadAddon(fit); terminal.loadAddon(finder); search.current = finder; terminal.open(container.current!);
    let loaded = false, disposed = false; const queued: { data: string; sequence: number }[] = [];
    const off = window.haven.on('terminal', e => { if (e.id !== s.id) return; if (loaded) terminal.write(e.data); else queued.push(e); });
    api<{ data: string; sequence: number }>('terminalData', { id: s.id }).then(snapshot => { if (disposed) return; terminal.write(snapshot.data); for (const event of queued) if (event.sequence > snapshot.sequence) terminal.write(event.data); loaded = true; queued.length = 0; }).catch(e => onError(e.message));
    const resize = () => { try { fit.fit(); api('terminalResize', { id: s.id, cols: terminal.cols, rows: terminal.rows }).catch(() => {}); } catch {} };
    resizeTerminal.current = resize;
    const observer = new ResizeObserver(resize); observer.observe(container.current!); resize();
    const sub = terminal.onData(data => api('terminalInput', { id: s.id, data }).catch(e => onError(e.message)));
    return () => { disposed = true; observer.disconnect(); sub.dispose(); off(); terminal.dispose(); term.current = null; resizeTerminal.current = null; };
  }, [s.id]);
  useEffect(() => { if (term.current) { term.current.options.fontSize = s.fontSize; term.current.options.theme = { background: theme === 'dark' ? '#202526' : '#fcfbf8', foreground: theme === 'dark' ? '#f1f0e8' : '#273532', cursor: '#60ab92', selectionBackground: '#438f7b55' }; resizeTerminal.current?.(); } }, [s.fontSize, theme]);
  return <div className="terminal-wrap"><div className="terminal-toolbar"><Search size={14} /><input aria-label="Find in terminal" placeholder="Find in terminal…" value={needle} onChange={e => { setNeedle(e.target.value); search.current?.findNext(e.target.value); }} onKeyDown={e => { if (e.key === 'Enter') search.current?.findNext(needle); }} /><span>zsh · {s.status}</span>{s.status !== 'running' && !s.closed && !s.archived && <button onClick={() => api('terminalStart', { id: s.id }).catch(e => onError(e.message))}>Reopen terminal</button>}<button onClick={() => { const text = term.current?.getSelection(); if (text) api('clipboard', { text }); }}>Copy selection</button></div><div ref={container} className="terminal" />{s.error && <p className="inline-error">{s.error}</p>}</div>;
}
// Hover shows where a link really goes: link text written by an agent can hide the destination.
export const linkTitle = (href?: string) => { try { const url = new URL(href || ''); return `${url.hostname || url.protocol} · ${url.href.length > 300 ? url.href.slice(0, 300) + '…' : url.href}`; } catch { return href; } };
const count = (n: number) => n.toLocaleString('en');
// Long whitespace runs render as visible markers so padding cannot push the decisive part out of view.
const showGaps = (value: string) => value.split(/([ \t]{8,}|(?:\r?\n[ \t]*){4,})/).map((part, i) => i % 2 === 0 ? part : <span key={i} className="approval-gap">{/\n/.test(part) ? `[${count(part.split('\n').length - 1)} line breaks]` : `[${count(part.length)} spaces]`}</span>);
function ApprovalFields({ fields, idPrefix }: { fields: ApprovalField[] | { label: string; value: string }[]; idPrefix: string }) {
  return <div className="approval-fields">{fields.map((f, i) => {
    const hidden = 'hiddenChars' in f ? f.hiddenChars : 0, chars = 'chars' in f ? f.chars : f.value.length, lines = 'lines' in f ? f.lines : f.value.split('\n').length;
    return <div className="approval-field" key={i}>
      <div className="approval-field-label"><span id={`${idPrefix}-${i}`}>{f.label}</span><small>{count(chars)} chars · {count(lines)} {lines === 1 ? 'line' : 'lines'}</small></div>
      <pre className="approval-value" tabIndex={0} role="region" aria-labelledby={`${idPrefix}-${i}`}>{showGaps(f.value)}</pre>
      {hidden > 0 && <p className="approval-truncated">Truncated, {count(hidden)} chars hidden</p>}
    </div>;
  })}</div>;
}
export function ApprovalCard({ sessionId, request, onError }: { sessionId: string; request: Approval; onError: (text: string) => void }) {
  const [answers, setAnswers] = useState<Record<string, string>>({}), [text, setText] = useState(''), [full, setFull] = useState<{ label: string; value: string }[] | null>(null);
  useEffect(() => { setAnswers({}); setText(''); setFull(null); }, [request.id]);
  const send = (allow: boolean) => api('answer', { id: sessionId, answer: { allow, answers, text, requestId: request.id } }).catch(e => onError(e.message));
  const openFull = () => api('approvalFull', { id: sessionId, requestId: request.id }).then(r => setFull(r.fields)).catch(e => onError(e.message));
  const hidden = request.hiddenChars || 0, blocked = request.kind !== 'questions' && hidden > 0 && !request.reviewed;
  const headingId = `approval-${request.id}`, warningId = `approval-warning-${request.id}`;
  return <section tabIndex={-1} className="approval-card" aria-labelledby={headingId}><div className="eyebrow">{request.kind === 'approval' ? 'YOUR APPROVAL' : 'YOUR INPUT'}</div><h3 id={headingId}>{request.title}</h3>{request.kind === 'questions' ? request.questions?.map(q => <fieldset key={q.id}><legend>{q.question}</legend><div className="answer-options">{q.options?.map(o => <button key={o.label} className={answers[q.id] === o.label ? 'selected' : ''} onClick={() => setAnswers(a => ({ ...a, [q.id]: o.label }))}>{o.label}{o.description && <small>{o.description}</small>}</button>)}</div><input aria-label={`Answer: ${q.question}`} placeholder="Or write your answer…" value={answers[q.id] || ''} onChange={e => setAnswers(a => ({ ...a, [q.id]: e.target.value }))} /></fieldset>) : <>
    {request.fields ? <ApprovalFields fields={request.fields} idPrefix={`${headingId}-field`} /> : request.details && <pre className="approval-value" tabIndex={0} role="region" aria-label="Request details">{request.details}</pre>}
    {hidden > 0 && <div className={`approval-warning ${blocked ? '' : 'reviewed'}`} id={warningId} role="status"><p>{blocked ? `Part of this input is not shown here (${count(hidden)} chars hidden). Allow stays off until you open the full input.` : `You opened the full input (${count(hidden)} chars were hidden here).`}</p>{request.reviewable === false ? <p>This input is too large to review in Haven. Decline it.</p> : <button className="button secondary" onClick={openFull}>{blocked ? 'Review full input' : 'Open full input again'}</button>}</div>}
    {request.kind === 'elicitation' && <textarea aria-label="Tool response JSON" placeholder='Response as JSON, if required' value={text} onChange={e => setText(e.target.value)} />}</>}
    <div className="button-row"><button className="button secondary" onClick={() => send(false)}>Decline</button><button className="button primary" disabled={blocked} aria-describedby={blocked ? warningId : undefined} onClick={() => send(true)}>{request.kind === 'questions' ? 'Send answer' : 'Allow this action'}</button></div>
    {full && <Modal open onOpenChange={open => !open && setFull(null)} title="Full input" description="Everything the agent asked to run, untruncated. Allow applies to exactly this." wide><ApprovalFields fields={full} idPrefix={`${headingId}-full`} /></Modal>}
  </section>;
}

type Mark = { kind: 'rect' | 'arrow' | 'text'; x: number; y: number; x2?: number; y2?: number; text?: string };
export function AnnotationEditor({ attachment, sessionId, onClose, toast }: { attachment: Attachment; sessionId: string; onClose: () => void; toast: Toast }) {
  const canvas = useRef<HTMLCanvasElement>(null), image = useRef<HTMLImageElement | null>(null), origin = useRef<{ x: number; y: number } | null>(null);
  const [cursor, setCursor] = useState({ x: 50, y: 50 }), [keyboardFocus, setKeyboardFocus] = useState(false);
  const [marks, setMarks] = useState<Mark[]>([]), [tool, setTool] = useState<Mark['kind']>('rect'), [comment, setComment] = useState(attachment.comment || ''), [label, setLabel] = useState(''), [ready, setReady] = useState(false);
  const draw = (extra?: Mark) => {
    const c = canvas.current, img = image.current; if (!c || !img) return; const ctx = c.getContext('2d')!;
    ctx.clearRect(0, 0, c.width, c.height); ctx.drawImage(img, 0, 0); const scale = Math.max(1, c.width / 1000); ctx.lineWidth = 3 * scale; ctx.strokeStyle = '#ed5a4f'; ctx.fillStyle = '#ed5a4f'; ctx.font = `600 ${20 * scale}px -apple-system, sans-serif`;
    for (const m of [...marks, ...(extra ? [extra] : [])]) {
      if (m.kind === 'rect') ctx.strokeRect(m.x, m.y, (m.x2 || m.x) - m.x, (m.y2 || m.y) - m.y);
      if (m.kind === 'arrow') { const x2 = m.x2 || m.x, y2 = m.y2 || m.y, angle = Math.atan2(y2 - m.y, x2 - m.x), len = 14 * scale; ctx.beginPath(); ctx.moveTo(m.x, m.y); ctx.lineTo(x2, y2); ctx.lineTo(x2 - len * Math.cos(angle - Math.PI / 6), y2 - len * Math.sin(angle - Math.PI / 6)); ctx.moveTo(x2, y2); ctx.lineTo(x2 - len * Math.cos(angle + Math.PI / 6), y2 - len * Math.sin(angle + Math.PI / 6)); ctx.stroke(); }
      if (m.kind === 'text') { const width = ctx.measureText(m.text || '').width; ctx.fillStyle = '#fffdf3'; ctx.fillRect(m.x - 5, m.y - 24 * scale, width + 10, 31 * scale); ctx.fillStyle = '#bc3c32'; ctx.fillText(m.text || '', m.x, m.y); ctx.fillStyle = '#ed5a4f'; }
    }
  };
  useEffect(() => { const img = new Image(); img.onload = () => { image.current = img; if (canvas.current) { canvas.current.width = img.width; canvas.current.height = img.height; } setCursor({ x: img.width / 2, y: img.height / 2 }); setReady(true); }; let cancelled = false; api<string | null>('attachmentData', { id: sessionId, attachmentId: attachment.id }).then(data => { if (!cancelled && data) img.src = data; }).catch(e => toast(e.message, 'error')); return () => { cancelled = true; img.onload = null; }; }, [attachment.id]);
  useEffect(() => { draw(keyboardFocus && origin.current ? { kind: tool, ...origin.current, x2: cursor.x, y2: cursor.y } : undefined); }, [marks, ready, cursor, keyboardFocus, tool]);
  const keyboardDraw = (e: React.KeyboardEvent<HTMLCanvasElement>) => {
    if (!ready) return;
    const c = canvas.current!, step = e.shiftKey ? 20 : 5;
    const movement: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
    if (movement[e.key]) { e.preventDefault(); const [x, y] = movement[e.key]; setCursor(p => ({ x: Math.max(0, Math.min(c.width, p.x + x)), y: Math.max(0, Math.min(c.height, p.y + y)) })); }
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      if (tool === 'text') { if (label.trim()) setMarks(m => [...m, { kind: 'text', ...cursor, text: label }]); }
      else if (origin.current) { const start = origin.current; origin.current = null; setMarks(m => [...m, { kind: tool, ...start, x2: cursor.x, y2: cursor.y }]); }
      else { origin.current = { ...cursor }; setCursor({ ...cursor }); }
    }
    if (e.key === 'Escape' && origin.current) { e.preventDefault(); e.stopPropagation(); origin.current = null; draw(); }
    if ((e.metaKey || e.ctrlKey) && e.key === 'z') { e.preventDefault(); setMarks(m => m.slice(0, -1)); }
  };
  const point = (e: React.PointerEvent<HTMLCanvasElement>) => { const c = canvas.current!, r = c.getBoundingClientRect(); return { x: (e.clientX - r.left) * c.width / r.width, y: (e.clientY - r.top) * c.height / r.height }; };
  return <Modal open onOpenChange={open => !open && onClose()} title="Make your point." description="Mark the area, add a note, and send. This capture is temporary." wide><div className="annotation-tools"><button className={tool === 'rect' ? 'active' : ''} onClick={() => setTool('rect')}><Square size={16} />Box</button><button className={tool === 'arrow' ? 'active' : ''} onClick={() => setTool('arrow')}><ArrowUpRight size={16} />Arrow</button><button className={tool === 'text' ? 'active' : ''} onClick={() => setTool('text')}><Type size={16} />Label</button><button onClick={() => setMarks(m => m.slice(0, -1))} disabled={!marks.length}><Undo2 size={16} />Undo</button>{tool === 'text' && <input aria-label="Annotation label" placeholder="Label text, then click the image" value={label} onChange={e => setLabel(e.target.value)} />}</div><p id="annotation-help" className="annotation-help">Keyboard: arrow keys move the cursor; Shift moves faster. Enter starts and finishes a box or arrow, or places a label. Escape cancels the current mark. ⌘ Z undoes.</p><div className="annotation-canvas"><div className="annotation-stage"><canvas ref={canvas} tabIndex={0} role="application" aria-describedby="annotation-help" onFocus={() => setKeyboardFocus(true)} onBlur={() => setKeyboardFocus(false)} onKeyDown={keyboardDraw} aria-label="Draw annotations on the screenshot" onPointerDown={e => { const p = point(e); if (tool === 'text') { if (label.trim()) setMarks(m => [...m, { kind: 'text', ...p, text: label }]); return; } origin.current = p; e.currentTarget.setPointerCapture(e.pointerId); }} onPointerMove={e => { if (origin.current) { const p = point(e); draw({ kind: tool, ...origin.current, x2: p.x, y2: p.y }); } }} onPointerUp={e => { if (origin.current) { const p = point(e), start = origin.current; origin.current = null; setMarks(m => [...m, { kind: tool, ...start, x2: p.x, y2: p.y }]); } }} />{keyboardFocus && <span className="annotation-cursor" aria-hidden="true" style={{ left: `${cursor.x / (canvas.current?.width || 1) * 100}%`, top: `${cursor.y / (canvas.current?.height || 1) * 100}%` }} />}</div></div><p className="annotation-help" role="status">{marks.length} marks · Cursor {Math.round(cursor.x)}, {Math.round(cursor.y)}</p><label className="field"><span><MessageSquare size={14} />Comment</span><textarea value={comment} placeholder="What should the agent notice?" onChange={e => setComment(e.target.value)} /></label><div className="modal-footer"><span>Temporary · cleared after the agent's turn</span><button className="button primary" disabled={!ready} onClick={async () => { try { draw(); await api('annotate', { id: sessionId, attachmentId: attachment.id, data: canvas.current!.toDataURL('image/png'), comment }); toast('Annotation saved'); onClose(); } catch (e: any) { toast(e.message, 'error'); } }}><Check size={16} />Done</button></div></Modal>;
}
