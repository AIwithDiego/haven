import { useEffect } from 'react';
import { Bell, ArrowRight } from 'lucide-react';
import type { Session, Toast } from './types';
import './attention-shortcut.css';

export function AttentionShortcut({ sessions, activeId, onPick, toast }: { sessions: Session[]; activeId: string | null; onPick: (id: string) => void; toast: Toast }) {
  const waiting = sessions.filter(s => !s.archived && !s.closed && (s.status === 'waiting' || s.status === 'error'));
  const next = () => {
    if (!waiting.length) { toast('All clear. No tasks need your attention.'); return; }
    const index = waiting.findIndex(s => s.id === activeId);
    onPick(waiting[(index + 1) % waiting.length].id);
    requestAnimationFrame(() => document.querySelector<HTMLElement>('.approval-card, .error-banner')?.focus());
  };
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (!event.metaKey || !event.shiftKey || event.key.toLowerCase() !== 'j' || event.isComposing || document.querySelector('[role="dialog"]')) return;
      event.preventDefault(); next();
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  });
  if (!waiting.length) return null;
  return <button className="attention-shortcut" onClick={next} aria-label={`Needs you: ${waiting.length} ${waiting.length === 1 ? 'task' : 'tasks'}. Go to next task`} aria-keyshortcuts="Meta+Shift+J" title="Jump to the next approval or error (⌘⇧J)">
    <Bell size={15} /><span>Needs you <strong>{waiting.length}</strong><small>Jump to the next task · ⌘⇧J</small></span><ArrowRight size={15} />
  </button>;
}
