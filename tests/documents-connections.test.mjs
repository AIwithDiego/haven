import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readDocument, parseDelimited, isDocumentPath } from '../electron/documents.mjs';
import { connectionDetails, normalizeConnection } from '../electron/connections.mjs';
import { CodexAdapter } from '../electron/agents.mjs';

test('CSV handles quotes, escaped quotes, multiline values, CRLF, and empty trailing cells', () => {
  const result = parseDelimited('Name,Note,Empty\r\nAlex,"A, B\nSaid ""yes""",\r\n');
  assert.deepEqual(result.rows, [['Name','Note','Empty'], ['Alex','A, B\nSaid "yes"','']]); assert.equal(result.totalRows, 2);
  assert.deepEqual(parseDelimited('a\tb\n1\t2', '\t').rows, [['a','b'],['1','2']]);
});
test('CSV bounds returned cells and labels truncation and malformed quotes', () => {
  const result = parseDelimited(Array.from({length:10002}, () => 'a,b').join('\n'));
  assert.equal(result.rows.length,10000); assert.equal(result.totalRows,10002); assert.equal(result.truncated,true);
  assert.match(parseDelimited('a,"unterminated').warning, /unfinished/);
});
test('local file reader rejects binary, oversize and unsupported files; code and HTML remain source text', async t => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'haven-docs-')); t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const file=path.join(root,'data.csv'); fs.writeFileSync(file,'name,value\nAlex,42'); assert.equal((await readDocument(file)).kind,'table');
  const html=path.join(root,'page.html'); fs.writeFileSync(html,'<script>unsafe()</script>'); const doc=await readDocument(html); assert.equal(doc.kind,'text'); assert.match(doc.content,/<script>/);
  fs.writeFileSync(file,'a\0b'); await assert.rejects(readDocument(file),/binary/);
  fs.writeFileSync(file,Buffer.alloc(2*1024*1024+1)); await assert.rejects(readDocument(file),/large/);
  assert.equal(isDocumentPath('file.py'),true); assert.equal(isDocumentPath('file.docx'),false);
});
test('connection display strips credentials, secrets, arbitrary query values and arguments', () => {
  const config={url:'https://user:password@mcp.supabase.com/mcp?project_ref=project123&access_token=secret&read_only=true',headers:{Authorization:'secret'},env:{TOKEN:'secret'},command:'/usr/local/bin/npx',args:['--token','secret','--project-ref','project123','--database=orders']};
  const result=connectionDetails(config); assert.deepEqual(result,{endpoint:'https://mcp.supabase.com/mcp',project:'project123',access:'Read only (configured)',command:'npx',database:'orders'});
  const server=normalizeConnection({name:'database',status:'failed',error:'Bearer secret',config,tools:[]});
  assert.ok(!JSON.stringify(server).includes('secret')); assert.ok(!JSON.stringify(server).includes('password'));
  assert.equal(normalizeConnection({name:'x',tools:[{name:'read'}]}, {}, false).status,'configured');
});
test('Codex inventory scopes runtime to the task and follows pagination; idle config is not called connected', async () => {
  const adapter=new CodexAdapter({}); adapter.connect=async()=>{}; const calls=[];
  adapter.request=async(method,params)=>{ calls.push([method,params]); if(method==='config/read')return{config:{mcp_servers:{db:{url:'https://mcp.supabase.com/mcp?project_ref=p'}}}}; return params.cursor ? {data:[{name:'second',runtimeStatus:'failed',tools:{}}]} : {data:[{name:'db',runtimeStatus:'connected',tools:{read:{name:'read'}}}],nextCursor:'next'}; };
  const idle=await adapter.connections({cwd:'/tmp'}); assert.equal(idle.servers[0].status,'configured'); assert.equal(calls.length,1);
  adapter.threads.set('thread','local'); const live=await adapter.connections({cwd:'/tmp',remoteId:'thread'}); assert.equal(live.servers.length,2); assert.equal(live.servers[0].status,'connected');
  for(const [method,params] of calls.filter(([m])=>m==='mcpServerStatus/list'))assert.equal(params.threadId,'thread');
});
test('database connection details expose only host, port and database, never credentials', () => {
  assert.deepEqual(connectionDetails({env:{DATABASE_URL:'postgresql://person:password@db.example.com:5432/orders?token=secret',OTHER_KEY:'private'}}),{host:'db.example.com',port:'5432',database:'orders'});
});
