import { app, BrowserWindow, ipcMain, protocol, net, dialog, clipboard, ClipboardItem, shell, Notification, Menu, Tray, nativeImage, systemPreferences, powerMonitor, globalShortcut } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createInterface } from 'node:readline';
import { Workspace } from './workspace.mjs';
import { busy } from './core.mjs';
import { captureTask } from './capture.mjs';
import { registerVoiceToggle } from './voice-shortcuts.mjs';
import { resolvePython, voiceConfiguration } from './validation.mjs';
import { agentEnv } from './agents.mjs';
import { openLink, resolveLink, localLinkReview, readerScope } from './links.mjs';
import { readMarkdownImage } from './markdown.mjs';
import { readDocument, isDocumentPath, documentPath, documentLinkBase, documentExtensions } from './documents.mjs';
import { normalizeProfileName, readProfilePhoto } from './profile.mjs';
import { editingMenu } from './context-menu.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const exec = promisify(execFile);
app.setName('Haven');
if (process.env.HAVEN_TEST_MODE === '1' && process.env.HAVEN_DATA_DIR) {
  const isolated = path.join(process.env.HAVEN_DATA_DIR, 'electron-profile');
  fs.mkdirSync(isolated, { recursive: true }); app.setPath('userData', isolated);
}
protocol.registerSchemesAsPrivileged([{ scheme: 'haven', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }]);
const primaryInstance = app.requestSingleInstanceLock();
if (!primaryInstance) app.quit();
let window, workspace, tray, quitting = false;
const voiceTargets = new Map();
const emit = (channel, value) => { if (window && !window.isDestroyed()) window.webContents.send('haven:' + channel, value); };
const show = () => { if (!window) return; window.show(); window.focus(); };

async function loadShellEnvironment() {
  try {
    const { stdout } = await exec('/bin/zsh', ['-ilc', 'env -0'], { timeout: 8000, maxBuffer: 1024 * 1024 });
    const login = {};
    for (const entry of stdout.split('\0')) {
      const match = entry.match(/^([A-Z_][A-Z0-9_]*)=([\s\S]*)$/);
      if (match) login[match[1]] = match[2];
    }
    Object.assign(process.env, agentEnv(login));
  } catch { /* Existing executable discovery remains available. */ }
}
// Shows where a flagged link goes before it opens. Isolated test mode cannot
// drive native dialogs, so it opens without asking (unit tests cover the rule).
async function confirmLink(request) {
  if (process.env.HAVEN_TEST_MODE === '1') return true;
  const shown = value => value.length > 2000 ? `${value.slice(0, 2000)}\n\n(truncated, ${value.length - 2000} more characters not shown)` : value;
  if (request.kind === 'data') {
    const url = new URL(request.url), host = url.hostname || url.protocol;
    const where = { query: `${request.carried} characters in its query string or fragment`, path: 'a long or encoded-looking path', host: 'a long or encoded-looking host name', length: `${url.href.length} characters in total` };
    const carries = (request.signals || ['query']).map(signal => where[signal]).filter(Boolean).join(', ');
    const answer = await dialog.showMessageBox(window, { type: 'warning', message: `Open a link to ${host}?`, detail: `This link may send data to ${host}: it has ${carries}. Links written by an agent can carry what it has read.\n\n${shown(url.href)}`, buttons: ['Cancel', 'Open link'], cancelId: 0, defaultId: 0 });
    return answer.response === 1;
  }
  if (request.kind === 'outside' || request.kind === 'sensitive') {
    const sensitive = request.kind === 'sensitive';
    const answer = await dialog.showMessageBox(window, { type: sensitive ? 'warning' : 'question',
      message: sensitive ? 'Open a file that may hold credentials?' : 'Open a file outside this task’s folder?',
      detail: `${sensitive ? 'This link points into a folder or file type that usually holds keys, tokens or settings. Once it is on screen, a Haven window capture could send it to an agent.' : request.from === 'document' ? 'This link is in the open document and points outside its task’s folder. An agent may have written the document.' : 'This link was written in the conversation and points outside the task’s folder.'}\n\n${shown(request.path)}`,
      buttons: ['Cancel', sensitive ? 'Open anyway' : 'Open'], cancelId: 0, defaultId: sensitive ? 0 : 1 });
    return answer.response === 1;
  }
  return false;
}
function startVoice(enabled) {
  globalShortcut.unregister('CommandOrControl+Shift+Space');
  workspace.store.state.settings.voiceEnabled = enabled;
  workspace.store.changed();
  workspace.voiceProcess?.kill(); workspace.voiceProcess = null;
  if (!enabled) { workspace.voice = { status: 'off', shortcutListening: false }; workspace.publish(); return; }
  if (process.env.HAVEN_TEST_MODE === '1') { workspace.voice = { status: 'ready', shortcutListening: false, message: 'Microphone and global shortcut are disabled in isolated tests.' }; workspace.publish(); return; }
  const config = path.join(workspace.store.root, 'dictation.json');
  fs.writeFileSync(config, JSON.stringify(voiceConfiguration(workspace.store.state.settings)), { mode: 0o600 });
  let python;
  try { python = resolvePython(workspace.store.state.settings.python); }
  catch (error) { workspace.voice = { status: 'error', shortcutListening: false, message: error.message }; workspace.publish(); return; }
  const p = spawn(python, [path.join(workspace.helpers, 'dictation.py'), config], { env: agentEnv(), stdio: ['pipe', 'pipe', 'pipe'] });
  workspace.voiceProcess = p; workspace.voice = { status: 'loading', shortcutListening: false, message: 'Starting local dictation…' }; workspace.publish();
  workspace.voice.toggleListening = registerVoiceToggle(globalShortcut, () => workspace.voice.status, type => {
    if (p.stdin.writable) p.stdin.write(JSON.stringify({ type }) + '\n');
  });
  workspace.publish();
  let stderr = '';
  p.stderr.on('data', d => { stderr = (stderr + d).slice(-2000); });
  p.on('error', e => { if (workspace.voiceProcess !== p) return; workspace.voice = { status: 'error', message: e.message }; workspace.publish(); });
  p.on('exit', code => { if (workspace.voiceProcess === p) { workspace.voiceProcess = null; workspace.voice = { status: code === 0 ? 'off' : 'error', message: code ? stderr || workspace.voice.message || 'Dictation stopped unexpectedly.' : undefined }; workspace.publish(); } });
  createInterface({ input: p.stdout }).on('line', line => {
    try {
      if (workspace.voiceProcess !== p) return;
      const event = JSON.parse(line);
      if (typeof event.shortcutListening === 'boolean') workspace.voice.shortcutListening = event.shortcutListening;
      if (event.shortcutPermission === 'input-monitoring') workspace.voice.shortcutPermission = event.shortcutPermission;
      if (event.type === 'recording') {
        const insideApp = Boolean(window?.isFocused()), id = insideApp ? workspace.store.state.activeId : null;
        voiceTargets.set(event.clipId, { insideApp, sessionId: id }); workspace.voice = { ...workspace.voice, status: 'recording' }; emit('voice', { ...event, insideApp });
      } else if (event.type === 'transcript') {
        const target = voiceTargets.get(event.clipId); voiceTargets.delete(event.clipId);
        workspace.voice = { ...workspace.voice, lastText: event.text, lastOriginal: event.original, lastSeconds: event.seconds };
        if (target?.insideApp) emit('voice', { ...event, ...target });
        else p.stdin.write(JSON.stringify({ type: 'paste', text: event.text, pid: event.pid }) + '\n');
      } else if (event.type === 'error') workspace.voice = { ...workspace.voice, status: 'error', message: event.message };
      else if (event.type === 'state') workspace.voice = { ...workspace.voice, status: event.status, message: event.message || '' };
      else if (event.message) workspace.voice = { ...workspace.voice, message: event.message };
      workspace.publish();
    } catch { /* Third-party library progress belongs on stderr, not the protocol. */ }
  });
}
function mimeFor(name) { return ({ '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.pdf': 'application/pdf', '.txt': 'text/plain', '.md': 'text/markdown', '.json': 'application/json' })[path.extname(name).toLowerCase()] || 'application/octet-stream'; }
function sessionAttachment(id, aid) { const s = workspace.store.get(id), a = s.attachments.find(a => a.id === aid); if (!a) throw new Error('Attachment not found.'); return a; }
function addAttachment(id, data, name, mime) { const s = workspace.store.get(id), a = workspace.attachments.create(data, name, mime); s.attachments.push(a); workspace.store.changed(); return a.id; }

if (primaryInstance) app.whenReady().then(async () => {
  await loadShellEnvironment();
  const root = process.env.HAVEN_DATA_DIR || path.join(app.getPath('appData'), 'Haven');
  const helpers = app.isPackaged ? path.join(process.resourcesPath, 'helpers') : path.join(here, '../helpers');
  try { workspace = new Workspace(root, helpers); }
  catch (e) { dialog.showErrorBox('Haven needs attention', e.message); app.quit(); return; }
  // Isolated desktop checks drive approval requests directly; never set outside test mode.
  if (process.env.HAVEN_TEST_MODE === '1') globalThis.havenTestWorkspace = workspace;
  powerMonitor.on('suspend', () => workspace.suspend()); powerMonitor.on('resume', () => workspace.resume());
  const dist = path.resolve(here, '../dist');
  protocol.handle('haven', request => {
    const url = new URL(request.url), file = path.resolve(dist, '.' + decodeURIComponent(url.pathname));
    if (url.host !== 'app' || !file.startsWith(dist + path.sep)) return new Response('Not found', { status: 404 });
    return net.fetch(pathToFileURL(file).toString());
  });
  window = new BrowserWindow({ width: 1440, height: 960, minWidth: 860, minHeight: 620, show: false,
    title: 'Haven', backgroundColor: '#f5f4ef', titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 20, y: 22 },
    webPreferences: { preload: path.join(here, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: true },
  });
  window.webContents.session.setPermissionRequestHandler((_wc, permission, callback) => callback(permission === 'clipboard-sanitized-write'));
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('context-menu', (_event, params) => {
    const items = editingMenu(params, window.webContents);
    if (items.length) Menu.buildFromTemplate(items).popup({ window });
  });
  window.webContents.on('will-navigate', (event, url) => { if (!url.startsWith('haven://app/')) event.preventDefault(); });
  window.on('close', event => { if (!quitting) { event.preventDefault(); window.hide(); } });
  for (const event of ['show', 'hide', 'minimize', 'restore']) window.on(event, () => emit('windowVisibility', { visible: window.isVisible() && !window.isMinimized() }));
  window.once('ready-to-show', show);
  workspace.on('state', state => emit('state', state));
  workspace.on('patch', patch => emit('patch', patch));
  workspace.on('terminal', event => emit('terminal', event));
  workspace.on('attention', event => {
    if (workspace.store.state.settings.notifications && Notification.isSupported() && (!window.isFocused() || workspace.store.state.activeId !== event.id)) {
      const notice = new Notification({ title: event.title, body: event.body });
      notice.on('click', () => { workspace.store.state.activeId = event.id; workspace.store.changed(); show(); }); notice.show();
    }
  });
  const menu = Menu.buildFromTemplate([
    { label: 'Haven', submenu: [{ label: 'About Haven', role: 'about' }, { type: 'separator' }, { label: 'Show Haven', click: show }, { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' }, { role: 'quit' }] },
    { role: 'editMenu' }, { role: 'viewMenu' }, { role: 'windowMenu' },
  ]); Menu.setApplicationMenu(menu);
  tray = new Tray(nativeImage.createEmpty()); tray.setTitle('◒'); tray.setToolTip('Haven · Your tasks, at home');
  tray.setContextMenu(Menu.buildFromTemplate([{ label: 'Open Haven', click: show }, { label: 'Toggle dictation', click: () => startVoice(!workspace.store.state.settings.voiceEnabled) }, { type: 'separator' }, { label: 'Quit Haven', click: () => app.quit() }])); tray.on('click', show);
  ipcMain.handle('haven:action', async (event, action, args = {}) => {
    if (event.sender !== window.webContents || !event.senderFrame?.url.startsWith('haven://app/')) throw new Error('Untrusted request.');
    const id = args.id;
    switch (action) {
      case 'state': return workspace.snapshot();
      case 'windowVisibility': return window.isVisible() && !window.isMinimized();
      case 'usage:refresh': {
        if (args.engine !== undefined && !['codex', 'claude'].includes(args.engine)) throw new Error('Choose Codex or Claude.');
        return workspace.refreshUsage(args.engine);
      }
      case 'retrySave': return workspace.store.save();
      case 'create': return workspace.create(args);
      case 'reorder': return workspace.store.reorder(id, args);
      case 'patch': return workspace.patch(id, args.patch);
      case 'activate': workspace.store.get(id); workspace.store.state.activeId = id; workspace.store.changed(); return;
      case 'send': return workspace.send(id, args.text, args.attachments, args.mode);
      case 'connections': return workspace.connections(id);
      case 'queuedMessage': return workspace.queuedMessage(id, args.messageId, args.action);
      case 'commands': return workspace.listCommands(id, args.reload === true, args.localOnly === true);
      case 'close': return workspace.closeSession(id);
      case 'delete': return workspace.remove(id);
      case 'stop': return workspace.stop(id);
      case 'archive': return workspace.archive(id);
      case 'restore': return workspace.restore(id);
      case 'answer': return workspace.answer(id, args.answer);
      case 'approvalFull': return workspace.reviewFull(id, args.requestId);
      case 'trustFolder': return workspace.trustFolder(id, args.trusted === true);
      case 'folder': { const result = await dialog.showOpenDialog(window, { properties: ['openDirectory', 'createDirectory'] }); return result.canceled ? null : result.filePaths[0]; }
      case 'attach': {
        if (args.data) {
          if (typeof args.data !== 'string' || args.data.length > 36000000) throw new Error('File is too large.');
          return addAttachment(id, Buffer.from(args.data, 'base64'), args.name, mimeFor(args.name));
        }
        const result = await dialog.showOpenDialog(window, { properties: ['openFile', 'multiSelections'] });
        if (!result.canceled) for (const file of result.filePaths) { if (fs.statSync(file).size > 25 * 1024 * 1024) throw new Error('Attachments must be smaller than 25 MB.'); addAttachment(id, fs.readFileSync(file), path.basename(file), mimeFor(file)); } return;
      }
      case 'capture': {
        try { return await captureTask({ store: workspace.store, attachments: workspace.attachments, window, exec, show, screenAccess: () => process.platform === 'darwin' ? systemPreferences.getMediaAccessStatus('screen') : 'unknown' }, id, args.mode); }
        catch (error) {
          if (process.env.HAVEN_TEST_MODE === '1') throw error;
          const answer = await dialog.showMessageBox(window, { type: 'warning', message: 'Screen capture needs attention', detail: error.message, buttons: ['Close', 'Open Screen Recording settings'], cancelId: 0, defaultId: 0 });
          if (answer.response === 1) await shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture');
          return null;
        }
      }
      case 'attachmentData': return workspace.attachments.preview(sessionAttachment(id, args.attachmentId));
      case 'annotate': {
        const a = sessionAttachment(id, args.attachmentId); if (!workspace.attachments.safe(a) || typeof args.data !== 'string' || !args.data.startsWith('data:image/png;base64,') || args.data.length > 36000000) throw new Error('Invalid annotation.');
        const data = Buffer.from(args.data.split(',')[1], 'base64'); fs.writeFileSync(a.path, data, { mode: 0o600 }); a.mime = 'image/png'; a.size = data.length; a.updatedAt = Date.now(); a.comment = typeof args.comment === 'string' ? args.comment.slice(0, 10000) : ''; workspace.store.changed(); return;
      }
      case 'discard': { const s = workspace.store.get(id), a = sessionAttachment(id, args.attachmentId); workspace.attachments.remove(a); s.attachments = s.attachments.filter(x => x.id !== a.id); workspace.store.changed(); return; }
      case 'clipboard': {
        if (typeof args.text !== 'string' || args.text.length > 2000000) throw new Error('Copy content is invalid.');
        if (typeof args.html === 'string') {
          if (args.html.length > 4000000) throw new Error('Copy content is too large.');
          await clipboard.write([new ClipboardItem({ 'text/plain': args.text, 'text/html': args.html })]);
        } else await clipboard.writeText(args.text);
        return;
      }
      case 'openLink': {
        const documentFile = args.documentPath ? await documentPath(args.documentPath) : undefined;
        const cwd = documentFile ? await documentLinkBase(documentFile) : id ? workspace.store.get(id).cwd : undefined;
        const target = await resolveLink(args.url, cwd);
        // A local link that leaves the task folder shows its real path first;
        // credential locations ask louder. Links inside a Reader document are
        // judged against the task folder holding that document (an agent may
        // have written it), or the document's own folder. Reloading the open
        // document itself is not a new link.
        if (target.kind === 'local' && target.path !== documentFile) {
          const scope = documentFile ? readerScope(documentFile, workspace.store.state.sessions.map(s => s.cwd)) : cwd;
          const review = localLinkReview(target.path, scope);
          if (review && !(await confirmLink({ ...review, from: documentFile ? 'document' : 'chat' }))) return;
        }
        if (target.kind === 'local' && isDocumentPath(target.path)) {
          const document = await readDocument(target.path, target.fragment || '');
          emit('markdown', document); return;
        }
        return openLink(args.url, cwd, shell, confirmLink);
      }
      case 'openDocument':
      case 'openMarkdown': {
        const result = await dialog.showOpenDialog(window, { title: 'Open a file in Haven', properties: ['openFile'], filters: [{ name: 'Documents, data, code and images', extensions: documentExtensions }, { name: 'All files', extensions: ['*'] }] });
        if (result.canceled || !result.filePaths.length) return false;
        if (!isDocumentPath(result.filePaths[0])) { await openLink(result.filePaths[0], undefined, shell, confirmLink); return false; }
        emit('markdown', await readDocument(result.filePaths[0])); return true;
      }
      case 'markdownImage': return readMarkdownImage(args.documentPath, args.src);
      case 'profilePhoto': {
        if (!['choose', 'remove'].includes(args.action)) throw new Error('Choose or remove your profile photo.');
        if (workspace.store.storage.readOnly) throw new Error('Your workspace is read-only. Resolve the storage issue before changing your profile.');
        let photo = '';
        if (args.action === 'choose') {
          const result = await dialog.showOpenDialog(window, { title: 'Choose your profile photo', properties: ['openFile'], filters: [{ name: 'Photos', extensions: ['jpg', 'jpeg', 'png'] }] });
          if (result.canceled || !result.filePaths.length) return false;
          photo = await readProfilePhoto(result.filePaths[0], nativeImage);
        }
        const previous = workspace.store.state.settings.profilePhoto;
        workspace.store.state.settings.profilePhoto = photo;
        if (!workspace.store.save()) { workspace.store.state.settings.profilePhoto = previous; throw new Error(workspace.store.storage.saveError || 'Your photo could not be saved.'); }
        workspace.publish(); return true;
      }
      case 'showFolder': shell.showItemInFolder(workspace.store.get(id).cwd); return;
      case 'settings': {
        const old = workspace.store.state.settings, next = {};
        if ('profileName' in args) {
          if (workspace.store.storage.readOnly) throw new Error('Your workspace is read-only. Resolve the storage issue before changing your profile.');
          next.profileName = normalizeProfileName(args.profileName);
        }
        if ('theme' in args && ['light', 'dark', 'system'].includes(args.theme)) next.theme = args.theme;
        if ('notifications' in args) next.notifications = Boolean(args.notifications);
        if ('voiceShortcut' in args && ['right-option', 'fn'].includes(args.voiceShortcut)) next.voiceShortcut = args.voiceShortcut;
        if ('voiceModel' in args && ['base', 'base.en', 'small', 'medium'].includes(args.voiceModel)) next.voiceModel = args.voiceModel;
        if ('vocabulary' in args && typeof args.vocabulary === 'string') next.vocabulary = args.vocabulary.slice(0, 8000);
        if ('substitutions' in args && Array.isArray(args.substitutions)) next.substitutions = args.substitutions.slice(0, 200).map(r => ({ from: String(r.from).slice(0, 200), to: String(r.to).slice(0, 300) }));
        workspace.store.state.settings = { ...old, ...next };
        if ('profileName' in next && !workspace.store.save()) { workspace.store.state.settings = old; throw new Error(workspace.store.storage.saveError || 'Your profile could not be saved.'); }
        workspace.store.changed();
        if (['voiceShortcut', 'voiceModel', 'vocabulary', 'substitutions'].some(key => key in next)) fs.writeFileSync(path.join(workspace.store.root, 'dictation.json'), JSON.stringify(voiceConfiguration(workspace.store.state.settings)), { mode: 0o600 });
        if (next.voiceShortcut && next.voiceShortcut !== old.voiceShortcut && old.voiceEnabled) startVoice(true);
        return;
      }
      case 'voice': if (args.enabled && process.platform === 'darwin' && process.env.HAVEN_TEST_MODE !== '1') await systemPreferences.askForMediaAccess('microphone'); startVoice(Boolean(args.enabled)); return;
      case 'voiceCommand': if (!['start', 'stop'].includes(args.type)) throw new Error('Invalid recording command.'); workspace.voiceProcess?.stdin.write(JSON.stringify({ type: args.type }) + '\n'); return;
      case 'terminalStart': return workspace.startTerminal(id);
      case 'terminalData': { const s = workspace.store.get(id); if (s.engine !== 'terminal') throw new Error('Not a terminal task.'); return { data: s.terminalBuffer || '', sequence: s.terminalSequence || 0 }; }
      case 'terminalInput': return workspace.terminal(id, { type: 'input', data: args.data });
      case 'terminalResize': return workspace.terminal(id, { type: 'resize', cols: args.cols, rows: args.rows });
      case 'update': return workspace.update(args.engine);
      case 'refresh': return workspace.refresh();
      case 'permissions': {
        const panes = { 'input-monitoring': 'Privacy_ListenEvent', accessibility: 'Privacy_Accessibility', screen: 'Privacy_ScreenCapture', microphone: 'Privacy_Microphone' };
        const pane = panes[args.kind || 'accessibility'];
        if (!pane) throw new Error('Unknown permission pane.');
        if (process.env.HAVEN_TEST_MODE === '1') return pane;
        return shell.openExternal('x-apple.systempreferences:com.apple.preference.security?' + pane);
      }
      default: throw new Error('Unsupported action.');
    }
  });
  await window.loadURL('haven://app/index.html');
  if (process.env.HAVEN_TEST_MODE !== '1') workspace.refresh();
  if (workspace.store.state.settings.voiceEnabled) startVoice(true);
});
app.on('activate', show);
app.on('second-instance', show);
app.on('window-all-closed', () => {});
app.on('before-quit', async event => {
  if (quitting || !workspace) return;
  event.preventDefault();
  if (Object.values(workspace.updates).some(update => update.running)) {
    show();
    await dialog.showMessageBox(window, { type: 'info', message: 'An agent update is still running.', detail: 'Let the update finish before quitting Haven. You can close the window while it completes.', buttons: ['Keep Haven open'] });
    return;
  }
  const active = workspace.store.state.sessions.filter(s => busy(s) || s.status === 'running');
  if (active.length) {
    show();
    const answer = await dialog.showMessageBox(window, { type: 'question', message: `${active.length} task${active.length === 1 ? ' is' : 's are'} still running.`, detail: 'Quitting stops running agents and terminal processes. Your conversations are saved. Close the window to keep work running in the background.', buttons: ['Keep working', 'Stop tasks and quit'], cancelId: 0, defaultId: 0 });
    if (answer.response !== 1) return;
  }
  quitting = true; globalShortcut.unregisterAll(); await workspace.shutdown(); tray?.destroy(); app.quit();
});
