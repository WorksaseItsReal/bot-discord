'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { PermissionFlagsBits: F, ChannelType } = require('discord.js');
const { memoryDb } = require('./db.helper');
const { LockRepository } = require('../src/database/repositories/LockRepository');
const { LockdownService, normalizeLock } = require('../src/services/LockdownService');

const LOCK4 = ['SendMessages', 'SendMessagesInThreads', 'CreatePublicThreads', 'CreatePrivateThreads'];

/** Salon factice dont l'overwrite @everyone évolue avec les edit() (tri-état par flag). */
function fakeChannel(id, type, { allow = 0n, deny = 0n } = {}) {
  const everyone = { id: 'g1' };
  const ow = { allow: { bitfield: allow }, deny: { bitfield: deny } };
  return {
    id,
    type,
    manageable: true,
    guild: { id: 'g1', roles: { everyone } },
    isThread: () => false,
    permissionOverwrites: {
      cache: new Map([[everyone.id, ow]]),
      edits: [],
      async edit(_t, perms) {
        this.edits.push(perms);
        for (const [flag, v] of Object.entries(perms)) {
          const bit = F[flag];
          ow.allow.bitfield &= ~bit;
          ow.deny.bitfield &= ~bit;
          if (v === true) ow.allow.bitfield |= bit;
          if (v === false) ow.deny.bitfield |= bit;
        }
      },
    },
    state(flag) {
      if (ow.allow.bitfield & F[flag]) return true;
      if (ow.deny.bitfield & F[flag]) return false;
      return null;
    },
  };
}

function setup() {
  const { db } = memoryDb();
  const locks = new LockRepository(db);
  const logs = [];
  return { locks, logs, svc: new LockdownService({ locks, logging: { send: async (...a) => logs.push(a) } }) };
}

test('M1 lock d\'un salon textuel : écriture ET fils refusés, chaque bit restauré en tri-état', async () => {
  const { svc, locks } = setup();
  const ch = fakeChannel('c1', ChannelType.GuildText, { allow: F.CreatePublicThreads, deny: F.CreatePrivateThreads });
  await svc.lockChannel(ch, null, 'x');
  for (const p of LOCK4) assert.equal(ch.state(p), false, p);
  assert.deepEqual(locks.get('g1', 'c1').data.perms, { SendMessages: null, SendMessagesInThreads: null, CreatePublicThreads: true, CreatePrivateThreads: false });
  await svc.unlockChannel(ch);
  assert.equal(ch.state('SendMessages'), null);
  assert.equal(ch.state('SendMessagesInThreads'), null);
  assert.equal(ch.state('CreatePublicThreads'), true);
  assert.equal(ch.state('CreatePrivateThreads'), false);
  assert.equal(locks.get('g1', 'c1'), undefined);
});

test('M1 permissions selon le type : annonces, forum, texte des vocaux', async () => {
  const { svc } = setup();
  const cases = [
    [ChannelType.GuildAnnouncement, ['SendMessages', 'SendMessagesInThreads', 'CreatePublicThreads']],
    [ChannelType.GuildForum, ['SendMessages', 'SendMessagesInThreads']],
    [ChannelType.GuildVoice, ['SendMessages']],
  ];
  for (const [type, perms] of cases) {
    const ch = fakeChannel(`c${type}`, type);
    await svc.lockChannel(ch, null, 'x');
    assert.deepEqual(Object.keys(ch.permissionOverwrites.edits[0]), perms, String(type));
  }
});

test('M1 compatibilité : ligne à l\'ancien format { allow, deny } restaurée et complétée', async () => {
  const { svc, locks } = setup();
  // Ancien lock : SendMessages était autorisé avant, puis refusé par l'ancien code.
  const ch = fakeChannel('c1', ChannelType.GuildText, { deny: F.SendMessages | F.CreatePrivateThreads });
  locks.save('g1', 'c1', { allow: F.SendMessages.toString(), deny: F.CreatePrivateThreads.toString() });
  assert.deepEqual(normalizeLock(locks.get('g1', 'c1').data).perms, { SendMessages: true });
  // Nouveau lock sur ce salon : complète les bits manquants avec leur état courant.
  await svc.lockChannel(ch, null, 'x');
  const saved = locks.get('g1', 'c1').data;
  assert.equal(saved.v, 2);
  assert.equal(saved.perms.SendMessages, true);
  assert.equal(saved.perms.CreatePrivateThreads, false);
  await svc.unlockChannel(ch);
  assert.equal(ch.state('SendMessages'), true);
  assert.equal(ch.state('SendMessagesInThreads'), null);
  assert.equal(ch.state('CreatePrivateThreads'), false);
});

test('M1 ancienne ligne sans portée : comptée et restaurée par le lockdown', async () => {
  const { svc, locks } = setup();
  const ch = fakeChannel('c1', ChannelType.GuildText, { deny: F.SendMessages });
  locks.save('g1', 'c1', { allow: '0', deny: '0' });
  const guild = { id: 'g1', channels: { cache: new Map([['c1', ch]]) } };
  assert.equal(svc.status(guild), 1);
  assert.equal(await svc.disable(guild, null), 1);
  assert.equal(ch.state('SendMessages'), null);
});

test('lockall : par lots, portée « lockdown », /lock individuel conservé par unlockall', async () => {
  const { svc, locks, logs } = setup();
  const channels = Array.from({ length: 12 }, (_, i) => fakeChannel(`c${i}`, ChannelType.GuildText));
  const voice = fakeChannel('v', ChannelType.GuildVoice);
  const category = fakeChannel('cat', ChannelType.GuildCategory);
  const manual = fakeChannel('m', ChannelType.GuildText);
  const guild = { id: 'g1', channels: { cache: new Map([...channels, voice, category, manual].map((c) => [c.id, c])) } };
  await svc.lockChannel(manual, null, 'lock');
  // Un salon en échec n'empêche pas les autres.
  channels[3].permissionOverwrites.edit = async () => { throw new Error('Missing Permissions'); };
  const n = await svc.enable(guild, null, 'raid');
  assert.equal(n, 13); // 12 textuels + 1 vocal + le salon déjà verrouillé - 1 échec
  assert.equal(category.permissionOverwrites.edits.length, 0);
  assert.equal(logs.length, 1);
  assert.equal(locks.get('g1', 'm').data.scope, 'manual');
  assert.equal(locks.get('g1', 'c3'), undefined); // échec : aucune trace de verrouillage
  assert.equal(svc.status(guild), 12);
  assert.equal(await svc.disable(guild, null), 12);
  assert.ok(locks.get('g1', 'm'));
  assert.equal(manual.state('SendMessages'), false);
});

test('lockdown automatique (AntiRaid) : pas de carte « Lockdown activé » en double', async () => {
  const { svc, logs } = setup();
  const guild = { id: 'g1', channels: { cache: new Map([['c1', fakeChannel('c1', ChannelType.GuildText)]]) } };
  assert.equal(await svc.enable(guild, null, 'AntiRaid', { log: false }), 1);
  assert.equal(logs.length, 0);
});

test('M5 hide / unhide : ViewChannel d\'origine restauré, état distinct du verrouillage', async () => {
  const { svc, locks } = setup();
  const ch = fakeChannel('c1', ChannelType.GuildText, { allow: F.ViewChannel });
  await svc.lockChannel(ch, null, 'x');
  await svc.hideChannel(ch, 'x');
  await svc.hideChannel(ch, 'x'); // second hide : l'état d'origine n'est pas écrasé
  assert.equal(ch.state('ViewChannel'), false);
  assert.equal(locks.list('g1').length, 1);
  assert.equal(locks.list('g1', 'hide').length, 1);
  await svc.unhideChannel(ch, 'x');
  assert.equal(ch.state('ViewChannel'), true);
  assert.equal(locks.list('g1', 'hide').length, 0);
  assert.equal(ch.state('SendMessages'), false); // toujours verrouillé
  await svc.unlockChannel(ch);
  assert.equal(locks.list('g1').length, 0);
});

test('M5 unhide sans état sauvegardé : ne retire que le refus (neutre)', async () => {
  const { svc } = setup();
  const ch = fakeChannel('c1', ChannelType.GuildText, { deny: F.ViewChannel });
  await svc.unhideChannel(ch, 'x');
  assert.deepEqual(ch.permissionOverwrites.edits, [{ ViewChannel: null }]);
});

test('LockRepository.deleteChannel oublie lock et hide d\'un salon supprimé', async () => {
  const { svc, locks } = setup();
  const ch = fakeChannel('c1', ChannelType.GuildText);
  const other = fakeChannel('c10', ChannelType.GuildText);
  await svc.lockChannel(ch, null, 'x');
  await svc.hideChannel(ch, 'x');
  await svc.lockChannel(other, null, 'x');
  locks.deleteChannel('g1', 'c1');
  assert.deepEqual(locks.list('g1').map((l) => l.channel_id), ['c10']);
  assert.equal(locks.list('g1', 'hide').length, 0);
});
