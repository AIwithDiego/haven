import fs from 'node:fs';

export const captureModes = ['area', 'area-including-haven', 'haven-window'];
export async function captureTask({ store, attachments, window, exec, show, screenAccess = () => 'unknown' }, id, requestedMode) {
  const task = store.get(id), mode = requestedMode ?? task.captureMode ?? 'area';
  if (!captureModes.includes(mode)) throw new Error('Invalid capture mode.');
  task.captureMode = mode; store.changed();
  const access = mode === 'haven-window' ? 'not-required' : screenAccess();
  if (['denied', 'restricted'].includes(access)) throw new Error(`macOS reports Screen Recording access as ${access} for this running Haven process. Enable Haven in System Settings → Privacy & Security → Screen & System Audio Recording. If the toggle is already on, turn it off and on, then quit and reopen Haven when your tasks can stop. Capture Haven window remains available without this permission.`);
  let attachment, attached = false;
  const hidden = mode === 'area';
  try {
    if (mode === 'haven-window') {
      const image = await window.webContents.capturePage();
      attachment = attachments.create(image.toPNG(), 'Haven window.png', 'image/png');
    } else {
      attachment = attachments.create(Buffer.alloc(0), 'Capture.png', 'image/png');
      if (hidden) window.hide();
      await exec('/usr/sbin/screencapture', ['-i', '-x', '-t', 'png', attachment.path], { timeout: 120000 });
      if (!fs.existsSync(attachment.path) || fs.statSync(attachment.path).size === 0) return null;
      attachment.size = fs.statSync(attachment.path).size;
    }
    store.get(id).attachments.push(attachment); attached = true; store.changed();
    return attachment.id;
  } catch (error) {
    if (error.code === 1 && !error.stderr) return null;
    const detail = String(error.stderr || error.message || '').trim().slice(0, 400);
    throw new Error(`Screen capture failed (macOS access: ${access}). ${detail}${/could not create image|not authorized|permission/i.test(detail) ? ' If Haven is already enabled in Screen Recording, the running process may still need its grant refreshed and a quit/reopen. Capture Haven window is available from the capture menu.' : ' Try selecting an area again, or use Capture Haven window.'}`);
  } finally {
    if (attachment && !attached) attachments.remove(attachment);
    if (hidden) show();
  }
}
