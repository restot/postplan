import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
test('destroy requires confirmation, deletes only the requested draft and clears matching local mappings after success',async()=>{
  const dir=mkdtempSync(`${tmpdir()}/postplan-destroy-test-`);
  let calls=0,status=200;
  const server=createServer((req,res)=>{calls++;assert.equal(req.method,'DELETE');assert.equal(req.url,'/api/drafts/draft-a');assert.equal(req.headers.authorization,'Bearer test-only');res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify({ok:status===200}));});
  server.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
  const mapping={files:{'/a.html':{draftId:'draft-a'},'/also-a.html':{draftId:'draft-a'},'/b.html':{draftId:'draft-b'}}};
  writeFileSync(`${dir}/drafts.json`,JSON.stringify(mapping));
  const cli=fileURLToPath(new URL('../node_modules/postplan/bin/postplan.js',import.meta.url));
  const run=(...args)=>promisify(execFile)(process.execPath,[cli,'destroy','draft-a',...args],{env:{...process.env,POSTPLAN_CONFIG_DIR:dir,POSTPLAN_API_KEY:'test-only',POSTPLAN_API_URL:`http://127.0.0.1:${server.address().port}`}});
  try {
    await assert.rejects(run(),/--yes/);assert.equal(calls,0);
    status=404;await assert.rejects(run('--yes'),/404/);assert.deepEqual(JSON.parse(readFileSync(`${dir}/drafts.json`)),mapping);
    status=200;assert.match((await run('--yes')).stdout,/Unpublished/);
    assert.deepEqual(JSON.parse(readFileSync(`${dir}/drafts.json`)),{files:{'/b.html':{draftId:'draft-b'}}});
    assert.equal(calls,2);
  } finally {await new Promise(r=>server.close(r));rmSync(dir,{recursive:true,force:true});}
});
