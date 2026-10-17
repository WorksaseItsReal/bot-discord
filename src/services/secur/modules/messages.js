'use strict';

const { AuditLogEvent, MessageFlags } = require('discord.js');
const { SECUR_BOUNDS } = require('../../../utils/secur');
const { createLogger } = require('../../../core/logger');

const logger = createLogger('secur:messages');

/**
 * Modules Secur « messages » (SEC5) :
 *  - everyone : mention @everyone / @here d'un auteur non exempté (src/events/securMessages.js →
 *    secur.signal). La sanction du module (« none » par défaut) PRIME : un bot ou un webhook
 *    d'alertes n'est jamais expulsé pour un @everyone. Annulation : suppression du message ; un
 *    webhook qui n'est pas un webhook de suivi est supprimé lui aussi, en max seulement.
 *  - messagePurge : suppression massive de messages (73) d'au moins `minMessages` messages.
 *    Sanction seule (les messages purgés ne reviennent pas).
 */

const SNOWFLAKE = /^\d{17,20}$/;
const clamp = (n, [min, max]) => Math.min(max, Math.max(min, n));

/**
 * Message à signaler au module everyone, ou null s'il est ignoré. Pur.
 * IGNORÉS : hors serveur, sans @everyone/@here effectif, ce bot, messages système, crossposts
 * (salon suivi : MessageFlags.IsCrosspost, publiés par un webhook de suivi).
 * @returns {{ executorId: string, record: object }|null}
 */
function everyoneSignal(message, botId = null) {
  if (!message?.guild?.id && !message?.guildId) return null;
  if (!message.mentions?.everyone) return null;
  if (message.system) return null;
  const authorId = message.author?.id ?? null;
  if (!authorId || (botId && authorId === botId)) return null;
  if (message.flags?.has?.(MessageFlags.IsCrosspost)) return null;
  // Webhook (hors réponse d'interaction d'une application, signée par son bot) : jugé sous son
  // identifiant ; un webhook n'a ni rôle ni niveau, il n'est jamais exempté.
  const webhookId = message.webhookId && !message.interactionMetadata && !message.interaction ? message.webhookId : null;
  return {
    executorId: webhookId ?? authorId,
    record: { channelId: message.channelId, messageId: message.id, webhookId, authorId },
  };
}

/** @everyone d'un message (écouteur messageCreate) : signalé au moteur si le module est actif. */
async function handleMessage(client, message) {
  const guild = message?.guild;
  const secur = client?.services?.secur;
  if (!guild || !secur?.covers?.(guild.id, 'everyone')) return null;
  const hit = everyoneSignal(message, client.user?.id ?? null);
  if (!hit) return null;
  return secur.signal(guild, hit.executorId, 'everyone', hit.record, { at: Number.isFinite(message.createdTimestamp) ? message.createdTimestamp : Date.now() });
}

const everyone = {
  key: 'everyone',
  auditTypes: [],
  priority: 5,
  classify: () => null,
  /** Supprime le message (relu : déjà supprimé → rien) ; en max, supprime aussi le webhook auteur. */
  async undo(guild, record, ctx) {
    if (!record?.channelId || !record?.messageId) return { ok: false, note: 'Message introuvable.' };
    const notes = [];
    let ok = true;
    const channel = guild.channels?.cache?.get?.(record.channelId) ?? (await guild.channels?.fetch?.(record.channelId).catch(() => null)) ?? null;
    if (channel?.messages) {
      const message = await channel.messages.fetch(record.messageId).catch(() => null);
      if (message) {
        try {
          await message.delete();
        } catch (err) {
          if (err?.code !== 10008) {
            ok = false;
            notes.push(`Message @everyone non supprimé (${String(err?.message ?? err).slice(0, 100)}).`);
          }
        }
      }
    }
    if (record.webhookId && SNOWFLAKE.test(String(record.webhookId)) && ctx.moduleCfg?.mode === 'max') {
      try {
        const hook = await ctx.client.fetchWebhook(record.webhookId);
        if (hook && hook.type !== 2) {
          await hook.delete('Secur : @everyone par un webhook (mode max)');
          notes.push(`Webhook \`${record.webhookId}\` supprimé.`);
        }
      } catch (err) {
        if (err?.code !== 10015) {
          logger.debug('Suppression du webhook @everyone :', err?.message);
          notes.push(`Webhook \`${record.webhookId}\` non supprimé (${String(err?.message ?? err).slice(0, 100)}).`);
        }
      }
    }
    return { ok, note: notes.join(' ') || undefined };
  },
  describe: (record) => (record?.channelId ? `@everyone dans <#${record.channelId}>` : '@everyone'),
  targetKey: (record) => (record?.messageId ? `message:${record.messageId}` : null),
};

const messagePurge = {
  key: 'messagePurge',
  auditTypes: [AuditLogEvent.MessageBulkDelete],
  priority: 5,
  /** Une purge compte seulement à partir de `minMessages` messages (20 par défaut). */
  classify(entry, guild, ctx) {
    const count = Number(entry.extra?.count ?? entry.options?.count);
    const rawMin = Number(ctx?.moduleCfg?.minMessages);
    const min = clamp(Number.isInteger(rawMin) ? rawMin : 20, SECUR_BOUNDS.minMessages);
    if (!Number.isFinite(count) || count < min) return null;
    const channelId = entry.extra?.channel?.id ?? entry.options?.channel_id ?? (SNOWFLAKE.test(String(entry.targetId ?? '')) ? entry.targetId : null);
    return { weight: 1, record: { channelId, count: Math.floor(count) } };
  },
  describe: (record) => `Purge de ${record?.count ?? '?'} messages${record?.channelId ? ` dans <#${record.channelId}>` : ''}`,
  targetKey: () => null,
};

module.exports = [everyone, messagePurge];
module.exports.everyoneSignal = everyoneSignal;
module.exports.handleMessage = handleMessage;
