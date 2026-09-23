const { contextBridge, ipcRenderer } = require('electron');
const allowed = new Set(['state', 'windowVisibility', 'usage:refresh', 'retrySave', 'create', 'reorder', 'patch', 'activate', 'send', 'connections', 'queuedMessage', 'commands', 'close', 'delete', 'stop', 'archive', 'restore', 'answer', 'approvalFull', 'trustFolder', 'folder', 'attach', 'capture', 'attachmentData', 'annotate', 'discard', 'clipboard', 'openLink', 'openMarkdown', 'openDocument', 'markdownImage', 'profilePhoto', 'showFolder', 'settings', 'voice', 'voiceCommand', 'terminalStart', 'terminalData', 'terminalInput', 'terminalResize', 'update', 'refresh', 'permissions']);
contextBridge.exposeInMainWorld('haven', {
  invoke(action, args = {}) {
    if (!allowed.has(action)) return Promise.reject(new Error('Unsupported action.'));
    return ipcRenderer.invoke('haven:action', action, args);
  },
  on(channel, callback) {
    if (!['state', 'patch', 'markdown', 'terminal', 'voice', 'focus-composer', 'windowVisibility'].includes(channel)) throw new Error('Unsupported event.');
    const listener = (_event, data) => callback(data);
    ipcRenderer.on('haven:' + channel, listener);
    return () => ipcRenderer.removeListener('haven:' + channel, listener);
  },
});
