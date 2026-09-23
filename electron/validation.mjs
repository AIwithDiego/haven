import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { normalizeStoredContext } from './usage.mjs';
import { isProfilePhoto, normalizeProfileName } from './profile.mjs';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value, max) => typeof value === 'string' && value.length <= max;
export function resolvePython(configured) {
  const candidates = ['/opt/homebrew/bin/python3', '/usr/local/bin/python3', '/usr/bin/python3'];
  const real = file => { try { fs.accessSync(file, fs.constants.X_OK); return fs.statSync(file).isFile() ? fs.realpathSync(file) : null; } catch { return null; } };
  const expected = candidates.map(real).filter(Boolean), selected = typeof configured === 'string' ? real(configured) : null;
  if (selected && expected.includes(selected)) return selected;
  if (expected.length) return expected[0];
  throw new Error('Install Python 3 using Homebrew or the macOS developer tools before using terminals or dictation.');
}
export function validateSettings(saved, defaults, notices) {
  const clean = { ...defaults, substitutions: [] }, input = object(saved) ? saved : {};
  if (input.profileName !== undefined) {
    try { clean.profileName = normalizeProfileName(input.profileName); }
    catch { notices.push('An invalid saved profile name was ignored. You can update it in Your profile.'); }
  }
  if (input.profilePhoto !== undefined) {
    if (isProfilePhoto(input.profilePhoto)) clean.profilePhoto = input.profilePhoto;
    else notices.push('An invalid saved profile photo was ignored. Choose a new photo in Your profile.');
  }
  for (const key of ['notifications', 'voiceEnabled']) if (typeof input[key] === 'boolean') clean[key] = input[key];
  if (['system', 'light', 'dark'].includes(input.theme)) clean.theme = input.theme;
  if (['right-option', 'fn'].includes(input.voiceShortcut)) clean.voiceShortcut = input.voiceShortcut;
  if (['base', 'base.en', 'small', 'medium'].includes(input.voiceModel)) clean.voiceModel = input.voiceModel;
  if (typeof input.voiceLanguage === 'string' && /^[a-z]{2,3}(?:-[A-Z]{2})?$/.test(input.voiceLanguage)) clean.voiceLanguage = input.voiceLanguage;
  if (text(input.vocabulary, 8000)) clean.vocabulary = input.vocabulary;
  if (Array.isArray(input.trustedFolders)) clean.trustedFolders = input.trustedFolders.filter(f => text(f, 4096) && path.isAbsolute(f)).slice(-500);
  if (Array.isArray(input.substitutions)) clean.substitutions = input.substitutions.slice(0, 200).filter(r => object(r) && text(r.from, 200) && text(r.to, 300)).map(r => ({ from: r.from, to: r.to }));
  try {
    clean.python = resolvePython(input.python || defaults.python);
    if (input.python && (!text(input.python, 1000) || !fs.existsSync(input.python) || fs.realpathSync(input.python) !== clean.python)) notices.push('An unrecognized Python executable was ignored. Haven will use the installed Python 3.');
  } catch (error) { notices.push(error.message); }
  return clean;
}
export function validateNativePolicy(policy) {
  if (!object(policy)) return undefined;
  const approval = policy.approvalPolicy, sandbox = policy.sandboxPolicy;
  if (!['untrusted', 'on-failure', 'on-request', 'never'].includes(approval) || !object(sandbox)) return undefined;
  if (!['readOnly', 'workspaceWrite', 'dangerFullAccess', 'externalSandbox'].includes(sandbox.type)) return undefined;
  const clean = { type: sandbox.type };
  if (sandbox.type === 'workspaceWrite') {
    if (!Array.isArray(sandbox.writableRoots) || !sandbox.writableRoots.every(p => text(p, 4096) && path.isAbsolute(p))) return undefined;
    clean.writableRoots = [...sandbox.writableRoots];
    for (const key of ['networkAccess', 'excludeTmpdirEnvVar', 'excludeSlashTmp']) { if (typeof sandbox[key] !== 'boolean') return undefined; clean[key] = sandbox[key]; }
  }
  if (sandbox.type === 'externalSandbox') {
    if (!['restricted', 'enabled'].includes(sandbox.networkAccess)) return undefined;
    clean.networkAccess = sandbox.networkAccess;
  }
  if (policy.approvalsReviewer !== undefined && !['user', 'guardian_subagent'].includes(policy.approvalsReviewer)) return undefined;
  return { approvalPolicy: approval, sandboxPolicy: clean, ...(policy.approvalsReviewer ? { approvalsReviewer: policy.approvalsReviewer } : {}) };
}
function validateAttachments(attachments, needsPath) {
  if (!Array.isArray(attachments) || !attachments.every(a => object(a) && text(a.id, 100) && a.id && text(a.name, 1000) && text(a.mime, 200) && (!needsPath || (text(a.path, 4096) && path.isAbsolute(a.path))) && (a.comment === undefined || typeof a.comment === 'string'))) throw new Error('Invalid saved attachments.');
  return attachments;
}
export function validateMessages(messages) {
  if (!Array.isArray(messages)) throw new Error('Invalid saved transcript.');
  return messages.map(m => {
    if (!object(m) || !text(m.id, 100) || !m.id || typeof m.text !== 'string') throw new Error('Invalid saved message.');
    if (m.attachments !== undefined) validateAttachments(m.attachments, false);
    return { ...m, role: ['user', 'assistant', 'activity', 'system'].includes(m.role) ? m.role : 'system', title: typeof m.title === 'string' ? m.title : undefined };
  });
}
export function validateWorkspace(saved, defaults, notices) {
  if (!object(saved) || !Array.isArray(saved.sessions) || !saved.sessions.every(s => object(s) && text(s.id, 100) && s.id && text(s.name, 300))) throw new Error('Invalid workspace structure.');
  if (new Set(saved.sessions.map(s => s.id)).size !== saved.sessions.length) throw new Error('Duplicate task IDs in workspace.');
  const sessions = saved.sessions.map(s => {
    if (!['claude', 'codex', 'terminal'].includes(s.engine) || typeof s.cwd !== 'string' || !path.isAbsolute(s.cwd) || !Array.isArray(s.messages) || !Array.isArray(s.attachments)) throw new Error('Invalid task structure.');
    const task = { ...s, name: s.name.trim() || 'Untitled task' };
    if (!['normal', 'autonomous', 'gated'].includes(s.profile) || (s.profile === 'gated' && s.engine !== 'claude') || (s.profile !== 'normal' && path.resolve(s.cwd) === path.parse(s.cwd).root)) {
      task.profile = 'normal'; notices.push(`Permissions for “${task.name}” were reset to normal. The filesystem root cannot use elevated permissions.`);
    }
    if (s.nativePolicy !== undefined) { task.nativePolicy = validateNativePolicy(s.nativePolicy); if (!task.nativePolicy) notices.push(`An invalid saved provider policy for “${task.name}” was ignored. Native settings will be read again.`); }
    task.gatedServer = typeof s.gatedServer === 'string' && /^[\w-]{0,100}$/.test(s.gatedServer) ? s.gatedServer : '';
    task.backgroundWork = Array.isArray(s.backgroundWork) ? s.backgroundWork.filter(w => object(w) && text(w.id, 200) && text(w.description, 2000) && ['running', 'starting', 'completed', 'failed', 'stopped', 'unknown'].includes(w.status)).slice(-100).map(w => ({ id: w.id, description: w.description, status: ['running', 'starting'].includes(w.status) ? 'unknown' : w.status, summary: text(w.summary, 4000) ? w.summary : undefined })) : [];
    task.draft = typeof s.draft === 'string' ? s.draft : '';
    task.model = text(s.model, 300) && !/[\r\n\x00-\x1f]/.test(s.model) ? s.model : '';
    task.effort = ['low', 'medium', 'high', 'xhigh', 'max', 'minimal', 'none', ''].includes(s.effort) ? s.effort : '';
    task.color = /^#[0-9a-f]{6}$/i.test(s.color || '') ? s.color : '#438f7b';
    task.font = ['system', 'serif', 'mono'].includes(s.font) ? s.font : 'system';
    task.fontSize = Math.max(13, Math.min(24, Number(s.fontSize) || 16));
    task.background = ['off', 'aurora', 'ocean', 'embers', 'stars'].includes(s.background) ? s.background : 'off';
    task.backgroundPaused = s.backgroundPaused === true;
    task.contextUsage = s.engine !== 'terminal' ? normalizeStoredContext(s.contextUsage) : undefined;
    task.runningMs = Number.isFinite(s.runningMs) && s.runningMs >= 0 ? s.runningMs : 0;
    task.runningSince = Number.isFinite(s.runningSince) && s.runningSince > 0 ? s.runningSince : null;
    task.timeline = Array.isArray(s.timeline) ? s.timeline.filter(event => object(event) && text(event.kind, 300) && Number.isFinite(event.at)).slice(-200) : [];
    for (const key of ['createdAt', 'lastOpenedAt', 'lastFinishedAt', 'timingTrackedAt', 'closedAt', 'archivedAt', 'lastTurnAt']) if (!Number.isFinite(s[key]) || s[key] < 0) delete task[key];
    for (const key of ['archived', 'closed', 'pinned']) task[key] = s[key] === true;
    task.status = ['idle', 'starting', 'working', 'waiting', 'running', 'stopped', 'error', 'interrupted', 'closed'].includes(s.status) ? s.status : 'idle';
    task.error = typeof s.error === 'string' ? s.error : undefined;
    task.messages = validateMessages(s.messages);
    task.attachments = validateAttachments(s.attachments, true);
    task.pendingMessages = Array.isArray(s.pendingMessages) ? s.pendingMessages.map(q => {
      if (!object(q) || !text(q.id, 100) || !text(q.text, 200000) || !Number.isFinite(q.at)) throw new Error('Invalid queued message.');
      return { id: q.id, text: q.text, at: q.at, attachments: validateAttachments(q.attachments, true), mode: q.mode === 'queue' ? 'queue' : 'auto', command: q.command === true, paused: true };
    }) : [];
    return task;
  });
  return { ...saved, savedAt: Number.isFinite(saved.savedAt) && saved.savedAt > 0 ? saved.savedAt : undefined, sessions, settings: validateSettings(saved.settings, defaults, notices), activeId: sessions.some(s => s.id === saved.activeId) ? saved.activeId : null };
}

// The dictation helper's config file gets voice settings only: never the
// profile or the list of folders trusted for Claude project settings.
export function voiceConfiguration(settings) {
  const { profileName, profilePhoto, trustedFolders, ...voiceSettings } = settings; return voiceSettings;
}
