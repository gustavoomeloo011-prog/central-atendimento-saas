import test from 'node:test';
import assert from 'node:assert/strict';
import {mediaKind,captureScroll,restoreScroll} from '../apps/web/public/chat-view.js';

test('incoming media is inline even when webhook MIME is generic',()=>{
  assert.equal(mediaKind({attachment_type:'audio/ogg; codecs=opus'}),'audio');
  assert.equal(mediaKind({attachment_type:'application/octet-stream',body:'[Mensagem image]'}),'image');
  assert.equal(mediaKind({attachment_name:'voz.m4a'}),'audio');
  assert.equal(mediaKind({attachment_name:'boleto.pdf'}),'document');
});
test('new messages follow the end, but do not interrupt reading older messages',()=>{
  const bottom=captureScroll({scrollTop:500,scrollHeight:1000,clientHeight:500});
  const target={scrollTop:0,scrollHeight:1300};
  restoreScroll(target,bottom);assert.equal(target.scrollTop,1300);
  const history=captureScroll({scrollTop:120,scrollHeight:1000,clientHeight:500});
  restoreScroll(target,history);assert.equal(target.scrollTop,120);
  restoreScroll(target,undefined);assert.equal(target.scrollTop,1300);
});
