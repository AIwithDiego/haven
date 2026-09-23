import { _electron as electron } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { Store } from '../electron/core.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'haven-updates-ui-'));
const project = path.join(root, 'project'); fs.mkdirSync(project);
const store = new Store(root), task = store.create({ name: 'Project studio', engine: 'codex', cwd: project });
const csv = path.join(root, 'Customer orders.csv'), code = path.join(root, 'notes.json');
fs.writeFileSync(csv, 'Customer,Item,Total,Status\n"Rivera, Alex","Bouquet\nof flowers",42.50,Paid\n' + Array.from({ length: 120 }, (_, i) => `Customer ${i + 1},Seasonal flowers,${i + 20},${i % 2 ? 'Paid' : 'Pending'}`).join('\n'));
fs.writeFileSync(code, '{"message":"<img src=x onerror=alert(1)>","ready":true}');
store.add(task.id, 'assistant', `[Open orders](<${csv}>)\n\n[Open JSON](<${code}>)`);
for (let i=0; i<9; i++) store.create({ name: ['Website refresh', 'Product research', 'Meeting notes', 'Weekly plan', 'Client dashboard', 'Release review', 'Content ideas', 'Operations', 'Next project'][i], engine: i % 2 ? 'claude' : 'codex', cwd: project });
store.state.activeId = task.id; store.save();
const launch = () => electron.launch({ ...(process.env.HAVEN_APP_PATH ? { executablePath: process.env.HAVEN_APP_PATH, args: [] } : { args: ['.'] }), cwd: process.cwd(), env: { ...process.env, HAVEN_TEST_MODE: '1', HAVEN_DATA_DIR: root } });
let app = await launch(), page = await app.firstWindow(); const errors=[]; page.on('pageerror',e=>errors.push(e.message));
const fixture = async () => app.evaluate(({ app }) => {
  const file = app.getAppPath() + '/electron/workspace.mjs';
  const { Workspace } = process.getBuiltinModule('module').createRequire(file)(file), send = Workspace.prototype.send, commands = Workspace.prototype.listCommands;
  Workspace.prototype.send = function(...args) {
    globalThis.__workspace = this;
    this.codex.send = async () => {}; this.codex.steer = async () => false;
    this.codex.stop = async session => this.finish(session.id, null, true);
    return send.apply(this,args);
  };
  Workspace.prototype.listCommands = function(id, reload, localOnly) { return commands.call(this,id,reload,true); };
  Workspace.prototype.connections = async function() {
    if(globalThis.__connectionFailure) throw new Error('Could not read this task’s connections. Check the provider connection and refresh.');
    return { updatedAt:Date.now(), source:'Live task connection · UI fixture', builtInTools:[], servers:[
      {name:'supabase-orders',status:'connected',tools:[{name:'list_tables',readOnly:true},{name:'execute_sql'}],details:{endpoint:'https://mcp.supabase.com/mcp',project:'orders-demo',access:'Read only (configured)'},scope:'project'},
      {name:'github',status:'needs-auth',tools:[],details:{endpoint:'https://api.githubcopilot.com/mcp'},issue:'Sign in again using the provider’s MCP settings.'},
      {name:'local-notes',status:'disabled',tools:[],details:{command:'node'},scope:'user'}
    ] };
  };
});
try {
  await page.getByRole('textbox',{name:'Message',exact:true}).waitFor(); await fixture();
  await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(1100,780));
  const field=page.getByRole('textbox',{name:'Message',exact:true}), send=page.getByRole('button',{name:'Send message',exact:true});
  await field.fill('Keep working on the current task'); await send.click(); await page.locator('.working-indicator').waitFor();
  await field.fill('Include the new requirements'); assert.equal(await send.isEnabled(),true); await send.click();
  await page.getByLabel('Queued messages').waitFor(); await page.waitForFunction(()=>document.querySelector('textarea[data-composer]').value==='');
  await field.fill('A newer draft');
  await page.getByRole('button',{name:'Stop',exact:true}).click(); await page.getByLabel('Queued messages').getByText('Paused',{exact:true}).waitFor();
  await page.getByLabel('Queued messages').getByRole('button',{name:'To draft',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('textarea[data-composer]').value.includes('Include the new requirements'));
  assert.match(await field.inputValue(),/A newer draft/);
  await field.fill('/mcp'); await field.press('Escape'); await send.click();
  await page.getByRole('heading',{name:'Connections & tools'}).waitFor();
  await page.getByText('supabase-orders',{exact:true}).click(); await page.getByText('orders-demo',{exact:true}).waitFor();
  await page.screenshot({path:'artifacts/0.5.0-connections-light.png',animations:'disabled'});
  await page.getByRole('textbox',{name:'Search connections and tools'}).fill('execute_sql'); assert.equal(await page.locator('.connection-card').count(),1);
  await page.getByRole('textbox',{name:'Search connections and tools'}).fill('');
  await app.evaluate(()=>{globalThis.__connectionFailure=true;}); await page.getByRole('button',{name:'Refresh',exact:true}).click();
  await page.getByRole('alert').filter({hasText:'Showing the last successful check'}).waitFor(); assert.match(await page.locator('.connection-status').first().innerText(),/^Last:/);
  await page.getByRole('button',{name:'Close dialog',exact:true}).click();
  await field.fill('This draft survives every preview');
  await page.getByRole('link',{name:'Open orders',exact:true}).click(); await page.getByLabel('File table').waitFor();
  assert.equal(await page.locator('.document-table tbody tr').count(),50); assert.match(await page.locator('.document-table').innerText(),/Rivera, Alex/);
  await page.getByRole('button',{name:'Next rows',exact:true}).click(); assert.equal(await page.getByText('Page 2 of 3',{exact:true}).count(),1);
  await page.getByRole('textbox',{name:'Filter file rows'}).fill('Rivera'); assert.equal(await page.locator('.document-table tbody tr').count(),1);
  await page.getByRole('textbox',{name:'Filter file rows'}).fill('');
  await page.screenshot({path:'artifacts/0.5.0-csv-light.png',animations:'disabled'});
  await page.getByRole('button',{name:'Close file reader',exact:true}).click(); assert.equal(await field.inputValue(),'This draft survives every preview');
  await page.getByRole('link',{name:'Open JSON',exact:true}).click(); await page.locator('.document-code').waitFor(); assert.equal(await page.getByRole('dialog').locator('img').count(),0);
  await page.getByRole('button',{name:'Close file reader',exact:true}).click();
  await page.getByRole('button',{name:'Focus mode · hide sidebar',exact:true}).click(); assert.equal(await page.locator('.sidebar').isVisible(),false); assert.equal(await field.inputValue(),'This draft survives every preview');
  await page.screenshot({path:'artifacts/0.5.0-focus.png',animations:'disabled'});
  await page.keyboard.press('Meta+k'); await page.getByRole('textbox',{name:'Search tasks and conversations'}).waitFor(); assert.equal(await page.locator('.sidebar').isVisible(),true);
  await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(860,620));
  await page.screenshot({path:'artifacts/0.5.0-sidebar-narrow.png',animations:'disabled'});
  const geometry = await page.locator('.session-list').boundingBox(); assert.ok(geometry.height >= 130,`Task list too short: ${geometry.height}`);
  for(const name of ['Settings','Files','Voice','Archive']) { const button=page.getByRole('button',{name,exact:true}); const rect=await button.boundingBox(); assert.ok(rect&&rect.y+rect.height<=620,name+' is off-screen'); }
  await page.evaluate(()=>window.haven.invoke('settings',{theme:'dark'}));
  await page.waitForFunction(()=>document.documentElement.dataset.theme==='dark');
  await app.evaluate(()=>{globalThis.__connectionFailure=false;});
  await page.getByRole('button',{name:'Connections',exact:true}).click(); await page.getByRole('heading',{name:'Connections & tools'}).waitFor();
  await page.getByText('supabase-orders',{exact:true}).waitFor();
  await page.screenshot({path:'artifacts/0.5.0-connections-dark-narrow.png',animations:'disabled'});
  await page.getByRole('button',{name:'Close dialog',exact:true}).click();
  await page.getByRole('link',{name:'Open orders',exact:true}).click(); await page.getByLabel('File table').waitFor();
  await page.screenshot({path:'artifacts/0.5.0-csv-dark-narrow.png',animations:'disabled'});
  await page.getByRole('button',{name:'Close file reader',exact:true}).click();
  await page.getByRole('button',{name:'Focus mode · hide sidebar',exact:true}).click();
  await app.close(); app=await launch(); page=await app.firstWindow();
  await page.getByRole('button',{name:'Show sidebar',exact:true}).waitFor(); assert.equal(await page.getByRole('textbox',{name:'Message',exact:true}).inputValue(),'This draft survives every preview');
  assert.deepEqual(errors,[]); console.log('Workspace updates UI passed: send while running, queue/stop/withdraw, /mcp and stale inventory, CSV paging/search, escaped code, Focus mode/restart, compact sidebar at 860×620, light/dark. Connection values were fixtures.');
} catch(error) { await page.screenshot({path:'artifacts/0.5.0-updates-failure.png'}); throw error; }
finally { await app.close(); }
