'use strict';

const { createLogger } = require('../core/logger');
const { truncate } = require('../utils/embeds');
const { discordTimestamp } = require('../utils/time');
const { card, field, ICONS } = require('../utils/ui');
const { sanctionCard } = require('./ModerationService');

const logger = createLogger('scheduler');

const DAY_MS = 86_400_000;
/** Un rappel non délivrable (erreurs transitoires) est abandonné 24 h après son échéance. */
const REMINDER_MAX_LATE_MS = DAY_MS;
/** Config d'un serveur quitté supprimée après 30 jours d'absence. */
const LEFT_GUILD_RETENTION_MS = 30 * DAY_MS;
/** Fréquence de la purge des serveurs quittés. */
const PURGE_INTERVAL_MS = DAY_MS;

/** Salon définitivement inutilisable (supprimé, accès ou permission retirés). */
const PERMANENT_CHANNEL_CODES = new Set([10003, 10004, 50001, 50008, 50013, 50024, 50083]);
/** Utilisateur définitivement injoignable en MP. */
const PERMANENT_USER_CODES = new Set([10013, 50007, 50278]);

/**
 * Boucle périodique robuste qui réconcilie l'état persistant avec la réalité :
 *  - expiration des bans temporaires et des mutes (levée automatique) ;
 *  - déclenchement des rappels arrivés à échéance ;
 *  - fin des giveaways, sauvegardes automatiques, purge des serveurs quittés.
 * Tout survit au redémarrage car l'état vit en base. Chaque étape est isolée :
 * une erreur dans l'une n'empêche pas les suivantes.
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
    this.stopping = false;
    /** @type {Promise<void> | null} tick en cours (attendu par stop()) */
    this.currentTick = null;
    this.lastPurgeAt = 0;
  }

  start() {
    if (this.timer) return;
    this.stopping = false;
    this.timer = setInterval(() => this.tick().catch((e) => logger.error('tick', e)), this.intervalMs);
    this.timer.unref?.();
    logger.info(`Scheduler démarré (intervalle ${this.intervalMs}ms)`);
  }

  /** Arrête la boucle et attend la fin du tick en cours (avant fermeture de la base). */
  async stop() {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.currentTick) await this.currentTick.catch(() => {});
  }

  tick() {
    // Garde anti-réentrance : un tick lent (rate limit, API lente) ne doit jamais
    // se chevaucher avec le suivant, sinon les mêmes échéances (bans, rappels,
    // giveaways) seraient traitées deux fois.
    if (this.running) return this.currentTick ?? Promise.resolve();
    this.running = true;
    this.currentTick = this.#runStages().finally(() => {
      this.running = false;
      this.currentTick = null;
    });
    return this.currentTick;
  }

  async #runStages() {
    const stages = [
      ['tempbans', () => this.#processExpiredTempbans()],
      ['mutes', () => this.#processExpiredMutes()],
      ['reminders', () => this.#processDueReminders()],
      ['giveaways', () => this.#processDueGiveaways()],
      ['autobackup', () => this.#processAutobackup()],
      ['purge', () => this.#processLeftGuildPurge()],
    ];
    for (const [name, run] of stages) {
      if (this.stopping) return;
      try {
        await run();
      } catch (e) {
        logger.error(`Étape « ${name} » du scheduler en échec :`, e);
      }
    }
  }

  async #processDueGiveaways() {
    const giveaways = this.client.services?.giveaways;
    const repo = this.client.repositories?.giveaways;
    if (!giveaways || !repo) return;
    for (const g of repo.findDue()) {
      if (this.stopping) return;
      // Annonce impossible (salon supprimé, permission retirée) : visible dans les logs,
      // le staff peut la retenter avec /giveaway end.
      await giveaways.end(g.id).catch((e) => logger.warn(`Fin du giveaway #${g.id} (serveur ${g.guild_id}) :`, e?.message ?? e));
    }
  }

  async #processAutobackup() {
    const backup = this.client.services?.backup;
    const config = this.client.services?.config;
    if (!backup || !config) return;
    for (const guild of this.client.guilds.cache.values()) {
      // Serveur indisponible (panne Discord) : cache vide ou partiel, la sauvegarde
      // serait incomplète et évincerait une bonne sauvegarde du quota.
      if (!guild.available) continue;
      const cfg = config.get(guild.id).autobackup;
      if (!cfg?.enabled) continue;
      const dueAt = (cfg.lastRun || 0) + (cfg.intervalHours || 24) * 3_600_000;
      if (Date.now() < dueAt) continue;
      try {
        // Créateur null : la sauvegarde apparaît comme automatique.
        backup.create(guild, null, 'Auto-backup');
        config.update(guild.id, { autobackup: { lastRun: Date.now() } });
        logger.info(`Auto-backup créé pour ${guild.id}`);
      } catch (e) {
        logger.warn(`Auto-backup échoué pour ${guild.id} :`, e?.message);
      }
    }
  }

  /**
   * Purge quotidienne : supprime la config (guild_config uniquement) des serveurs
   * quittés depuis plus de 30 jours. Si le bot y est de nouveau, la date de départ
   * est simplement effacée.
   */
  async #processLeftGuildPurge(now = Date.now()) {
    const repo = this.client.repositories?.guildConfig;
    const config = this.client.services?.config;
    if (!repo?.findLeftBefore || !config) return;
    // Cache incomplet tant que le client n'est pas prêt : on ne purge jamais à l'aveugle.
    if (!this.client.isReady?.()) return;
    if (now - this.lastPurgeAt < PURGE_INTERVAL_MS) return;
    this.lastPurgeAt = now;
    for (const guildId of repo.findLeftBefore(now - LEFT_GUILD_RETENTION_MS)) {
      if (this.client.guilds.cache.has(guildId)) {
        config.clearLeft(guildId);
        continue;
      }
      config.forget(guildId);
      logger.info(`Configuration du serveur ${guildId} purgée (quitté depuis plus de 30 jours).`);
    }
  }

  /** Sanction « absente » : serveur quitté (client prêt) → désactivée ; sinon réessai. */
  #resolveGuild(s) {
    const guild = this.client.guilds.cache.get(s.guild_id);
    if (!guild) {
      // Client prêt et serveur absent du cache : le bot a quitté le serveur, la
      // sanction ne pourra jamais être levée → on la désactive (sinon réessai à vie).
      if (this.client.isReady?.()) this.sanctions.deactivate(s.id);
      return null;
    }
    // Serveur indisponible (outage, cache pas encore prêt) : on réessaie au prochain tick.
    if (!guild.available) return null;
    return guild;
  }

  async #processExpiredTempbans() {
    for (const s of this.sanctions.findDue()) {
      if (this.stopping) return;
      if (s.type === 'mute') continue; // étape dédiée
      if (s.type !== 'tempban') {
        this.sanctions.deactivate(s.id); // timeout : expiré côté Discord
        continue;
      }
      const guild = this.#resolveGuild(s);
      if (!guild) continue;
      const moderation = this.client.services?.moderation;
      // Marqué AVANT l'appel : guildBanRemove ne journalise pas une seconde fois cette levée.
      moderation?.markBotAction?.('unban', guild.id, s.user_id);
      try {
        await guild.bans.remove(s.user_id, 'Fin du bannissement temporaire');
      } catch (e) {
        moderation?.unmarkBotAction?.('unban', guild.id, s.user_id);
        // 10026 Unknown Ban : déjà débanni manuellement → rien à faire.
        if (e?.code === 10026) this.sanctions.deactivate(s.id);
        else logger.debug(`Débannissement automatique échoué (réessai) guild=${s.guild_id} user=${s.user_id}`, e?.message);
        continue;
      }
      this.sanctions.deactivate(s.id);
      logger.info(`Ban temporaire expiré retiré: guild=${s.guild_id} user=${s.user_id}`);
      await this.#logExpiry(guild, s, 'unban', `<@${s.user_id}> a purgé son bannissement temporaire et peut de nouveau rejoindre le serveur.`);
    }
  }

  /**
   * Mutes expirés : la sanction n'est désactivée qu'une fois le rôle réellement
   * retiré (ou si le membre est parti / n'a plus le rôle). Un échec transitoire
   * (permissions, hiérarchie, API) la garde active pour un nouvel essai.
   */
  async #processExpiredMutes() {
    for (const s of this.sanctions.findDue()) {
      if (this.stopping) return;
      if (s.type !== 'mute') continue;
      const guild = this.#resolveGuild(s);
      if (!guild) continue;
      try {
        await this.#expireMute(guild, s);
      } catch (e) {
        logger.warn(`Levée du mute expiré échouée (réessai) guild=${s.guild_id} user=${s.user_id} :`, e?.message ?? e);
      }
    }
  }

  async #expireMute(guild, s) {
    const roleId = this.client.services?.config?.get(guild.id)?.moderation?.mutedRoleId;
    // Aucun rôle muet configuré : rien à retirer.
    if (!roleId) return this.sanctions.deactivate(s.id);
    let member;
    try {
      member = await guild.members.fetch(s.user_id);
    } catch (e) {
      // 10007 Unknown Member / 10013 Unknown User : parti, plus rien à lever.
      if (e?.code === 10007 || e?.code === 10013) return this.sanctions.deactivate(s.id);
      throw e;
    }
    if (!member?.roles?.cache?.has(roleId)) return this.sanctions.deactivate(s.id);
    try {
      await member.roles.remove(roleId, 'Fin du mute temporaire');
    } catch (e) {
      // Parti entre-temps, ou rôle supprimé : le membre n'est plus muet.
      if (e?.code === 10007 || e?.code === 10011) return this.sanctions.deactivate(s.id);
      throw e; // pas de carte « unmute » : le rôle est toujours là
    }
    this.sanctions.deactivate(s.id);
    logger.info(`Mute temporaire expiré retiré: guild=${s.guild_id} user=${s.user_id}`);
    await this.#logExpiry(guild, s, 'unmute', `${member} peut de nouveau écrire et parler : son mute temporaire est terminé.`, member.user);
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
      }), undefined, { event: 'revocation' })
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

  /**
   * Rappels échus : salon d'origine d'abord, puis MP en secours. La ligne n'est
   * supprimée qu'après une livraison réussie, ou si l'utilisateur et le salon
   * sont définitivement injoignables. Sur erreur transitoire, le rappel est gardé
   * (réessai au prochain tick) — au plus 24 h après son échéance.
   */
  async #processDueReminders(now = Date.now()) {
    for (const r of this.reminders.findDue(now)) {
      if (this.stopping) return;
      let outcome;
      try {
        outcome = await this.#deliverReminder(r);
      } catch (e) {
        logger.debug(`Rappel #${r.id} : erreur inattendue`, e?.message);
        outcome = 'retry';
      }
      if (outcome === 'sent' || outcome === 'unreachable') {
        if (outcome === 'unreachable') logger.info(`Rappel #${r.id} abandonné : utilisateur ${r.user_id} injoignable.`);
        this.reminders.deleteById(r.id);
      } else if (now - r.remind_at > REMINDER_MAX_LATE_MS) {
        logger.warn(`Rappel #${r.id} abandonné : non délivré plus de 24 h après son échéance (utilisateur ${r.user_id}).`);
        this.reminders.deleteById(r.id);
      }
    }
  }

  /** @returns {Promise<'sent' | 'unreachable' | 'retry'>} */
  async #deliverReminder(r) {
    const embed = SchedulerService.reminderCard(r);
    let permanent = true;

    if (r.channel_id) {
      try {
        const channel = await this.client.channels.fetch(r.channel_id);
        if (channel?.isTextBased?.() && typeof channel.send === 'function') {
          await channel.send({ content: `<@${r.user_id}>`, embeds: [embed], allowedMentions: { users: [r.user_id] } });
          return 'sent';
        }
        // Salon devenu non textuel : inutilisable, on passe au MP.
      } catch (e) {
        if (!PERMANENT_CHANNEL_CODES.has(e?.code)) permanent = false;
        logger.debug(`Rappel #${r.id} : salon ${r.channel_id} indisponible (${e?.code ?? e?.message}), envoi en MP.`);
      }
    }

    try {
      const user = await this.client.users.fetch(r.user_id);
      await user.send({ embeds: [embed] });
      return 'sent';
    } catch (e) {
      if (!PERMANENT_USER_CODES.has(e?.code)) permanent = false;
      logger.debug(`Rappel #${r.id} : MP impossible (${e?.code ?? e?.message}).`);
    }
    return permanent ? 'unreachable' : 'retry';
  }
}

module.exports = { SchedulerService, REMINDER_MAX_LATE_MS, LEFT_GUILD_RETENTION_MS };
