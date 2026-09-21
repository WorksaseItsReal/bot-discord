'use strict';

const { createLogger } = require('../core/logger');
const { embeds } = require('../utils/embeds');

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
  }

  async tick() {
    await this.#processExpiredBans();
    await this.#processDueReminders();
  }

  async #processExpiredBans() {
    const due = this.sanctions.findDue();
    for (const s of due) {
      this.sanctions.deactivate(s.id);
      if (s.type !== 'tempban') continue;
      const guild = this.client.guilds.cache.get(s.guild_id);
      if (!guild) continue;
      await guild.bans.remove(s.user_id, 'Fin du bannissement temporaire').catch(() => {});
      logger.info(`Ban temporaire expiré retiré: guild=${s.guild_id} user=${s.user_id}`);
    }
  }

  async #processDueReminders() {
    const due = this.reminders.findDue();
    for (const r of due) {
      this.reminders.deleteById(r.id);
      try {
        const user = await this.client.users.fetch(r.user_id);
        const embed = embeds.info(r.message, '⏰ Rappel');
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
