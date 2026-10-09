'use strict';

const { escapeMarkdown } = require('discord.js');
const { createLogger } = require('../core/logger');
const { applyRoles } = require('../utils/memberRoles');
const { card, field, ICONS } = require('../utils/ui');
const { truncate } = require('../utils/embeds');
const { isValidTimeZone } = require('../utils/datetime');
const { localParts, localDateKey, isLeapYear, isBirthdayOn, nextBirthday, DAY_MS } = require('../utils/calendar');
const { escapeMassMentions } = require('./WelcomeService');
const { channelIssue } = require('./AnnouncementService');
const { roleIssue, botIssue } = require('./TempRoleService');
const { logCard } = require('./LoggingService');

const logger = createLogger('birthdays');

/** Durée pendant laquelle le rôle « anniversaire » est porté. */
const ROLE_DURATION_MS = DAY_MS;
/**
 * Au plus une fête par période glissante de 300 jours : changer sa date chaque jour (ou la
 * retirer puis la remettre) ne fait pas fêter un membre tous les jours. Les changements
 * restent libres (faute de frappe) ; une date modifiée n'est jamais fêtée le jour même.
 */
const MIN_DAYS_BETWEEN = 300;
const GONE_CODES = new Set([10007, 10013]);
const UNKNOWN_ROLE = 10011;
/** Message par défaut. La ligne contenant {age} n'est affichée qu'avec l'accord du membre. */
const DEFAULT_MESSAGE = '🎂 Joyeux anniversaire {membre} !\n{age} ans aujourd\'hui, ça se fête !';
const VARIABLES = Object.freeze({ membre: 'mention du membre', pseudo: 'pseudo', age: 'âge (ligne masquée sans accord)', serveur: 'nom du serveur' });

/** Âge affichable (année connue ET accord du membre), sinon null. Pur. */
function shownAge(row, year) {
  if (!row?.year || !row.show_age) return null;
  const age = year - row.year;
  return age > 0 && age < 150 ? age : null;
}

/**
 * Message d'anniversaire rendu. Les lignes contenant {age} disparaissent quand l'âge
 * ne peut pas être affiché ; @everyone / @here sont neutralisés. Pur.
 */
function renderBirthday(template, { id, name, server, age }) {
  const lines = String(template || DEFAULT_MESSAGE).split('\n').filter((line) => age != null || !/\{age\}/i.test(line));
  const values = {
    membre: id ? `<@${id}>` : `@${escapeMarkdown(String(name ?? 'membre'))}`,
    pseudo: escapeMarkdown(String(name ?? 'membre')),
    serveur: escapeMarkdown(String(server ?? 'le serveur')),
    age: age != null ? String(age) : '',
  };
  const out = lines.join('\n').replace(/\{(membre|pseudo|serveur|age)\}/gi, (_, key) => values[key.toLowerCase()]).trim();
  return escapeMassMentions(out || `🎂 Joyeux anniversaire ${values.membre} !`);
}

/** Variables inconnues d'un modèle. Pur. */
function unknownVariables(template) {
  const found = [...String(template ?? '').matchAll(/\{([\p{L}\w]{1,30})\}/gu)].map((m) => m[1].toLowerCase());
  return [...new Set(found.filter((k) => !Object.hasOwn(VARIABLES, k)))];
}

/** Carte publiée pour un anniversaire. Pur. */
function birthdayCard(text, avatar) {
  return card({ tone: 'celebrate', icon: '🎂', title: 'Joyeux anniversaire !', description: text, thumbnail: avatar ?? null });
}

/**
 * Anniversaires du jour (date locale). Le 29 février est fêté le 28 les années non
 * bissextiles. Pur.
 */
function dueToday(rows, local) {
  return rows.filter((r) => isBirthdayOn(r, local));
}

/** Jours entre deux dates locales « AAAA-MM-JJ » (b - a). Pur. */
function daysBetweenKeys(a, b) {
  const t = (key) => {
    const [y, m, d] = String(key).split('-').map(Number);
    return Date.UTC(y, m - 1, d);
  };
  return Math.round((t(b) - t(a)) / DAY_MS);
}

/**
 * Pourquoi ce membre n'est PAS fêté aujourd'hui malgré la date (anti-abus), ou null. Pur.
 * @param {object} row ligne birthdays
 * @param {string} dateKey date locale du jour (AAAA-MM-JJ)
 * @param {string} timeZone fuseau du serveur
 * @param {number} lockedUntil verrou (anniversaire retiré peu après une fête)
 */
function celebrationBlock(row, dateKey, timeZone, { now = Date.now(), lockedUntil = 0 } = {}) {
  if (row.date_changed_at && localDateKey(row.date_changed_at, timeZone) === dateKey) return 'date enregistrée ou modifiée aujourd\'hui';
  if (row.last_celebrated && row.last_celebrated !== dateKey && daysBetweenKeys(row.last_celebrated, dateKey) < MIN_DAYS_BETWEEN) {
    return `déjà fêté il y a moins de ${MIN_DAYS_BETWEEN} jours`;
  }
  if (lockedUntil > now) return `anniversaire retiré puis remis moins de ${MIN_DAYS_BETWEEN} jours après une fête`;
  return null;
}

/** Prochains anniversaires triés à partir d'une date locale. Pur. */
function upcoming(rows, local) {
  return rows.map((row) => ({ row, next: nextBirthday(row, local) })).sort((a, b) => a.next.inDays - b.next.inDays || a.row.user_id.localeCompare(b.row.user_id));
}

/**
 * Anniversaires : message une fois par jour et par membre (mémorisé en base),
 * rôle « anniversaire » porté 24 h. Étape du SchedulerService.
 */
class BirthdayService {
  /**
   * @param {{ client: import('discord.js').Client, birthdays: import('../database/repositories/BirthdayRepository').BirthdayRepository, config: import('./ConfigService').ConfigService }} deps
   */
  constructor({ client, birthdays, config }) {
    this.client = client;
    this.repo = birthdays;
    this.config = config;
    /** guildId → date locale entièrement traitée (évite de relire la base à chaque tick). */
    this.done = new Map();
    /** guildId → date locale du dernier avertissement « salon inutilisable » (un par jour). */
    this.warned = new Map();
  }

  settings(guildId) {
    return this.config.get(guildId).birthdays ?? {};
  }

  /** Fuseau valide de la configuration (repli Europe/Paris). */
  timeZone(guildId) {
    const tz = this.settings(guildId).timeZone;
    return tz && isValidTimeZone(tz) ? tz : 'Europe/Paris';
  }

  /** Date locale du serveur. */
  today(guildId, now = Date.now()) {
    return localParts(now, this.timeZone(guildId));
  }

  /**
   * @param {{ isStopping?: () => boolean, now?: number }} [opts]
   */
  async processDue({ isStopping = () => false, now = Date.now() } = {}) {
    this.repo.purgeLocks?.(now);
    await this.#removeExpiredRoles(isStopping, now);
    for (const guild of this.client.guilds.cache.values()) {
      if (isStopping()) return;
      if (!guild.available) continue;
      const cfg = this.settings(guild.id);
      if (!cfg.enabled) continue;
      const tz = this.timeZone(guild.id);
      const local = localParts(now, tz);
      if (local.hour < (cfg.hour ?? 0)) continue;
      const dateKey = localDateKey(now, tz);
      if (this.done.get(guild.id) === dateKey) continue;
      try {
        if (await this.#celebrateGuild(guild, cfg, local, dateKey, isStopping, tz, now)) this.done.set(guild.id, dateKey);
      } catch (e) {
        logger.warn(`Anniversaires du serveur ${guild.id} en échec, réessai :`, e?.message ?? e);
      }
    }
  }

  /** @returns {Promise<boolean>} true si tout a été traité (sinon réessai au prochain tick) */
  async #celebrateGuild(guild, cfg, local, dateKey, isStopping, tz = this.timeZone(guild.id), now = Date.now()) {
    const rows = [...this.repo.onDate(guild.id, local.month, local.day)];
    if (local.month === 2 && local.day === 28 && !isLeapYear(local.year)) rows.push(...this.repo.onDate(guild.id, 2, 29));
    let complete = true;
    for (const row of dueToday(rows, local)) {
      if (isStopping()) return false;
      if (row.last_celebrated === dateKey) continue;
      const block = celebrationBlock(row, dateKey, tz, { now, lockedUntil: this.repo.lockedUntil?.(guild.id, row.user_id) ?? 0 });
      if (block) {
        logger.debug(`Anniversaire de ${row.user_id} (serveur ${guild.id}) non fêté : ${block}.`);
        continue;
      }
      try {
        await this.#celebrate(guild, cfg, row, local, dateKey);
      } catch (e) {
        complete = false;
        logger.debug(`Anniversaire de ${row.user_id} (serveur ${guild.id}) : réessai`, e?.message);
      }
    }
    return complete;
  }

  async #fetchMember(guild, userId) {
    const cached = guild.members.cache.get(userId);
    if (cached) return cached;
    try {
      return await guild.members.fetch(userId);
    } catch (e) {
      if (GONE_CODES.has(e?.code)) return null;
      throw e;
    }
  }

  async #celebrate(guild, cfg, row, local, dateKey) {
    const member = await this.#fetchMember(guild, row.user_id);
    // Membre parti : ignoré, rien n'est réservé. Le serveur est toutefois marqué « traité »
    // pour la journée : un retour le jour même n'est fêté qu'au prochain passage complet
    // (redémarrage du bot ou modification de la configuration).
    if (!member || member.user?.bot) return;
    // Réservation AVANT l'envoi : jamais deux messages pour la même date.
    if (!this.repo.claim(guild.id, row.user_id, dateKey)) return;

    const role = cfg.roleId ? guild.roles.cache.get(cfg.roleId) : null;
    if (role && !roleIssue(guild, role)) {
      const { added } = await applyRoles(member, { add: member.roles.cache.has(role.id) ? [] : [role.id] }, 'Anniversaire (rôle porté 24 h)', (id, e) =>
        logger.debug(`Rôle d'anniversaire ${id} sur ${guild.id} :`, e?.message));
      if (added.length) this.repo.setRole(guild.id, row.user_id, role.id, Date.now() + ROLE_DURATION_MS);
    }

    if (!cfg.channelId) return;
    const issue = channelIssue(guild, cfg.channelId);
    if (issue) return this.#warnChannel(guild, cfg.channelId, issue, dateKey);
    const text = renderBirthday(cfg.message, { id: member.id, name: member.displayName, server: guild.name, age: shownAge(row, local.year) });
    try {
      await guild.channels.cache.get(cfg.channelId).send({
        content: `<@${member.id}>`,
        embeds: [birthdayCard(truncate(text, 4000), member.displayAvatarURL?.() ?? null)],
        allowedMentions: { parse: [], users: [member.id] },
      });
    } catch (e) {
      logger.warn(`Message d'anniversaire non envoyé (serveur ${guild.id}, membre ${member.id}) :`, e?.message ?? e);
    }
    return undefined;
  }

  async #warnChannel(guild, channelId, issue, dateKey) {
    if (this.warned.get(guild.id) === dateKey) return;
    this.warned.set(guild.id, dateKey);
    logger.warn(`Salon d'anniversaires inutilisable (serveur ${guild.id}) : ${issue.replace(/\*/g, '')}`);
    const embed = logCard({
      category: 'server',
      tone: 'warning',
      icon: ICONS.warning,
      title: 'Anniversaires non annoncés',
      description: `Je ne peux pas publier dans <#${channelId}> : ${issue}. Corrigez-le avec \`/anniversaire config\`.`,
    });
    await this.client.services?.logging?.send(guild.id, 'server', embed).catch(() => {});
  }

  /** Rôles « anniversaire » portés depuis 24 h : retirés (ligne relue avant d'effacer). */
  async #removeExpiredRoles(isStopping, now) {
    for (const row of this.repo.findRoleDue(now)) {
      if (isStopping()) return;
      try {
        await this.#removeRole(row, now);
      } catch (e) {
        logger.debug(`Retrait du rôle d'anniversaire (serveur ${row.guild_id}, membre ${row.user_id}) : réessai`, e?.message);
      }
    }
  }

  async #removeRole(row, now) {
    const guild = this.client.guilds.cache.get(row.guild_id);
    if (!guild) {
      if (this.client.isReady?.()) this.repo.clearRole(row.guild_id, row.user_id, now);
      return;
    }
    if (!guild.available) return;
    const role = row.role_id ? guild.roles.cache.get(row.role_id) : null;
    if (!role) {
      this.repo.clearRole(row.guild_id, row.user_id, now);
      return;
    }
    const late = now - row.role_until;
    // Le bot ne peut plus gérer ce rôle (permission, hiérarchie) : on attend qu'on la lui
    // rende, au plus 24 h, puis le staff est prévenu (le rôle ne reste jamais en silence).
    const issue = botIssue(guild, role);
    if (issue) {
      if (late >= DAY_MS) await this.#abandonRole(guild, row, issue.replace(/\*/g, ''), now);
      return;
    }
    const member = await this.#fetchMember(guild, row.user_id);
    if (member?.roles.cache.has(role.id)) {
      let error = null;
      const { failed } = await applyRoles(member, { remove: [role.id] }, 'Fin de l\'anniversaire', (_id, e) => { error = e; });
      if (failed.length && !GONE_CODES.has(error?.code) && error?.code !== UNKNOWN_ROLE) {
        // Erreur transitoire : réessai, au plus 24 h après l'échéance, puis log.
        if (late < DAY_MS) return;
        await this.#abandonRole(guild, row, error?.message ?? 'erreur Discord', now);
        return;
      }
    }
    this.repo.clearRole(row.guild_id, row.user_id, now);
  }

  /** Rôle d'anniversaire impossible à retirer depuis 24 h : ligne effacée, staff prévenu. */
  async #abandonRole(guild, row, why, now) {
    if (!this.repo.clearRole(row.guild_id, row.user_id, now)) return;
    logger.warn(`Rôle d'anniversaire non retiré (serveur ${guild.id}, membre ${row.user_id}) : ${why}`);
    const embed = logCard({
      category: 'members',
      tone: 'warning',
      icon: ICONS.warning,
      title: 'Rôle d\'anniversaire non retiré',
      description: `Je n'ai pas pu retirer le rôle <@&${row.role_id}> à <@${row.user_id}> depuis plus de 24 h (${truncate(why, 200)}). Retirez-le à la main.`,
      id: row.user_id,
      fields: [field(ICONS.user, 'Membre', `<@${row.user_id}>`), field(ICONS.role, 'Rôle', `<@&${row.role_id}>`)],
    });
    await this.client.services?.logging?.send(guild.id, 'members', embed, undefined, { event: 'memberRoles' }).catch(() => {});
  }

  /**
   * Après `/anniversaire retirer` : un membre fêté il y a moins de 300 jours ne peut pas se
   * faire fêter de nouveau en remettant une date. Seule l'échéance du verrou est conservée.
   * @returns {boolean} un verrou a été posé
   */
  afterRemoval(guildId, row, now = Date.now()) {
    if (!row?.last_celebrated) return false;
    const today = localDateKey(now, this.timeZone(guildId));
    if (daysBetweenKeys(row.last_celebrated, today) >= MIN_DAYS_BETWEEN) return false;
    this.repo.lock(guildId, row.user_id, now + MIN_DAYS_BETWEEN * DAY_MS);
    return true;
  }

  /** Retire le rôle d'anniversaire en cours (membre qui retire sa date). */
  async dropRole(guild, row) {
    if (!row?.role_id || !row.role_until) return;
    const role = guild.roles.cache.get(row.role_id);
    const member = role ? guild.members.cache.get(row.user_id) : null;
    if (role && member?.roles.cache.has(role.id) && !botIssue(guild, role)) {
      await applyRoles(member, { remove: [role.id] }, 'Anniversaire retiré par le membre').catch(() => {});
    }
  }

  /**
   * Membres encore présents parmi `userIds` (cache, puis récupération par lots de 100).
   * En cas d'échec, seuls les membres en cache sont retenus.
   */
  async presentMembers(guild, userIds) {
    const present = new Set(userIds.filter((id) => guild.members.cache.has(id)));
    const missing = userIds.filter((id) => !present.has(id));
    for (let i = 0; i < missing.length; i += 100) {
      try {
        const fetched = await guild.members.fetch({ user: missing.slice(i, i + 100), time: 5_000 });
        for (const id of fetched.keys()) present.add(id);
      } catch (e) {
        logger.debug(`Récupération des membres (anniversaires) sur ${guild.id} :`, e?.message);
        break;
      }
    }
    return present;
  }

  /** Remet à zéro le cache « déjà traité aujourd'hui » (configuration modifiée). */
  invalidate(guildId) {
    this.done.delete(guildId);
    this.warned.delete(guildId);
  }
}

module.exports = {
  BirthdayService,
  DEFAULT_MESSAGE,
  VARIABLES,
  ROLE_DURATION_MS,
  shownAge,
  renderBirthday,
  unknownVariables,
  birthdayCard,
  dueToday,
  upcoming,
  celebrationBlock,
  daysBetweenKeys,
  MIN_DAYS_BETWEEN,
};
