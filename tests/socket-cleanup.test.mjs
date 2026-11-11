import test from 'node:test';
import assert from 'node:assert/strict';
import { closeSocketSession } from '../apps/connector/src/socket-cleanup.mjs';

test('disconnect drains authentication before releasing lease and never deletes it', async () => {
  const calls = [];
  let finish;
  const pending = new Promise(resolve => { finish = resolve; });
  const cleanup = closeSocketSession({ev:{removeAllListeners:event=>calls.push(event)},end:()=>calls.push('end')}, {
    flush:async()=>{calls.push('flush');await pending;},
    close:async()=>calls.push('close'),
    deleteSession:()=>assert.fail('credentials must be preserved'),
  });
  assert.deepEqual(calls,['connection.update','end','flush']);
  finish(); await cleanup;
  assert.equal(calls.at(-1),'close');
});
test('failed authentication flush still closes resources and reports the error', async () => {
  let closed = false;
  await assert.rejects(closeSocketSession(null,{flush:async()=>{throw new Error('write failed');},close:async()=>{closed=true;}}),/write failed/);
  assert.equal(closed,true);
});
