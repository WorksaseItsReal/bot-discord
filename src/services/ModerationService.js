'use strict';

const { assertCanModerate } = require('../utils/permissions');
const { embeds } = require('../utils/embeds');
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

  /** Enregistre + notifie + log une sanction déjà autorisée. */
  async record(guild, targetUser, moderator, { type, reason, durationMs }) {
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

    const cfg = this.config.get(guild.id);
    if (cfg.moderation?.dmOnSanction) {
      await this.#notifyUser(guild, targetUser, { type, reason, durationMs }).catch(() => {});
    }
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
    await targetMember.timeout(durationMs, reason || undefined);
    return this.record(guild, targetMember.user, moderator, { type: 'timeout', reason, durationMs });
  }

  async removeTimeout(guild, targetMember, moderator) {
    assertCanModerate(moderator, targetMember, guild.members.me, { action: 'retirer le timeout de' });
    await targetMember.timeout(null);
    return this.record(guild, targetMember.user, moderator, { type: 'timeout', reason: 'Timeout retiré', durationMs: null });
  }

  async kick(guild, targetMember, moderator, reason) {
    assertCanModerate(moderator, targetMember, guild.members.me, { action: 'expulser' });
    const sanction = await this.record(guild, targetMember.user, moderator, { type: 'kick', reason });
    await targetMember.kick(reason || undefined);
    return sanction;
  }

  async ban(guild, targetUser, moderator, reason, { durationMs, deleteMessageSeconds = 0, targetMember } = {}) {
    if (targetMember) {
      assertCanModerate(moderator, targetMember, guild.members.me, { action: 'bannir' });
    }
    const type = durationMs ? 'tempban' : 'ban';
    const sanction = await this.record(guild, targetUser, moderator, { type, reason, durationMs });
    await guild.bans.create(targetUser.id, { reason: reason || undefined, deleteMessageSeconds });
    return sanction;
  }

  async unban(guild, userId, moderator, reason) {
    const existing = await guild.bans.fetch(userId).catch(() => null);
    if (!existing) throw new UserError('Cet utilisateur n\'est pas banni.');
    await guild.bans.remove(userId, reason || undefined);
    // Désactive les bans temporaires actifs correspondants
    for (const s of this.sanctions.listActiveByType(guild.id, 'tempban')) {
      if (s.user_id === userId) this.sanctions.deactivate(s.id);
    }
    await this.logging.send(guild.id, 'moderation', embeds.moderation('Débannissement').addFields(
      { name: 'Utilisateur', value: `<@${userId}> (${userId})` },
      { name: 'Modérateur', value: `${moderator}` },
      { name: 'Raison', value: reason || 'Aucune raison fournie' },
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
        { name: 'Raison', value: reason || 'Aucune raison fournie' },
      );
    await user.send({ embeds: [embed] });
  }

  #logEmbed({ id, guild, targetUser, moderator, type, reason, durationMs, expiresAt }) {
    const label = TYPE_LABELS[type] || type;
    const embed = embeds.moderation(`${label} • #${id}`).addFields(
      { name: 'Membre', value: `${targetUser} (${targetUser.id})`, inline: true },
      { name: 'Modérateur', value: `${moderator}`, inline: true },
      { name: 'Raison', value: reason || 'Aucune raison fournie' },
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
