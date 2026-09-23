import { useEffect, useId, useState } from 'react';
import { Camera, Check, LoaderCircle, ShieldCheck, Trash2 } from 'lucide-react';
import { api, type Settings, type Toast } from './types';
import './profile-settings.css';

export function profileWorkspaceName(name = 'You') {
  const trimmed = name.trim() || 'You';
  if (trimmed === 'You') return 'Your workspace';
  return `${trimmed}${/s$/i.test(trimmed) ? '’' : '’s'} workspace`;
}

export function ProfileAvatar({ name = 'You', photo = '', className = '' }: { name?: string; photo?: string; className?: string }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [photo]);
  const initials = (name.trim() || 'You').split(/\s+/).slice(0, 2).map(part => Array.from(part)[0]).join('').toLocaleUpperCase();
  return <span className={`profile-avatar ${className}`} aria-hidden="true">{photo && !failed ? <img src={photo} alt="" draggable={false} onError={() => setFailed(true)} /> : initials}</span>;
}

export function ProfileSettings({ settings, toast }: { settings: Settings; toast: Toast }) {
  const id = useId();
  const savedName = settings.profileName || 'You';
  const [name, setName] = useState(savedName), [saving, setSaving] = useState(false), [photoBusy, setPhotoBusy] = useState(false), [error, setError] = useState('');
  useEffect(() => setName(savedName), [savedName]);
  const normalizedName = name.trim().replace(/\s+/g, ' ');
  const updatePhoto = async (action: 'choose' | 'remove') => {
    setPhotoBusy(true); setError('');
    try {
      if (await api<boolean>('profilePhoto', { action })) toast(action === 'choose' ? 'Your photo is saved' : 'Profile photo removed');
    } catch (e: any) { setError(e.message); }
    finally { setPhotoBusy(false); }
  };
  return <div className="settings-content profile-settings">
    <div className="setting-title"><h3>Make yourself at home.</h3><p>Your name. Your face. A space that feels familiar.</p></div>
    <div className="profile-card">
      <div className="profile-portrait"><ProfileAvatar name={name} photo={settings.profilePhoto} /><span className="profile-portrait-badge" aria-hidden="true"><Camera size={15} /></span></div>
      <div className="profile-photo-details"><h4>{settings.profilePhoto ? 'Looking like you.' : 'Put a face to your space.'}</h4><p>Choose a photo for the sidebar and your messages.</p><div className="profile-photo-actions"><button type="button" className="button secondary" disabled={photoBusy} onClick={() => updatePhoto('choose')}>{photoBusy ? <LoaderCircle size={14} className="spin" /> : <Camera size={14} />}{settings.profilePhoto ? 'Change photo' : 'Choose photo'}</button>{settings.profilePhoto && <button type="button" className="text-button" disabled={photoBusy} onClick={() => updatePhoto('remove')}><Trash2 size={14} />Remove photo</button>}</div><small>PNG or JPEG · up to 15 MB · cropped to a circle</small></div>
    </div>
    <form onSubmit={async e => {
      e.preventDefault(); setSaving(true); setError('');
      try { await api('settings', { profileName: normalizedName }); setName(normalizedName); toast('Your name is saved'); }
      catch (e: any) { setError(e.message); }
      finally { setSaving(false); }
    }}>
      <label className="field" htmlFor={`profile-name-${id}`}><span>Your name</span><input id={`profile-name-${id}`} aria-label="Your name" autoComplete="name" maxLength={80} value={name} onChange={e => setName(e.target.value)} placeholder="What should we call you?" required aria-describedby={`profile-name-help-${id}`} /><small id={`profile-name-help-${id}`}>This is how your workspace introduces itself.</small></label>
      <div className="profile-name-footer"><span className="profile-workspace-preview">{profileWorkspaceName(normalizedName || savedName)}</span><button type="submit" className="button primary" disabled={saving || !normalizedName || normalizedName === savedName}>{saving ? <LoaderCircle size={14} className="spin" /> : <Check size={14} />}Save name</button></div>
    </form>
    {error && <p className="inline-error" role="alert">{error}</p>}
    <div className="profile-local-note"><ShieldCheck size={18} /><p>Your profile stays on this Mac. Haven keeps a small copy of your photo; your original stays untouched.</p></div>
  </div>;
}
