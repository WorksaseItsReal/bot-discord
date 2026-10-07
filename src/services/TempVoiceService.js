'use strict';

const { ChannelType, PermissionFlagsBits, OverwriteType } = require('discord.js');
const { card, field, ICONS, bullets } = require('../utils/ui');
const { CooldownManager } = require('../core/cooldowns');
const { UserError } = require('../core/errors');
const { discordTimestamp } = require('../utils/time');
const tv = require('../utils/tempVoice');

const { OWNER_PERMISSIONS } = tv;

/** Délai minimal entre deux créations de vocal pour un même membre (anti va-et-vient). */
const HUB_COOLDOWN_MS = 10_000;
/** Au-delà, un renommage est considéré comme mis en file par la limite de Discord. */
const RENAME_TIMEOUT_MS = 5_000;

/**
 * Overwrites de la catégorie parente, copiés (liste { id, type, allow, deny }). Pur.
 * @param {{ permissionOverwrites?: { cache?: Map<string, any> } }|null|undefined} parent
 */
function parentOverwrites(parent) {
  return [...(parent?.permissionOverwrites?.cache?.values?.() ?? [])].map((ow) => ({
    id: ow.id,
    type: ow.type,
    allow: BigInt(ow.allow?.bitfield ?? 0n),
    deny: BigInt(ow.deny?.bitfield ?? 0n),
  }));
}

/**
 * Overwrites d'un nouveau vocal temporaire : ceux de la catégorie parente
 * (sinon un `permissionOverwrites` explicite les remplacerait, et un vocal créé
 * dans une catégorie privée deviendrait public) + celui du propriétaire, fusionné
 * avec un éventuel overwrite existant pour lui. Pur.
 * @param {{ permissionOverwrites?: { cache?: Map<string, any> } }|null|undefined} parent
 * @param {string} ownerId
 */
function inheritedOverwrites(parent, ownerId) {
  const out = [];
  let owner = null;
  for (const entry of parentOverwrites(parent)) {
    if (entry.id === ownerId) owner = entry;
    else out.push(entry);
  }
  out.push({
    id: ownerId,
    type: OverwriteType.Member,
    allow: (owner?.allow ?? 0n) | OWNER_PERMISSIONS,
    deny: (owner?.deny ?? 0n) & ~OWNER_PERMISSIONS,
  });
  return out;
}

/** Promesse résolue à `fallback` si elle n'aboutit pas à temps (la requête continue). */
function withTimeout(promise, ms, fallback) {
  let timer;
  return Promise.race([promise, new Promise((resolve) => (timer = setTimeout(() => resolve(fallback), ms)))]).finally(() => clearTimeout(timer));
}

const isRateLimit = (err) => err?.status === 429 || err?.name === 'RateLimitError' || /rate ?limit/i.test(err?.message ?? '');

/**
 * Vocaux temporaires : rejoindre un salon "hub" crée un vocal personnel,
 * supprimé automatiquement quand il devient vide. Un panneau de contrôle
 * (verrou, visibilité, nom, limite, expulsion, bannissement, transfert…) est
 * posté dans le chat du vocal.
 */
class TempVoiceService {
  /**
   * @param {object} deps
   * @param {import('../database/repositories/TempVoiceRepository').TempVoiceRepository} deps.tempVoice
   * @param {import('./ConfigService').ConfigService} deps.config
   * @param {number} [deps.renameTimeoutMs] délai avant de considérer un renommage « en file » (tests)
   */
  constructor({ tempVoice, config, renameTimeoutMs = RENAME_TIMEOUT_MS }) {
    this.tempVoice = tempVoice;
    this.config = config;
    this.renameTimeoutMs = renameTimeoutMs;
    /** Cooldown par membre sur le hub : évite les rafales création/suppression. */
    this.hubCooldowns = new CooldownManager();
    /** Horodatages des renommages par salon (limite Discord : 2 / 10 min). */
    this.renames = new Map();
  }

  /** Réagit à un changement d'état vocal (join/leave). */
  async handleVoiceUpdate(oldState, newState) {
    const guild = newState.guild || oldState.guild;
    const cfg = this.config.get(guild.id).tempVoice;

    // Création : arrivée dans le hub
    if (cfg?.enabled && cfg.hubChannelId && newState.channelId === cfg.hubChannelId && oldState.channelId !== newState.channelId) {
      const userId = newState.member?.id ?? newState.id;
      // En cooldown : le membre reste dans le hub, aucun salon n'est créé.
      if (!this.hubCooldowns.hit(`${guild.id}:${userId}`, HUB_COOLDOWN_MS)) {
        await this.#createFor(newState, cfg).catch(() => {});
      }
    }

    // Suppression : un salon temporaire devenu vide
    if (oldState.channelId && oldState.channelId !== newState.channelId) {
      const record = this.tempVoice.get(oldState.channelId);
      if (record) {
        const channel = oldState.guild.channels.cache.get(oldState.channelId);
        if (channel && channel.members.size === 0) {
          this.tempVoice.delete(oldState.channelId);
          this.renames.delete(oldState.channelId);
          await channel.delete().catch(() => {});
        } else if (channel && record.owner_id === (oldState.member?.id ?? oldState.id)) {
          // Le propriétaire est parti : le panneau propose de réclamer le salon.
          await this.refreshPanel(channel, `🙋 <@${record.owner_id}> est parti : un membre connecté peut **réclamer** le salon.`).catch(() => {});
        }
      }
    }

    // Le propriétaire revient dans son salon : le panneau ne propose plus de le réclamer.
    // (Depuis le hub, c'est le déplacement de création : le panneau vient d'être posté.)
    if (newState.channelId && oldState.channelId !== newState.channelId && newState.channelId !== cfg?.hubChannelId && oldState.channelId !== cfg?.hubChannelId) {
      const record = this.tempVoice.get(newState.channelId);
      if (record?.panel_message_id && record.owner_id === (newState.member?.id ?? newState.id)) {
        const channel = guild.channels.cache.get(newState.channelId);
        if (channel) await this.refreshPanel(channel).catch(() => {});
      }
    }
  }

  async #createFor(state, cfg) {
    const member = state.member;
    if (!member) return;
    const guild = state.guild;
    const guildConfig = this.config.get(guild.id);
    const prefs = cfg.rememberPrefs !== false ? this.tempVoice.getPrefs?.(guild.id, member.id) ?? null : null;
    const n = (this.tempVoice.all?.() ?? []).filter((r) => r.guild_id === guild.id).length + 1;

    const remembered = prefs?.name ? tv.checkName(prefs.name, guildConfig) : null;
    const name = remembered?.ok
      ? remembered.name
      : tv.defaultName(cfg.nameTemplate || tv.DEFAULT_TEMPLATE, { pseudo: member.displayName, username: member.user?.username, n }, guildConfig);
    const rawLimit = prefs?.user_limit ?? cfg.defaultLimit ?? 0;
    const userLimit = Number.isInteger(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, tv.MAX_USER_LIMIT) : 0;
    const locked = Boolean(prefs?.locked);

    // Catégorie configurée supprimée : on retombe sur celle du hub.
    const category = cfg.categoryId && guild.channels.cache.get(cfg.categoryId)?.type === ChannelType.GuildCategory ? cfg.categoryId : null;
    const parentId = category || state.channel?.parentId || null;
    const parent = parentId ? guild.channels.cache.get(parentId) : null;
    let permissionOverwrites = inheritedOverwrites(parent, member.id);
    if (locked) {
      permissionOverwrites = tv.accessOverwrites(permissionOverwrites, {
        flag: PermissionFlagsBits.Connect,
        on: true,
        guildId: guild.id,
        parent: parentOverwrites(parent),
        roles: guild.roles?.cache,
        keep: [member.id],
      });
    }
    const options = { name, type: ChannelType.GuildVoice, parent: parentId, permissionOverwrites };
    if (userLimit) options.userLimit = userLimit;
    const channel = await guild.channels.create(options);
    this.tempVoice.create(channel.id, guild.id, member.id, { locked });
    try {
      await member.voice.setChannel(channel);
    } catch {
      // Le membre a quitté entre-temps (ou déplacement impossible) : pas de salon orphelin.
      this.tempVoice.delete(channel.id);
      await channel.delete().catch(() => {});
      return;
    }
    // Panneau de contrôle dans le chat textuel du vocal (facultatif).
    if (cfg.panel !== false) await this.postPanel(channel, { mention: true }).catch(() => {});
    else if (typeof channel.send === 'function') await channel.send({ embeds: [this.welcomeCard(member, channel)] }).catch(() => {});
  }

  // -------------------------------------------------------------- panneau

  /** Ligne du vocal temporaire (ou null). */
  record(channelId) {
    return this.tempVoice.get(channelId) ?? null;
  }

  /** Contenu du panneau d'un vocal (null si ce n'est pas un vocal temporaire). */
  panel(channel, notice) {
    const record = this.record(channel.id);
    if (!record) return null;
    return tv.panelPayload({ channel, record, guild: channel.guild, notice });
  }

  /** Poste le panneau dans le chat du vocal et mémorise son message. */
  async postPanel(channel, { notice, mention = false } = {}) {
    if (typeof channel?.send !== 'function') return null;
    const payload = this.panel(channel, notice);
    if (!payload) return null;
    const ownerId = this.record(channel.id).owner_id;
    const message = await channel.send({
      ...payload,
      ...(mention ? { content: `<@${ownerId}>`, allowedMentions: { users: [ownerId] } } : {}),
    });
    if (message?.id) this.tempVoice.setPanel?.(channel.id, message.id);
    return message;
  }

  /** Met à jour le panneau existant (jamais de nouveau message : pas de spam). */
  async refreshPanel(channel, notice) {
    const record = this.record(channel.id);
    if (!record?.panel_message_id || !channel.messages?.fetch) return false;
    const message = await channel.messages.fetch(record.panel_message_id).catch(() => null);
    if (!message) return false;
    await message.edit({ ...this.panel(channel, notice), content: null });
    return true;
  }

  // -------------------------------------------------------------- actions

  /** Overwrites actuels du salon et de sa catégorie. */
  #overwrites(channel) {
    const parent = channel.parentId ? channel.guild?.channels?.cache?.get(channel.parentId) : null;
    return { current: tv.snapshot(channel), parent: parentOverwrites(parent) };
  }

  /** Mémorise une préférence si c'est le propriétaire qui agit (et si l'option est active). */
  #remember(channel, actorId, patch) {
    const record = this.record(channel.id);
    if (!record || record.owner_id !== actorId) return;
    if (this.config.get(channel.guild.id).tempVoice?.rememberPrefs === false) return;
    this.tempVoice.savePrefs?.(channel.guild.id, actorId, patch);
  }

  /** Membres connectés à garder lors d'un verrouillage / masquage (hors bots) + propriétaire. */
  #keep(channel, record) {
    const ids = [...(channel.members?.values?.() ?? [])].filter((m) => !m.user?.bot).map((m) => m.id);
    return [record.owner_id, ...ids];
  }

  /**
   * Verrouille / masque (on) ou rétablit (off). Les membres présents gardent l'accès.
   * @param {'lock'|'hide'} kind
   */
  async setAccess(channel, kind, on, actorId) {
    const record = this.record(channel.id);
    if (!record) throw new UserError('Ce salon n\'est plus un vocal temporaire.');
    const flag = kind === 'lock' ? PermissionFlagsBits.Connect : PermissionFlagsBits.ViewChannel;
    const { current, parent } = this.#overwrites(channel);
    const list = tv.accessOverwrites(current, { flag, on, guildId: channel.guild.id, parent, roles: channel.guild.roles?.cache, keep: this.#keep(channel, record) });
    await channel.permissionOverwrites.set(list, `Vocal temporaire : ${kind === 'lock' ? (on ? 'verrouillé' : 'déverrouillé') : on ? 'masqué' : 'affiché'}`);
    this.tempVoice.setState?.(channel.id, kind === 'lock' ? { locked: on } : { hidden: on });
    if (kind === 'lock') this.#remember(channel, actorId, { locked: on });
  }

  /**
   * Renomme (nom filtré, limite de Discord gérée).
   * @returns {Promise<{ name: string, queued: boolean }>}
   */
  async rename(channel, raw, actorId, now = Date.now()) {
    const name = tv.assertName(raw, this.config.get(channel.guild.id));
    if (name === channel.name) return { name, queued: false };
    const window = tv.renameWindow(this.renames.get(channel.id), now);
    if (!window.allowed) {
      throw new UserError(`Discord limite les renommages à **${tv.RENAME_LIMIT} toutes les 10 minutes** par salon. Réessayez ${discordTimestamp(window.retryAt, 'R')}.`);
    }
    this.renames.set(channel.id, [...window.history, now]);
    let result;
    try {
      result = await withTimeout(channel.setName(name, 'Vocal temporaire renommé'), this.renameTimeoutMs, 'queued');
    } catch (err) {
      if (isRateLimit(err)) throw new UserError('Discord limite les renommages de ce salon : réessayez dans quelques minutes.');
      throw err;
    }
    this.#remember(channel, actorId, { name });
    return { name, queued: result === 'queued' };
  }

  async setLimit(channel, limit, actorId) {
    if (!Number.isInteger(limit) || limit < 0 || limit > tv.MAX_USER_LIMIT) throw new UserError(`La limite doit être comprise entre 0 et ${tv.MAX_USER_LIMIT}.`);
    await channel.setUserLimit(limit, 'Vocal temporaire : limite de places');
    this.#remember(channel, actorId, { limit });
  }

  async setBitrate(channel, kbps) {
    const max = tv.maxBitrate(channel.guild);
    if (!tv.BITRATES.includes(kbps) || kbps * 1000 > max) throw new UserError(`Débit indisponible : ce serveur autorise jusqu'à **${max / 1000} kb/s**.`);
    await channel.setBitrate(kbps * 1000, 'Vocal temporaire : débit');
  }

  async setRegion(channel, region) {
    if (region !== 'auto' && !tv.REGION_IDS.has(region)) throw new UserError('Région inconnue.');
    await channel.setRTCRegion(region === 'auto' ? null : region, 'Vocal temporaire : région');
  }

  /**
   * Cibles valides d'une action de modération du salon.
   * @returns {{ ok: string[], refused: string[] }}
   */
  #targets(channel, ids, { staff, record, allowOwner = false }) {
    const me = channel.guild.members?.me?.id ?? channel.client?.user?.id;
    const ok = [];
    const refused = [];
    for (const id of new Set(ids)) {
      if (!tv.SNOWFLAKE.test(id)) continue;
      const member = channel.guild.members?.cache?.get(id) ?? channel.members?.get?.(id);
      const protectedTarget =
        id === me ||
        (id === record.owner_id && !allowOwner) ||
        (!staff && (id === channel.guild.ownerId || tv.hasStaffPermissions(member?.permissions)));
      (protectedTarget ? refused : ok).push(id);
    }
    return { ok, refused };
  }

  /** Déconnecte des membres présents. @returns {Promise<{ done: string[], refused: string[] }>} */
  async kick(channel, ids, { actorId, staff }) {
    const record = this.record(channel.id);
    const { ok, refused } = this.#targets(channel, ids.filter((id) => id !== actorId), { staff, record, allowOwner: staff });
    const done = [];
    for (const id of ok) {
      const member = channel.members?.get?.(id);
      if (!member) continue;
      await member.voice.disconnect('Expulsé du vocal temporaire');
      done.push(id);
    }
    return { done, refused };
  }

  /** Bannit du salon (Connect refusé) et déconnecte les bannis présents. */
  async ban(channel, ids, { actorId, staff }) {
    const record = this.record(channel.id);
    const { ok, refused } = this.#targets(channel, ids.filter((id) => id !== actorId), { staff, record });
    if (ok.length) {
      await channel.permissionOverwrites.set(tv.banOverwrites(tv.snapshot(channel), ok), 'Vocal temporaire : membres bannis du salon');
      for (const id of ok) await channel.members?.get?.(id)?.voice?.disconnect('Banni du vocal temporaire').catch(() => {});
    }
    return { done: ok, refused };
  }

  /** Autorise (voir + rejoindre, même verrouillé ; lève un bannissement). */
  async permit(channel, ids) {
    const me = channel.guild.members?.me?.id;
    const ok = [...new Set(ids)].filter((id) => tv.SNOWFLAKE.test(id) && id !== me);
    if (ok.length) await channel.permissionOverwrites.set(tv.permitOverwrites(tv.snapshot(channel), ok), 'Vocal temporaire : membres autorisés');
    return { done: ok, refused: [] };
  }

  /** Transfère la propriété à un membre connecté. */
  async transfer(channel, toId) {
    const record = this.record(channel.id);
    if (!record) throw new UserError('Ce salon n\'est plus un vocal temporaire.');
    if (!tv.SNOWFLAKE.test(toId ?? '')) throw new UserError('Membre invalide.');
    if (toId === record.owner_id) throw new UserError('Ce membre est déjà propriétaire du salon.');
    const target = channel.members?.get?.(toId);
    if (!target) throw new UserError('Le nouveau propriétaire doit être connecté à ce salon.');
    if (target.user?.bot) throw new UserError('Un bot ne peut pas être propriétaire d\'un vocal.');
    await channel.permissionOverwrites.set(tv.transferOverwrites(tv.snapshot(channel), record.owner_id, toId), 'Vocal temporaire : transfert de propriété');
    this.tempVoice.setOwner?.(channel.id, toId);
    return record.owner_id;
  }

  /** Réclame un salon dont le propriétaire est parti. */
  async claim(channel, memberId) {
    const record = this.record(channel.id);
    if (!record) throw new UserError('Ce salon n\'est plus un vocal temporaire.');
    if (record.owner_id === memberId) throw new UserError('Vous êtes déjà propriétaire de ce salon.');
    if (channel.members?.has?.(record.owner_id)) throw new UserError(`Le propriétaire <@${record.owner_id}> est toujours connecté : demandez-lui un transfert.`);
    if (!channel.members?.has?.(memberId)) throw new UserError('Rejoignez ce salon vocal pour pouvoir le réclamer.');
    return this.transfer(channel, memberId);
  }

  // -------------------------------------------------------------- divers

  /** Carte d'accueil d'un vocal temporaire (si le panneau est désactivé). Pure. */
  welcomeCard(member, channel) {
    return card({
      tone: 'info',
      section: 'voice',
      icon: ICONS.voice,
      title: 'Votre vocal temporaire',
      description: [
        `Bienvenue ${member} ! Ce salon est à vous : il sera supprimé automatiquement dès qu'il sera vide.`,
        '',
        bullets(['Déplacez ou déconnectez les membres si besoin.']),
      ],
      fields: [field(ICONS.owner, 'Propriétaire', `${member}`), field(ICONS.voice, 'Salon', `${channel}`)],
      footer: 'Vocaux temporaires',
    });
  }

  /** Vocaux temporaires actifs d'un serveur. */
  listByGuild(guildId) {
    return this.tempVoice.all().filter((r) => r.guild_id === guildId);
  }

  /**
   * Nettoyage au démarrage : supprime les salons temporaires vides et oublie
   * ceux qui n'existent plus (suppressions survenues pendant que le bot était hors ligne).
   * @param {import('discord.js').Client} client
   * @returns {Promise<{ deleted: number, dropped: number }>}
   */
  async cleanup(client) {
    let deleted = 0;
    let dropped = 0;
    for (const record of this.tempVoice.all()) {
      const guild = client.guilds.cache.get(record.guild_id);
      if (!guild) {
        // Serveur indisponible (panne) ou quitté : on ne touche à rien, il peut revenir.
        continue;
      }
      const channel = await guild.channels.fetch(record.channel_id).catch(() => null);
      if (!channel) {
        this.tempVoice.delete(record.channel_id);
        dropped += 1;
        continue;
      }
      if (channel.members?.size === 0) {
        this.tempVoice.delete(record.channel_id);
        await channel.delete('Vocal temporaire vide').catch(() => {});
        deleted += 1;
      }
    }
    return { deleted, dropped };
  }
}

module.exports = { TempVoiceService, HUB_COOLDOWN_MS, inheritedOverwrites, parentOverwrites, OWNER_PERMISSIONS };
