'use strict';

const { ChannelType, PermissionFlagsBits, OverwriteType } = require('discord.js');
const { card, field, ICONS, bullets, status } = require('../utils/ui');
const { CooldownManager } = require('../core/cooldowns');
const { UserError } = require('../core/errors');
const { createLogger } = require('../core/logger');
const { discordTimestamp } = require('../utils/time');
const tv = require('../utils/tempVoice');

const logger = createLogger('tempvoice');

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
 * Overwrites attendus sur un vocal créé dans `parent` : ceux de la catégorie + celui
 * du propriétaire, fusionné avec un éventuel overwrite existant pour lui. Pur.
 * (La création, elle, ne passe plus d'overwrites : le salon hérite de la catégorie
 * côté Discord, puis seul l'overwrite du propriétaire est ajouté.)
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

/** Salon inconnu (déjà supprimé). */
const isUnknownChannel = (err) => err?.code === 10003;

/** Membres humains connectés (un bot de musique seul ne garde pas le salon en vie). */
const humanCount = (channel) => [...(channel?.members?.values?.() ?? [])].filter((m) => !m.user?.bot).length;

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
    /** Avertissements « cooldown » déjà envoyés (un MP par fenêtre, pas de spam). */
    this.cooldownNotices = new CooldownManager();
    /** File d'attente par salon : les actions du panneau sur un même vocal s'exécutent une par une. */
    this.locks = new Map();
  }

  /**
   * Exécute `fn` quand les actions précédentes sur ce salon sont terminées
   * (réussies ou non). La file est retirée de la Map dès qu'elle est vide.
   */
  #withLock(channelId, fn) {
    const previous = this.locks.get(channelId) ?? Promise.resolve();
    const run = previous.then(() => fn());
    const tail = run.then(() => {}, () => {});
    this.locks.set(channelId, tail);
    tail.then(() => {
      if (this.locks.get(channelId) === tail) this.locks.delete(channelId);
    });
    return run;
  }

  /**
   * Applique des overwrites par changements ciblés (un `edit` / `delete` par overwrite
   * modifié) au lieu de remplacer toute la liste : une action ne peut plus effacer celle
   * d'une autre. Le cache est mis à jour aussitôt (discord.js ne le fait qu'à la
   * réception de l'événement) pour que l'action suivante de la file parte du bon état.
   */
  async #applyOverwrites(channel, desired, reason) {
    const manager = channel.permissionOverwrites;
    const { edits, deletes } = tv.overwriteChanges(tv.snapshot(channel), desired);
    for (const e of edits) {
      await manager.edit(e.id, e.options, { type: e.type, reason });
      if (typeof manager._add === 'function') manager._add({ id: e.id, type: e.type, allow: String(e.allow), deny: String(e.deny) });
    }
    for (const id of deletes) {
      await manager.delete(id, reason);
      manager.cache?.delete?.(id);
    }
  }

  /** Prévient un membre : MP, sinon message (avec mention) dans le chat du salon `fallback`. */
  async #notify(member, fallback, text) {
    const embeds = [status.warn(text, 'Vocaux temporaires')];
    const dm = typeof member?.send === 'function' ? await member.send({ embeds }).then(() => true, () => false) : false;
    if (!dm && typeof fallback?.send === 'function') {
      await fallback.send({ content: `<@${member.id}>`, embeds, allowedMentions: { users: [member.id] } }).catch(() => {});
    }
  }

  /** Réagit à un changement d'état vocal (join/leave). */
  async handleVoiceUpdate(oldState, newState) {
    const guild = newState.guild || oldState.guild;
    const cfg = this.config.get(guild.id).tempVoice;

    // Création : arrivée dans le hub
    if (cfg?.enabled && cfg.hubChannelId && newState.channelId === cfg.hubChannelId && oldState.channelId !== newState.channelId) {
      const userId = newState.member?.id ?? newState.id;
      const key = `${guild.id}:${userId}`;
      const wait = this.hubCooldowns.hit(key, HUB_COOLDOWN_MS);
      if (!wait) {
        await this.#createFor(newState, cfg).catch(async (err) => {
          logger.warn(`Création d'un vocal temporaire impossible sur ${guild.id} :`, err?.message);
          if (newState.member) {
            await this.#notify(newState.member, newState.channel, 'Je n\'ai pas pu créer votre vocal temporaire. Prévenez un administrateur : il me manque sans doute des permissions dans la catégorie.');
          }
        });
      } else if (newState.member && !this.cooldownNotices.hit(key, HUB_COOLDOWN_MS)) {
        // En cooldown : le membre reste dans le hub, aucun salon n'est créé (un seul avertissement par fenêtre).
        await this.#notify(newState.member, newState.channel, `Vous venez de créer un vocal : patientez **${Math.ceil(wait / 1000)} s**, puis rejoignez à nouveau le salon créateur.`);
      }
    }

    // Suppression : un salon temporaire devenu vide
    if (oldState.channelId && oldState.channelId !== newState.channelId) {
      const record = this.tempVoice.get(oldState.channelId);
      if (record) {
        const channel = oldState.guild.channels.cache.get(oldState.channelId);
        if (channel && humanCount(channel) === 0) {
          // La ligne n'est oubliée qu'une fois le salon réellement supprimé (sinon il resterait orphelin).
          const deleted = await channel.delete().then(() => true, (err) => isUnknownChannel(err));
          if (deleted) {
            this.tempVoice.delete(oldState.channelId);
            this.renames.delete(oldState.channelId);
          }
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
    // Aucun `permissionOverwrites` explicite : Discord copie ceux de la catégorie. En les
    // passant nous-mêmes, la création échouait (50013) dès qu'un droit copié n'était pas
    // détenu par le bot (ou Gérer les rôles en overwrite, sans Administrateur).
    const options = { name, type: ChannelType.GuildVoice, parent: parentId };
    if (userLimit) options.userLimit = userLimit;
    const channel = await guild.channels.create(options);
    this.tempVoice.create(channel.id, guild.id, member.id, { locked });
    // Puis l'overwrite du propriétaire (et le verrou mémorisé), changements ciblés.
    const ownerReady = await this.#withLock(channel.id, async () => {
      let desired = tv.setBits(tv.snapshot(channel), member.id, OverwriteType.Member, { allow: OWNER_PERMISSIONS });
      if (locked) {
        desired = tv.accessOverwrites(desired, {
          flag: PermissionFlagsBits.Connect,
          on: true,
          guildId: guild.id,
          parent: parentOverwrites(parent),
          roles: guild.roles?.cache,
          keep: [member.id],
        });
      }
      await this.#applyOverwrites(channel, desired, 'Vocal temporaire : droits du propriétaire');
    }).then(() => true, (err) => {
      logger.warn(`Droits du propriétaire non appliqués sur le vocal ${channel.id} (${guild.id}) :`, err?.message);
      return false;
    });
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
    if (!ownerReady) {
      await this.#notify(member, channel, `Votre vocal <#${channel.id}> est créé, mais je n'ai pas pu vous y donner vos droits de propriétaire${locked ? ' ni le verrouiller' : ''}. Le panneau de contrôle fonctionne ; prévenez un administrateur si le problème persiste.`);
    }
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
    const payload = message ? this.panel(channel, notice) : null;
    if (!payload) return false;
    await message.edit({ ...payload, content: null });
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
    return this.#withLock(channel.id, async () => {
      const record = this.record(channel.id);
      if (!record) throw new UserError('Ce salon n\'est plus un vocal temporaire.');
      const flag = kind === 'lock' ? PermissionFlagsBits.Connect : PermissionFlagsBits.ViewChannel;
      const { current, parent } = this.#overwrites(channel);
      const list = tv.accessOverwrites(current, { flag, on, guildId: channel.guild.id, parent, roles: channel.guild.roles?.cache, keep: this.#keep(channel, record) });
      await this.#applyOverwrites(channel, list, `Vocal temporaire : ${kind === 'lock' ? (on ? 'verrouillé' : 'déverrouillé') : on ? 'masqué' : 'affiché'}`);
      this.tempVoice.setState?.(channel.id, kind === 'lock' ? { locked: on } : { hidden: on });
      if (kind === 'lock') this.#remember(channel, actorId, { locked: on });
    });
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
      // Un échec (membre parti entre-temps…) n'interrompt pas les autres ; seuls les expulsés sont annoncés.
      const kicked = await member.voice.disconnect('Expulsé du vocal temporaire').then(() => true, () => false);
      if (kicked) done.push(id);
    }
    return { done, refused };
  }

  /** Bannit du salon (Connect refusé) et déconnecte les bannis présents. */
  async ban(channel, ids, { actorId, staff }) {
    return this.#withLock(channel.id, async () => {
      const record = this.record(channel.id);
      if (!record) throw new UserError('Ce salon n\'est plus un vocal temporaire.');
      const { ok, refused } = this.#targets(channel, ids.filter((id) => id !== actorId), { staff, record });
      if (ok.length) {
        await this.#applyOverwrites(channel, tv.banOverwrites(tv.snapshot(channel), ok), 'Vocal temporaire : membres bannis du salon');
        for (const id of ok) await channel.members?.get?.(id)?.voice?.disconnect('Banni du vocal temporaire').catch(() => {});
      }
      return { done: ok, refused };
    });
  }

  /** Autorise (voir + rejoindre, même verrouillé ; lève un bannissement). */
  async permit(channel, ids) {
    const me = channel.guild.members?.me?.id;
    const ok = [...new Set(ids)].filter((id) => tv.SNOWFLAKE.test(id) && id !== me);
    if (!ok.length) return { done: ok, refused: [] };
    return this.#withLock(channel.id, async () => {
      await this.#applyOverwrites(channel, tv.permitOverwrites(tv.snapshot(channel), ok), 'Vocal temporaire : membres autorisés');
      return { done: ok, refused: [] };
    });
  }

  /** Transfère la propriété à un membre connecté. */
  async transfer(channel, toId) {
    return this.#withLock(channel.id, () => this.#transfer(channel, toId));
  }

  /** Transfert (appelé dans la file du salon : l'enregistrement est relu ici). */
  async #transfer(channel, toId) {
    const record = this.record(channel.id);
    if (!record) throw new UserError('Ce salon n\'est plus un vocal temporaire.');
    if (!tv.SNOWFLAKE.test(toId ?? '')) throw new UserError('Membre invalide.');
    if (toId === record.owner_id) throw new UserError('Ce membre est déjà propriétaire du salon.');
    const target = channel.members?.get?.(toId);
    if (!target) throw new UserError('Le nouveau propriétaire doit être connecté à ce salon.');
    if (target.user?.bot) throw new UserError('Un bot ne peut pas être propriétaire d\'un vocal.');
    await this.#applyOverwrites(channel, tv.transferOverwrites(tv.snapshot(channel), record.owner_id, toId), 'Vocal temporaire : transfert de propriété');
    this.tempVoice.setOwner?.(channel.id, toId);
    return record.owner_id;
  }

  /** Réclame un salon dont le propriétaire est parti (deux réclamations simultanées : la seconde est refusée). */
  async claim(channel, memberId) {
    return this.#withLock(channel.id, async () => {
      const record = this.record(channel.id);
      if (!record) throw new UserError('Ce salon n\'est plus un vocal temporaire.');
      if (record.owner_id === memberId) throw new UserError('Vous êtes déjà propriétaire de ce salon.');
      if (channel.members?.has?.(record.owner_id)) throw new UserError(`Le propriétaire <@${record.owner_id}> est toujours connecté : demandez-lui un transfert.`);
      if (!channel.members?.has?.(memberId)) throw new UserError('Rejoignez ce salon vocal pour pouvoir le réclamer.');
      return this.#transfer(channel, memberId);
    });
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
        bullets(['Invitez qui vous voulez : le salon vit tant que quelqu\'un y est connecté.']),
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
      if (humanCount(channel) === 0) {
        const ok = await channel.delete('Vocal temporaire vide').then(() => true, (err) => isUnknownChannel(err));
        if (ok) {
          this.tempVoice.delete(record.channel_id);
          deleted += 1;
        }
      }
    }
    return { deleted, dropped };
  }
}

module.exports = { TempVoiceService, HUB_COOLDOWN_MS, inheritedOverwrites, parentOverwrites, OWNER_PERMISSIONS };
