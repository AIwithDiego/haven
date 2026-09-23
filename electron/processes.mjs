const stopping = new WeakMap();
export function stopProcess(proc, input, timeout = 1500) {
  if (!proc || proc.exitCode != null || proc.signalCode != null) return Promise.resolve();
  if (stopping.has(proc)) return stopping.get(proc);
  /** @type {Promise<void>} */
  const stopped = new Promise(resolve => {
    let timer;
    const done = () => { clearTimeout(timer); proc.off('exit', done); proc.off('error', done); resolve(); };
    proc.once('exit', done); proc.once('error', done);
    timer = setTimeout(() => { try { proc.kill('SIGKILL'); } catch {} done(); }, timeout);
    try { if (input && proc.stdin?.writable) proc.stdin.end(input); else proc.kill('SIGTERM'); } catch { done(); }
  });
  stopping.set(proc, stopped); return stopped;
}
export async function bounded(operation, timeout = 2500) {
  let timer;
  try { return await Promise.race([Promise.resolve().then(operation), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Cleanup timed out.')), timeout); })]); }
  finally { clearTimeout(timer); }
}
