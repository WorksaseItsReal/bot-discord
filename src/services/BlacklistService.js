'use strict';

const { AuditLogEvent, PermissionFlagsBits } = require('discord.js');
const { UserError } = require('../core/errors');
const { createLogger } = require('../core/logger');
const { field, wide, ICONS, code } = require('../utils/ui');
const { truncate } = require('../utils/embeds');
const { discordTimestamp } = require('../utils/time');
const { fetchExecutor } = require('../utils/audit');
const { applyRoles } = require('../utils/memberRoles');
const { assertCanModerate } = require('../utils/permissions');
const S = require('../utils/secur');
const { logCard } = require('./LoggingService');
const { MAX_PER_KIND } = require('../database/repositories/SecurityBlacklistRepository');

const logger = createLogger('blacklist');

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
/** Prochain contrôle d'un blacklisté toujours banni. */
const CHECK_INTERVAL_MS = 6 * HOUR;
/** Échec (bannissement ou contrôle) : 5 min × 2ⁿ, plafonné à 24 h. */
const RETRY_BASE_MS = 5 * MINUTE;
const RETRY_MAX_MS = 24 * HOUR;
/** Lignes contrôlées au plus par passage de l'étape `security` (au plus autant de GET). */
const DUE_PER_TICK = 50;
/** Blrank : 3 retraits au plus par membre et par 10 min ; au-delà, carte « boucle » sans retrait. */
const BLRANK_MAX_REMOVALS = 3;
const BLRANK_WINDOW_MS = 10 * MINUTE;
const MAX_TRACKED = 5_000;
const PRUNE_INTERVAL_MS = MINUTE;
const REASON_MAX = 300;
/** Erreurs de bannissement définitives (permission, hiérarchie, utilisateur inconnu, corps refusé). */
const PERMANENT_BAN_CODES = new Set([50013, 10013, 50035]);

const UNBAN_REFUSED = 'Cet utilisateur est sur la **liste noire** de sécurité : il ne peut pas être débanni ainsi. Un owner doit utiliser `/secur blacklist retirer`.';
const SOFTBAN_REFUSED = 'Cet utilisateur est sur la **liste noire** de sécurité : un softban le débannirait. Rien n\'a été modifié.';

/** Délai avant le prochain essai après `failures` échecs (0 → 5 min). Pur. */
function retryDelay(failures) {
  const n = Math.max(0, Math.floor(Number(failures) || 0));
  return Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** Math.min(n, 20));
}

/** Texte lisible d'une erreur Discord de bannissement. Pur. */
function banErrorText(err) {
  if (err?.code === 50013) return 'permission « Bannir des membres » manquante ou rôle de la cible au-dessus du mien';
  if (err?.code === 10013) return 'utilisateur inconnu de Discord';
  return truncate(String(err?.message ?? err ?? 'erreur inconnue'), 200);
}

/**
 * Liste noire persistante (/secur blacklist) et blrank (/secur blrank), SEC3.
 *  - blacklist : un utilisateur banni le reste malgré un débannissement manuel, /unban, la fin
 *    d'un tempban, un softban ou un débannissement fait pendant que le bot était hors ligne
 *    (contrôles : arrivée, guildBanRemove, étape `security` du scheduler) ;
 *  - blrank : un membre listé ne peut recevoir AUCUN rôle (applyRoles saute les ajouts ; un rôle
 *    donné hors du bot est retiré, 3 fois au plus par 10 min).
 * Contrat (plan.notes) : has, count, isRankBlocked, processSecurityDue, purgeGuild.
 */
class BlacklistService {
  /**
   * @param {{ client: object, config: object, logging: object, repo: import('../database/repositories/SecurityBlacklistRepository').SecurityBlacklistRepository, now?: () => number }} deps
   */
  constructor({ client, config, logging, repo, now = () => Date.now() }) {
    this.client = client;
    this.config = config;
    this.logging = logging;
    this.repo = repo;
    this.now = now;
    /** @type {Set<string>} bannissements en cours `${guild}:${user}` (un seul à la fois) */
    this.enforcing = new Set();
    /** @type {Map<string, number[]>} retraits blrank `${guild}:${user}` → instants (sans minuteur) */
    this.rankRemovals = new Map();
    /** @type {Map<string, number>} carte « boucle » déjà publiée `${guild}:${user}` → instant */
    this.loopNotified = new Map();
    this.lastPrune = now();
  }

  /* ------------------------------------------------------------------ */
  /* Lecture (contrat)                                                    */
  /* ------------------------------------------------------------------ */

  has(guildId, userId, kind = 'ban') {
    if (!guildId || !userId) return false;
    try {
      return this.repo.has(guildId, userId, kind);
    } catch {
      return false;
    }
  }

  count(guildId, kind = 'ban') {
    if (!guildId) return 0;
    return this.repo.count(guildId, kind);
  }

  /** Le membre est-il dans le blrank (aucun rôle ne peut lui être ajouté) ? */
  isRankBlocked(guildId, userId) {
    return this.has(guildId, userId, 'rank');
  }

  get(guildId, userId, kind = 'ban') {
    return this.repo.get(guildId, userId, kind);
  }

  /** Lève l'UserError de refus si l'utilisateur est blacklisté (ModerationService.unban / softban). */
  assertNotBlacklisted(guildId, userId, action = 'unban') {
    if (!this.has(guildId, userId, 'ban')) return;
    throw new UserError(action === 'softban' ? SOFTBAN_REFUSED : UNBAN_REFUSED);
  }

  /* ------------------------------------------------------------------ */
  /* Garde-fous                                                           */
  /* ------------------------------------------------------------------ */

  levelOpts() {
    return this.client.services?.secur?.levelOpts?.() ?? {
      botOwnerIds: this.client.config?.ownerIds ?? [],
      trustBotOwners: Boolean(this.client.config?.securTrustBotOwners),
      botId: this.client.user?.id ?? null,
    };
  }

  /** Lève l'UserError « réservé au propriétaire et aux owners » (ajouter, retirer). */
  assertOwner(interaction) {
    S.assertOwnerLevel(interaction.guild, interaction.user?.id, this.config.get(interaction.guild.id), this.levelOpts());
  }

  /**
   * Refus communs : soi-même, le bot, le propriétaire, un owner (niveau owner) ; pour la liste
   * noire : un whitelisté, un bot de confiance, une cible que le bot (ou l'auteur) ne peut pas bannir.
   * @param {import('discord.js').GuildMember|null} member cible présente sur le serveur
   */
  assertTarget(interaction, targetId, kind, member = null) {
    const guild = interaction.guild;
    const actorId = interaction.user?.id;
    const what = kind === 'ban' ? 'la liste noire' : 'le blrank';
    if (!/^\d{17,20}$/.test(String(targetId ?? ''))) throw new UserError('Utilisateur invalide.');
    if (targetId === actorId) throw new UserError(`Vous ne pouvez pas vous ajouter vous-même dans ${what}.`);
    if (targetId === this.client.user?.id) throw new UserError(`Je ne peux pas m'ajouter moi-même dans ${what}.`);
    if (targetId === guild.ownerId) throw new UserError(`Impossible : c'est le propriétaire du serveur.`);
    const cfg = this.config.get(guild.id);
    const roleIds = member?.roles?.cache?.keys ? [...member.roles.cache.keys()] : [];
    const isBot = Boolean(member?.user?.bot);
    const level = S.securityLevel(guild, targetId, roleIds, cfg, { ...this.levelOpts(), isBot });
    if (S.isOwnerLevel(level) || (!isBot && (cfg.secur?.owners ?? []).includes(targetId))) {
      throw new UserError('Impossible : c\'est un owner de sécurité. Retirez-le d\'abord des owners.');
    }
    if (kind !== 'ban') return;
    if ((cfg.secur?.trustedBots ?? []).includes(targetId)) throw new UserError('Impossible : c\'est un bot de confiance. Retirez-le d\'abord des bots de confiance.');
    const wl = cfg.whitelist ?? {};
    if ((wl.users ?? []).includes(targetId) || roleIds.some((r) => (wl.roles ?? []).includes(r))) {
      throw new UserError('Ce membre est **whitelisté** : retirez-le d\'abord de la whitelist (`/whitelist remove`).');
    }
    const me = guild.members?.me;
    if (me?.permissions && !me.permissions.has(PermissionFlagsBits.BanMembers)) throw new UserError('Il me manque la permission **Bannir des membres**.');
    if (member) {
      if (member.bannable === false) throw new UserError('Je ne peux pas bannir ce membre (rôle trop élevé ou permission « Bannir » manquante).');
      if (interaction.member?.roles?.highest && me?.roles?.highest) assertCanModerate(interaction.member, member, me, { action: 'blacklister' });
    }
  }

  /* ------------------------------------------------------------------ */
  /* Bannissement                                                         */
  /* ------------------------------------------------------------------ */

  /**
   * Bannit par identifiant (cible présente ou non), marqué comme action du bot (guildBanAdd ne le
   * journalise pas une seconde fois). Ne lève jamais.
   * @returns {Promise<{ ok: boolean, permanent?: boolean, error?: string, code?: number }>}
   */
  async #ban(guild, userId, reason) {
    const me = guild.members?.me;
    if (me?.permissions && !me.permissions.has(PermissionFlagsBits.BanMembers)) return { ok: false, permanent: true, code: 50013, error: 'permission « Bannir des membres » manquante' };
    const member = guild.members?.cache?.get?.(userId);
    if (member && member.bannable === false) return { ok: false, permanent: true, code: 50013, error: 'rôle de la cible au-dessus du mien' };
    const moderation = this.client.services?.moderation;
    const welcome = this.client.services?.welcome;
    moderation?.markBotAction?.('ban', guild.id, userId);
    welcome?.silence?.(guild.id, userId);
    try {
      await guild.bans.create(userId, { reason: truncate(`Blacklist : ${reason || 'sans raison'}`, 400) });
      return { ok: true };
    } catch (err) {
      moderation?.unmarkBotAction?.('ban', guild.id, userId);
      welcome?.unsilence?.(guild.id, userId);
      return { ok: false, permanent: PERMANENT_BAN_CODES.has(err?.code), code: err?.code, error: banErrorText(err) };
    }
  }

  /** Bannissement d'une ligne existante (arrivée, débannissement, contrôle) : état mis à jour. */
  async #enforce(guild, row, { context }) {
    const key = `${guild.id}:${row.user_id}`;
    if (this.enforcing.has(key)) return { ok: true, skipped: true };
    this.enforcing.add(key);
    try {
      // Relue juste avant d'agir : la ligne a pu être retirée (/secur blacklist retirer).
      const fresh = this.repo.get(guild.id, row.user_id, 'ban');
      if (!fresh) return { ok: false, gone: true };
      const now = this.now();
      const res = await this.#ban(guild, fresh.user_id, fresh.reason);
      if (res.ok) {
        this.repo.markEnforced(guild.id, fresh.user_id, 'ban', { at: now, next: now + CHECK_INTERVAL_MS });
        // Premier bannissement effectif (l'ajout avait échoué passagèrement) : inscrit au casier.
        if (!fresh.last_enforced_at) this.#casier(guild, fresh.user_id, fresh.author_id, fresh.reason);
      } else {
        this.repo.markFailure(guild.id, fresh.user_id, 'ban', now + retryDelay(fresh.enforce_failures));
        logger.warn(`Liste noire (${context}) : bannissement de ${fresh.user_id} sur ${guild.id} impossible : ${res.error}`);
      }
      return { ...res, row: fresh };
    } finally {
      this.enforcing.delete(key);
    }
  }

  #casier(guild, userId, authorId, reason) {
    try {
      return this.client.repositories?.sanctions?.create?.({ guildId: guild.id, userId, moderatorId: authorId, type: 'ban', reason: truncate(`Blacklist : ${reason || 'sans raison'}`, 1000) }) ?? null;
    } catch (e) {
      logger.debug('Casier :', e?.message);
      return null;
    }
  }

  /* ------------------------------------------------------------------ */
  /* Commandes                                                            */
  /* ------------------------------------------------------------------ */

  /**
   * /secur blacklist ajouter (l'appelant a différé la réponse et vérifié le niveau owner).
   * INSERT OR IGNORE puis ban par identifiant. Échec définitif (50013, hiérarchie) : ligne
   * supprimée et UserError. Échec passager : ligne gardée, nouvel essai dans 5 min.
   * @returns {Promise<{ banned: boolean, error?: string, sanctionId?: number|null, member: object|null }>}
   */
  async add(interaction, user, reason) {
    const guild = interaction.guild;
    const actor = interaction.user;
    const text = String(reason ?? '').trim();
    if (!text) throw new UserError('Indiquez une raison (300 caractères au plus).');
    if ([...text].length > REASON_MAX) throw new UserError(`Raison trop longue (${REASON_MAX} caractères au plus).`);
    const member = guild.members?.cache?.get?.(user.id) ?? (await guild.members?.fetch?.(user.id).catch(() => null)) ?? null;
    this.assertTarget(interaction, user.id, 'ban', member);
    // Pré-contrôle Secur / AntiRaid : le ban est fait par le bot au nom de l'auteur.
    this.client.services?.secur?.assertAllowed?.(interaction, 'ban', { targetId: user.id });
    const now = this.now();
    const res = this.repo.add({ guildId: guild.id, userId: user.id, kind: 'ban', reason: text, authorId: actor.id, createdAt: now, nextCheckAt: now + RETRY_BASE_MS });
    if (res.full) throw new UserError(`La liste noire est pleine (${MAX_PER_KIND} entrées). Retirez-en avant d'en ajouter.`);
    if (!res.added) throw new UserError('Cet utilisateur est **déjà** sur la liste noire.');
    const key = `${guild.id}:${user.id}`;
    this.enforcing.add(key);
    let ban;
    try {
      ban = await this.#ban(guild, user.id, text);
      if (!ban.ok && ban.permanent) {
        this.repo.remove(guild.id, user.id, 'ban');
        throw new UserError(`Bannissement impossible (${ban.error}) : l'utilisateur n'a pas été ajouté à la liste noire.`);
      }
      if (!ban.ok) {
        this.repo.markFailure(guild.id, user.id, 'ban', now + RETRY_BASE_MS);
        return { banned: false, error: ban.error, member };
      }
      this.repo.markEnforced(guild.id, user.id, 'ban', { at: now, next: now + CHECK_INTERVAL_MS });
    } finally {
      this.enforcing.delete(key);
    }
    // Un tempban en cours serait levé à son échéance : remplacé par la liste noire.
    try {
      this.client.repositories?.sanctions?.deactivateActive?.(guild.id, user.id, 'tempban', { by: actor.id, reason: 'Remplacé par la liste noire' });
    } catch {
      /* best-effort */
    }
    const sanctionId = this.#casier(guild, user.id, actor.id, text);
    return { banned: true, sanctionId, member };
  }

  /**
   * Retrait de la liste noire : DELETE (verrou, changes = 1) AVANT le débannissement, pour que
   * guildBanRemove ne trouve plus la ligne et ne rebannisse pas. Un second clic ne fait rien.
   * @returns {Promise<{ unbanned: boolean|null, note?: string }>}
   */
  async remove(interaction, userId, { unban = true } = {}) {
    const guild = interaction.guild;
    if (unban) this.client.services?.secur?.assertAllowed?.(interaction, 'unban', { targetId: userId });
    if (!this.repo.remove(guild.id, userId, 'ban')) throw new UserError('Cet utilisateur n\'est plus sur la liste noire (déjà retiré).');
    if (!unban) return { unbanned: null };
    try {
      await this.client.services.moderation.unban(guild, userId, interaction.member ?? interaction.user, `Retiré de la liste noire par ${interaction.user?.tag ?? interaction.user?.id}`);
      return { unbanned: true };
    } catch (err) {
      return { unbanned: false, note: err?.isUserError ? err.message : `Discord a refusé le débannissement (${banErrorText(err)}).` };
    }
  }

  /** /secur blrank ajouter (niveau owner vérifié par l'appelant). */
  async addRank(interaction, user, reason = null) {
    const guild = interaction.guild;
    const member = guild.members?.cache?.get?.(user.id) ?? (await guild.members?.fetch?.(user.id).catch(() => null)) ?? null;
    this.assertTarget(interaction, user.id, 'rank', member);
    const text = reason ? String(reason).trim().slice(0, REASON_MAX) || null : null;
    const res = this.repo.add({ guildId: guild.id, userId: user.id, kind: 'rank', reason: text, authorId: interaction.user.id, createdAt: this.now() });
    if (res.full) throw new UserError(`Le blrank est plein (${MAX_PER_KIND} entrées).`);
    if (!res.added) throw new UserError('Ce membre est **déjà** dans le blrank.');
    return { member };
  }

  removeRank(guildId, userId) {
    if (!this.repo.remove(guildId, userId, 'rank')) throw new UserError('Ce membre n\'est pas dans le blrank.');
    this.rankRemovals.delete(`${guildId}:${userId}`);
    this.loopNotified.delete(`${guildId}:${userId}`);
    return true;
  }

  /* ------------------------------------------------------------------ */
  /* Événements                                                           */
  /* ------------------------------------------------------------------ */

  /**
   * Arrivée (guildMemberAdd, AVANT l'AntiRaid) : un blacklisté est rebanni. `punished: true` :
   * ni accueil, ni rôles d'arrivée, ni comptage dans la vague.
   * @returns {Promise<{ punished: boolean }>}
   */
  async handleJoin(member) {
    const guild = member?.guild;
    if (!guild || member.id === this.client.user?.id) return { punished: false };
    const row = this.repo.get(guild.id, member.id, 'ban');
    if (!row) return { punished: false };
    const res = await this.#enforce(guild, row, { context: 'arrivée' });
    if (res.gone) return { punished: false };
    if (res.skipped) return { punished: true };
    await this.#log(guild, res.ok ? {
      tone: 'danger', icon: ICONS.ban, title: 'Blacklisté banni à son arrivée',
      description: `<@${row.user_id}> est sur la liste noire : il a été rebanni dès son arrivée.`,
      fields: this.#rowFields(row),
    } : {
      tone: 'warning', icon: ICONS.warning, title: 'Blacklisté non banni',
      description: `<@${row.user_id}> est sur la liste noire et vient d'arriver, mais je n'ai pas pu le bannir : ${res.error}. Nouvel essai automatique.`,
      fields: this.#rowFields(row),
    }, row.user_id);
    return { punished: Boolean(res.ok) };
  }

  /** guildBanRemove : un blacklisté débanni (à la main, par un autre bot…) est rebanni tout de suite. */
  async handleUnban(guild, user) {
    if (!guild?.id || !user?.id) return;
    const row = this.repo.get(guild.id, user.id, 'ban');
    if (!row) return;
    const res = await this.#enforce(guild, row, { context: 'débannissement' });
    if (res.gone || res.skipped) return;
    const executor = await fetchExecutor(guild, AuditLogEvent.MemberBanRemove, user.id).catch(() => null);
    await this.#log(guild, res.ok ? {
      tone: 'danger', icon: ICONS.ban, title: 'Débannissement annulé',
      description: `<@${row.user_id}> est sur la liste noire : son débannissement a été annulé et il a été rebanni. Pour le débannir, un owner doit utiliser \`/secur blacklist retirer\`.`,
      fields: [field(ICONS.moderator, 'Débanni par', executor ? `<@${executor}>` : '*Inconnu*'), ...this.#rowFields(row)],
    } : {
      tone: 'warning', icon: ICONS.warning, title: 'Débannissement non annulé',
      description: `<@${row.user_id}> est sur la liste noire mais a été débanni, et je n'ai pas pu le rebannir : ${res.error}. Nouvel essai automatique.`,
      fields: [field(ICONS.moderator, 'Débanni par', executor ? `<@${executor}>` : '*Inconnu*'), ...this.#rowFields(row)],
    }, row.user_id);
  }

  /**
   * guildMemberUpdate : un membre du blrank qui gagne un rôle (non géré, modifiable par le bot,
   * autre que booster) le perd aussitôt (applyRoles), 3 fois au plus par 10 min ; au-delà, carte
   * « boucle d'attribution avec un autre bot », sans nouveau retrait.
   */
  async handleMemberUpdate(oldMember, newMember) {
    const guild = newMember?.guild;
    if (!guild?.id || !newMember?.id || newMember.id === this.client.user?.id) return;
    if (!this.isRankBlocked(guild.id, newMember.id)) return;
    if (!oldMember || oldMember.partial || !oldMember.roles?.cache) return;
    const before = new Set(oldMember.roles.cache.keys());
    const gained = [...(newMember.roles?.cache?.values?.() ?? [])].filter((r) => r && !before.has(r.id) && r.id !== guild.id && !r.managed && r.editable !== false && !r.tags?.premiumSubscriberRole);
    if (!gained.length) return;
    const level = S.securityLevel(guild, newMember.id, [], this.config.get(guild.id), { ...this.levelOpts(), isBot: Boolean(newMember.user?.bot) });
    if (level === 'bot' || S.isOwnerLevel(level)) return;
    const now = this.now();
    if (now - this.lastPrune > PRUNE_INTERVAL_MS) this.prune(now);
    const key = `${guild.id}:${newMember.id}`;
    const list = (this.rankRemovals.get(key) ?? []).filter((t) => now - t < BLRANK_WINDOW_MS);
    if (list.length >= BLRANK_MAX_REMOVALS) {
      this.rankRemovals.set(key, list);
      const notified = this.loopNotified.get(key);
      if (notified && now - notified < BLRANK_WINDOW_MS) return;
      this.loopNotified.set(key, now);
      await this.#log(guild, {
        tone: 'warning', icon: ICONS.warning, title: 'Boucle d\'attribution avec un autre bot',
        description: `<@${newMember.id}> est dans le blrank, mais ses rôles lui sont rendus en boucle (sans doute par un autre bot). J'arrête de les retirer pendant 10 minutes : retirez ce rôle de l'attribution automatique de l'autre bot, ou retirez le membre du blrank.`,
        fields: [field(ICONS.user, 'Membre', `<@${newMember.id}>`), field(ICONS.role, 'Rôles', gained.slice(0, 10).map((r) => `<@&${r.id}>`).join(' '))],
      }, newMember.id);
      return;
    }
    list.push(now);
    this.rankRemovals.delete(key);
    this.rankRemovals.set(key, list);
    while (this.rankRemovals.size > MAX_TRACKED) this.rankRemovals.delete(this.rankRemovals.keys().next().value);
    const res = await applyRoles(newMember, { remove: gained.map((r) => r.id) }, 'Blrank : ce membre ne peut recevoir aucun rôle');
    const executor = await fetchExecutor(guild, AuditLogEvent.MemberRoleUpdate, newMember.id).catch(() => null);
    await this.#log(guild, {
      tone: res.failed.length ? 'warning' : 'caution', icon: ICONS.role, title: 'Rôle retiré (blrank)',
      description: `<@${newMember.id}> est dans le blrank : ${res.removed.length ? `${res.removed.map((id) => `<@&${id}>`).join(' ')} lui ${res.removed.length > 1 ? 'ont été retirés' : 'a été retiré'}.` : 'aucun rôle n\'a pu lui être retiré.'}`,
      fields: [
        field(ICONS.user, 'Membre', `<@${newMember.id}>`),
        field(ICONS.moderator, 'Rôle donné par', executor ? `<@${executor}>` : '*Inconnu*'),
        res.failed.length ? field(ICONS.warning, 'Échecs', res.failed.map((id) => `<@&${id}>`).join(' ')) : null,
      ],
    }, newMember.id);
  }

  /* ------------------------------------------------------------------ */
  /* Contrôle périodique (étape `security` du scheduler)                  */
  /* ------------------------------------------------------------------ */

  /**
   * 50 lignes dues au plus par passage, sur un serveur présent, chacune RELUE avant d'agir :
   * GET du ban (10026 → rebannissement), prochain contrôle dans 6 h ; en échec, 5 min × 2ⁿ (24 h max).
   */
  async processSecurityDue({ isStopping = () => false } = {}) {
    const now = this.now();
    if (now - this.lastPrune > PRUNE_INTERVAL_MS) this.prune(now);
    let rows;
    try {
      rows = this.repo.due(now, DUE_PER_TICK);
    } catch (e) {
      logger.warn('Liste noire : lecture des contrôles dus :', e?.message);
      return;
    }
    for (const due of rows) {
      if (isStopping()) return;
      const guild = this.client.guilds?.cache?.get?.(due.guild_id);
      if (!guild || guild.available === false) {
        // Serveur absent ou indisponible : contrôle repoussé (purgé avec le serveur s'il ne revient pas).
        this.repo.postpone(due.guild_id, due.user_id, 'ban', now + CHECK_INTERVAL_MS);
        continue;
      }
      const row = this.repo.get(guild.id, due.user_id, 'ban');
      if (!row || row.next_check_at == null || row.next_check_at > now || this.enforcing.has(`${guild.id}:${row.user_id}`)) continue;
      const me = guild.members?.me;
      if (me?.permissions && !me.permissions.has(PermissionFlagsBits.BanMembers)) {
        // Aucun appel voué au 403 : échec compté, nouvel essai plus tard.
        this.repo.markFailure(guild.id, row.user_id, 'ban', now + retryDelay(row.enforce_failures));
        if (!row.enforce_failures) await this.#failureLog(guild, row, 'la permission « Bannir des membres » me manque');
        continue;
      }
      let banned;
      try {
        await guild.bans.fetch({ user: row.user_id, force: true });
        banned = true;
      } catch (err) {
        if (err?.code === 10026) banned = false;
        else {
          this.repo.markFailure(guild.id, row.user_id, 'ban', now + retryDelay(row.enforce_failures));
          continue;
        }
      }
      if (banned) {
        this.repo.markChecked(guild.id, row.user_id, 'ban', now + CHECK_INTERVAL_MS);
        continue;
      }
      const res = await this.#enforce(guild, row, { context: 'contrôle' });
      if (res.gone || res.skipped) continue;
      if (res.ok) {
        await this.#log(guild, {
          tone: 'danger', icon: ICONS.ban, title: 'Bannissement rétabli',
          description: `<@${row.user_id}> est sur la liste noire mais n'était plus banni (débanni pendant une absence du bot ?) : il a été rebanni.`,
          fields: this.#rowFields(row),
        }, row.user_id);
      } else if (!row.enforce_failures) {
        await this.#failureLog(guild, row, res.error);
      }
    }
  }

  async #failureLog(guild, row, error) {
    await this.#log(guild, {
      tone: 'warning', icon: ICONS.warning, title: 'Liste noire : bannissement impossible',
      description: `<@${row.user_id}> est sur la liste noire mais n'est pas banni, et je n'arrive pas à le bannir : ${error}. Je réessaie automatiquement (de 5 min à 24 h d'intervalle).`,
      fields: this.#rowFields(row),
    }, row.user_id);
  }

  /* ------------------------------------------------------------------ */
  /* Logs, mémoire                                                        */
  /* ------------------------------------------------------------------ */

  #rowFields(row) {
    return [
      field(ICONS.user, 'Utilisateur', `<@${row.user_id}>\n${code(row.user_id)}`),
      field(ICONS.moderator, 'Ajouté par', `<@${row.author_id}>`),
      field(ICONS.date, 'Depuis', discordTimestamp(row.created_at, 'R')),
      row.reason ? wide(ICONS.reason, 'Raison', truncate(row.reason, 1024)) : null,
    ];
  }

  /** Log « Liste noire » (catégorie Sécurité, événement blacklist). Ne lève jamais. */
  async #log(guild, { tone, icon, title, description, fields = [] }, id = null) {
    const embed = logCard({ category: 'security', tone, icon, title, description, fields, id });
    await Promise.resolve(this.logging?.send?.(guild.id, 'security', embed, undefined, { event: 'blacklist' })).catch(() => false);
  }

  /** Log d'une action de commande (ajout, retrait) : APRÈS la réponse. */
  async logAction(guild, payload, id = null) {
    await this.#log(guild, payload, id);
  }

  prune(now = this.now()) {
    this.lastPrune = now;
    for (const [key, list] of this.rankRemovals) {
      const kept = list.filter((t) => now - t < BLRANK_WINDOW_MS);
      if (kept.length) this.rankRemovals.set(key, kept);
      else this.rankRemovals.delete(key);
    }
    for (const [key, at] of this.loopNotified) if (now - at >= BLRANK_WINDOW_MS) this.loopNotified.delete(key);
  }

  /** Serveur quitté : état mémoire oublié. */
  forgetGuild(guildId) {
    if (!guildId) return;
    const prefix = `${guildId}:`;
    for (const map of [this.rankRemovals, this.loopNotified]) for (const key of map.keys()) if (key.startsWith(prefix)) map.delete(key);
  }

  /** Données du serveur supprimées (appelé 30 jours après son départ) et mémoire oubliée. */
  purgeGuild(guildId) {
    if (!guildId) return 0;
    const n = this.repo.purgeGuild(guildId);
    this.forgetGuild(guildId);
    return n;
  }
}

module.exports = {
  BlacklistService,
  retryDelay,
  banErrorText,
  CHECK_INTERVAL_MS,
  RETRY_BASE_MS,
  RETRY_MAX_MS,
  DUE_PER_TICK,
  BLRANK_MAX_REMOVALS,
  BLRANK_WINDOW_MS,
  REASON_MAX,
  UNBAN_REFUSED,
  SOFTBAN_REFUSED,
};
