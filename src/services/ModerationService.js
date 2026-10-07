'use strict';

const { assertCanModerate } = require('../utils/permissions');
const { embeds, truncate } = require('../utils/embeds');
const { formatDuration, discordTimestamp } = require('../utils/time');
const { UserError } = require('../core/errors');

const TYPE_LABELS = {
  warn: 'Avertissement',
  mute: 'Mute',
  timeout: 'Timeout',
  kick: 'Expulsion',
  ban: 'Bannissement',
  tempban: 'Bannissement temporaire',
};

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
   */
  constructor({ sanctions, config, logging }) {
    this.sanctions = sanctions;
    this.config = config;
    this.logging = logging;
  }

  /** Récupère (ou crée) le rôle "Muted" et applique les refus dans les salons. */
  async ensureMutedRole(guild) {
    const { PermissionFlagsBits, ChannelType } = require('discord.js');
    const cfg = this.config.get(guild.id);
    let roleId = cfg.moderation.mutedRoleId;
    let role = roleId ? guild.roles.cache.get(roleId) : guild.roles.cache.find((r) => r.name === 'Muted');
    if (!role) {
      role = await guild.roles.create({ name: 'Muted', colors: { primaryColor: 0x607d8b }, reason: 'Rôle de mute Inspecteur Gadget' });
    }
    if (cfg.moderation.mutedRoleId !== role.id) this.config.update(guild.id, { moderation: { mutedRoleId: role.id } });
    // Applique les refus (best-effort) sur les salons texte/vocaux
    for (const channel of guild.channels.cache.values()) {
      if (![ChannelType.GuildText, ChannelType.GuildVoice, ChannelType.GuildCategory, ChannelType.GuildForum].includes(channel.type)) continue;
      const ow = channel.permissionOverwrites.cache.get(role.id);
      if (ow) continue;
      await channel.permissionOverwrites
        .edit(role, { SendMessages: false, AddReactions: false, Speak: false, SendMessagesInThreads: false }, { reason: 'Configuration mute' })
        .catch(() => {});
    }
    return role;
  }

  async mute(guild, targetMember, moderator, reason, durationMs) {
    assertCanModerate(moderator, targetMember, guild.members.me, { action: 'mute' });
    const role = await this.ensureMutedRole(guild);
    if (targetMember.roles.cache.has(role.id)) throw new UserError('Ce membre est déjà mute.');
    await targetMember.roles.add(role, reason || undefined);
    return this.record(guild, targetMember.user, moderator, { type: 'mute', reason, durationMs });
  }

  async unmute(guild, targetMember, moderator, reason) {
    assertCanModerate(moderator, targetMember, guild.members.me, { action: 'retirer le mute de' });
    const cfg = this.config.get(guild.id);
    const roleId = cfg.moderation.mutedRoleId;
    const role = roleId ? guild.roles.cache.get(roleId) : guild.roles.cache.find((r) => r.name === 'Muted');
    if (!role || !targetMember.roles.cache.has(role.id)) throw new UserError('Ce membre n\'est pas mute.');
    await targetMember.roles.remove(role, reason || undefined);
    this.#deactivateActive(guild.id, targetMember.id, 'mute');
    await this.logging.send(guild.id, 'moderation', embeds.moderation('🔊 Unmute').addFields(
      { name: 'Membre', value: `${targetMember} (${targetMember.id})`, inline: true },
      { name: 'Modérateur', value: `${moderator}`, inline: true },
    ));
    return { ok: true };
  }

  /**
   * Notifie + (exécute l'action Discord) + enregistre + log une sanction autorisée.
   * Si `action` est fourni (kick/ban), il est exécuté APRÈS le DM (le membre doit
   * encore partager un serveur avec le bot pour le recevoir) mais AVANT l'écriture
   * en base et le log : en cas d'échec, rien n'est enregistré et le DM est retiré.
   * @param {() => Promise<unknown>} [action]
   */
  async record(guild, targetUser, moderator, { type, reason, durationMs }, action) {
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
    });

    await this.logging.send(guild.id, 'moderation', this.#logEmbed({ id, guild, targetUser, moderator, type, reason, durationMs, expiresAt }));
    return { id, expiresAt };
  }

  async warn(guild, targetMember, moderator, reason) {
    assertCanModerate(moderator, targetMember, guild.members.me, { action: 'avertir' });
    return this.record(guild, targetMember.user, moderator, { type: 'warn', reason });
  }

  async timeout(guild, targetMember, moderator, reason, durationMs) {
    assertCanModerate(moderator, targetMember, guild.members.me, { action: 'timeout' });
    if (!durationMs) throw new UserError('Une durée valide est requise pour un timeout.');
    if (durationMs > 28 * 24 * 60 * 60 * 1000) throw new UserError('La durée maximale d\'un timeout est de 28 jours.');
    if (!targetMember.moderatable) {
      throw new UserError('Je ne peux pas timeout ce membre (administrateur, rôle trop élevé ou permission « Exclure temporairement » manquante).');
    }
    await targetMember.timeout(durationMs, reason || undefined);
    return this.record(guild, targetMember.user, moderator, { type: 'timeout', reason, durationMs });
  }

  async removeTimeout(guild, targetMember, moderator, reason) {
    assertCanModerate(moderator, targetMember, guild.members.me, { action: 'retirer le timeout de' });
    if (!targetMember.moderatable) {
      throw new UserError('Je ne peux pas retirer le timeout de ce membre (rôle trop élevé ou permission manquante).');
    }
    await targetMember.timeout(null, reason || undefined);
    this.#deactivateActive(guild.id, targetMember.id, 'timeout');
    await this.logging.send(guild.id, 'moderation', embeds.moderation('⏳ Untimeout').addFields(
      { name: 'Membre', value: `${targetMember} (${targetMember.id})`, inline: true },
      { name: 'Modérateur', value: `${moderator}`, inline: true },
    ));
    return { ok: true };
  }

  async kick(guild, targetMember, moderator, reason) {
    assertCanModerate(moderator, targetMember, guild.members.me, { action: 'expulser' });
    if (!targetMember.kickable) {
      throw new UserError('Je ne peux pas expulser ce membre (rôle trop élevé ou permission « Expulser » manquante).');
    }
    return this.record(guild, targetMember.user, moderator, { type: 'kick', reason }, () => targetMember.kick(reason || undefined));
  }

  async ban(guild, targetUser, moderator, reason, { durationMs, deleteMessageSeconds = 0, targetMember } = {}) {
    if (targetMember) {
      assertCanModerate(moderator, targetMember, guild.members.me, { action: 'bannir' });
      if (!targetMember.bannable) {
        throw new UserError('Je ne peux pas bannir ce membre (rôle trop élevé ou permission « Bannir » manquante).');
      }
    }
    const type = durationMs ? 'tempban' : 'ban';
    return this.record(guild, targetUser, moderator, { type, reason, durationMs }, async () => {
      await guild.bans.create(targetUser.id, { reason: reason || undefined, deleteMessageSeconds });
      // Un nouveau ban (permanent ou temporaire) remplace tout ban temporaire en cours :
      // le scheduler ne doit pas débannir l'utilisateur à l'expiration de l'ancien.
      this.#deactivateActive(guild.id, targetUser.id, 'tempban');
    });
  }

  /** Désactive les sanctions actives d'un type donné pour un membre. */
  #deactivateActive(guildId, userId, type) {
    for (const s of this.sanctions.listActiveByType(guildId, type)) {
      if (s.user_id === userId) this.sanctions.deactivate(s.id);
    }
  }

  /** Appelé quand un utilisateur est débanni (commande ou manuellement). */
  clearTempbans(guildId, userId) {
    this.#deactivateActive(guildId, userId, 'tempban');
  }

  async unban(guild, userId, moderator, reason) {
    const existing = await guild.bans.fetch(userId).catch(() => null);
    if (!existing) throw new UserError('Cet utilisateur n\'est pas banni.');
    await guild.bans.remove(userId, reason || undefined);
    // Désactive les bans temporaires actifs correspondants
    this.#deactivateActive(guild.id, userId, 'tempban');
    await this.logging.send(guild.id, 'moderation', embeds.moderation('Débannissement').addFields(
      { name: 'Utilisateur', value: `<@${userId}> (${userId})` },
      { name: 'Modérateur', value: `${moderator}` },
      { name: 'Raison', value: truncate(reason || 'Aucune raison fournie', 1024) },
    ));
    return { ok: true };
  }

  history(guildId, userId, limit) {
    return this.sanctions.listByUser(guildId, userId, limit);
  }

  async #notifyUser(guild, user, { type, reason, durationMs }) {
    const label = TYPE_LABELS[type] || type;
    const embed = embeds.moderation(`${label} — ${guild.name}`)
      .setDescription(`Vous avez reçu une sanction sur **${guild.name}**.`)
      .addFields(
        { name: 'Type', value: label, inline: true },
        { name: 'Durée', value: durationMs ? formatDuration(durationMs) : 'Permanent', inline: true },
        { name: 'Raison', value: truncate(reason || 'Aucune raison fournie', 1024) },
      );
    return user.send({ embeds: [embed] });
  }

  #logEmbed({ id, guild, targetUser, moderator, type, reason, durationMs, expiresAt }) {
    const label = TYPE_LABELS[type] || type;
    const embed = embeds.moderation(`${label} • #${id}`).addFields(
      { name: 'Membre', value: `${targetUser} (${targetUser.id})`, inline: true },
      { name: 'Modérateur', value: `${moderator}`, inline: true },
      { name: 'Raison', value: truncate(reason || 'Aucune raison fournie', 1024) },
    );
    if (durationMs) {
      embed.addFields(
        { name: 'Durée', value: formatDuration(durationMs), inline: true },
        { name: 'Expire', value: expiresAt ? discordTimestamp(expiresAt) : 'N/A', inline: true },
      );
    }
    return embed;
  }
}

module.exports = { ModerationService, TYPE_LABELS };
