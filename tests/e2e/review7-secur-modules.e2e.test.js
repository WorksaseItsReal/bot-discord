'use strict';

/**
 * Revue n° 7, modules Secur, bout en bout (vrai discord.js, faux Discord) : transfert de propriété,
 * déplacements vocaux, homonymes et disjoncteur, restauration /backup pendant la file
 * d'annulation, modifications successives, rôle rendu à l'auteur, roleRemove pendant un incident,
 * références en base d'un rôle recréé, mémoires périmées pendant que la file travaille.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHarness, IDS } = require('./harness');
const { presetPatch } = require('../../src/utils/secur');
const { defaultGuildConfig } = require('../../src/config/defaults');

const incidents = (h) => h.client.repositories.securityIncidents.recent(h.guild.id, 10);
const rolesOf = (h, userId) => h.fake.members.get(userId)?.roles ?? [];

async function presetHarness(preset, extra = {}) {
  const h = await createHarness();
  h.configure({ logChannels: { security: IDS.channels.logs }, automod: { enabled: false }, antiraid: { enabled: false } });
  h.configure({ secur: { modules: presetPatch(preset, defaultGuildConfig.secur.modules) }, ...extra });
  return h;
}

/* -------------------------------------------------------------------- */
/* S3 : transfert de propriété                                           */
/* -------------------------------------------------------------------- */

for (const preset of ['on', 'max']) {
  test(`S3 [${preset}] : transfert de propriété (GUILD_UPDATE avant l'audit) → l'ancien propriétaire n'est pas dérangé`, async () => {
    const h = await presetHarness(preset);
    try {
      await h.asHuman('owner').addRole('owner', IDS.roles.admin);
      await h.asHuman('owner').editGuild({ owner_id: IDS.users.admin }, { label: 'transfert' });
      await h.settle({ timeout: 5_000 });
      assert.equal(h.guild.ownerId, IDS.users.admin);
      assert.equal(incidents(h).length, 0, 'incident ouvert contre l\'ancien propriétaire');
      assert.ok(rolesOf(h, IDS.users.owner).includes(IDS.roles.admin), 'ancien propriétaire dérangé');
      assert.equal(h.problemCount(), 0, h.formatProblems());
    } finally {
      await h.close();
    }
  });
}

test('S3 [max] : un renommage du serveur par un admin reste sanctionné', async () => {
  const h = await presetHarness('max');
  try {
    await h.asHuman('admin').editGuild({ name: 'Serveur piraté' }, { label: 'renommage' });
    await h.settle({ timeout: 5_000 });
    const [inc] = incidents(h);
    assert.ok(inc, 'aucun incident');
    assert.equal(inc.executor_id, IDS.users.admin);
  } finally {
    await h.close();
  }
});

/* -------------------------------------------------------------------- */
/* S8 : déplacements vocaux                                               */
/* -------------------------------------------------------------------- */

const securVoice = require('../../src/events/securVoice');
const { nextId } = require('./lib/ids');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function voiceHarness() {
  const h = await createHarness();
  h.configure({ logChannels: { security: IDS.channels.logs }, automod: { enabled: false }, antiraid: { enabled: false }, tempVoice: { enabled: false }, secur: { modules: { voiceKick: { mode: 'on' } } } });
  return h;
}

test('S8 : un modérateur qui glisse 5 membres vers un autre vocal (entrée 26 regroupée) n\'est pas dérangé ; 6 déconnexions restent sanctionnées', async () => {
  const delay = securVoice.timing.delayMs;
  securVoice.timing.delayMs = 10;
  const h = await voiceHarness();
  try {
    const ids = [];
    for (let i = 0; i < 5; i += 1) {
      const u = h.addUser(`Invite${i}`);
      await h.memberJoin(u);
      await h.voice(u.id, 'hub');
      ids.push(u.id);
    }
    // Discord regroupe : UNE entrée 26 (salon cible) dont le compte passe de 1 à 5.
    const move = { id: nextId(), action_type: 26, target_id: null, user_id: IDS.users.mod, changes: [], options: { count: '0', channel_id: IDS.channels.voice } };
    h.fake.auditLog.unshift(move);
    for (const id of ids) {
      move.options.count = String(Number(move.options.count) + 1);
      await h.asHuman('mod').perform('PATCH', `/guilds/${h.guild.id}/members/${id}`, { channel_id: IDS.channels.voice });
      await sleep(40);
      await h.settle();
    }
    await sleep(40);
    await h.settle();
    assert.equal(ids.filter((id) => h.fake.voiceStates.get(id)?.channel_id === IDS.channels.voice).length, 5);
    assert.equal(incidents(h).length, 0, 'déplacements comptés comme des déconnexions');
    assert.ok(rolesOf(h, IDS.users.mod).includes(IDS.roles.mod), 'modérateur dérangé');

    // Non-régression : 6 déconnexions regroupées (entrée 27).
    h.fake.auditLog.unshift({ id: nextId(), action_type: 27, target_id: null, user_id: IDS.users.mod, changes: [], options: { count: '6' } });
    await h.asHuman('mod').perform('PATCH', `/guilds/${h.guild.id}/members/${ids[0]}`, { channel_id: null });
    assert.ok(await h.waitFor(() => incidents(h).length > 0, { timeout: 2_000 }), 'déconnexions non sanctionnées');
    assert.equal(incidents(h)[0].actions, 6);
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    securVoice.timing.delayMs = delay;
    await h.close();
  }
});
