'use strict';

const { PermissionFlagsBits, escapeMarkdown } = require('discord.js');
const { fitEmbeds, status, ICONS } = require('../../utils/ui');
const { createLogger } = require('../../core/logger');

const logger = createLogger('secur:notify');

/** Fenêtre du plafond et du dédoublonnage des MP. */
const DM_WINDOW_MS = 10 * 60_000;
/** MP d'alerte par serveur et par fenêtre ; le suivant annonce le plafond, puis silence. */
const DM_CAP = 5;
/** Destinataires d'un MP d'alerte (propriétaire compris). */
const MAX_DM_RECIPIENTS = 5;
/** Serveurs suivis (MP et pings) : mémoire bornée. */
const MAX_TRACKED_GUILDS = 1_000;
/** Délai minimal entre deux pings du rôle d'alerte, par serveur. */
const PING_COOLDOWN_MS = 60_000;
const SNOWFLAKE = /^\d{17,20}$/;
const SEND_PERMISSIONS = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks];

/** Ajoute à une Map bornée (les plus anciennes entrées sortent d'abord). */
function boundedSet(map, key, value, max = MAX_TRACKED_GUILDS) {
  map.delete(key);
  map.set(key, value);
  while (map.size > max) map.delete(map.keys().next().value);
}

/**
 * Remise des alertes de sécurité (AntiRaid historique, Secur, journal, accès en attente).
 *
 * Une alerte N'EST PAS un log : elle part DIRECTEMENT (channel.send) dans le salon d'alerte
 * AntiRaid s'il est joignable, sinon dans le salon des logs sécurité — jamais soumise à
 * logs.enabled, aux catégories ou événements coupés. Le log normal (filtré) part en plus,
 * sauf s'il tombe dans le salon qui vient de recevoir l'alerte.
 *
 * MP (propriétaire si notifyOwner, owners si alertOwnersDm, 5 au plus) : alerte critique, ou
 * alerte de repli que personne n'a reçue. SANS minuteur : envoi immédiat, dédoublonnage par
 * empreinte exacte (10 min), plafond de 5 MP par serveur et par 10 min (le 6ᵉ annonce le
 * plafond, puis silence jusqu'à la fin de la fenêtre).
 */
class SecurNotifier {
  /**
   * @param {{ client: import('discord.js').Client, config: { get: (id: string) => object }, logging: { send: Function }, now?: () => number }} deps
   */
  constructor({ client, config, logging, now = () => Date.now() }) {
    this.client = client;
    this.config = config;
    this.logging = logging;
    this.now = now;
    /** @type {Map<string, { start: number, count: number, capped: boolean, prints: Map<string, number> }>} */
    this.dmState = new Map();
    /** @type {Map<string, number>} dernier ping du rôle d'alerte par serveur */
    this.pingAt = new Map();
  }

  /** Serveur quitté : son état est oublié. */
  forgetGuild(guildId) {
    this.dmState.delete(guildId);
    this.pingAt.delete(guildId);
  }

  /** Salon d'envoi direct utilisable (cache, sinon lecture), ou null. */
  async #reachable(guild, channelId) {
    if (!channelId || typeof channelId !== 'string') return null;
    const channel = guild.channels?.cache?.get?.(channelId) ?? (await this.client.channels?.fetch?.(channelId).catch(() => null));
    if (typeof channel?.send !== 'function') return null;
    if (channel.guildId && channel.guildId !== guild.id) return null;
    const me = guild.members?.me;
    if (me && typeof channel.permissionsFor === 'function' && !channel.permissionsFor(me)?.has?.(SEND_PERMISSIONS)) return null;
    return channel;
  }

  /** Rôle à mentionner (au plus une fois par minute et par serveur), ou null. */
  #pingRole(guild, cfg) {
    const roleId = cfg.secur?.raidPingRoleId;
    if (!SNOWFLAKE.test(String(roleId ?? '')) || roleId === guild.id) return null;
    if (guild.roles?.cache?.get && !guild.roles.cache.get(roleId)) return null;
    const now = this.now();
    if (now - (this.pingAt.get(guild.id) ?? 0) < PING_COOLDOWN_MS) return null;
    boundedSet(this.pingAt, guild.id, now);
    return roleId;
  }

  /**
   * Remet une alerte.
   * @param {import('discord.js').Guild} guild
   * @param {{ embed: object, components?: object[], dmContent?: string }} payload
   * @param {{ critical?: boolean, fallback?: boolean, ping?: boolean, event?: string, fingerprint?: string,
   *   channels?: { alert?: string|null, security?: string|null }, skipDm?: string[], log?: boolean }} [opts]
   *   critical : MP même si l'alerte est reçue · fallback : MP (puis salon système) si personne ne l'a reçue ·
   *   channels : salons à utiliser (journal : salons tels qu'ils étaient AVANT le changement)
   * @returns {Promise<{ delivered: boolean, channelId: string|null, message: object|null, dms: number }>}
   */
  async deliver(guild, { embed, components = [], dmContent } = {}, opts = {}) {
    const { critical = false, fallback = true, ping = false, event = 'secur', fingerprint = null, skipDm = [], log = true, label = 'Alerte de sécurité' } = opts;
    const out = { delivered: false, channelId: null, message: null, dms: 0 };
    if (!guild?.id || !embed) return out;
    const cfg = this.config.get(guild.id) ?? {};
    const alertId = opts.channels ? opts.channels.alert ?? null : cfg.antiraid?.alertChannel ?? null;
    const securityId = opts.channels ? opts.channels.security ?? null : cfg.logChannels?.security ?? null;

    // 1. Envoi direct : salon d'alerte, sinon salon des logs sécurité (hors filtres des logs).
    for (const id of [...new Set([alertId, securityId].filter(Boolean))]) {
      const channel = await this.#reachable(guild, id);
      if (!channel) continue;
      const roleId = ping ? this.#pingRole(guild, cfg) : null;
      const message = await channel
        .send({
          ...(roleId ? { content: `<@&${roleId}>` } : {}),
          embeds: fitEmbeds([embed]),
          components,
          allowedMentions: roleId ? { parse: [], roles: [roleId] } : { parse: [] },
        })
        .catch((e) => {
          logger.debug(`Alerte non remise dans ${id} (${guild.id}) :`, e?.message);
          return null;
        });
      if (!message) {
        if (roleId) this.pingAt.delete(guild.id); // ping non parti : le prochain pourra partir
        continue;
      }
      out.delivered = true;
      out.channelId = channel.id ?? id;
      out.message = message;
      break;
    }

    // 2. Log normal (filtré par /logs), sauf s'il tombe dans le salon qui a reçu l'alerte.
    if (log && !(out.delivered && out.channelId === cfg.logChannels?.security)) {
      const logged = await Promise.resolve(this.logging?.send?.(guild.id, 'security', embed, components, { event })).catch(() => false);
      if (logged === true) out.delivered = true;
    }

    // 3. MP : événement critique, alerte de repli que personne n'a reçue, ou alerte de repli dont
    //    les logs sécurité sont coupés (/logs : logs désactivés, catégorie ou événement en pause) :
    //    l'équipe ne regarde peut-être plus ce salon.
    const muted = cfg.logs?.enabled === false || Boolean(cfg.logs?.disabledCategories?.includes?.('security')) || Boolean(cfg.logs?.disabledEvents?.includes?.(event));
    if (critical || (fallback && (!out.delivered || muted))) {
      const why = !out.delivered ? 'lost' : muted && !critical ? 'muted' : null;
      out.dms = await this.#directMessages(guild, cfg, embed, { dmContent, fingerprint, skipDm, why, label });
    }

    // 4. Dernier recours : salon système (sans boutons ni mention).
    if (fallback && !out.delivered && out.dms === 0) out.delivered = await this.#systemChannel(guild, embed, dmContent, label);
    return out;
  }

  /** Destinataires des MP : propriétaire (notifyOwner) puis owners (alertOwnersDm), 5 au plus. */
  #recipients(guild, cfg, skip) {
    const ids = [];
    if (guild.ownerId && cfg.secur?.notifyOwner !== false) ids.push(guild.ownerId);
    if (cfg.secur?.alertOwnersDm !== false) for (const id of cfg.secur?.owners ?? []) ids.push(id);
    return [...new Set(ids)].filter((id) => SNOWFLAKE.test(String(id)) || id === guild.ownerId).filter((id) => !skip.includes(id)).slice(0, MAX_DM_RECIPIENTS);
  }

  /**
   * Garde des MP (sans minuteur) : 'send', 'cap' (annoncer le plafond) ou 'skip'. Pur hors état.
   * Dédoublonnage par empreinte exacte pendant 10 min, 5 MP par 10 min et par serveur.
   */
  dmGate(guildId, fingerprint) {
    const now = this.now();
    let st = this.dmState.get(guildId);
    if (!st || now - st.start >= DM_WINDOW_MS) st = { start: now, count: 0, capped: false, prints: new Map(st?.prints ?? []) };
    for (const [fp, at] of st.prints) if (now - at >= DM_WINDOW_MS) st.prints.delete(fp);
    boundedSet(this.dmState, guildId, st);
    if (fingerprint && st.prints.has(fingerprint)) return 'skip';
    if (st.count >= DM_CAP) {
      if (st.capped) return 'skip';
      st.capped = true;
      return 'cap';
    }
    st.count += 1;
    if (fingerprint) st.prints.set(fingerprint, now);
    return 'send';
  }

  async #directMessages(guild, cfg, embed, { dmContent, fingerprint, skipDm, why, label }) {
    const recipients = this.#recipients(guild, cfg, skipDm);
    if (!recipients.length) return 0;
    const fp = fingerprint ?? `${embed.data?.title ?? embed.title ?? ''}\n${embed.data?.description ?? embed.description ?? ''}`;
    const gate = this.dmGate(guild.id, fp);
    if (gate === 'skip') return 0;
    const name = escapeMarkdown(String(guild.name ?? guild.id)).slice(0, 100);
    const payload = gate === 'cap'
      ? {
        content: `${ICONS.warning} Trop d'alertes de sécurité sur **${name}** : consultez le salon Sécurité.`,
        embeds: [status.warn('Plus d\'aucun message privé de sécurité pour ce serveur pendant quelques minutes : les alertes continuent d\'arriver dans le salon Sécurité.', 'Trop d\'alertes')],
        allowedMentions: { parse: [] },
      }
      : {
        content: dmContent ?? ({
          lost: `${ICONS.warning} **${label}** sur **${name}** : ni le salon d'alerte ni les logs sécurité n'ont pu la recevoir (salon supprimé, logs coupés ou permissions). Vérifiez /antiraid et /logs.`,
          muted: `${ICONS.warning} **${label}** sur **${name}** : les logs Sécurité sont coupés ou en pause dans /logs (l'alerte a quand même été publiée dans le salon de sécurité).`,
        }[why] ?? `${ICONS.warning} **${label}** sur **${name}**.`),
        embeds: fitEmbeds([embed]),
        allowedMentions: { parse: [] },
      };
    let sent = 0;
    for (const id of recipients) {
      const user = await this.client.users?.fetch?.(id).catch(() => null);
      if (!user || user.bot || typeof user.send !== 'function') continue;
      if (await user.send(payload).then(() => true, () => false)) sent += 1;
    }
    return sent;
  }

  async #systemChannel(guild, embed, dmContent, label) {
    const system = guild.systemChannel;
    if (typeof system?.send !== 'function') return false;
    const me = guild.members?.me;
    if (me && typeof system.permissionsFor === 'function' && !system.permissionsFor(me)?.has(SEND_PERMISSIONS)) return false;
    const name = escapeMarkdown(String(guild.name ?? guild.id)).slice(0, 100);
    return system
      .send({
        content: dmContent ?? `${ICONS.warning} **${label}** sur **${name}** : ni le salon d'alerte ni les logs sécurité n'ont pu la recevoir (salon supprimé, logs coupés ou permissions). Vérifiez /antiraid et /logs.`,
        embeds: fitEmbeds([embed]),
        allowedMentions: { parse: [] },
      })
      .then(() => true, () => false);
  }
}

module.exports = { SecurNotifier, DM_WINDOW_MS, DM_CAP, MAX_DM_RECIPIENTS, PING_COOLDOWN_MS };
