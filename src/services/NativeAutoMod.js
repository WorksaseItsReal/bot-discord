'use strict';

const {
  AutoModerationRuleEventType: EventType,
  AutoModerationRuleTriggerType: Trigger,
  AutoModerationActionType: ActionType,
  AutoModerationRuleKeywordPresetType: Preset,
  PermissionFlagsBits,
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
  return [...new Set(words.map((w) => String(w).trim().toLowerCase()).filter((w) => w && w.length <= 60))].slice(0, 1000);
}

function actions(logChannelId) {
  const list = [{ type: ActionType.BlockMessage, metadata: { customMessage: BLOCK_MESSAGE } }];
  if (logChannelId) list.push({ type: ActionType.SendAlertMessage, metadata: { channel: logChannelId } });
  return list;
}

/** Règles souhaitées pour une configuration AutoMod. Pur. */
function desiredRules(cfg, logChannelId) {
  const exempt = {
    exemptRoles: (cfg.ignoredRoles ?? []).slice(0, 20),
    exemptChannels: (cfg.ignoredChannels ?? []).slice(0, 50),
  };
  const rules = [];
  const keywords = toKeywords(cfg.filters?.badWords?.words);
  if (cfg.filters?.badWords?.enabled && keywords.length) {
    rules.push({ key: 'keywords', name: NAMES.keywords, triggerType: Trigger.Keyword, triggerMetadata: { keywordFilter: keywords }, ...exempt });
  }
  rules.push({
    key: 'preset',
    name: NAMES.preset,
    triggerType: Trigger.KeywordPreset,
    triggerMetadata: { presets: [Preset.Slurs, Preset.SexualContent] },
    ...exempt,
  });
  rules.push({
    key: 'mentions',
    name: NAMES.mentions,
    triggerType: Trigger.MentionSpam,
    triggerMetadata: { mentionTotalLimit: Math.min(50, Math.max(2, cfg.filters?.antiMassMention?.limit ?? 5)), mentionRaidProtectionEnabled: true },
    ...exempt,
  });
  rules.push({ key: 'spam', name: NAMES.spam, triggerType: Trigger.Spam, ...exempt });
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
  const existing = await ownRules(guild);
  const result = { created: [], updated: [], failed: [] };
  for (const rule of desiredRules(cfg, logChannelId)) {
    const { key, ...data } = rule;
    void key;
    const current = existing.find((r) => r.name === rule.name);
    try {
      if (current) {
        const { triggerType, ...editable } = data; // le type d'une règle ne peut pas changer
        void triggerType;
        await current.edit(editable);
        result.updated.push(rule.name);
      } else {
        await guild.autoModerationRules.create(data);
        result.created.push(rule.name);
      }
    } catch (err) {
      result.failed.push({ name: rule.name, reason: err?.code === 30035 || /maximum/i.test(err?.message ?? '') ? 'une règle de ce type existe déjà sur le serveur' : err?.message ?? 'erreur inconnue' });
    }
  }
  // Mots interdits vidés ou filtre coupé : on retire la règle de mots-clés devenue obsolète.
  const stale = existing.find((r) => r.name === NAMES.keywords);
  if (stale && !desiredRules(cfg, logChannelId).some((r) => r.name === NAMES.keywords)) await stale.delete().catch(() => {});
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
