'use strict';

const { PermissionFlagsBits, Routes } = require('discord.js');
const St = require('../structure');

/**
 * Module Secur « serveur » (SEC4) : serverUpdate (audit 1).
 *
 *  - Rétablis par PATCH, après relecture de la valeur actuelle (seulement si elle vaut encore la
 *    nouvelle ; un salon disparu est ignoré, un salon recréé est suivi) : nom, description, langue,
 *    barre des boosts, niveau de vérification, notifications par défaut, filtre de contenu, salon
 *    et délai AFK, salon système et ses options, salons des règles, des mises à jour et des alertes.
 *  - Icône, bannière et image d'invitation : rétablies AU MIEUX via discordCdn.fetchDiscordImage
 *    (ancien hash, 8 Mo, hôtes du CDN de Discord uniquement, chargé paresseusement) puis PATCH avec
 *    une data URI. Échec, ou CDN_NETWORK=off : alerte seule (critique §4.14).
 *  - URL personnalisée, niveau A2F, propriétaire, fonctionnalités : alerte seule.
 */

const REASON = 'Secur : annulation (anti-nuke)';

/** Valeur actuelle d'un paramètre du serveur (forme API). */
function guildApiValue(guild, key) {
  switch (key) {
    case 'name': return guild.name;
    case 'description': return guild.description ?? null;
    case 'preferred_locale': return guild.preferredLocale ?? null;
    case 'premium_progress_bar_enabled': return Boolean(guild.premiumProgressBarEnabled);
    case 'verification_level': return guild.verificationLevel;
    case 'default_message_notifications': return guild.defaultMessageNotifications;
    case 'explicit_content_filter': return guild.explicitContentFilter;
    case 'afk_channel_id': return guild.afkChannelId ?? null;
    case 'afk_timeout': return guild.afkTimeout;
    case 'system_channel_id': return guild.systemChannelId ?? null;
    case 'system_channel_flags': return Number(guild.systemChannelFlags?.bitfield ?? 0);
    case 'rules_channel_id': return guild.rulesChannelId ?? null;
    case 'public_updates_channel_id': return guild.publicUpdatesChannelId ?? null;
    case 'safety_alerts_channel_id': return guild.safetyAlertsChannelId ?? null;
    case 'icon': return guild.icon ?? null;
    case 'banner': return guild.banner ?? null;
    case 'splash': return guild.splash ?? null;
    default: return undefined;
  }
}

const label = (key) => St.SERVER_LABELS[key] ?? key;

const serverUpdate = {
  key: 'serverUpdate',
  auditTypes: [1],
  priority: 5,
  classify(entry) {
    const plan = St.planServerRestore(entry.changes);
    if (!plan.restore.length && !plan.images.length && !plan.alertOnly.length) return null;
    return { weight: 1, record: { plan } };
  },
  async undo(guild, record, ctx) {
    const plan = record?.plan;
    if (!plan) return { ok: false };
    const notes = [];
    const body = {};
    const me = guild.members?.me;
    if (me?.permissions && !me.permissions.has(PermissionFlagsBits.ManageGuild)) {
      return { ok: false, note: 'Paramètres du serveur non rétablis : il me manque « Gérer le serveur ».' };
    }
    const store = St.storeFor(ctx.client);
    for (const c of plan.restore) {
      const now = guildApiValue(guild, c.key);
      if (St.sameValue(now, c.old)) continue; // déjà rétabli
      if (!St.sameValue(now, c.new)) {
        notes.push(`${label(c.key)} modifié depuis : laissé tel quel`);
        continue;
      }
      let value = c.old ?? null;
      if (St.SERVER_CHANNEL_KEYS.includes(c.key) && value) {
        value = St.resolveChannelId(guild, ctx, store, value);
        if (!value) {
          notes.push(`${label(c.key)} : l'ancien salon n'existe plus, ignoré`);
          continue;
        }
      }
      body[c.key] = value;
    }
    for (const img of plan.images) {
      const now = guildApiValue(guild, img.field);
      if (St.sameValue(now, img.old)) continue;
      if (!St.sameValue(now, img.new)) {
        notes.push(`${label(img.field)} modifiée depuis : laissée telle quelle`);
        continue;
      }
      if (!img.old) {
        body[img.field] = null; // il n'y en avait pas : retirée
        continue;
      }
      const res = await St.fetchImageDataUri(St.guildImageUrl(guild.id, img.field, img.old));
      if (res.ok) body[img.field] = res.data;
      else notes.push(`${label(img.field)} non rétablie (${res.reason}) : alerte seule, remettez-la à la main`);
    }
    if (plan.alertOnly.length) notes.push(`Alerte seule (un bot ne peut pas les rétablir) : ${[...new Set(plan.alertOnly.map((c) => label(c.key)))].join(', ')}`);
    const keys = Object.keys(body);
    if (keys.length) {
      try {
        await ctx.client.rest.patch(Routes.guild(guild.id), { body, reason: REASON });
      } catch (e) {
        return { ok: false, note: `Paramètres du serveur non rétablis : ${String(e?.message ?? e).slice(0, 120)}.` };
      }
    }
    if (!keys.length && notes.length) return { ok: false, note: `Serveur : ${notes.join(' ; ')}.`.slice(0, 200) };
    St.noteSummary(ctx, 'server', (d) => {
      d.keys = [...new Set([...(d.keys ?? []), ...keys.map((k) => label(k))])];
      d.notes = [...new Set([...(d.notes ?? []), ...notes])].slice(0, 4);
    }, (d) => `Paramètres du serveur rétablis : ${d.keys.join(', ') || 'aucun (déjà rétablis)'}${d.notes.length ? ` — ${d.notes.join(' ; ')}` : ''}.`);
    return { ok: true };
  },
  describe: (record) => `Serveur modifié (${[...(record?.plan?.restore ?? []), ...(record?.plan?.images ?? []), ...(record?.plan?.alertOnly ?? [])].map((c) => label(c.field ?? c.key)).join(', ')})`,
  targetKey: (record) => `server:${[...(record?.plan?.restore ?? []), ...(record?.plan?.images ?? [])].map((c) => c.key).sort().join(',')}`,
};

module.exports = serverUpdate;
