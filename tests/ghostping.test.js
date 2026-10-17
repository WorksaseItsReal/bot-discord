'use strict';

/**
 * Ghostping d'arrivée (GhostPingService, /bienvenue › Ghostping) : regroupement sur 2 s,
 * 20 mentions par message, salons invisibles filtrés, vague et lockdown, vérification,
 * suppression après le délai et à l'arrêt.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { PermissionsBitField, PermissionFlagsBits: P, ChannelType, Collection } = require('discord.js');
const { memoryDb } = require('./db.helper');
const { GuildConfigRepository } = require('../src/database/repositories/GuildConfigRepository');
const { ConfigService } = require('../src/services/ConfigService');
const { GhostPingService, parseDelay, clampDelay, MAX_MENTIONS } = require('../src/services/GhostPingService');
const { WelcomeService } = require('../src/services/WelcomeService');
const { defaultGuildConfig } = require('../src/config/defaults');
const bienvenue = require('../src/commands/configuration/bienvenue');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(predicate, timeout = 2_000) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeout) return false;
    await sleep(5);
  }
  return true;
}

const GUILD = '100000000000000001';
const BOT = '999999999999999999';
const GENERAL = '400000000000000001';
const RULES = '400000000000000002';
const STAFF = '400000000000000003';
const VERIFIED = '300000000000000001';

let seq = 210000000000000000n;

function world() {
  const { db } = memoryDb();
  const config = new ConfigService(new GuildConfigRepository(db));
  const members = new Collection();
  const channels = new Collection();
  const deleted = [];
  const suppressed = [];
  const me = { id: BOT, user: { id: BOT, bot: true }, roles: { cache: new Collection() } };
  members.set(BOT, me);
  const guild = { id: GUILD, name: 'Gadget', available: true, channels: { cache: channels }, members: { cache: members, me }, roles: { cache: new Collection(), everyone: { id: GUILD } } };
  let msgSeq = 600000000000000000n;
  /** hidden : membres qui ne voient pas le salon (le staff voit tout). */
  const makeChannel = (id, { hiddenFor = () => false, botPerms = PermissionsBitField.All } = {}) => {
    const ch = {
      id,
      type: ChannelType.GuildText,
      guild,
      sent: [],
      permissionsFor: (who) => {
        if (who === me) return new PermissionsBitField(botPerms);
        return new PermissionsBitField(hiddenFor(who) ? [] : [P.ViewChannel, P.SendMessages]);
      },
      async send(payload) {
        const msg = { id: String(msgSeq++), payload, channelId: id, delete: async () => deleted.push(msg.id) };
        ch.sent.push(msg);
        return msg;
      },
    };
    channels.set(id, ch);
    return ch;
  };
  const addMember = ({ bot = false, roles = [] } = {}) => {
    const id = String(seq++);
    const member = { id, guild, user: { id, bot }, roles: { cache: new Collection(roles.map((r) => [r, { id: r }])) } };
    members.set(id, member);
    return member;
  };
  const services = { config, logging: { suppressMessage: (id) => suppressed.push(id) }, antiraid: { joinAlertAt: new Map() }, welcome: { waves: new Map() }, lockdown: { status: () => 0 } };
  const client = { user: { id: BOT }, guilds: { cache: new Collection([[GUILD, guild]]) }, services };
  const svc = new GhostPingService({ client, config });
  svc.batchMs = 20;
  services.ghostPing = svc;
  return { config, guild, client, services, svc, makeChannel, addMember, deleted, suppressed };
}

const enable = (config, patch = {}) => config.update(GUILD, { ghostPing: { enabled: true, channels: [GENERAL], deleteAfterSeconds: 1, ...patch } });

// ---------------------------------------------------------------- briques pures

test('délai : 1 à 10 s, virgule acceptée ; bornage ; bloc de configuration dédié', () => {
  assert.equal(parseDelay('1,5'), 1.5);
  assert.equal(parseDelay('2'), 2);
  assert.equal(parseDelay('3s'), 3);
  assert.equal(parseDelay('10 secondes'), 10);
  assert.equal(parseDelay('0,5'), null);
  assert.equal(parseDelay('11'), null);
  assert.equal(parseDelay('abc'), null);
  assert.equal(clampDelay(0), 1);
  assert.equal(clampDelay(99), 10);
  assert.equal(clampDelay('x'), 1.5);
  assert.deepEqual(defaultGuildConfig.ghostPing, { enabled: false, channels: [], afterVerification: true, deleteAfterSeconds: 1.5 });
});

// ---------------------------------------------------------------- regroupement

test('3 arrivées en 2 s → 1 message par salon, mentions limitées aux arrivants, puis suppression', async () => {
  const { config, svc, makeChannel, addMember, deleted, suppressed } = world();
  const general = makeChannel(GENERAL);
  const rules = makeChannel(RULES);
  enable(config, { channels: [GENERAL, RULES] });
  const joiners = [addMember(), addMember(), addMember()];
  for (const m of joiners) assert.equal(svc.queue(m), true);
  assert.ok(await until(() => general.sent.length === 1 && rules.sent.length === 1));
  const { payload } = general.sent[0];
  assert.equal(payload.content, joiners.map((m) => `<@${m.id}>`).join(' '));
  assert.deepEqual(payload.allowedMentions, { users: joiners.map((m) => m.id), parse: [] });
  assert.equal(general.sent.length, 1, 'un seul message');
  // Suppression après le délai (1 s), sans log (marque « supprimé par le bot »).
  assert.ok(await until(() => deleted.length === 2, 2_500));
  assert.deepEqual(suppressed.sort(), deleted.sort());
  await svc.stop();
});

test('25 arrivées → un message de 20 mentions, puis un de 5 ; 20 en attente au plus', async () => {
  const { config, svc, makeChannel, addMember } = world();
  const general = makeChannel(GENERAL);
  enable(config, { deleteAfterSeconds: 10 });
  const joiners = Array.from({ length: 25 }, () => addMember());
  for (const m of joiners) svc.queue(m);
  assert.ok(await until(() => general.sent.length === 2));
  const counts = general.sent.map((m) => m.payload.allowedMentions.users.length);
  assert.deepEqual(counts, [MAX_MENTIONS, 5]);
  // Lot plein juste après un envoi : les arrivées suivantes sont abandonnées (au plus 20 pings / 2 s).
  svc.batchMs = 200;
  const burst = Array.from({ length: 22 }, () => addMember());
  for (const m of burst) svc.queue(m);
  assert.equal(svc.pendingCount(GUILD), MAX_MENTIONS);
  await svc.stop();
});

test('salons invisibles pour le membre ou fermés au bot : filtrés', async () => {
  const { config, svc, makeChannel, addMember } = world();
  const general = makeChannel(GENERAL);
  const staff = makeChannel(STAFF, { hiddenFor: (m) => !m.roles?.cache?.has('staff') });
  const closed = makeChannel(RULES, { botPerms: [P.ViewChannel] });
  enable(config, { channels: [GENERAL, STAFF, RULES] });
  const m = addMember();
  svc.queue(m);
  assert.ok(await until(() => general.sent.length === 1));
  await sleep(30);
  assert.equal(staff.sent.length, 0, 'salon que le membre ne voit pas');
  assert.equal(closed.sent.length, 0, 'salon où le bot ne peut pas écrire');
  await svc.stop();
});

test('vague (AntiRaid < 60 s, vague sanctionnée, lockdown), bot, membre parti → aucun ping', async () => {
  const { config, svc, services, makeChannel, addMember, guild } = world();
  const general = makeChannel(GENERAL);
  enable(config);
  assert.equal(svc.queue(addMember({ bot: true })), false, 'bot');
  services.antiraid.joinAlertAt.set(GUILD, Date.now() - 30_000);
  assert.equal(svc.queue(addMember()), false, 'AntiRaid déclenché il y a 30 s');
  services.antiraid.joinAlertAt.set(GUILD, Date.now() - 61_000);
  services.welcome.waves.set(GUILD, Date.now() + 60_000);
  assert.equal(svc.queue(addMember()), false, 'vague sanctionnée');
  services.welcome.waves.clear();
  // Lockdown déclenché pendant le regroupement : le lot est annulé.
  const m = addMember();
  assert.equal(svc.queue(m), true);
  services.lockdown.status = () => 3;
  await sleep(60);
  assert.equal(general.sent.length, 0, 'lockdown actif');
  services.lockdown.status = () => 0;
  // Membre parti (expulsé) avant l'envoi.
  const gone = addMember();
  svc.queue(gone);
  guild.members.cache.delete(gone.id);
  await sleep(60);
  assert.equal(general.sent.length, 0);
  await svc.stop();
});

test('vérification : le ping attend la vérification (option), sinon à l\'arrivée ; jamais deux fois en 10 min', async () => {
  const { config, svc, makeChannel, addMember } = world();
  const general = makeChannel(GENERAL);
  enable(config);
  config.update(GUILD, { welcome: { verification: { enabled: true, roleId: VERIFIED } } });
  const m = addMember();
  assert.equal(svc.queue(m, { source: 'join' }), false, 'attend la vérification');
  assert.equal(svc.queue(m, { source: 'verify' }), true);
  assert.ok(await until(() => general.sent.length === 1));
  assert.equal(svc.queue(m, { source: 'verify' }), false, 'déjà pingué récemment');
  config.update(GUILD, { ghostPing: { afterVerification: false } });
  const n = addMember();
  assert.equal(svc.queue(n, { source: 'verify' }), false, 'option coupée : pas de ping à la vérification');
  assert.equal(svc.queue(n, { source: 'join' }), true);
  config.update(GUILD, { ghostPing: { enabled: false } });
  assert.equal(svc.queue(addMember()), false, 'désactivé');
  await svc.stop();
});

test('arrêt : les mentions encore affichées sont supprimées tout de suite', async () => {
  const { config, svc, makeChannel, addMember, deleted } = world();
  const general = makeChannel(GENERAL);
  enable(config, { deleteAfterSeconds: 10 });
  svc.queue(addMember());
  assert.ok(await until(() => general.sent.length === 1));
  assert.equal(deleted.length, 0);
  const t0 = Date.now();
  await svc.stop();
  assert.deepEqual(deleted, [general.sent[0].id]);
  assert.ok(Date.now() - t0 < 1_000, 'suppression immédiate');
  assert.equal(svc.queue(addMember()), false, 'arrêté');
});

test('WelcomeService : ping en fin d\'accueil (pas si l\'AntiRaid a sanctionné), et après la vérification', async () => {
  const calls = [];
  const { config, addMember, guild } = world();
  const client = { services: { ghostPing: { queue: (m, ctx) => calls.push([m.id, ctx.source]) } } };
  const welcome = new WelcomeService({ client, config });
  const m = addMember();
  m.pending = false;
  m.guild = guild;
  guild.roles.cache = new Collection();
  m.roles.cache = new Collection();
  m.user.username = 'alice';
  m.displayName = 'Alice';
  await welcome.handleJoin(m, { raid: { punished: true } });
  assert.equal(calls.length, 0, 'sanctionné par l\'AntiRaid : aucun ping');
  await welcome.handleJoin(m, { raid: { punished: false } });
  assert.deepEqual(calls, [[m.id, 'join']]);
});

// ---------------------------------------------------------------- tableau de bord

test('/bienvenue : vue Ghostping conforme (5 salons, boutons à valeur cible, délai)', () => {
  const { config, guild, makeChannel, client } = world();
  makeChannel(GENERAL);
  enable(config, { channels: [GENERAL], deleteAfterSeconds: 1.5 });
  client.services.config = config;
  const view = bienvenue.render(client, guild, 'ghostping');
  assert.ok(view.components.length <= 5);
  const ids = view.components.flatMap((r) => r.components.map((c) => c.data.custom_id));
  assert.ok(ids.includes('cmd:bienvenue:gpchannels'));
  assert.ok(ids.includes('cmd:bienvenue:gptoggle:off'));
  assert.ok(ids.includes('cmd:bienvenue:gpverify:off'));
  const menu = view.components[1].components[0].data;
  assert.equal(menu.max_values, 5);
  assert.match(view.embeds[0].data.fields.map((f) => f.value).join(' '), /1,5 s/);
});
