import { _electron as electron } from 'playwright';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { Store } from '../electron/core.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'haven-permissions-ui-'));
const store = new Store(root);
const task = store.create({ name: 'Visible permissions', engine: 'claude', cwd: root, profile: 'autonomous' });
store.save();
const app = await electron.launch({ args: ['.'], cwd: process.cwd(), env: { ...process.env, HAVEN_TEST_MODE: '1', HAVEN_DATA_DIR: root } });
try {
  const page = await app.firstWindow();
  await page.getByRole('textbox', { name: 'Message', exact: true }).waitFor();
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(900, 700));
  // Render the real pre-fix stylesheet for reproducible red evidence without
  // changing shared source files or the running installed app.
  if (process.env.HAVEN_BASELINE_CSS === '1') {
    const css = execFileSync('git', ['show', '338baa1:src/styles.css'], { encoding: 'utf8' });
    await page.evaluate(css => { const sheet = new CSSStyleSheet(); sheet.replaceSync(css); document.adoptedStyleSheets = [sheet]; document.querySelectorAll('link[rel="stylesheet"]').forEach(el => el.remove()); }, css);
  }
  await page.locator('.autonomy-badge').waitFor({ state: 'visible', timeout: 2000 });
  const style = await page.locator('.autonomy-badge').evaluate(el => ({ color: getComputedStyle(el).color, background: getComputedStyle(el).backgroundColor, size: getComputedStyle(el).fontSize }));
  assert.deepEqual(style, { color: 'rgb(255, 255, 255)', background: 'rgb(170, 73, 61)', size: '11px' });
  assert.equal(await page.locator('.composer').evaluate(el => getComputedStyle(el).borderTopColor), 'rgb(170, 73, 61)');
  await page.evaluate(async id => window.haven.invoke('send', { id, text: '/clear' }), task.id);
  await page.waitForFunction(async () => { const state = await window.haven.invoke('state'); return state.sessions.find(s => s.id === state.activeId)?.profile === 'normal'; });
  console.log(JSON.stringify({ ok: true, tested: ['autonomy badge at 900px', 'red composer border', 'fresh task uses normal permissions'], data: root }));
} finally { await app.close(); }
