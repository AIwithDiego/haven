export function registerVoiceToggle(shortcuts, getStatus, command) {
  return shortcuts.register('CommandOrControl+Shift+Space', () => {
    const status = getStatus();
    if (status === 'ready' || status === 'recording') command(status === 'recording' ? 'stop' : 'start');
  });
}
