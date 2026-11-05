import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizePairingNumber, createPairingController } from '../apps/connector/src/pairing.mjs';

test('normaliza sem acrescentar ou remover dígitos', () => {
  assert.equal(normalizePairingNumber('+55 (11) 97807-9451'),'5511978079451');
  assert.equal(normalizePairingNumber('5511978079451'),'5511978079451');
  assert.throws(()=>normalizePairingNumber('11 97807-9451x'),/Informe/);
  assert.throws(()=>normalizePairingNumber('123'),/inválido/);
});

test('usa somente o código real do socket, expira e limita tentativas', async () => {
  let clock=1000,calls=0;
  const controller=createPairingController({now:()=>clock,intervalMs:1000,ttlMs:5000,maxAttempts:2});
  const socket={requestPairingCode:async number=>{calls++; assert.equal(number,'5511978079451'); return 'ABCD1234';}};
  assert.equal((await controller.request(socket,'+55 (11) 97807-9451')).code,'ABCD1234');
  assert.equal(controller.snapshot().code,'ABCD1234');
  await assert.rejects(controller.request(socket,'5511978079451'),/Aguarde/);
  clock+=5001;
  assert.equal(controller.snapshot().code,null);
  assert.equal(controller.snapshot().expired,true);
  await controller.request(socket,'5511978079451');
  await assert.rejects(controller.request(socket,'5511978079451'),/Limite/);
  assert.equal(calls,2);
});

test('bloqueia sessão autenticada e solicitações simultâneas', async () => {
  let release;
  const socket={requestPairingCode:()=>new Promise(resolve=>{release=resolve;})};
  const controller=createPairingController();
  await assert.rejects(controller.request(socket,'5511978079451',{connected:true}),/autenticado/);
  const first=controller.request(socket,'5511978079451');
  await assert.rejects(controller.request(socket,'5511978079451'),/andamento/);
  release('1234ABCD'); await first;
  controller.clear(); assert.equal(controller.snapshot().code,null);
});

test('erro do Baileys não inventa código', async () => {
  const controller=createPairingController();
  await assert.rejects(controller.request({requestPairingCode:async()=>{throw new Error('pairing failed');}},'5511978079451'),/pairing failed/);
  assert.equal(controller.snapshot().code,null);
});
