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
    await this.#processDueGiveaways();
    await this.#processAutobackup();
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
      this.sanctions.deactivate(s.id);
      const guild = this.client.guilds.cache.get(s.guild_id);
      if (!guild) continue;
      if (s.type === 'tempban') {
        await guild.bans.remove(s.user_id, 'Fin du bannissement temporaire').catch(() => {});
        logger.info(`Ban temporaire expiré retiré: guild=${s.guild_id} user=${s.user_id}`);
      } else if (s.type === 'mute') {
        const cfg = this.client.services.config.get(guild.id);
        const roleId = cfg.moderation?.mutedRoleId;
        const member = roleId ? await guild.members.fetch(s.user_id).catch(() => null) : null;
        if (member && member.roles.cache.has(roleId)) {
          await member.roles.remove(roleId, 'Fin du mute temporaire').catch(() => {});
          logger.info(`Mute temporaire expiré retiré: guild=${s.guild_id} user=${s.user_id}`);
        }
      }
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
