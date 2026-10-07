'use strict';

const {
  AutoModerationRuleEventType: EventType,
  AutoModerationRuleTriggerType: Trigger,
  AutoModerationActionType: ActionType,
  AutoModerationRuleKeywordPresetType: Preset,
  PermissionFlagsBits,
  ChannelType,
} = require('discord.js');
const { UserError } = require('../core/errors');

/**
 * Synchronisation avec l'AutoMod NATIF de Discord : les règles bloquent les
 * messages AVANT leur envoi et fonctionnent même si le bot est hors ligne.
 * Le bot complète ensuite avec ses filtres avancés (arnaques, multi-salons…).
 */
const PREFIX = 'Gadget · ';
const NAMES = {
  keywords: `${PREFIX}Mots interdits`,
  preset: `${PREFIX}Contenu offensant`,
  mentions: `${PREFIX}Mentions massives`,
  spam: `${PREFIX}Spam suspect`,
};
const BLOCK_MESSAGE = 'Message bloqué par l\'AutoMod du serveur.';

/** Mots du bot → mots-clés Discord (≤ 60 caractères, 1000 max, joker « * » conservé). Pur. */
function toKeywords(words = []) {
  return [...new Set(words.map((w) => String(w).trim().toLowerCase()).filter((w) => w && w.length <= 60 && /[\p{L}\p{N}]/u.test(w)))].slice(0, 1000);
}

function actions(logChannelId) {
  const list = [{ type: ActionType.BlockMessage, metadata: { customMessage: BLOCK_MESSAGE } }];
  if (logChannelId) list.push({ type: ActionType.SendAlertMessage, metadata: { channel: logChannelId } });
  return list;
}

/**
 * Règles souhaitées pour une configuration AutoMod. Pur.
 * Seuls les filtres ACTIFS du bot ont leur équivalent natif.
 */
function desiredRules(cfg, logChannelId, guild = null) {
  const f = cfg.filters ?? {};
  // Un rôle ou salon supprimé dans les exemptions ferait refuser TOUTES les règles par Discord.
  const exists = (cache) => (id) => !cache || cache.has(id);
  const exempt = {
    exemptRoles: (cfg.ignoredRoles ?? []).filter(exists(guild?.roles?.cache)).slice(0, 20),
    exemptChannels: (cfg.ignoredChannels ?? []).filter(exists(guild?.channels?.cache)).slice(0, 50),
  };
  const rules = [];
  if (f.badWords?.enabled) {
    const keywords = toKeywords(f.badWords.words);
    if (keywords.length) rules.push({ name: NAMES.keywords, triggerType: Trigger.Keyword, triggerMetadata: { keywordFilter: keywords }, ...exempt });
    rules.push({ name: NAMES.preset, triggerType: Trigger.KeywordPreset, triggerMetadata: { presets: [Preset.Slurs, Preset.SexualContent] }, ...exempt });
  }
  if (f.antiMassMention?.enabled) {
    // Le bot sanctionne à partir de `limit` mentions ; Discord bloque AU-DELÀ de la limite.
    const limit = Math.min(50, Math.max(1, (f.antiMassMention.limit ?? 5) - 1));
    rules.push({ name: NAMES.mentions, triggerType: Trigger.MentionSpam, triggerMetadata: { mentionTotalLimit: limit, mentionRaidProtectionEnabled: true }, ...exempt });
  }
  if (f.antiSpam?.enabled) rules.push({ name: NAMES.spam, triggerType: Trigger.Spam, ...exempt });
  return rules.map((r) => ({ ...r, eventType: EventType.MessageSend, actions: actions(logChannelId), enabled: true }));
}

function assertCanManage(guild) {
  if (!guild.members.me?.permissions.has(PermissionFlagsBits.ManageGuild)) {
    throw new UserError('Il me faut la permission **Gérer le serveur** pour gérer l\'AutoMod de Discord.');
  }
}

/** Règles natives créées par le bot. */
async function ownRules(guild) {
  const rules = await guild.autoModerationRules.fetch();
  return [...rules.values()].filter((r) => r.name.startsWith(PREFIX));
}

/**
 * Crée ou met à jour les règles natives. Une règle refusée par Discord (limite
 * atteinte : 1 règle anti-spam, 1 anti-mentions… par serveur) est signalée, pas bloquante.
 * @returns {Promise<{ created: string[], updated: string[], failed: Array<{ name: string, reason: string }> }>}
 */
async function sync(guild, cfg, logChannelId) {
  assertCanManage(guild);
  // Le salon d'alerte doit être un salon textuel visible par le bot, sinon toutes les règles échouent.
  const logChannel = logChannelId ? guild.channels?.cache?.get(logChannelId) : null;
  const alertChannelId = logChannel && [ChannelType.GuildText, ChannelType.GuildAnnouncement].includes(logChannel.type) ? logChannelId : null;
  const desired = desiredRules(cfg, alertChannelId, guild);
  const existing = await ownRules(guild);
  const result = { created: [], updated: [], removed: [], failed: [] };
  for (const rule of desired) {
    const current = existing.find((r) => r.name === rule.name);
    try {
      if (current) {
        const { triggerType, ...editable } = rule; // le type d'une règle ne peut pas changer
        void triggerType;
        await current.edit(editable);
        result.updated.push(rule.name);
      } else {
        await guild.autoModerationRules.create(rule);
        result.created.push(rule.name);
      }
    } catch (err) {
      const limitReached = /maximum|max.*rules|limit/i.test(err?.message ?? '');
      result.failed.push({ name: rule.name, reason: limitReached ? 'une règle de ce type existe déjà sur le serveur' : err?.message ?? 'erreur inconnue' });
    }
  }
  // Règles du bot devenues inutiles (filtre coupé, liste vidée) : retirées.
  for (const r of existing) {
    if (!desired.some((d) => d.name === r.name)) {
      if (await r.delete().then(() => true, () => false)) result.removed.push(r.name);
    }
  }
  return result;
}

/** Supprime les règles natives créées par le bot. @returns {Promise<number>} */
async function remove(guild) {
  assertCanManage(guild);
  let n = 0;
  for (const r of await ownRules(guild)) n += await r.delete().then(() => 1, () => 0);
  return n;
}

module.exports = { sync, remove, ownRules, desiredRules, toKeywords, NAMES, PREFIX };
