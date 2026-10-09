'use strict';

const { PermissionFlagsBits, ChannelType } = require('discord.js');
const { card, field, wide, ICONS } = require('../utils/ui');
const { truncate } = require('../utils/embeds');
const { snowflake } = require('../utils/buttonGuard');
const { UserError } = require('../core/errors');

/** Présentation des actions sur un salon (lock, unlock, hide, unhide). */
const CHANNEL_ACTIONS = {
  lock: { tone: 'caution', icon: ICONS.lock, title: 'Salon verrouillé', text: (c) => `${c} est désormais en lecture seule pour @everyone.` },
  unlock: { tone: 'success', icon: ICONS.unlock, title: 'Salon déverrouillé', text: (c) => `Tout le monde peut de nouveau écrire dans ${c}.` },
  hide: { tone: 'caution', icon: ICONS.hidden, title: 'Salon masqué', text: (c) => `${c} n'est plus visible par @everyone.` },
  unhide: { tone: 'success', icon: ICONS.visible, title: 'Salon visible', text: (c) => `${c} est de nouveau visible par @everyone.` },
};

/**
 * Carte de résultat d'une action sur un salon.
 * @param {'lock'|'unlock'|'hide'|'unhide'} kind
 */
function channelCard(kind, channel, moderator) {
  const meta = CHANNEL_ACTIONS[kind];
  return card({
    tone: meta.tone,
    section: 'moderation',
    icon: meta.icon,
    title: meta.title,
    description: meta.text(`${channel}`),
    fields: [
      field(ICONS.channel, 'Salon', `${channel}`),
      field(ICONS.moderator, 'Modérateur', moderator?.id ? `<@${moderator.id}>` : '—'),
    ],
  });
}

/**
 * Carte de verrouillage / déverrouillage de tout le serveur (lockall, lockdown, logs).
 * @param {{ enabled: boolean, count: number, moderator?: {id:string}|null, reason?: string|null, section?: string }} opts
 */
function serverLockCard({ enabled, count, moderator, reason, section = 'security' }) {
  const plural = count > 1 ? 's' : '';
  return card({
    tone: enabled ? 'danger' : 'success',
    section,
    icon: enabled ? '🚨' : ICONS.unlock,
    title: enabled ? 'Lockdown activé' : 'Lockdown levé',
    description: enabled
      ? `**${count}** salon${plural} ${count > 1 ? 'sont' : 'est'} désormais en lecture seule.`
      : count
        ? `**${count}** salon${plural} ${count > 1 ? 'ont' : 'a'} retrouvé ${count > 1 ? 'leurs' : 'ses'} permissions d'origine.`
        : 'Aucun salon n\'était verrouillé : rien à restaurer.',
    fields: [
      field(ICONS.count, enabled ? 'Salons verrouillés' : 'Salons restaurés', `**${count}**`),
      field(ICONS.moderator, 'Par', moderator?.id ? `<@${moderator.id}>` : '—'),
      reason ? wide(ICONS.reason, 'Raison', truncate(reason, 1024)) : null,
    ],
  });
}

/**
 * Permissions refusées à @everyone par un verrouillage, selon le type de salon.
 * Écrire, écrire dans les fils et créer des fils : sinon le lock se contourne
 * en ouvrant un fil. Types inconnus : SendMessages seul.
 */
const LOCK_PERMS = {
  [ChannelType.GuildText]: ['SendMessages', 'SendMessagesInThreads', 'CreatePublicThreads', 'CreatePrivateThreads'],
  [ChannelType.GuildAnnouncement]: ['SendMessages', 'SendMessagesInThreads', 'CreatePublicThreads'],
  [ChannelType.GuildForum]: ['SendMessages', 'SendMessagesInThreads'], // SendMessages = créer un post
  [ChannelType.GuildVoice]: ['SendMessages'], // salon textuel intégré au vocal
};
const DEFAULT_LOCK_PERMS = ['SendMessages'];
/** Types de salons verrouillés par lockall / lockdown. */
const LOCKABLE_TYPES = new Set(Object.keys(LOCK_PERMS).map(Number));
/** Parallélisme des opérations de masse (lockall / unlockall). */
const BATCH_SIZE = 5;

/** Portée d'un verrouillage : /lock individuel ou lockall / lockdown (y compris AntiRaid). */
const SCOPES = Object.freeze({ manual: 'manual', lockdown: 'lockdown' });

function lockPermsFor(channel) {
  return LOCK_PERMS[channel?.type] ?? DEFAULT_LOCK_PERMS;
}

/** État tri-valué d'un flag dans un overwrite (absent → null). */
function overwriteState(ow, flag) {
  return bitToState(ow?.allow?.bitfield, ow?.deny?.bitfield, flag);
}

/**
 * Normalise une ligne sauvegardée.
 *  - format actuel : `{ v: 2, scope, perms: { SendMessages: true|false|null, … } }` ;
 *  - ancien format : `{ allow, deny }` (bitfields complets d'avant le lock). L'ancien
 *    code ne refusait que SendMessages : seul ce bit est restauré (les autres n'ont
 *    pas été touchés). Pas de portée → traité comme un lockdown (comportement d'avant).
 * @returns {{ scope?: string, perms: Record<string, boolean|null> }}
 */
/**
 * Restaure des permissions de @everyone. Si la surcharge résultante est entièrement neutre
 * (rien d'autorisé, rien de refusé), elle est SUPPRIMÉE au lieu d'être laissée vide (0/0) :
 * le salon retrouve exactement l'apparence d'origine. Le calcul part du cache AVANT l'appel
 * (discord.js ne le met à jour qu'à réception de l'événement de la passerelle).
 */
async function restoreEveryone(channel, perms, reason) {
  const everyone = channel.guild.roles.everyone;
  const current = channel.permissionOverwrites.cache.get(everyone.id);
  let allow = BigInt(current?.allow?.bitfield ?? 0n);
  let deny = BigInt(current?.deny?.bitfield ?? 0n);
  for (const [name, value] of Object.entries(perms)) {
    const bit = PermissionFlagsBits[name];
    if (bit == null) continue;
    allow &= ~bit;
    deny &= ~bit;
    if (value === true) allow |= bit;
    else if (value === false) deny |= bit;
  }
  if (allow === 0n && deny === 0n && typeof channel.permissionOverwrites.delete === 'function') {
    if (current) await channel.permissionOverwrites.delete(everyone, reason);
    return;
  }
  await channel.permissionOverwrites.edit(everyone, perms, { reason });
}

function normalizeLock(data) {
  if (data?.perms) return { scope: data.scope, perms: { ...data.perms } };
  return { scope: data?.scope, perms: { SendMessages: bitToState(data?.allow, data?.deny) } };
}

/** Ligne prise en compte par lockdown status / unlockall / lockdown disable. */
function isLockdownLock(row) {
  return (normalizeLock(row.data).scope ?? SCOPES.lockdown) === SCOPES.lockdown;
}

/** Exécute `fn` par lots de `size` (Promise.allSettled) ; renvoie le nombre de succès. */
async function inBatches(items, fn, size = BATCH_SIZE) {
  let done = 0;
  for (let i = 0; i < items.length; i += size) {
    const results = await Promise.allSettled(items.slice(i, i + size).map((item) => fn(item)));
    done += results.filter((r) => r.status === 'fulfilled' && r.value !== false).length;
  }
  return done;
}

/**
 * Verrouillage de salons et lockdown d'urgence, avec sauvegarde de l'état
 * précédent pour restauration.
 */
class LockdownService {
  /**
   * @param {object} deps
   * @param {import('../database/repositories/LockRepository').LockRepository} deps.locks
   * @param {import('./LoggingService').LoggingService} deps.logging
   */
  constructor({ locks, logging }) {
    this.locks = locks;
    this.logging = logging;
    /** Serveurs dont un verrouillage ou une levée globale est en cours (double clic, deux admins). */
    this.busy = new Set();
  }

  /** Exécute `fn` seul pour ce serveur : enable/disable simultanés se marcheraient dessus. */
  async #exclusive(guildId, fn) {
    if (this.busy.has(guildId)) throw new UserError('Un verrouillage ou une levée du serveur est déjà en cours. Patientez quelques secondes.');
    this.busy.add(guildId);
    try {
      return await fn();
    } finally {
      this.busy.delete(guildId);
    }
  }

  /**
   * Verrouille un salon : refuse à @everyone d'écrire et de créer / écrire dans des
   * fils, en sauvegardant l'état tri-valué d'ORIGINE de chaque permission touchée.
   * Un second lock ne remplace jamais l'état d'origine par l'état « verrouillé » ;
   * il ne fait que compléter les permissions qui n'étaient pas encore sauvegardées.
   * Un /lock manuel sur un salon déjà verrouillé par un lockdown le fait passer en
   * portée « manuel » : la levée du lockdown ne doit pas annuler ce verrouillage voulu.
   * @param {{ scope?: 'manual'|'lockdown' }} [opts]
   */
  async lockChannel(channel, moderator, reason, { scope = SCOPES.manual } = {}) {
    assertOverwritable(channel);
    const everyone = channel.guild.roles.everyone;
    const perms = lockPermsFor(channel);
    const saved = this.locks.get(channel.guild.id, channel.id);
    const state = saved ? normalizeLock(saved.data) : { scope, perms: {} };
    const current = channel.permissionOverwrites.cache.get(everyone.id);
    const missing = perms.filter((p) => !(p in state.perms));
    const promote = Boolean(saved) && scope === SCOPES.manual && (state.scope ?? SCOPES.lockdown) !== SCOPES.manual;
    if (promote) state.scope = SCOPES.manual;
    if (!saved || missing.length || promote) {
      for (const p of missing) state.perms[p] = overwriteState(current, p);
      this.locks.save(channel.guild.id, channel.id, { v: 2, scope: state.scope, perms: state.perms });
    }
    try {
      await channel.permissionOverwrites.edit(everyone, Object.fromEntries(perms.map((p) => [p, false])), { reason });
    } catch (err) {
      // Salon non verrouillé : on n'en garde pas une trace qui fausserait le statut du lockdown.
      if (!saved) this.locks.delete(channel.guild.id, channel.id);
      else if (promote) this.locks.save(channel.guild.id, channel.id, saved.data);
      throw err;
    }
  }

  /**
   * Déverrouille un salon en restaurant l'état sauvegardé de chaque permission.
   * Sans état sauvegardé (salon non verrouillé par le bot) : on ne retire que le
   * refus d'écriture (SendMessages → neutre), sans toucher aux autres réglages.
   */
  async unlockChannel(channel, reason) {
    assertOverwritable(channel);
    const saved = this.locks.get(channel.guild.id, channel.id);
    if (saved) {
      await restoreEveryone(channel, normalizeLock(saved.data).perms, reason);
      this.locks.delete(channel.guild.id, channel.id);
    } else {
      await restoreEveryone(channel, { SendMessages: null }, reason);
    }
  }

  /**
   * Masque un salon à @everyone en sauvegardant l'état d'origine de ViewChannel
   * (état distinct du verrouillage : sorte `hide` dans LockRepository).
   */
  async hideChannel(channel, reason) {
    assertOverwritable(channel);
    const everyone = channel.guild.roles.everyone;
    if (!this.locks.get(channel.guild.id, channel.id, 'hide')) {
      const current = channel.permissionOverwrites.cache.get(everyone.id);
      this.locks.save(channel.guild.id, channel.id, { v: 2, perms: { ViewChannel: overwriteState(current, 'ViewChannel') } }, 'hide');
    }
    await channel.permissionOverwrites.edit(everyone, { ViewChannel: false }, { reason });
  }

  /**
   * Rend un salon visible : restaure l'état d'origine de ViewChannel (autorisé ou neutre).
   * Sans état sauvegardé (ou si le salon était déjà masqué avant /hide), on ne retire que
   * le refus posé par le bot (ViewChannel → neutre) : /unhide doit rendre le salon visible.
   */
  async unhideChannel(channel, reason) {
    assertOverwritable(channel);
    const saved = this.locks.get(channel.guild.id, channel.id, 'hide');
    const original = saved?.data?.perms?.ViewChannel;
    await restoreEveryone(channel, { ViewChannel: original === true ? true : null }, reason);
    if (saved) this.locks.delete(channel.guild.id, channel.id, 'hide');
  }

  /**
   * Verrouille tous les salons où l'on peut écrire (textuels, annonces, forums,
   * texte des vocaux), par lots de 5.
   * @param {{ log?: boolean }} [opts] log=false : l'appelant publie sa propre carte (AntiRaid)
   */
  async enable(guild, moderator, reason = 'Lockdown', { log = true } = {}) {
    return this.#exclusive(guild.id, async () => {
      const channels = [...guild.channels.cache.values()].filter((c) => LOCKABLE_TYPES.has(c.type) && c.manageable);
      const n = await inBatches(channels, (c) => this.lockChannel(c, moderator, reason, { scope: SCOPES.lockdown }));
      if (log) await this.logging.send(guild.id, 'security', serverLockCard({ enabled: true, count: n, moderator, reason }), undefined, { event: 'lockdown' });
      return n;
    });
  }

  /**
   * Lève le lockdown : ne restaure QUE les salons verrouillés par lockall / lockdown
   * (les /lock individuels restent, à lever avec /unlock), par lots de 5.
   */
  async disable(guild, moderator) {
    return this.#exclusive(guild.id, async () => {
      const rows = this.locks.list(guild.id).filter(isLockdownLock);
      const n = await inBatches(rows, async (lock) => {
        const channel = guild.channels.cache.get(lock.channel_id);
        if (!channel?.permissionOverwrites) {
          this.locks.delete(guild.id, lock.channel_id); // salon supprimé entre-temps
          return false;
        }
        await this.unlockChannel(channel, 'Fin du lockdown');
        return true;
      });
      await this.logging.send(guild.id, 'security', serverLockCard({ enabled: false, count: n, moderator }), undefined, { event: 'lockdown' });
      return n;
    });
  }

  /** Nombre de salons verrouillés par un lockdown en cours. */
  status(guild) {
    return this.locks.list(guild.id).filter(isLockdownLock).length;
  }
}

/** Restaure l'état tri-valué (true / false / null) d'un flag (SendMessages par défaut). */
function bitToState(allow, deny, flag = 'SendMessages') {
  const bit = typeof flag === 'bigint' ? flag : PermissionFlagsBits[flag];
  if ((BigInt(allow || 0) & bit) === bit) return true;
  if ((BigInt(deny || 0) & bit) === bit) return false;
  return null; // neutre (hérite)
}

/**
 * Vérifie que le membre a « Gérer les salons » sur CE salon (overwrites compris).
 * `overwrites` : l'action modifie les permissions du salon (lock, hide…) → comme
 * Discord, « Gérer les permissions » (bit ManageRoles) est aussi exigée sur ce salon.
 * @param {import('discord.js').GuildMember} member
 * @param {{ overwrites?: boolean }} [opts]
 */
function assertCanManageChannel(member, channel, { overwrites = false } = {}) {
  const perms = channel?.permissionsFor?.(member);
  if (!perms?.has(PermissionFlagsBits.ManageChannels)) {
    throw new UserError(`Il vous faut la permission **Gérer les salons** dans ${channel ?? 'ce salon'}.`);
  }
  if (overwrites && !perms.has(PermissionFlagsBits.ManageRoles)) {
    throw new UserError(`Il vous faut la permission **Gérer les permissions** dans ${channel ?? 'ce salon'}.`);
  }
}

/**
 * Salon visé par l'option `salon` d'une commande (ou le salon courant), avec la
 * même vérification que les boutons : « Gérer les salons » sur CE salon.
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 */
function channelForCommand(interaction, option = 'salon', opts = {}) {
  const picked = interaction.options.getChannel(option);
  const channel = picked ? interaction.guild.channels.cache.get(picked.id) ?? picked : interaction.channel;
  assertCanManageChannel(interaction.member, channel, opts);
  return channel;
}

/**
 * Salon visé par un bouton (id encodé dans le customId) : identifiant validé, doit
 * exister sur ce serveur et le cliqueur doit pouvoir le gérer (« Gérer les salons » sur CE salon).
 * @param {import('discord.js').ButtonInteraction} interaction
 */
async function channelForButton(interaction, rawChannelId, opts = {}) {
  const channelId = snowflake(rawChannelId, 'salon');
  const channel = interaction.guild.channels.cache.get(channelId)
    ?? (await interaction.client.channels.fetch(channelId).catch(() => null));
  if (!channel || channel.guildId !== interaction.guildId) throw new UserError('Ce salon n\'existe plus.');
  assertCanManageChannel(interaction.member, channel, opts);
  return channel;
}

/** Refuse les fils et salons sans permissions propres (UserError). */
function assertOverwritable(channel) {
  if (!channel || channel.isThread?.() || !channel.permissionOverwrites || !channel.guild) {
    throw new UserError('Ce salon ne gère pas de permissions propres (fil ou salon non pris en charge).');
  }
}

module.exports = {
  LockdownService,
  bitToState,
  assertOverwritable,
  assertCanManageChannel,
  channelCard,
  serverLockCard,
  channelForButton,
  channelForCommand,
  normalizeLock,
  lockPermsFor,
  CHANNEL_ACTIONS,
  LOCK_PERMS,
  SCOPES,
};
