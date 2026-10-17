'use strict';

/**
 * Revue 7, lot admin — tests unitaires.
 *  S12 : LockdownService.nativeOpenings (refus d'@everyone que le bot n'a pas posé), purgeMinimum de /clear.
 *  S42 : surcharges recopiées par /channel renouveler et par Secur (recréation) — règle de Discord à
 *        la création d'un salon : « only permissions your bot has in the guild can be allowed/denied.
 *        Setting MANAGE_ROLES permission in channels is only possible for guild administrators ».
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { PermissionFlagsBits: P, PermissionsBitField, ChannelType } = require('discord.js');
const { LockdownService } = require('../src/services/LockdownService');
const { purgeMinimum } = require('../src/commands/moderation/clear');
const { missingGrantedPermissions } = require('../src/services/ChannelRenewService');
const St = require('../src/services/secur/structure');

const G = 'g1';

/** Dépôt de verrous en mémoire (même clé que LockRepository : sorte 'send' par défaut). */
function memLocks() {
  const rows = new Map();
  const key = (g, c, kind = 'send') => `${g}:${c}:${kind}`;
  return {
    save: (g, c, data, kind) => rows.set(key(g, c, kind), { channel_id: c, data }),
    get: (g, c, kind) => rows.get(key(g, c, kind)) ?? null,
    delete: (g, c, kind) => rows.delete(key(g, c, kind)),
    list: () => [...rows.values()],
  };
}

/** Salon minimal : surcharge @everyone { allow, deny } (bits), ou aucune. */
function channel(id, ow = null, { type = ChannelType.GuildText, guild } = {}) {
  const cache = new Map();
  if (ow) cache.set(G, { allow: { bitfield: ow.allow ?? 0n }, deny: { bitfield: ow.deny ?? 0n } });
  return { id, type, guild, permissionOverwrites: { cache } };
}

function world() {
  const guild = { id: G, channels: { cache: new Map() } };
  const add = (id, ow, opts = {}) => {
    const c = channel(id, ow, { ...opts, guild });
    guild.channels.cache.set(id, c);
    return c;
  };
  const locks = memLocks();
  return { guild, add, locks, service: new LockdownService({ locks, logging: { send: async () => {} } }) };
}

test('S12 nativeOpenings(lock) : refus d\'écrire posé à la main (sans état) → 1 ; /lock du bot (état sauvegardé) → 0 ; rien de refusé → 0', () => {
  const { add, locks, service } = world();
  const manual = add('c1', { deny: P.SendMessages });
  assert.equal(service.nativeOpenings(manual, 'lock'), 1);
  const botLocked = add('c2', { deny: P.SendMessages });
  locks.save(G, 'c2', { v: 2, perms: { SendMessages: null } });
  assert.equal(service.nativeOpenings(botLocked, 'lock'), 0);
  // Refus d'origine sous un /lock : unlockChannel le rend tel quel (pas d'ouverture).
  const nativeUnderLock = add('c3', { deny: P.SendMessages });
  locks.save(G, 'c3', { v: 2, perms: { SendMessages: false } });
  assert.equal(service.nativeOpenings(nativeUnderLock, 'lock'), 0);
  assert.equal(service.nativeOpenings(add('c4', null), 'lock'), 0);
  assert.equal(service.nativeOpenings(add('c5', { allow: P.SendMessages }), 'lock'), 0);
});

test('S12 nativeOpenings(hide) : refus natif de « Voir » → 1 ; /hide du bot sur un salon public → 0 ; /hide sur un salon déjà privé → 1 (#unhide le rend visible)', () => {
  const { add, locks, service } = world();
  assert.equal(service.nativeOpenings(add('h1', { deny: P.ViewChannel }), 'hide'), 1);
  const hidden = add('h2', { deny: P.ViewChannel });
  locks.save(G, 'h2', { v: 2, perms: { ViewChannel: null } }, 'hide');
  assert.equal(service.nativeOpenings(hidden, 'hide'), 0);
  const wasPrivate = add('h3', { deny: P.ViewChannel });
  locks.save(G, 'h3', { v: 2, perms: { ViewChannel: false } }, 'hide');
  assert.equal(service.nativeOpenings(wasPrivate, 'hide'), 1);
  // Déjà visible (rouvert à la main entre-temps) : rien à ouvrir.
  const reopened = add('h4', null);
  locks.save(G, 'h4', { v: 2, perms: { ViewChannel: false } }, 'hide');
  assert.equal(service.nativeOpenings(reopened, 'hide'), 0);
  // Un verrou d'écriture ne compte pas pour /unhide (et inversement).
  const both = add('h5', { deny: P.ViewChannel | P.SendMessages });
  locks.save(G, 'h5', { v: 2, perms: { SendMessages: null } });
  assert.equal(service.nativeOpenings(both, 'hide'), 1);
});

test('S12 nativeOpenings(hide) d\'une catégorie : ses salons masqués avec elle et privés d\'origine comptent aussi', () => {
  const { add, locks, service } = world();
  const cat = add('cat', { deny: P.ViewChannel }, { type: ChannelType.GuildCategory });
  add('k1', { deny: P.ViewChannel });
  add('k2', { deny: P.ViewChannel });
  add('k3', { deny: P.ViewChannel });
  locks.save(G, 'cat', { v: 2, perms: { ViewChannel: false }, children: ['k1', 'k2', 'k3', 'gone'] }, 'hide');
  locks.save(G, 'k1', { v: 2, perms: { ViewChannel: false } }, 'hide');
  locks.save(G, 'k2', { v: 2, perms: { ViewChannel: null } }, 'hide');
  // k3 : plus d'état « hide » (déjà rendu visible puis remasqué à la main) → non traité par unhideChannel.
  assert.equal(service.nativeOpenings(cat, 'hide'), 2);
});

test('S12 purgeMinimum : 20 par défaut, réglage du module borné à [2, 100]', () => {
  assert.equal(purgeMinimum({}), 20);
  assert.equal(purgeMinimum({ secur: { modules: { messagePurge: { minMessages: 50 } } } }), 50);
  assert.equal(purgeMinimum({ secur: { modules: { messagePurge: { minMessages: 1 } } } }), 2);
  assert.equal(purgeMinimum({ secur: { modules: { messagePurge: { minMessages: 500 } } } }), 100);
  assert.equal(purgeMinimum({ secur: { modules: { messagePurge: { minMessages: 'x' } } } }), 20);
});

test('S42 missingGrantedPermissions : un REFUS d\'une permission que le bot n\'a pas bloque aussi la copie', () => {
  const bot = P.ViewChannel | P.SendMessages | P.ManageChannels | P.ManageRoles;
  // @everyone : « Mentionner @everyone » refusé dans le salon, le bot ne l'a pas.
  assert.deepEqual(missingGrantedPermissions([{ allow: 0n, deny: P.MentionEveryone | P.SendMessages }], bot), ['MentionEveryone']);
  assert.deepEqual(missingGrantedPermissions([{ allow: { bitfield: 0n }, deny: { bitfield: P.ManageWebhooks } }], bot), ['ManageWebhooks']);
  assert.deepEqual(missingGrantedPermissions([{ allow: 0n, deny: P.SendMessages }], bot), []);
});

test('S42 missingGrantedPermissions : « Gérer les permissions » (ManageRoles) dans une surcharge exige un bot Administrateur', () => {
  const bot = P.ViewChannel | P.ManageChannels | P.ManageRoles;
  assert.deepEqual(missingGrantedPermissions([{ allow: P.ManageRoles, deny: 0n }], bot), ['ManageRoles']);
  assert.deepEqual(missingGrantedPermissions([{ allow: 0n, deny: P.ManageRoles }], bot), ['ManageRoles']);
  assert.deepEqual(missingGrantedPermissions([{ allow: P.ManageRoles | P.MentionEveryone, deny: P.ManageWebhooks }], P.Administrator), []);
});

test('S42 Secur botMask : ManageRoles retiré du masque d\'un bot non administrateur (recréation refusée sinon)', () => {
  const guild = (bits) => ({ members: { me: { permissions: new PermissionsBitField(bits) } } });
  const mask = St.botMask(guild(P.ViewChannel | P.ManageChannels | P.ManageRoles));
  assert.equal(mask & P.ManageRoles, 0n);
  assert.equal(mask & P.ManageChannels, P.ManageChannels);
  assert.equal(St.botMask(guild(P.Administrator)), null);
  const [ow] = St.mapOverwrites([{ id: 'r1', type: 0, allow: String(P.ManageRoles | P.ViewChannel), deny: String(P.ManageRoles) }], (id) => id, mask);
  assert.equal(ow.allow, P.ViewChannel);
  assert.equal(ow.deny, 0n);
});
