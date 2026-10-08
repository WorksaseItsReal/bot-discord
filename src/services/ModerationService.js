'use strict';

const { ChannelType, ButtonStyle, MessageFlags, PermissionFlagsBits } = require('discord.js');
const { assertCanModerate } = require('../utils/permissions');
const { truncate } = require('../utils/embeds');
const { formatDuration, discordTimestamp } = require('../utils/time');
const { card, field, wide, ICONS, userLine, subtext, buttonRows, deleteButton, actionButton } = require('../utils/ui');
const { permissionLabel } = require('../utils/permissionNames');
const { snowflake, SNOWFLAKE } = require('../utils/buttonGuard');
const { UserError } = require('../core/errors');
const { sanctionState } = require('../database/repositories/SanctionRepository');

/** Durée pendant laquelle une action du bot est reconnue dans les événements Discord (anti-doublon de logs). */
const BOT_ACTION_TTL_MS = 15_000;

/** Refus posés par le rôle Muted, selon le type de salon. */
const MUTE_DENIES = {
  [ChannelType.GuildText]: ['SendMessages', 'AddReactions', 'SendMessagesInThreads'],
  [ChannelType.GuildAnnouncement]: ['SendMessages', 'AddReactions', 'SendMessagesInThreads'],
  [ChannelType.GuildForum]: ['SendMessages', 'AddReactions', 'SendMessagesInThreads'],
  [ChannelType.GuildVoice]: ['SendMessages', 'AddReactions', 'Speak'],
  [ChannelType.GuildCategory]: ['SendMessages', 'AddReactions', 'Speak', 'SendMessagesInThreads'],
};

/**
 * Présentation de chaque type de sanction (et de levée de sanction).
 * Une seule source pour la carte publique, le log de modération et le DM.
 *   text(mention, expiresAt) : phrase clé côté serveur
 *   dm(guildName, expiresAt) : phrase clé dans le message privé
 */
const SANCTIONS = {
  warn: {
    label: 'Avertissement',
    tone: 'warning',
    icon: ICONS.warn,
    title: 'Membre averti',
    text: (u) => `${u} a reçu un avertissement.`,
    dmTitle: 'Vous avez reçu un avertissement',
    dm: (g) => `Un modérateur de **${g}** vous a averti. Merci de relire le règlement du serveur.`,
  },
  mute: {
    label: 'Mute',
    tone: 'caution',
    icon: ICONS.mute,
    title: 'Membre rendu muet',
    text: (u, exp) => (exp ? `${u} ne peut plus écrire ni parler jusqu'au ${discordTimestamp(exp, 'f')}.` : `${u} ne peut plus écrire ni parler.`),
    dmTitle: 'Vous avez été rendu muet',
    dm: (g, exp) => (exp ? `Vous ne pouvez plus écrire ni parler sur **${g}** jusqu'au ${discordTimestamp(exp, 'f')}.` : `Vous ne pouvez plus écrire ni parler sur **${g}**.`),
  },
  timeout: {
    label: 'Timeout',
    tone: 'caution',
    icon: ICONS.mute,
    title: 'Membre exclu temporairement',
    text: (u, exp) => `${u} ne peut plus interagir${exp ? ` jusqu'au ${discordTimestamp(exp, 'f')}` : ''}.`,
    dmTitle: 'Vous avez été exclu temporairement',
    dm: (g, exp) => `Vous ne pouvez plus interagir sur **${g}**${exp ? ` jusqu'au ${discordTimestamp(exp, 'f')}` : ''}.`,
  },
  kick: {
    label: 'Expulsion',
    tone: 'caution',
    icon: ICONS.kick,
    title: 'Membre expulsé',
    text: (u) => `${u} a été expulsé du serveur. Il peut revenir avec une nouvelle invitation.`,
    dmTitle: 'Vous avez été expulsé',
    dm: (g) => `Vous avez été expulsé de **${g}**. Vous pourrez revenir avec une nouvelle invitation.`,
  },
  ban: {
    label: 'Bannissement',
    tone: 'danger',
    icon: ICONS.ban,
    title: 'Membre banni',
    text: (u) => `${u} ne pourra plus rejoindre le serveur.`,
    dmTitle: 'Vous avez été banni',
    dm: (g) => `Vous avez été banni définitivement de **${g}**.`,
  },
  tempban: {
    label: 'Bannissement temporaire',
    tone: 'danger',
    icon: ICONS.ban,
    title: 'Membre banni temporairement',
    text: (u, exp) => `${u} ne pourra pas revenir avant le ${discordTimestamp(exp, 'f')}.`,
    dmTitle: 'Vous avez été banni temporairement',
    dm: (g, exp) => `Vous êtes banni de **${g}** jusqu'au ${discordTimestamp(exp, 'f')}.`,
  },
  unban: {
    label: 'Débannissement',
    tone: 'success',
    icon: ICONS.unlock,
    title: 'Membre débanni',
    text: (u) => `${u} peut de nouveau rejoindre le serveur.`,
  },
  unmute: {
    label: 'Fin du mute',
    tone: 'success',
    icon: ICONS.unmute,
    title: 'Mute retiré',
    text: (u) => `${u} peut de nouveau écrire et parler.`,
  },
  untimeout: {
    label: 'Fin du timeout',
    tone: 'success',
    icon: ICONS.unmute,
    title: 'Timeout retiré',
    text: (u) => `${u} peut de nouveau interagir.`,
  },
};

const REVOCATIONS = new Set(['unban', 'unmute', 'untimeout']);

/**
 * Levée de chaque type de sanction encore en vigueur : action de ModerationService,
 * permission exigée du modérateur et libellé du bouton.
 */
const LIFTS = {
  tempban: { type: 'unban', permission: 'BanMembers', label: 'Débannir' },
  ban: { type: 'unban', permission: 'BanMembers', label: 'Débannir' },
  mute: { type: 'unmute', permission: 'ModerateMembers', label: 'Démuter' },
  timeout: { type: 'untimeout', permission: 'ModerateMembers', label: 'Retirer le timeout' },
};

/** Longueur maximale d'une raison de sanction. */
const MAX_REASON = 512;
/** Nom du champ « Raison » des cartes de sanction (repéré pour mettre à jour un log). */
const REASON_FIELD = `${ICONS.reason} Raison`;
const EDITED_FIELD = '✏️ Raison modifiée';

/** Libellés français des types de sanctions (historique, listes…). */
const TYPE_LABELS = Object.fromEntries(Object.entries(SANCTIONS).map(([k, v]) => [k, v.label]));

/** Icône d'un type de sanction. */
function sanctionIcon(type) {
  return SANCTIONS[type]?.icon ?? ICONS.history;
}

/** Utilisateur « minimal » à partir d'un identifiant (affichage seulement). */
function userFromId(id) {
  return id ? { id, username: id, toString: () => `<@${id}>` } : null;
}

/** Champ « Durée » : durée + expiration relative, « Définitive » ou rien. */
function durationField(type, durationMs, expiresAt) {
  if (durationMs) {
    const until = expiresAt ? `\nExpire ${discordTimestamp(expiresAt, 'R')}` : '';
    return field(ICONS.duration, 'Durée', `**${formatDuration(durationMs)}**${until}`);
  }
  if (type === 'ban' || type === 'mute') return field(ICONS.duration, 'Durée', 'Définitive');
  return null;
}

/**
 * Carte de sanction : MÊME rendu pour la réponse à la commande, le log de
 * modération et le message privé envoyé au membre.
 *
 * @param {{
 *   type: keyof SANCTIONS, user?: object|null, userId?: string,
 *   moderator?: { id: string }|null, reason?: string|null,
 *   durationMs?: number|null, expiresAt?: number|null, id?: number|null,
 *   guild?: import('discord.js').Guild, audience?: 'public'|'dm',
 *   fields?: object[], description?: string|string[], tone?: string,
 * }} opts
 */
function sanctionCard(opts) {
  const { type, moderator, reason, durationMs, id, guild, audience = 'public', fields = [], description, tone } = opts;
  const meta = SANCTIONS[type] ?? { label: type, tone: 'caution', icon: ICONS.history, title: type, text: (u) => `${u}` };
  const user = opts.user ?? userFromId(opts.userId);
  const expiresAt = opts.expiresAt ?? (durationMs ? Date.now() + durationMs : null);
  const dm = audience === 'dm';
  const revocation = REVOCATIONS.has(type);
  const reasonField = reason
    ? wide(ICONS.reason, 'Raison', truncate(reason, 1024))
    : revocation
      ? null
      : wide(ICONS.reason, 'Raison', '*Aucune raison fournie*');

  return card({
    tone: tone ?? meta.tone,
    section: dm ? { emoji: ICONS.server, label: guild?.name ?? 'Serveur' } : 'moderation',
    icon: meta.icon,
    title: dm ? meta.dmTitle ?? meta.title : meta.title,
    description:
      description ??
      (dm
        ? [meta.dm ? meta.dm(guild?.name ?? 'ce serveur', expiresAt) : meta.text('Vous', expiresAt), '', subtext('En cas de désaccord, contactez l\'équipe de modération du serveur.')]
        : meta.text(user ? `${user}` : 'Ce membre', expiresAt)),
    thumbnail: dm ? guild?.iconURL?.() : user?.displayAvatarURL?.(),
    fields: [
      // En DM, on ne révèle pas l'identité du modérateur (évite les représailles).
      dm ? null : field(ICONS.user, 'Membre', userLine(user)),
      dm ? null : field(ICONS.moderator, 'Modérateur', moderator?.id ? `<@${moderator.id}>` : '—'),
      durationField(type, durationMs, expiresAt),
      ...fields,
      reasonField,
    ],
    footer: id ? `Sanction #${id}` : undefined,
  });
}

/** Raison de sanction nettoyée (sur une ligne, 1 à 512 caractères). */
function normalizeReason(raw) {
  const reason = String(raw ?? '').replace(/\s+/g, ' ').trim();
  if (!reason) throw new UserError('La nouvelle raison ne peut pas être vide.');
  if (reason.length > MAX_REASON) throw new UserError(`La raison est trop longue (${MAX_REASON} caractères maximum).`);
  return reason;
}

/** UserError explicite quand le cliqueur n'a pas la permission requise. */
function needPermission(flag) {
  return new UserError(`Il vous faut la permission **${permissionLabel(flag)}** pour cette action.`);
}

/** Exige une permission du cliqueur / de l'invocateur (nom de flag, ex : 'BanMembers'). */
function requirePermission(interaction, flag) {
  if (!interaction.memberPermissions?.has(PermissionFlagsBits[flag])) throw needPermission(flag);
}

/** Boutons d'administration (antiraid, lockdown…) : réservés aux administrateurs. */
function assertAdmin(interaction) {
  requirePermission(interaction, 'Administrator');
}

/** Bouton « 📜 Sanctions » (historique éphémère du membre), partagé par toutes les cartes. */
function historyButton(userId) {
  return actionButton({ command: 'sanctions', action: 'history', args: [userId], label: 'Sanctions', emoji: ICONS.history });
}

/**
 * Raison obligatoire (option `moderation.requireReason`) pour les commandes de sanction.
 * @param {{ moderation?: { requireReason?: boolean } }} cfg config du serveur
 */
function assertReason(cfg, reason) {
  if (cfg?.moderation?.requireReason && !reason?.trim()) {
    throw new UserError('Une **raison** est obligatoire sur ce serveur : renseignez l\'option `raison`.');
  }
}

/**
 * Membre visé par une option utilisateur, à partir des données RÉSOLUES de
 * l'interaction (pas de fetch qui pourrait échouer silencieusement et faire
 * sauter les garde-fous de hiérarchie).
 * @returns {import('discord.js').GuildMember|null} null si l'utilisateur n'est pas sur le serveur
 */
function resolveTargetMember(interaction, option = 'membre') {
  const user = interaction.options.getUser(option);
  const member = interaction.options.getMember(option) ?? interaction.guild.members.cache.get(user?.id) ?? null;
  if (!member) return null;
  // Membre présent mais données incomplètes (payload brut) : on refuse plutôt que d'ignorer la hiérarchie.
  if (!member.roles?.highest || !member.guild) {
    throw new UserError('Impossible de vérifier les rôles de ce membre pour le moment. Réessayez dans quelques secondes.');
  }
  return member;
}

/**
 * Rangées de composants du message, où le bouton cliqué devient une étiquette
 * désactivée (ex : « ✅ Débanni par Bob »). Les autres boutons (🗑️…) sont conservés.
 */
function settleComponents(message, customId, label, emoji = ICONS.success) {
  return (message?.components ?? []).map((row) => {
    const json = typeof row?.toJSON === 'function' ? row.toJSON() : row;
    return {
      ...json,
      components: (json.components ?? []).map((c) =>
        c.custom_id === customId ? { ...c, label: truncate(label, 80), emoji: { name: emoji }, style: ButtonStyle.Secondary, disabled: true } : c,
      ),
    };
  });
}

/**
 * Après un bouton de levée de sanction : fige le bouton cliqué sur le message
 * d'origine puis publie la carte de résultat (éphémère si l'origine l'était).
 * @param {import('discord.js').ButtonInteraction} interaction
 * @param {{ label: string, embed: import('discord.js').EmbedBuilder, buttons?: import('discord.js').ButtonBuilder[] }} opts
 */
async function settleAndAnnounce(interaction, { label, embed, buttons = [] }) {
  const components = settleComponents(interaction.message, interaction.customId, label);
  // Interaction déjà acquittée (deferUpdate avant les appels API) : on édite le message.
  if (interaction.deferred || interaction.replied) await interaction.editReply({ components });
  else await interaction.update({ components });
  const ephemeral = Boolean(interaction.message?.flags?.has?.(MessageFlags.Ephemeral));
  await interaction.followUp({
    embeds: [embed],
    components: buttonRows(...buttons, ephemeral ? null : deleteButton(interaction.user.id)),
    ephemeral,
  });
}

/**
 * Fabrique du handler de bouton de levée de sanction (cmd:<unban|unmute|untimeout>:revoke:<userId>).
 * Revérifie la permission du cliqueur, valide l'identifiant (customId contrôlé par le client),
 * exécute `run` puis fige le bouton et publie la carte de levée.
 * @param {{
 *   permission: string, type: 'unban'|'unmute'|'untimeout', done: string,
 *   run: (interaction: import('discord.js').ButtonInteraction, client: object, userId: string) => Promise<import('discord.js').User|null>,
 * }} opts `run` renvoie l'utilisateur RÉSOLU sur lequel l'action a porté
 */
function revokeHandler({ permission, type, done, run }) {
  return async function revoke(interaction, client, [rawUserId]) {
    requirePermission(interaction, permission);
    const userId = snowflake(rawUserId, 'membre');
    // Acquitte le clic AVANT les appels API (fetch, levée, log) : le délai de 3 s ne peut plus expirer.
    await interaction.deferUpdate();
    const user = await run(interaction, client, userId);
    const id = user?.id ?? userId;
    await settleAndAnnounce(interaction, {
      label: `${done} par ${interaction.user.username}`,
      embed: sanctionCard({ type, user, userId: id, moderator: interaction.user }),
      buttons: [historyButton(id)],
    });
  };
}

/**
 * Orchestre les actions de modération : garde-fous de hiérarchie, exécution de
 * l'action Discord, enregistrement de la sanction, DM au membre et log.
 * Les commandes restent fines et délèguent toute la logique ici.
 */
class ModerationService {
  /**
   * @param {object} deps
   * @param {import('../database/repositories/SanctionRepository').SanctionRepository} deps.sanctions
   * @param {import('./ConfigService').ConfigService} deps.config
   * @param {import('./LoggingService').LoggingService} deps.logging
   * @param {import('./AntiRaidService').AntiRaidService} [deps.antiraid] détection des bans en masse faits via le bot
   */
  constructor({ sanctions, config, logging, antiraid = null }) {
    this.sanctions = sanctions;
    this.config = config;
    this.logging = logging;
    this.antiraid = antiraid;
    /**
     * Actions (ban/unban) lancées par le bot, marquées AVANT l'appel API : les
     * événements guildBanAdd/guildBanRemove les reconnaissent et ne les journalisent
     * pas une seconde fois. Clé `<type>:<guildId>:<userId>` → expiration.
     * @type {Map<string, number>}
     */
    this.recentBotActions = new Map();
  }

  /** Marque une action du bot (avant l'appel API). */
  markBotAction(type, guildId, userId, ttlMs = BOT_ACTION_TTL_MS) {
    const now = Date.now();
    for (const [k, exp] of this.recentBotActions) if (exp <= now) this.recentBotActions.delete(k);
    this.recentBotActions.set(`${type}:${guildId}:${userId}`, now + ttlMs);
  }

  /** Retire une marque (l'appel API a échoué : l'événement ne viendra pas du bot). */
  unmarkBotAction(type, guildId, userId) {
    this.recentBotActions.delete(`${type}:${guildId}:${userId}`);
  }

  /** true si le bot vient de lancer cette action (marque encore fraîche). */
  isRecentBotAction(type, guildId, userId) {
    const key = `${type}:${guildId}:${userId}`;
    const exp = this.recentBotActions.get(key);
    if (!exp) return false;
    if (exp <= Date.now()) {
      this.recentBotActions.delete(key);
      return false;
    }
    return true;
  }

  /** Marque l'action, exécute l'appel API, retire la marque en cas d'échec. */
  async #asBot(type, guildId, userId, fn) {
    this.markBotAction(type, guildId, userId);
    try {
      return await fn();
    } catch (err) {
      this.unmarkBotAction(type, guildId, userId);
      throw err;
    }
  }

  /**
   * Récupère (ou crée) le rôle "Muted". Les refus ne sont posés dans les salons
   * qu'à la création du rôle (ou quand un rôle « Muted » existant est adopté pour
   * la première fois) : pas de parcours de tous les salons à chaque /mute.
   */
  async ensureMutedRole(guild) {
    const cfg = this.config.get(guild.id);
    const roleId = cfg.moderation.mutedRoleId;
    let role = roleId ? guild.roles.cache.get(roleId) : guild.roles.cache.find((r) => r.name === 'Muted');
    let setup = false;
    if (!role) {
      role = await guild.roles.create({ name: 'Muted', colors: { primaryColor: 0x607d8b }, reason: 'Rôle de mute Inspecteur Gadget' });
      setup = true;
    }
    if (cfg.moderation.mutedRoleId !== role.id) {
      this.config.update(guild.id, { moderation: { mutedRoleId: role.id } });
      setup = true;
    }
    if (setup) await this.syncMutedRole(guild, role);
    return role;
  }

  /**
   * Pose les refus du rôle Muted (best-effort) dans les salons où ils manquent et où
   * le bot peut le faire (« Voir le salon » + « Gérer les permissions » sur CE salon).
   * @returns {Promise<number>} salons modifiés
   */
  async syncMutedRole(guild, role) {
    const me = guild.members?.me;
    let edited = 0;
    for (const channel of guild.channels.cache.values()) {
      const denies = MUTE_DENIES[channel.type];
      if (!denies || !channel.permissionOverwrites) continue;
      const perms = me ? channel.permissionsFor?.(me) : null;
      if (!perms?.has?.(PermissionFlagsBits.ViewChannel) || !perms.has(PermissionFlagsBits.ManageRoles)) continue;
      const ow = channel.permissionOverwrites.cache.get(role.id);
      if (ow && denies.every((p) => ow.deny?.has?.(PermissionFlagsBits[p]))) continue;
      const ok = await channel.permissionOverwrites
        .edit(role, Object.fromEntries(denies.map((p) => [p, false])), { reason: 'Configuration mute' })
        .then(() => true, () => false);
      if (ok) edited += 1;
    }
    return edited;
  }

  /** Rôle de mute existant (sans le créer). */
  mutedRole(guild) {
    const roleId = this.config.get(guild.id).moderation?.mutedRoleId;
    return roleId ? guild.roles.cache.get(roleId) : guild.roles.cache.find((r) => r.name === 'Muted');
  }

  async mute(guild, targetMember, moderator, reason, durationMs) {
    assertCanModerate(moderator, targetMember, guild.members.me, { action: 'mute' });
    const role = await this.ensureMutedRole(guild);
    if (targetMember.roles.cache.has(role.id)) throw new UserError('Ce membre est déjà mute.');
    await targetMember.roles.add(role, reason || undefined);
    // Un nouveau mute remplace tout mute encore actif (rôle retiré à la main…) :
    // le scheduler ne doit pas lever le nouveau mute à l'échéance de l'ancien.
    this.#deactivateActive(guild.id, targetMember.id, 'mute', { by: moderator.id, reason: 'Remplacé par un nouveau mute' });
    return this.record(guild, targetMember.user, moderator, { type: 'mute', reason, durationMs });
  }

  /**
   * Retire le mute. Rôle déjà retiré à la main mais mute encore actif en base :
   * seule la sanction est levée (sinon il serait réappliqué au retour du membre).
   * @returns {Promise<{ ok: true, dbOnly?: boolean }>}
   */
  async unmute(guild, targetMember, moderator, reason) {
    assertCanModerate(moderator, targetMember, guild.members.me, { action: 'retirer le mute de' });
    const role = this.mutedRole(guild);
    if (!role || !targetMember.roles.cache.has(role.id)) {
      if (!this.sanctions.activeMute?.(guild.id, targetMember.id)) throw new UserError('Ce membre n\'est pas mute.');
      this.#deactivateActive(guild.id, targetMember.id, 'mute', { by: moderator.id, reason });
      await this.logging.send(guild.id, 'moderation', sanctionCard({ type: 'unmute', user: targetMember.user, moderator, reason }), undefined, { event: 'revocation' });
      return { ok: true, dbOnly: true };
    }
    await targetMember.roles.remove(role, reason || undefined);
    this.#deactivateActive(guild.id, targetMember.id, 'mute', { by: moderator.id, reason });
    await this.logging.send(guild.id, 'moderation', sanctionCard({ type: 'unmute', user: targetMember.user, moderator, reason }), undefined, { event: 'revocation' });
    return { ok: true };
  }

  /**
   * Notifie + (exécute l'action Discord) + enregistre + log une sanction autorisée.
   * Si `action` est fourni (kick/ban), il est exécuté APRÈS le DM (le membre doit
   * encore partager un serveur avec le bot pour le recevoir) mais AVANT l'écriture
   * en base et le log : en cas d'échec, rien n'est enregistré et le DM est retiré.
   * @param {() => Promise<unknown>} [action]
   */
  async record(guild, targetUser, moderator, { type, reason, durationMs, escalationStep = null }, action) {
    const cfg = this.config.get(guild.id);
    const dm = cfg.moderation?.dmOnSanction
      ? await this.#notifyUser(guild, targetUser, { type, reason, durationMs }).catch(() => null)
      : null;
    if (action) {
      try {
        await action();
      } catch (err) {
        await dm?.delete?.().catch(() => {});
        throw err;
      }
    }

    const expiresAt = durationMs ? Date.now() + durationMs : null;
    const id = this.sanctions.create({
      guildId: guild.id,
      userId: targetUser.id,
      moderatorId: moderator.id,
      type,
      reason,
      durationMs: durationMs ?? null,
      expiresAt,
      escalationStep,
    });

    await this.logging.send(guild.id, 'moderation', sanctionCard({ id, type, user: targetUser, moderator, reason, durationMs, expiresAt }), undefined, {
      event: 'sanction',
      // Message de log mémorisé : /sanctions raison pourra le mettre à jour.
      onSent: (message) => message?.id && this.sanctions.setLogMessage?.(guild.id, id, message.channelId ?? message.channel?.id, message.id),
    });
    return { id, expiresAt };
  }

  async warn(guild, targetMember, moderator, reason) {
    assertCanModerate(moderator, targetMember, guild.members.me, { action: 'avertir' });
    return this.record(guild, targetMember.user, moderator, { type: 'warn', reason });
  }

  /** @param {{ escalationStep?: number|null }} [opts] palier d'escalade appliqué (/warn) */
  async timeout(guild, targetMember, moderator, reason, durationMs, { escalationStep = null } = {}) {
    assertCanModerate(moderator, targetMember, guild.members.me, { action: 'timeout' });
    if (!durationMs) throw new UserError('Une durée valide est requise pour un timeout.');
    if (durationMs > 28 * 24 * 60 * 60 * 1000) throw new UserError('La durée maximale d\'un timeout est de 28 jours.');
    if (!targetMember.moderatable) {
      throw new UserError('Je ne peux pas timeout ce membre (administrateur, rôle trop élevé ou permission « Exclure temporairement » manquante).');
    }
    await targetMember.timeout(durationMs, reason || undefined);
    // Le nouveau timeout remplace l'ancien encore actif (même règle que le mute).
    this.#deactivateActive(guild.id, targetMember.id, 'timeout', { by: moderator.id, reason: 'Remplacé par un nouveau timeout' });
    return this.record(guild, targetMember.user, moderator, { type: 'timeout', reason, durationMs, escalationStep });
  }

  async removeTimeout(guild, targetMember, moderator, reason) {
    assertCanModerate(moderator, targetMember, guild.members.me, { action: 'retirer le timeout de' });
    if (!targetMember.moderatable) {
      throw new UserError('Je ne peux pas retirer le timeout de ce membre (rôle trop élevé ou permission manquante).');
    }
    await targetMember.timeout(null, reason || undefined);
    this.#deactivateActive(guild.id, targetMember.id, 'timeout', { by: moderator.id, reason });
    await this.logging.send(guild.id, 'moderation', sanctionCard({ type: 'untimeout', user: targetMember.user, moderator, reason }), undefined, { event: 'revocation' });
    return { ok: true };
  }

  /** @param {{ escalationStep?: number|null }} [opts] palier d'escalade appliqué (/warn) */
  async kick(guild, targetMember, moderator, reason, { escalationStep = null } = {}) {
    assertCanModerate(moderator, targetMember, guild.members.me, { action: 'expulser' });
    if (!targetMember.kickable) {
      throw new UserError('Je ne peux pas expulser ce membre (rôle trop élevé ou permission « Expulser » manquante).');
    }
    return this.record(guild, targetMember.user, moderator, { type: 'kick', reason, escalationStep }, () => targetMember.kick(reason || undefined));
  }

  async ban(guild, targetUser, moderator, reason, { durationMs, deleteMessageSeconds = 0, targetMember, escalationStep = null } = {}) {
    if (targetMember) {
      assertCanModerate(moderator, targetMember, guild.members.me, { action: 'bannir' });
      if (!targetMember.bannable) {
        throw new UserError('Je ne peux pas bannir ce membre (rôle trop élevé ou permission « Bannir » manquante).');
      }
    }
    const type = durationMs ? 'tempban' : 'ban';
    if (durationMs && SNOWFLAKE.test(String(targetUser?.id ?? ''))) {
      // Déjà banni (souvent définitivement) : un tempban le débannirait à son échéance.
      const existing = await guild.bans?.fetch?.(targetUser.id).catch(() => null);
      if (existing?.user?.id === targetUser.id) {
        throw new UserError('Cet utilisateur est **déjà banni** : un bannissement temporaire le débannirait à son échéance. Levez d\'abord le bannissement actuel avec `/unban` si vous voulez le remplacer.');
      }
    }
    const joinedAt = targetMember?.joinedTimestamp ?? null;
    const result = await this.record(guild, targetUser, moderator, { type, reason, durationMs, escalationStep }, async () => {
      await this.#asBot('ban', guild.id, targetUser.id, () =>
        guild.bans.create(targetUser.id, { reason: reason || undefined, deleteMessageSeconds }),
      );
      // Un nouveau ban (permanent ou temporaire) remplace tout ban temporaire en cours :
      // le scheduler ne doit pas débannir l'utilisateur à l'expiration de l'ancien.
      this.#deactivateActive(guild.id, targetUser.id, 'tempban', { by: moderator.id, reason: 'Remplacé par un nouveau bannissement' });
      // Tempban d'un utilisateur que Discord ne voyait pas banni : une ligne « ban » encore
      // active est périmée (débanni hors du bot pendant une absence) et bloquerait la levée.
      if (type === 'tempban') this.#deactivateActive(guild.id, targetUser.id, 'ban', { by: null, reason: 'Débanni hors du bot' });
    });
    // Le ban porte la signature du bot dans l'audit log (ignorée par l'AntiRaid) :
    // on signale le MODÉRATEUR à la détection des bannissements en masse.
    await this.#reportBan(guild, moderator, targetUser.id, joinedAt);
    return result;
  }

  /** Signale un ban fait via le bot à l'AntiRaid (best-effort, jamais bloquant). */
  async #reportBan(guild, moderator, targetId, targetJoinedAt) {
    if (!this.antiraid?.handleDestructive || !moderator?.id) return;
    try {
      await this.antiraid.handleDestructive(guild, moderator.id, 'ban', { targetId, targetJoinedAt });
    } catch {
      // La détection ne doit jamais faire échouer la sanction déjà appliquée.
    }
  }

  /** Désactive (lève) les sanctions actives d'un type donné pour un membre, en gardant la trace. */
  #deactivateActive(guildId, userId, type, revoke) {
    this.sanctions.deactivateActive(guildId, userId, type, revoke);
  }

  /**
   * Plus haut palier d'escalade déjà appliqué à ce membre (0 si aucun), d'après la
   * colonne dédiée `escalation_step` (jamais d'après le texte libre des raisons,
   * qu'un modérateur pourrait imiter avec /warn).
   */
  appliedEscalationLevel(guildId, userId) {
    return this.sanctions.maxEscalationStep(guildId, userId);
  }

  /**
   * Sanction levée HORS du bot (rôle Muted retiré, timeout retiré par un tiers) :
   * la ligne active est désactivée pour ne pas être réappliquée ni levée plus tard.
   * @param {'mute'|'timeout'} type
   * @returns {number} lignes désactivées
   */
  liftedOutside(guildId, userId, type, executorId = null) {
    return this.sanctions.deactivateActive(guildId, userId, type, { by: executorId, reason: 'Levé hors du bot' });
  }

  /**
   * Appelé quand un utilisateur est débanni (événement guildBanRemove) : plus aucun
   * bannissement (temporaire ou définitif) n'est en vigueur. Si le bot vient lui-même
   * de débannir (commande, bouton, scheduler), c'est cette action qui enregistre la
   * levée avec son auteur : on ne l'écrase pas ici.
   */
  clearTempbans(guildId, userId) {
    if (this.isRecentBotAction('unban', guildId, userId)) return;
    const revoke = { by: null, reason: 'Débanni hors du bot' };
    this.#deactivateActive(guildId, userId, 'tempban', revoke);
    this.#deactivateActive(guildId, userId, 'ban', revoke);
  }

  /**
   * Débannit un utilisateur. L'identifiant est validé (jamais de `bans.fetch('')`,
   * qui renverrait TOUTE la liste des bans) et l'action porte sur l'utilisateur
   * RÉSOLU par Discord (`existing.user.id`), pas sur la valeur reçue.
   * @returns {Promise<{ ok: true, user: import('discord.js').User }>}
   */
  async unban(guild, userId, moderator, reason) {
    if (typeof userId !== 'string' || !SNOWFLAKE.test(userId)) throw new UserError('Identifiant utilisateur invalide.');
    const existing = await guild.bans.fetch(userId).catch(() => null);
    const user = existing?.user;
    if (!user?.id || user.id !== userId) throw new UserError('Cet utilisateur n\'est pas banni.');
    await this.#asBot('unban', guild.id, user.id, () => guild.bans.remove(user.id, reason || undefined));
    // Lève les bannissements (temporaires et définitifs) encore actifs, avec leur auteur.
    const revoke = { by: moderator?.id ?? null, reason: reason ?? null };
    this.#deactivateActive(guild.id, user.id, 'tempban', revoke);
    this.#deactivateActive(guild.id, user.id, 'ban', revoke);
    await this.logging.send(guild.id, 'moderation', sanctionCard({ type: 'unban', user, userId: user.id, moderator, reason }), undefined, { event: 'revocation' });
    return { ok: true, user };
  }

  /**
   * Modifie la raison d'une sanction. L'ancienne raison est conservée (sanction_edits),
   * le message de log d'origine est mis à jour si possible et la modification est journalisée.
   * Les PERMISSIONS (auteur ou « Gérer le serveur ») sont vérifiées par l'appelant.
   * @returns {Promise<{ sanction: object, oldReason: string|null, logUpdated: boolean }>}
   */
  async editReason(guild, sanctionId, editor, rawReason) {
    const reason = normalizeReason(rawReason);
    const current = this.sanctions.get(guild.id, sanctionId);
    if (!current) throw new UserError(`Aucune sanction \`#${sanctionId}\` trouvée sur ce serveur.`);
    if ((current.reason ?? '') === reason) throw new UserError('La nouvelle raison est identique à l\'actuelle.');
    const result = this.sanctions.editReason(guild.id, sanctionId, editor.id, reason);
    if (!result) throw new UserError(`Aucune sanction \`#${sanctionId}\` trouvée sur ce serveur.`);
    const logUpdated = await this.#updateLogReason(guild, result.sanction, editor, reason);
    await this.logging.send(
      guild.id,
      'moderation',
      card({
        tone: 'info',
        section: 'moderation',
        icon: '✏️',
        title: 'Raison modifiée',
        description: `La raison de la sanction \`#${sanctionId}\` a été modifiée.`,
        fields: [
          field(ICONS.user, 'Membre', `<@${current.user_id}>`),
          field(sanctionIcon(current.type), 'Type', TYPE_LABELS[current.type] ?? current.type),
          field(ICONS.moderator, 'Modifiée par', `<@${editor.id}>`),
          wide('🗒️', 'Ancienne raison', truncate(result.oldReason || '*Aucune raison fournie*', 1024)),
          wide(ICONS.reason, 'Nouvelle raison', truncate(reason, 1024)),
        ],
        footer: `Sanction #${sanctionId}`,
      }),
      undefined,
      { event: 'sanction' },
    );
    return { sanction: result.sanction, oldReason: result.oldReason, logUpdated };
  }

  /** Remplace la raison sur le message de log d'origine (best-effort). @returns {Promise<boolean>} */
  async #updateLogReason(guild, sanction, editor, reason) {
    if (!sanction?.log_channel_id || !sanction?.log_message_id) return false;
    try {
      const channel = guild.channels?.cache?.get(sanction.log_channel_id);
      if (!channel?.messages?.fetch) return false;
      const message = await channel.messages.fetch(sanction.log_message_id);
      const me = guild.members?.me?.id;
      if (!message?.embeds?.length || (me && message.author?.id && message.author.id !== me)) return false;
      const [first, ...rest] = message.embeds.map((e) => (typeof e?.toJSON === 'function' ? e.toJSON() : { ...(e?.data ?? e) }));
      const fields = (first.fields ?? []).filter((f) => f.name !== EDITED_FIELD);
      const value = truncate(reason, 1024);
      const at = fields.findIndex((f) => f.name === REASON_FIELD);
      if (at >= 0) fields[at] = { ...fields[at], value };
      else fields.push({ name: REASON_FIELD, value, inline: false });
      fields.push({ name: EDITED_FIELD, value: `Par <@${editor.id}> ${discordTimestamp(Date.now(), 'R')}`, inline: false });
      await message.edit({ embeds: [{ ...first, fields: fields.slice(0, 25) }, ...rest] });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Lève une sanction encore en vigueur en passant par l'action dédiée (unban, unmute,
   * untimeout) et ses garde-fous (hiérarchie, permissions du bot). La permission du
   * MODÉRATEUR (`LIFTS[type].permission`) est vérifiée par l'appelant.
   * @param {import('discord.js').GuildMember} moderator
   * @returns {Promise<{ type: 'unban'|'unmute'|'untimeout', user: object }>}
   */
  async lift(guild, sanction, moderator, reason) {
    const lift = LIFTS[sanction?.type];
    if (!lift || sanctionState(sanction) !== 'active') throw new UserError('Cette sanction n\'est plus en vigueur : il n\'y a rien à lever.');
    const userId = sanction.user_id;
    if (lift.type === 'unban') {
      if (!guild.members?.me?.permissions?.has(PermissionFlagsBits.BanMembers)) {
        throw new UserError('Il me manque la permission **Bannir des membres** pour débannir.');
      }
      const { user } = await this.unban(guild, userId, moderator, reason);
      return { type: 'unban', user };
    }
    if (!SNOWFLAKE.test(String(userId))) throw new UserError('Identifiant de membre invalide.');
    const member = await guild.members.fetch(userId).catch(() => null);
    if (lift.type === 'untimeout') {
      if (!member) throw new UserError('Ce membre n\'est plus sur le serveur.');
      if (!member.isCommunicationDisabled?.()) throw new UserError('Ce membre n\'est plus en timeout.');
      await this.removeTimeout(guild, member, moderator, reason);
      return { type: 'untimeout', user: member.user };
    }
    // Mute : rôle encore présent → unmute classique (hiérarchie + rôle vérifiés).
    const role = this.mutedRole(guild);
    if (member && role && member.roles?.cache?.has(role.id)) {
      await this.unmute(guild, member, moderator, reason);
      return { type: 'unmute', user: member.user };
    }
    // Membre parti (le mute serait réappliqué à son retour) ou rôle déjà retiré à la main :
    // seule la sanction en base est levée.
    if (member) assertCanModerate(moderator, member, guild.members.me, { action: 'retirer le mute de' });
    const user = member?.user ?? userFromId(userId);
    this.#deactivateActive(guild.id, userId, 'mute', { by: moderator.id, reason });
    await this.logging.send(guild.id, 'moderation', sanctionCard({ type: 'unmute', user, userId, moderator, reason }), undefined, { event: 'revocation' });
    return { type: 'unmute', user };
  }

  async #notifyUser(guild, user, { type, reason, durationMs }) {
    const embed = sanctionCard({ type, user, reason, durationMs, guild, audience: 'dm' });
    return user.send({ embeds: [embed] });
  }
}

module.exports = {
  ModerationService,
  TYPE_LABELS,
  SANCTIONS,
  LIFTS,
  MAX_REASON,
  normalizeReason,
  BOT_ACTION_TTL_MS,
  sanctionCard,
  sanctionIcon,
  userFromId,
  needPermission,
  requirePermission,
  assertAdmin,
  assertReason,
  historyButton,
  resolveTargetMember,
  revokeHandler,
  settleComponents,
  settleAndAnnounce,
};
