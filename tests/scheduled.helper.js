'use strict';

/**
 * Faux objets discord.js (serveur, rôles, membres, salons) et client minimal pour
 * tester les services planifiés (rôles temporaires, annonces, anniversaires) sans réseau.
 */

const { PermissionsBitField, PermissionFlagsBits, ChannelType, Collection } = require('discord.js');
const { memoryDb } = require('./db.helper');
const { GuildConfigRepository } = require('../src/database/repositories/GuildConfigRepository');
const { ConfigService } = require('../src/services/ConfigService');

const GUILD = '100000000000000001';
const ROLE = { safe: '300000000000000001', mod: '300000000000000002', high: '300000000000000003', bot: '300000000000000004', other: '300000000000000005' };
const CH = { general: '400000000000000001', voice: '400000000000000002' };
const USER = { a: '500000000000000001', b: '500000000000000002', mod: '500000000000000003' };

const apiError = (code) => Object.assign(new Error(`Erreur ${code}`), { code });

function fakeRole(id, { position = 1, managed = false, perms = 0n, mentionable = true, name = `role-${id.slice(-2)}` } = {}) {
  return { id, name, position, managed, mentionable, permissions: new PermissionsBitField(perms), toString: () => `<@&${id}>` };
}

function fakeChannel(id, { type = ChannelType.GuildText, perms = PermissionsBitField.All, fail = null } = {}) {
  const ch = {
    id,
    type,
    sent: [],
    fail,
    async send(payload) {
      if (ch.fail) throw ch.fail;
      ch.sent.push(payload);
      return { id: `60000000000000000${ch.sent.length}` };
    },
    permissionsFor: () => new PermissionsBitField(perms),
    toString: () => `<#${id}>`,
  };
  return ch;
}

function fakeMember(guild, userId, roleIds = []) {
  const roles = new Set(roleIds);
  const member = {
    id: userId,
    guild,
    displayName: `Membre ${userId.slice(-2)}`,
    user: { id: userId, bot: false, tag: `membre${userId.slice(-2)}`, username: `membre${userId.slice(-2)}`, displayAvatarURL: () => null, toString: () => `<@${userId}>` },
    displayAvatarURL: () => null,
    calls: [],
    failNext: null,
    roles: {
      cache: { has: (id) => roles.has(id), keys: () => roles.keys() },
      highest: { position: 0 },
      async add(id) {
        member.calls.push(['add', id]);
        if (member.failNext) {
          const e = member.failNext;
          member.failNext = null;
          throw e;
        }
        roles.add(id);
      },
      async remove(id) {
        member.calls.push(['remove', id]);
        if (member.failNext) {
          const e = member.failNext;
          member.failNext = null;
          throw e;
        }
        roles.delete(id);
      },
    },
    toString: () => `<@${userId}>`,
  };
  return member;
}

/** Serveur factice : rôles, salons, membres (cache + fetch), bot avec « Gérer les rôles ». */
function fakeGuild() {
  const guild = {
    id: GUILD,
    name: 'Serveur test',
    ownerId: USER.mod,
    available: true,
    roles: { cache: new Collection() },
    channels: { cache: new Collection() },
    members: { cache: new Collection(), me: null, fetchCalls: 0 },
  };
  guild.roles.cache.set(GUILD, fakeRole(GUILD, { position: 0, name: '@everyone' }));
  guild.roles.cache.set(ROLE.safe, fakeRole(ROLE.safe, { position: 2, name: 'VIP' }));
  guild.roles.cache.set(ROLE.other, fakeRole(ROLE.other, { position: 3, name: 'Autre', mentionable: false }));
  guild.roles.cache.set(ROLE.mod, fakeRole(ROLE.mod, { position: 4, name: 'Modo', perms: PermissionFlagsBits.KickMembers }));
  guild.roles.cache.set(ROLE.high, fakeRole(ROLE.high, { position: 20, name: 'Haut' }));
  guild.roles.cache.set(ROLE.bot, fakeRole(ROLE.bot, { position: 10, name: 'Bot', managed: true }));
  guild.channels.cache.set(CH.general, fakeChannel(CH.general));
  guild.channels.cache.set(CH.voice, fakeChannel(CH.voice, { type: ChannelType.GuildVoice }));
  guild.members.me = { permissions: new PermissionsBitField(PermissionFlagsBits.ManageRoles | PermissionFlagsBits.SendMessages), roles: { highest: { position: 10 } } };
  guild.members.fetch = async (arg) => {
    guild.members.fetchCalls += 1;
    if (typeof arg === 'string') {
      const m = guild.members.cache.get(arg);
      if (!m) throw apiError(10007);
      return m;
    }
    return new Collection([...(arg?.user ?? [])].filter((id) => guild.members.cache.has(id)).map((id) => [id, guild.members.cache.get(id)]));
  };
  return guild;
}

/** Client minimal : serveur en cache, logs enregistrés, base en mémoire. */
function fakeClient(guild) {
  const { db } = memoryDb();
  const config = new ConfigService(new GuildConfigRepository(db));
  const logs = [];
  const client = {
    db,
    user: { id: '999999999999999999', toString: () => '<@999999999999999999>' },
    guilds: { cache: new Collection(guild ? [[guild.id, guild]] : []) },
    isReady: () => true,
    services: {
      config,
      logging: { send: async (guildId, category, embed, components, ctx) => (logs.push({ guildId, category, embed: embed.toJSON?.() ?? embed, ctx }), true) },
    },
    logs,
  };
  return client;
}

module.exports = { GUILD, ROLE, CH, USER, apiError, fakeRole, fakeChannel, fakeMember, fakeGuild, fakeClient };
