'use strict';

const { PermissionFlagsBits } = require('discord.js');
const { createLogger } = require('../core/logger');
const { UserError } = require('../core/errors');
const { applyRoles } = require('../utils/memberRoles');
const { discordTimestamp, formatDuration, MAX_DURATION_MS } = require('../utils/time');
const { truncate } = require('../utils/embeds');
const { field, wide, ICONS, userLine, code } = require('../utils/ui');
const { logCard } = require('./LoggingService');
const { hasForbiddenPermissions } = require('../commands/roles/rolemenu');

const logger = createLogger('temproles');

/** Au-delà de ce retard, un retrait impossible (hiérarchie, permission) est abandonné et signalé. */
const MAX_LATE_MS = 86_400_000;
/** Ligne en échec (permission, hiérarchie, erreur passagère) : prochaine tentative. */
const RETRY_MS = 5 * 60_000;
/** Plafonds par tick du scheduler : par serveur, et au total. */
const PER_GUILD_PER_TICK = 25;
const MAX_PER_TICK = 200;
/** Membre ou utilisateur inconnu : parti du serveur. */
const GONE_CODES = new Set([10007, 10013]);
const UNKNOWN_ROLE = 10011;

/**
 * Raison pour laquelle le bot ne peut pas (ou ne doit pas) attribuer ce rôle
 * temporairement, ou null. Ne regarde PAS la hiérarchie de l'auteur (vérifiée
 * par la commande). Pur.
 */
function roleIssue(guild, role) {
  if (!role) return 'Ce rôle n\'existe plus.';
  if (role.id === guild.id) return 'Le rôle @everyone ne peut pas être attribué.';
  if (role.managed) return `Le rôle ${role.name} est géré par une intégration (bot, boost…) et ne peut pas être attribué.`;
  if (hasForbiddenPermissions(role)) return `Le rôle ${role.name} donne des permissions de modération ou d'administration : il ne peut pas être attribué temporairement.`;
  return botIssue(guild, role);
}

/** Le bot peut-il gérer ce rôle (permission « Gérer les rôles » et hiérarchie) ? Message, ou null. Pur. */
function botIssue(guild, role) {
  const me = guild.members?.me;
  if (me && !me.permissions?.has?.(PermissionFlagsBits.ManageRoles)) return 'Il me faut la permission **Gérer les rôles**.';
  if (me && role.position >= me.roles.highest.position) return `Le rôle ${role.name} est au-dessus (ou au niveau) de mon rôle le plus haut : je ne peux pas l'attribuer.`;
  return null;
}

/**
 * Rôles temporaires : attribution, prolongation, retrait manuel, expiration
 * (étape du SchedulerService) et réapplication au retour d'un membre.
 */
class TempRoleService {
  /**
   * @param {{ client: import('discord.js').Client, tempRoles: import('../database/repositories/TempRoleRepository').TempRoleRepository }} deps
   */
  constructor({ client, tempRoles }) {
    this.client = client;
    this.repo = tempRoles;
  }

  /**
   * Attribue (ou renouvelle) un rôle temporaire. Refuse de rendre temporaire un rôle
   * que le membre possède déjà sans échéance.
   * @returns {Promise<{ id: number, renewed: boolean, expiresAt: number }>}
   */
  async grant({ guild, member, role, durationMs, moderator, reason = null, now = Date.now() }) {
    const issue = roleIssue(guild, role);
    if (issue) throw new UserError(issue);
    if (!Number.isSafeInteger(durationMs) || durationMs <= 0 || durationMs > MAX_DURATION_MS) throw new UserError('Durée invalide : un an maximum (ex : `1h`, `7d`, `2w`).');
    const existing = this.repo.activeFor(guild.id, member.id, role.id);
    if (!existing && member.roles.cache.has(role.id)) {
      throw new UserError(`${member} a déjà le rôle ${role} sans échéance : retirez-le d'abord pour l'attribuer temporairement.`);
    }
    if (!member.roles.cache.has(role.id)) {
      let error = null;
      const { failed } = await applyRoles(member, { add: [role.id] }, truncate(`Rôle temporaire (${formatDuration(durationMs)}) — par ${moderator?.tag ?? moderator?.username ?? 'le staff'}`, 400), (_id, e) => { error = e; });
      if (failed.length) {
        logger.debug(`Ajout du rôle temporaire ${role.id} à ${member.id} refusé :`, error?.message);
        throw new UserError(`Impossible d'ajouter le rôle ${role} (${error?.code === 50013 ? 'permission ou hiérarchie insuffisante' : 'erreur Discord'}).`);
      }
    }
    const expiresAt = now + durationMs;
    const { id, renewed } = this.repo.upsert({ guildId: guild.id, userId: member.id, roleId: role.id, moderatorId: moderator?.id ?? null, reason, expiresAt, now });
    await this.#log(guild, {
      tone: 'success',
      icon: '⏳',
      title: renewed ? 'Rôle temporaire renouvelé' : 'Rôle temporaire attribué',
      description: `${member} a le rôle ${role} jusqu'à ${discordTimestamp(expiresAt, 'f')} (${discordTimestamp(expiresAt, 'R')}).`,
      user: member.user,
      row: { id, role_id: role.id, reason },
      by: moderator,
    });
    return { id, renewed, expiresAt };
  }

  /**
   * Prolonge un rôle temporaire actif (à partir de l'échéance, ou de maintenant si elle est passée).
   * @returns {Promise<number>} nouvelle échéance
   */
  async extend(guild, id, addMs, moderator, now = Date.now()) {
    const row = this.repo.get(guild.id, id);
    if (!row?.active) throw new UserError('Ce rôle temporaire est déjà terminé.');
    if (!Number.isSafeInteger(addMs) || addMs <= 0) throw new UserError('Durée invalide (ex : `1h`, `7d`, `2w`).');
    const expiresAt = Math.max(row.expires_at, now) + addMs;
    if (expiresAt - now > MAX_DURATION_MS) throw new UserError('La durée restante ne peut pas dépasser **un an**.');
    if (!this.repo.setExpiry(row.id, expiresAt, moderator?.id ?? null)) throw new UserError('Ce rôle temporaire est déjà terminé.');
    await this.#log(guild, {
      tone: 'info',
      icon: '⏩',
      title: 'Rôle temporaire prolongé',
      description: `<@${row.user_id}> garde le rôle <@&${row.role_id}> jusqu'à ${discordTimestamp(expiresAt, 'f')} (${discordTimestamp(expiresAt, 'R')}).`,
      userId: row.user_id,
      row,
      by: moderator,
      extra: [field(ICONS.duration, 'Ajout', formatDuration(addMs))],
    });
    return expiresAt;
  }

  /** Retire tout de suite un rôle temporaire (bouton « Retirer maintenant »). */
  async removeNow(guild, id, moderator) {
    const row = this.repo.get(guild.id, id);
    if (!row?.active) throw new UserError('Ce rôle temporaire est déjà terminé.');
    const role = guild.roles.cache.get(row.role_id);
    const member = role ? await this.#fetchMember(guild, row.user_id) : null;
    if (role && member?.roles.cache.has(role.id)) {
      // Seule la capacité du bot compte : retirer un rôle devenu sensible reste permis.
      const issue = botIssue(guild, role);
      if (issue) throw new UserError(issue);
      let error = null;
      const { failed } = await applyRoles(member, { remove: [role.id] }, truncate(`Rôle temporaire retiré par ${moderator?.tag ?? 'le staff'}`, 400), (_id, e) => { error = e; });
      if (failed.length && error?.code !== UNKNOWN_ROLE && !GONE_CODES.has(error?.code)) {
        throw new UserError(`Impossible de retirer le rôle ${role} (${error?.code === 50013 ? 'permission ou hiérarchie insuffisante' : 'erreur Discord'}).`);
      }
    }
    if (!this.repo.close(row.id, 'removed')) throw new UserError('Ce rôle temporaire est déjà terminé.');
    await this.#log(guild, {
      tone: 'neutral',
      icon: '➖',
      title: 'Rôle temporaire retiré',
      description: `Le rôle <@&${row.role_id}> a été retiré à <@${row.user_id}> avant son échéance.`,
      userId: row.user_id,
      user: member?.user,
      row,
      by: moderator,
    });
    return row;
  }

  /**
   * Étape du scheduler : retire les rôles arrivés à échéance. Chaque ligne est relue
   * avant d'agir (prolongée ou retirée entre-temps → rien à faire).
   * @param {{ isStopping?: () => boolean, now?: number }} [opts]
   */
  async processDue({ isStopping = () => false, now = Date.now() } = {}) {
    for (const row of this.repo.findDue(now, { perGuild: PER_GUILD_PER_TICK, limit: MAX_PER_TICK })) {
      if (isStopping()) return;
      try {
        await this.#expire(row);
      } catch (e) {
        this.#retryLater(row);
        logger.warn(`Retrait du rôle temporaire #${row.id} (serveur ${row.guild_id}) en échec, réessai :`, e?.message ?? e);
      }
    }
  }

  /** Ligne en échec : réessayée plus tard, sans bloquer les suivantes (ni les autres serveurs). */
  #retryLater(row) {
    this.repo.defer(row.id, Date.now() + RETRY_MS);
  }

  /** Ligne relue en base : toujours active et échue ? */
  #stillDue(row) {
    const fresh = this.repo.byId(row.id);
    return fresh?.active && fresh.expires_at <= Date.now() ? fresh : null;
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

  async #expire(row) {
    const guild = this.client.guilds.cache.get(row.guild_id);
    if (!guild) {
      // Client prêt et serveur absent : le bot l'a quitté, le rôle ne pourra jamais être retiré.
      if (this.client.isReady?.()) this.repo.close(row.id, 'guild_left');
      return;
    }
    if (!guild.available) {
      this.#retryLater(row);
      return;
    }
    if (!this.#stillDue(row)) return;
    const role = guild.roles.cache.get(row.role_id);
    if (!role) {
      this.repo.close(row.id, 'role_deleted');
      return;
    }
    // Capacité du bot vérifiée AVANT toute requête : aucun appel voué à l'échec, on attend
    // qu'on rende la permission (réessai espacé), au plus 24 h.
    const me = guild.members.me;
    const late = Date.now() - row.expires_at;
    if (me && (!me.permissions.has(PermissionFlagsBits.ManageRoles) || role.position >= me.roles.highest.position)) {
      if (late > MAX_LATE_MS) await this.#abandon(guild, row, null, 'permission « Gérer les rôles » ou hiérarchie insuffisante');
      else this.#retryLater(row);
      return;
    }
    const member = await this.#fetchMember(guild, row.user_id);
    if (!member) {
      this.repo.close(row.id, 'left');
      return;
    }
    // Rôle déjà retiré à la main : rien à faire.
    if (!member.roles.cache.has(role.id)) {
      this.repo.close(row.id, 'expired');
      return;
    }
    // Relecture après le fetch : prolongé ou retiré entre-temps → on ne touche à rien.
    if (!this.#stillDue(row)) return;
    let error = null;
    const { failed } = await applyRoles(member, { remove: [role.id] }, 'Fin du rôle temporaire', (_id, e) => { error = e; });
    if (failed.length) {
      if (GONE_CODES.has(error?.code)) this.repo.close(row.id, 'left');
      else if (error?.code === UNKNOWN_ROLE) this.repo.close(row.id, 'role_deleted');
      else if (late > MAX_LATE_MS) await this.#abandon(guild, row, member, error?.message ?? 'erreur Discord');
      else {
        this.#retryLater(row);
        logger.debug(`Retrait du rôle temporaire #${row.id} échoué (réessai) :`, error?.message);
      }
      return;
    }
    if (!this.repo.close(row.id, 'expired')) return;
    logger.info(`Rôle temporaire #${row.id} expiré : guild=${row.guild_id} user=${row.user_id} role=${row.role_id}`);
    await this.#log(guild, {
      tone: 'neutral',
      icon: '⌛',
      title: 'Rôle temporaire expiré',
      description: `${member} n'a plus le rôle ${role} : son échéance est arrivée.`,
      user: member.user,
      row,
      by: this.client.user,
    });
  }

  /** @param {import('discord.js').GuildMember|null} member null : membre non récupéré */
  async #abandon(guild, row, member, why) {
    if (!this.repo.close(row.id, 'failed')) return;
    logger.warn(`Rôle temporaire #${row.id} abandonné (serveur ${row.guild_id}) : ${why}`);
    await this.#log(guild, {
      tone: 'warning',
      icon: ICONS.warning,
      title: 'Rôle temporaire non retiré',
      description: `Je n'ai pas pu retirer le rôle <@&${row.role_id}> à <@${row.user_id}> depuis plus de 24 h (${truncate(why, 200)}). Retirez-le à la main.`,
      user: member?.user,
      userId: row.user_id,
      row,
    });
  }

  /**
   * Rôle retiré à la main (/role remove, bouton « Retirer ») : la ligne active est close,
   * sinon le rôle serait rendu au membre s'il quittait puis revenait avant l'échéance.
   * @returns {boolean} une ligne active a été close
   */
  closeManual(guildId, userId, roleId) {
    const row = this.repo.activeFor(guildId, userId, roleId);
    return row ? this.repo.close(row.id, 'removed') : false;
  }

  /**
   * Membre revenu avant l'échéance : ses rôles temporaires encore valides lui sont rendus.
   * @returns {Promise<string[]>} rôles réappliqués
   */
  async reapply(member, now = Date.now()) {
    const guild = member.guild;
    const rows = this.repo.activeByMember(guild.id, member.id).filter((r) => r.expires_at > now);
    if (!rows.length) return [];
    const wanted = rows.filter((r) => {
      const role = guild.roles.cache.get(r.role_id);
      if (!role || member.roles.cache.has(role.id)) return false;
      const issue = roleIssue(guild, role);
      if (issue) logger.debug(`Rôle temporaire #${r.id} non réappliqué : ${issue}`);
      return !issue;
    });
    if (!wanted.length) return [];
    const { added } = await applyRoles(member, { add: wanted.map((r) => r.role_id) }, 'Rôle temporaire toujours valide (retour sur le serveur)', (id, e) =>
      logger.debug(`Réapplication du rôle temporaire ${id} à ${member.id} échouée :`, e?.message));
    if (added.length) {
      const until = rows.filter((r) => added.includes(r.role_id)).map((r) => `<@&${r.role_id}> · ${discordTimestamp(r.expires_at, 'R')}`);
      await this.#log(guild, {
        tone: 'info',
        icon: '🔁',
        title: 'Rôles temporaires réappliqués',
        description: `${member} est revenu avant l'échéance : ses rôles temporaires lui ont été rendus.`,
        user: member.user,
        extra: [wide(ICONS.role, 'Rôles', until.join('\n'))],
      });
    }
    return added;
  }

  /** Log « Membres · Rôles » (désactivable dans /logs via l'événement memberRoles). */
  async #log(guild, { tone, icon, title, description, user, userId, row, by, extra = [] }) {
    const logging = this.client.services?.logging;
    if (!logging) return;
    const target = user ?? (userId ? { id: userId, toString: () => `<@${userId}>` } : null);
    const embed = logCard({
      category: 'members',
      tone,
      icon,
      title,
      description,
      user: user ?? null,
      id: user?.id ?? userId ?? null,
      fields: [
        target ? field(ICONS.user, 'Membre', user ? userLine(user) : `<@${userId}>`) : null,
        row?.role_id ? field(ICONS.role, 'Rôle', `<@&${row.role_id}>`) : null,
        by ? field(ICONS.moderator, 'Par', `${by}`) : null,
        row?.id ? field(ICONS.id, 'Référence', code(`#${row.id}`)) : null,
        ...extra,
        row?.reason ? wide(ICONS.reason, 'Raison', truncate(row.reason, 1000)) : null,
      ],
    });
    await logging.send(guild.id, 'members', embed, undefined, { event: 'memberRoles' }).catch(() => {});
  }
}

module.exports = { TempRoleService, roleIssue, botIssue, MAX_LATE_MS, RETRY_MS, PER_GUILD_PER_TICK };
