'use strict';

const { SlidingWindow } = require('../utils/rate');
const { card, field, wide, ICONS, userLine, actionButton, buttonRows, ButtonStyle } = require('../utils/ui');
const { createLogger } = require('../core/logger');

const logger = createLogger('antiraid');
const DAY_MS = 24 * 60 * 60 * 1000;
/** Délai minimal entre deux alertes « vague d'arrivées » (et lockdowns auto) par serveur. */
const JOIN_ALERT_COOLDOWN_MS = 60_000;
/** Fréquence de purge des fenêtres d'actions destructrices vides (mémoire bornée). */
const WINDOW_PRUNE_INTERVAL_MS = 60_000;

/** Plafond de membres sanctionnés par déclenchement de vague (garde-fou contre un faux positif massif). */
const MAX_WAVE_PUNISH = 50;
/** Sanctions possibles pour les nouveaux comptes / bots non autorisés (indépendantes de l'action de vague). */
const NEW_ACCOUNT_ACTIONS = new Set(['kick', 'ban']);

/**
 * Sanction appliquée aux comptes trop récents / bots : `antiraid.newAccountAction`.
 * Non réglée : reprend l'ancienne règle (« ban » si l'action anti-raid est le ban, sinon kick). Pur.
 */
function newAccountAction(cfg) {
  if (NEW_ACCOUNT_ACTIONS.has(cfg?.newAccountAction)) return cfg.newAccountAction;
  return cfg?.action === 'ban' ? 'ban' : 'kick';
}

const DESTRUCTIVE_LABELS = { channelDelete: 'Suppressions de salons', roleDelete: 'Suppressions de rôles', ban: 'Bannissements' };
const EXECUTOR_LABELS = { strip: 'Rôles retirés', ban: 'Banni', none: 'Aucune' };

/** Bouton « Lever le lockdown » joint aux alertes qui ont déclenché un lockdown automatique. */
function liftLockdownButton() {
  return actionButton({ command: 'lockdown', action: 'disable', label: 'Lever le lockdown', emoji: ICONS.unlock, style: ButtonStyle.Success });
}

/**
 * Sécurité anti-raid : détection de vagues d'arrivées, comptes trop récents,
 * bots, et actions destructrices massives (suppression de salons/rôles, bans).
 * Utilise la whitelist avant toute sanction.
 */
class AntiRaidService {
  /**
   * @param {object} deps
   * @param {import('discord.js').Client} deps.client
   * @param {import('./ConfigService').ConfigService} deps.config
   * @param {import('./LoggingService').LoggingService} deps.logging
   */
  constructor({ client, config, logging }) {
    this.client = client;
    this.config = config;
    this.logging = logging;
    /**
     * Fenêtre d'arrivées par serveur, avec les identifiants des arrivants : une
     * vague en mode kick/ban sanctionne les membres arrivés dans la fenêtre.
     * @type {Map<string, { windowMs: number, entries: { id: string, at: number }[] }>}
     */
    this.joinWindows = new Map();
    /** @type {Map<string, SlidingWindow>} */
    this.destructiveWindows = new Map();
    /** @type {Map<string, number>} dernier déclenchement d'alerte de vague par serveur */
    this.joinAlertAt = new Map();
    this.lastWindowPrune = Date.now();
  }

  /** Oublie les fenêtres d'actions destructrices devenues vides. */
  pruneWindows(now = Date.now()) {
    this.lastWindowPrune = now;
    for (const [key, w] of this.destructiveWindows) {
      if (w.count(now) === 0) this.destructiveWindows.delete(key);
    }
  }

  /** Marque un ban lancé par le bot (pas de log en double dans guildBanAdd). */
  #markBan(guildId, userId) {
    this.client.services?.moderation?.markBotAction?.('ban', guildId, userId);
  }

  isWhitelisted(guildId, userId, roleIds = []) {
    const wl = this.config.get(guildId).whitelist || { users: [], roles: [] };
    if (wl.users?.includes(userId)) return true;
    return roleIds.some((r) => wl.roles?.includes(r));
  }

  /** Enregistre une arrivée et renvoie les arrivants encore dans la fenêtre (le plus ancien d'abord). */
  #recordJoin(guildId, memberId, ms, now = Date.now()) {
    let w = this.joinWindows.get(guildId);
    if (!w || w.windowMs !== ms) {
      w = { windowMs: ms, entries: [] };
      this.joinWindows.set(guildId, w);
    }
    w.entries = w.entries.filter((e) => e.at > now - ms && e.id !== memberId);
    w.entries.push({ id: memberId, at: now });
    return w.entries;
  }

  #window(map, key, ms) {
    let w = map.get(key);
    if (!w || w.windowMs !== ms) {
      w = new SlidingWindow(ms);
      map.set(key, w);
    }
    return w;
  }

  /**
   * @param {import('discord.js').GuildMember} member
   * @returns {Promise<{ punished: boolean }|undefined>} punished : le membre arrivant a été expulsé/banni
   */
  async handleJoin(member) {
    const cfg = this.config.get(member.guild.id).antiraid;
    if (!cfg?.enabled) return;
    if (this.isWhitelisted(member.guild.id, member.id, [...(member.roles?.cache?.keys() ?? [])])) return;

    // Anti-bot : bot ajouté hors whitelist
    if (cfg.antiBot && member.user.bot) {
      return { punished: await this.#punishNewMember(member, 'AntiRaid: bot non autorisé', cfg) };
    }

    // Âge de compte minimal
    if (cfg.minAccountAgeDays > 0) {
      const ageDays = (Date.now() - member.user.createdTimestamp) / DAY_MS;
      if (ageDays < cfg.minAccountAgeDays) {
        return { punished: await this.#punishNewMember(member, `AntiRaid: compte trop récent (${ageDays.toFixed(1)}j)`, cfg) };
      }
    }

    // Vague d'arrivées
    const guild = member.guild;
    const entries = this.#recordJoin(guild.id, member.id, cfg.joinWindowSeconds * 1000);
    const count = entries.length;
    if (count < cfg.joinThreshold) return { punished: false };

    // Réinitialise la fenêtre : une vague = un déclenchement.
    const joinerIds = entries.map((e) => e.id);
    this.joinWindows.delete(guild.id);
    // En mode kick/ban, les arrivants de la vague sont sanctionnés à chaque
    // déclenchement (le raid continue pendant le cooldown) ; seules l'alerte et
    // le lockdown sont limités à un par cooldown.
    const wave = cfg.action === 'kick' || cfg.action === 'ban' ? await this.#punishWave(guild, joinerIds, cfg.action) : null;
    const now = Date.now();
    const cooling = now - (this.joinAlertAt.get(guild.id) || 0) < JOIN_ALERT_COOLDOWN_MS;
    if (!cooling) {
      this.joinAlertAt.set(guild.id, now);
      const locked = cfg.action === 'lockdown' ? await this.#tryLockdown(guild) : null;
      await this.alert(guild, {
        tone: 'danger',
        icon: '🚨',
        title: 'Vague d\'arrivées détectée',
        description: `**${count}** membres ont rejoint le serveur en moins de **${cfg.joinWindowSeconds} s**.`,
        fields: [
          field(ICONS.members, 'Arrivées', `**${count}**`),
          field(ICONS.warning, 'Seuil', `${cfg.joinThreshold} en ${cfg.joinWindowSeconds} s`),
          wave
            ? field(cfg.action === 'ban' ? ICONS.ban : ICONS.kick, cfg.action === 'ban' ? 'Bannis' : 'Expulsés', waveSummary(wave))
            : field(ICONS.lock, 'Lockdown', locked == null ? 'Non configuré' : `🔒 ${locked} salon${locked > 1 ? 's' : ''} verrouillé${locked > 1 ? 's' : ''}`),
        ],
        buttons: locked ? [liftLockdownButton()] : [],
      });
    } else if (wave?.punished.length) {
      logger.info(`Vague continue sur ${guild.id} : ${wave.punished.length} arrivant(s) sanctionné(s) (${cfg.action}).`);
    }
    return { punished: Boolean(wave?.punished.includes(member.id)) };
  }

  /**
   * Sanctionne (kick/ban) les membres arrivés pendant la vague. Whitelist
   * revérifiée (rôles attribués depuis l'arrivée), propriétaire et bot exclus,
   * au plus MAX_WAVE_PUNISH membres par déclenchement.
   * @returns {Promise<{ punished: string[], skipped: number, capped: number }>}
   */
  async #punishWave(guild, ids, action) {
    const reason = 'AntiRaid: vague d\'arrivées';
    const punished = [];
    let skipped = 0;
    const eligible = ids.filter((id) => id !== guild.ownerId && id !== this.client.user?.id);
    const capped = Math.max(0, eligible.length - MAX_WAVE_PUNISH);
    for (const id of eligible.slice(-MAX_WAVE_PUNISH)) {
      const member = guild.members.cache.get(id) ?? (await guild.members.fetch(id).catch(() => null));
      if (this.isWhitelisted(guild.id, id, member ? [...(member.roles?.cache?.keys() ?? [])] : [])) {
        skipped += 1;
        continue;
      }
      try {
        if (action === 'ban') {
          if (member && member.bannable === false) throw new Error('non bannissable');
          this.#markBan(guild.id, id);
          await guild.bans.create(id, { reason });
        } else {
          if (!member) throw new Error('déjà parti');
          if (member.kickable === false) throw new Error('non expulsable');
          await member.kick(reason);
        }
        punished.push(id);
      } catch (e) {
        if (action === 'ban') this.client.services?.moderation?.unmarkBotAction?.('ban', guild.id, id);
        skipped += 1;
        logger.debug(`punishWave ${id}`, e?.message);
      }
    }
    return { punished, skipped, capped };
  }

  /**
   * Action destructrice détectée via audit log (suppression salon/rôle, ban…).
   * Alimentée par l'événement `guildAuditLogEntryCreate` (une entrée = une action,
   * pas de double comptage ni de fetch des audit logs par événement).
   * @param {import('discord.js').Guild} guild
   * @param {string} executorId
   * @param {'channelDelete'|'roleDelete'|'ban'} type
   */
  async handleDestructive(guild, executorId, type) {
    const cfg = this.config.get(guild.id).antiraid;
    if (!cfg?.enabled || !executorId) return;
    if (executorId === this.client.user?.id) return;
    if (executorId === guild.ownerId) return;
    const executor = await guild.members.fetch(executorId).catch(() => null);
    if (this.isWhitelisted(guild.id, executorId, executor ? [...executor.roles.cache.keys()] : [])) return;

    const thresholds = {
      channelDelete: cfg.channelDeleteThreshold,
      roleDelete: cfg.roleDeleteThreshold,
      ban: cfg.banThreshold,
    };
    const limit = thresholds[type];
    if (!limit) return;

    const now = Date.now();
    if (now - this.lastWindowPrune > WINDOW_PRUNE_INTERVAL_MS) this.pruneWindows(now);
    const key = `${guild.id}:${executorId}:${type}`;
    const w = this.#window(this.destructiveWindows, key, cfg.destructiveWindowSeconds * 1000);
    const count = w.hit();
    if (count < limit) return;

    w.reset();
    const punished = await this.#punishExecutor(guild, executorId, cfg, type);
    await this.alert(guild, {
      tone: 'danger',
      icon: '🚨',
      title: 'Activité destructrice anormale',
      description: `<@${executorId}> a effectué **${count}** actions destructrices en **${cfg.destructiveWindowSeconds} s**.`,
      thumbnail: executor?.user?.displayAvatarURL?.(),
      fields: [
        field(ICONS.user, 'Auteur', executor ? userLine(executor.user) : `<@${executorId}>`),
        field('💣', 'Type', `${DESTRUCTIVE_LABELS[type] ?? type} ×**${count}**`),
        field(ICONS.shield, 'Sanction', punished ? EXECUTOR_LABELS[cfg.punishExecutor] ?? cfg.punishExecutor : 'Aucune (échec ou désactivée)'),
      ],
      footer: `ID : ${executorId}`,
    });
  }

  /** @returns {Promise<boolean>} true si le membre a été expulsé/banni */
  async #punishNewMember(member, reason, cfg) {
    try {
      const ban = newAccountAction(cfg) === 'ban';
      if (ban) {
        this.#markBan(member.guild.id, member.id);
        await member.ban({ reason });
      }
      else await member.kick(reason);
      await this.alert(member.guild, {
        tone: 'caution',
        icon: ICONS.shield,
        title: ban ? 'Nouveau membre banni' : 'Nouveau membre expulsé',
        description: `${member.user} a été ${ban ? 'banni' : 'expulsé'} automatiquement à son arrivée.`,
        thumbnail: member.user.displayAvatarURL?.(),
        fields: [
          field(ICONS.user, 'Membre', userLine(member.user)),
          field(ban ? ICONS.ban : ICONS.kick, 'Sanction', ban ? 'Bannissement' : 'Expulsion'),
          wide(ICONS.reason, 'Motif', reason.replace(/^AntiRaid: /, '')),
        ],
        footer: `ID : ${member.id}`,
      });
      return true;
    } catch (e) {
      logger.debug('punishNewMember', e?.message);
      return false;
    }
  }

  /** @returns {Promise<boolean>} true si une sanction a été appliquée */
  async #punishExecutor(guild, executorId, cfg, type) {
    const member = await guild.members.fetch(executorId).catch(() => null);
    if (!member) return false;
    try {
      if (cfg.punishExecutor === 'ban') {
        this.#markBan(guild.id, member.id);
        await member.ban({ reason: `AntiRaid: ${type} massif` });
        return true;
      }
      if (cfg.punishExecutor === 'strip') {
        const removable = member.roles.cache.filter((r) => r.id !== guild.id && r.editable);
        await member.roles.remove(removable, `AntiRaid: ${type} massif`);
        return true;
      }
    } catch (e) {
      logger.debug('punishExecutor', e?.message);
    }
    return false;
  }

  /** @returns {Promise<number|null>} salons verrouillés (null si le service est indisponible) */
  async #tryLockdown(guild) {
    // Délègue au LockdownService s'il est disponible. Pas de carte « Lockdown activé » :
    // l'alerte AntiRaid (avec le nombre de salons et le bouton de levée) en tient lieu.
    const lockdown = this.client.services?.lockdown;
    if (!lockdown) return null;
    return lockdown.enable(guild, guild.members.me, 'AntiRaid automatique', { log: false }).catch(() => 0);
  }

  /**
   * Publie une alerte (carte danger/caution) dans le salon d'alertes et les logs sécurité.
   * @param {import('discord.js').Guild} guild
   * @param {string | { tone?: string, icon?: string, title: string, description?: string, fields?: object[],
   *   thumbnail?: string, footer?: string, buttons?: import('discord.js').ButtonBuilder[] }} alert
   */
  async alert(guild, alert) {
    const a = typeof alert === 'string' ? { description: alert } : alert;
    const guildCfg = this.config.get(guild.id);
    const alertChannelId = guildCfg.antiraid?.alertChannel;
    const embed = card({
      tone: a.tone ?? 'danger',
      section: 'security',
      icon: a.icon ?? '🚨',
      title: a.title ?? 'Alerte AntiRaid',
      description: a.description,
      thumbnail: a.thumbnail,
      fields: a.fields ?? [],
      footer: a.footer,
    });
    const components = buttonRows(...(a.buttons ?? []));
    // Salon d'alertes dédié uniquement s'il diffère du salon de logs sécurité,
    // sinon l'alerte serait postée deux fois au même endroit.
    if (alertChannelId && alertChannelId !== guildCfg.logChannels?.security) {
      const channel = await this.client.channels.fetch(alertChannelId).catch(() => null);
      if (channel?.isTextBased()) await channel.send({ embeds: [embed], components }).catch(() => {});
    }
    await this.logging.send(guild.id, 'security', embed, components, { event: 'antiraid' });
  }
}

/** Résumé d'une sanction de vague pour l'alerte. Pur. */
function waveSummary({ punished, skipped, capped }) {
  const parts = [`**${punished.length}**`];
  if (skipped) parts.push(`${skipped} ignoré${skipped > 1 ? 's' : ''}`);
  if (capped) parts.push(`${capped} hors plafond (${MAX_WAVE_PUNISH})`);
  return parts.join(' · ');
}

module.exports = { AntiRaidService, newAccountAction, waveSummary, MAX_WAVE_PUNISH };
