'use strict';

const { createLogger } = require('../core/logger');
const { truncate } = require('../utils/embeds');
const { discordTimestamp } = require('../utils/time');
const { card, field, ICONS } = require('../utils/ui');
const { sanctionCard } = require('./ModerationService');

const logger = createLogger('scheduler');

/**
 * Boucle périodique robuste qui réconcilie l'état persistant avec la réalité :
 *  - expiration des bans temporaires (débannissement automatique) ;
 *  - déclenchement des rappels arrivés à échéance.
 * Tout survit au redémarrage car l'état vit en base.
 */
class SchedulerService {
  /**
   * @param {object} deps
   * @param {import('discord.js').Client} deps.client
   * @param {import('../database/repositories/SanctionRepository').SanctionRepository} deps.sanctions
   * @param {import('../database/repositories/ReminderRepository').ReminderRepository} deps.reminders
   * @param {number} [deps.intervalMs]
   */
  constructor({ client, sanctions, reminders, intervalMs = 30_000 }) {
    this.client = client;
    this.sanctions = sanctions;
    this.reminders = reminders;
    this.intervalMs = intervalMs;
    this.timer = null;
    this.running = false;
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick().catch((e) => logger.error('tick', e)), this.intervalMs);
    this.timer.unref?.();
    logger.info(`Scheduler démarré (intervalle ${this.intervalMs}ms)`);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.running = false;
  }

  async tick() {
    // Garde anti-réentrance : un tick lent (rate limit, API lente) ne doit jamais
    // se chevaucher avec le suivant, sinon les mêmes échéances (bans, rappels,
    // giveaways) seraient traitées deux fois.
    if (this.running) return;
    this.running = true;
    try {
      await this.#processExpiredBans();
      await this.#processDueReminders();
      await this.#processDueGiveaways();
      await this.#processAutobackup();
    } finally {
      this.running = false;
    }
  }

  async #processDueGiveaways() {
    const giveaways = this.client.services?.giveaways;
    const repo = this.client.repositories?.giveaways;
    if (!giveaways || !repo) return;
    for (const g of repo.findDue()) {
      await giveaways.end(g.id).catch((e) => logger.debug('giveaway end', e?.message));
    }
  }

  async #processAutobackup() {
    const backup = this.client.services?.backup;
    const config = this.client.services?.config;
    if (!backup || !config) return;
    for (const guild of this.client.guilds.cache.values()) {
      const cfg = config.get(guild.id).autobackup;
      if (!cfg?.enabled) continue;
      const dueAt = (cfg.lastRun || 0) + (cfg.intervalHours || 24) * 3_600_000;
      if (Date.now() < dueAt) continue;
      try {
        backup.create(guild, this.client.user, 'Auto-backup');
        config.update(guild.id, { autobackup: { lastRun: Date.now() } });
        logger.info(`Auto-backup créé pour ${guild.id}`);
      } catch (e) {
        logger.debug('autobackup', e?.message);
      }
    }
  }

  async #processExpiredBans() {
    const due = this.sanctions.findDue();
    for (const s of due) {
      if (s.type !== 'tempban' && s.type !== 'mute') {
        this.sanctions.deactivate(s.id); // timeout : expiré côté Discord
        continue;
      }
      const guild = this.client.guilds.cache.get(s.guild_id);
      // Serveur indisponible (outage, cache pas encore prêt) : on réessaie au prochain tick.
      if (!guild?.available) continue;
      if (s.type === 'tempban') {
        try {
          await guild.bans.remove(s.user_id, 'Fin du bannissement temporaire');
          this.sanctions.deactivate(s.id);
          logger.info(`Ban temporaire expiré retiré: guild=${s.guild_id} user=${s.user_id}`);
          await this.#logExpiry(guild, s, 'unban', `<@${s.user_id}> a purgé son bannissement temporaire et peut de nouveau rejoindre le serveur.`);
        } catch (e) {
          // 10026 Unknown Ban : déjà débanni manuellement → rien à faire.
          if (e?.code === 10026) this.sanctions.deactivate(s.id);
          else logger.debug(`Débannissement automatique échoué (réessai) guild=${s.guild_id} user=${s.user_id}`, e?.message);
        }
      } else {
        const cfg = this.client.services.config.get(guild.id);
        const roleId = cfg.moderation?.mutedRoleId;
        const member = roleId ? await guild.members.fetch(s.user_id).catch(() => null) : null;
        if (member && member.roles.cache.has(roleId)) {
          await member.roles.remove(roleId, 'Fin du mute temporaire').catch(() => {});
          logger.info(`Mute temporaire expiré retiré: guild=${s.guild_id} user=${s.user_id}`);
          await this.#logExpiry(guild, s, 'unmute', `${member} peut de nouveau écrire et parler : son mute temporaire est terminé.`, member.user);
        }
        this.sanctions.deactivate(s.id);
      }
    }
  }

  /** Log de modération d'une levée automatique (même carte que les levées manuelles). */
  async #logExpiry(guild, sanction, type, description, user) {
    const logging = this.client.services?.logging;
    if (!logging) return;
    await logging
      .send(guild.id, 'moderation', sanctionCard({
        type,
        user,
        userId: sanction.user_id,
        moderator: this.client.user,
        reason: 'Expiration automatique',
        description,
        id: sanction.id,
      }))
      .catch(() => {});
  }

  /** Carte de rappel (salon d'origine ou message privé). */
  static reminderCard(reminder) {
    return card({
      tone: 'info',
      section: 'utility',
      icon: '⏰',
      title: 'Rappel',
      description: truncate(reminder.message, 4000),
      fields: [reminder.created_at ? field(ICONS.date, 'Programmé', discordTimestamp(reminder.created_at, 'R')) : null],
      footer: `Rappel #${reminder.id}`,
    });
  }

  async #processDueReminders() {
    const due = this.reminders.findDue();
    for (const r of due) {
      this.reminders.deleteById(r.id);
      try {
        const user = await this.client.users.fetch(r.user_id);
        const embed = SchedulerService.reminderCard(r);
        const channel = r.channel_id ? await this.client.channels.fetch(r.channel_id).catch(() => null) : null;
        if (channel?.isTextBased()) await channel.send({ content: `${user}`, embeds: [embed] });
        else await user.send({ embeds: [embed] });
      } catch (e) {
        logger.debug('Rappel non délivré', e?.message);
      }
    }
  }
}

module.exports = { SchedulerService };
