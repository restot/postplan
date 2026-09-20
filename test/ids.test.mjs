import {test} from 'node:test';
import assert from 'node:assert/strict';
import {newDraftId} from '../node_modules/postplan/src/ids.js';
import {getDraftIdFromHost} from '../node_modules/postplan/src/public-url.js';
test('new drafts use full UUID v4; old and new host IDs remain readable',()=>{
  const id=newDraftId();
  assert.match(id,/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  for(const value of [id,'abcdefghijkl']) assert.equal(getDraftIdFromHost({publicBaseUrl:'https://*.example.test',host:`${value}.example.test`}),value);
});
