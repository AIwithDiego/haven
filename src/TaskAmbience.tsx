import { useEffect, useId, useState } from 'react';
import { Check, Leaf, Pause, Play } from 'lucide-react';
import './task-ambience.css';

import type { TaskBackground } from './types';
import { api } from './types';
export type { TaskBackground } from './types';
type BackgroundProps = { background?: TaskBackground; paused?: boolean };
type BackgroundPatch = { background?: TaskBackground; backgroundPaused?: boolean };

const backgrounds: { value: TaskBackground; name: string; description: string }[] = [
  { value: 'off', name: 'Off', description: 'Your familiar, quiet workspace.' },
  { value: 'aurora', name: 'Aurora', description: 'Soft ribbons of green and violet, drifting slowly.' },
  { value: 'ocean', name: 'Ocean', description: 'Gentle blue tides, with room to think.' },
  { value: 'embers', name: 'Embers', description: 'A warm glow and a few wandering sparks.' },
  { value: 'stars', name: 'Stargaze', description: 'A still night sky, passing almost imperceptibly.' },
];

function useReducedMotion() {
  const [reduced, setReduced] = useState(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  useEffect(() => {
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => setReduced(media.matches);
    update(); media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);
  return reduced;
}

function AmbienceScene() {
  return <span className="task-ambience-scene"><i className="ambience-field ambience-field-a" /><i className="ambience-field ambience-field-b" /><i className="ambience-field ambience-field-c" /></span>;
}

/** A decorative sibling of the task content, inside .task-ambience-host. */
export function TaskAmbience({ background = 'off', paused = false }: BackgroundProps) {
  const reduced = useReducedMotion();
  const [hidden, setHidden] = useState(() => document.hidden);
  const [nativeVisible, setNativeVisible] = useState(true);
  useEffect(() => {
    const update = () => setHidden(document.hidden);
    document.addEventListener('visibilitychange', update);
    return () => document.removeEventListener('visibilitychange', update);
  }, []);
  useEffect(() => {
    if (background === 'off') return;
    let active = true, version = 0;
    const unsubscribe = window.haven.on('windowVisibility', ({ visible }: { visible: boolean }) => {
      version++;
      if (active) setNativeVisible(visible);
    });
    // Some macOS hide paths change isVisible without emitting hide or a DOM
    // visibility event. Reconcile while a backdrop is enabled as a fallback.
    const refresh = () => {
      const request = ++version;
      api<boolean>('windowVisibility').then(visible => {
        if (active && request === version) setNativeVisible(visible);
      }).catch(() => {});
    };
    refresh(); const timer = setInterval(refresh, 1000);
    return () => { active = false; clearInterval(timer); unsubscribe(); };
  }, [background]);
  if (background === 'off') return null;
  return <div className="task-ambience" data-background={background} data-paused={paused || reduced || hidden || !nativeVisible} aria-hidden="true"><AmbienceScene /><span className="ambience-reading-veil" /></div>;
}

export function TaskAmbienceChooser({ background = 'off', paused = false, onChange }: BackgroundProps & { onChange: (patch: BackgroundPatch) => void }) {
  const id = useId(), reduced = useReducedMotion();
  const selected = backgrounds.find(option => option.value === background) || backgrounds[0];
  return <fieldset className="ambience-chooser">
    <legend>Task atmosphere</legend>
    <p className="ambience-intro">A quiet backdrop, just for this task.</p>
    <div className="ambience-options">
      {backgrounds.map(option => <label key={option.value} className={`ambience-option ${background === option.value ? 'selected' : ''}`}>
        <input type="radio" name={`task-background-${id}`} value={option.value} checked={background === option.value} aria-label={option.value === 'off' ? 'No background' : `${option.name} background`} onChange={() => onChange({ background: option.value })} />
        <span className="ambience-preview" data-background={option.value} aria-hidden="true">{option.value === 'off' ? <Leaf size={19} strokeWidth={1.25} /> : <AmbienceScene />}</span>
        <span className="ambience-option-name">{option.name}{background === option.value && <Check size={12} aria-hidden="true" />}</span>
      </label>)}
    </div>
    <p id={`ambience-description-${id}`} className="ambience-description" aria-live="polite">{selected.description}</p>
    <div className="ambience-motion-row"><div><strong>Gentle motion</strong><p>{reduced ? 'Still while Reduce Motion is enabled on your Mac.' : background === 'off' ? 'Choose a backdrop to add a little movement.' : 'Pause whenever you need a little more stillness.'}</p></div><button type="button" className={`toggle ${!paused && !reduced && background !== 'off' ? 'on' : ''}`} role="switch" aria-label="Animate task background" aria-checked={!paused && !reduced && background !== 'off'} disabled={reduced || background === 'off'} onClick={() => onChange({ backgroundPaused: !paused })}><span /></button></div>
  </fieldset>;
}

/** Optional compact control beside task timing. */
export function TaskAmbienceControl({ background = 'off', paused = false, onTogglePause, onOpen }: BackgroundProps & { onTogglePause: () => void; onOpen: () => void }) {
  const reduced = useReducedMotion();
  if (background === 'off') return null;
  const name = backgrounds.find(option => option.value === background)?.name || 'Atmosphere';
  return <div className="ambience-control">
    <button type="button" className="ambience-control-name" onClick={onOpen} aria-label="Change task background" title={`${name} background`}><Leaf size={13} aria-hidden="true" /><span>{name}</span></button>
    <button type="button" className="ambience-control-pause" disabled={reduced} aria-label={reduced ? 'Background motion follows Reduce Motion' : paused ? 'Resume background motion' : 'Pause background motion'} title={reduced ? 'Reduce Motion is enabled on your Mac' : paused ? 'Resume background motion' : 'Pause background motion'} onClick={onTogglePause}>{paused || reduced ? <Play size={12} aria-hidden="true" /> : <Pause size={12} aria-hidden="true" />}</button>
  </div>;
}
