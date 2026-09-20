import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('homelab CLI state does not overwrite hosted Postplan credentials', () => {
  const dir = mkdtempSync(`${tmpdir()}/postplan-cli-test-`);
  try {
    execFileSync(process.execPath, [fileURLToPath(new URL('../node_modules/postplan/bin/postplan.js',import.meta.url)), 'auth', 'set', 'test-only'], {env:{...process.env,HOME:dir,POSTPLAN_CONFIG_DIR:`${dir}/isolated`}});
    assert.equal(existsSync(`${dir}/isolated/credentials.json`),true);
    assert.equal(existsSync(`${dir}/.postplan/credentials.json`),false);
  } finally {rmSync(dir,{recursive:true,force:true});}
});
