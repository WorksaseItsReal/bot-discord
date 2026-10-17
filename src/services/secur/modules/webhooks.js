'use strict';

const { Routes } = require('discord.js');
const S = require('../../../utils/secur');
const St = require('../structure');

/**
 * Module Secur « webhooks » (SEC4) : création (audit 50), modification (51), suppression (52).
 *
 *  - Création : le webhook est supprimé (DELETE /webhooks/:id). En « on » (ignoreFollowers), les
 *    webhooks de suivi (type 2, salon d'annonces suivi) sont tolérés.
 *  - Modification : comptée en « max » seulement, et le webhook est supprimé.
 *  - Suppression : sanction seule (un webhook supprimé ne se recrée pas à l'identique).
 */

const REASON = 'Secur : annulation (anti-nuke)';
const FOLLOWER = 2;

function webhookType(entry) {
  const side = entry.action === 52 ? 'old' : 'new';
  const raw = St.changeValue(entry, 'type', side) ?? entry.target?.type ?? null;
  return raw == null ? null : Number(raw);
}

const webhook = {
  key: 'webhook',
  auditTypes: [50, 51, 52],
  priority: 3,
  classify(entry, guild, ctx) {
    const id = entry.targetId;
    if (!id) return null;
    const type = webhookType(entry);
    const name = St.changeValue(entry, 'name', entry.action === 52 ? 'old' : 'new') ?? entry.target?.name ?? null;
    if (entry.action === 50) {
      if (type === FOLLOWER && St.isLenient(ctx, 'webhook', 'ignoreFollowers')) return null;
      return { weight: 1, record: { action: 50, webhookId: id, type, name } };
    }
    if (entry.action === 51) {
      if (S.moduleMode(ctx.cfg, 'webhook') !== 'max') return null;
      return { weight: 1, record: { action: 51, webhookId: id, type, name } };
    }
    if (entry.action === 52) return { weight: 1, record: { action: 52, webhookId: id, type, name, sanctionOnly: true } };
    return null;
  },
  async undo(guild, record, ctx) {
    if (!record?.webhookId) return { ok: false };
    if (record.sanctionOnly) {
      St.noteSummary(ctx, 'webhooks', (d) => {
        d.count = (d.count ?? 0) + 1;
      }, (d) => `Webhooks supprimés : ${d.count} — non recréables à l'identique, sanction seule.`);
      return { ok: false };
    }
    try {
      await ctx.client.rest.delete(Routes.webhook(record.webhookId), { reason: REASON });
      return { ok: true };
    } catch (e) {
      if (e?.code === 10015) return { ok: true }; // déjà supprimé
      return { ok: false, note: `Webhook non supprimé : ${String(e?.message ?? e).slice(0, 100)}.` };
    }
  },
  describe: (record) => ({ 50: 'Webhook créé', 51: 'Webhook modifié', 52: 'Webhook supprimé' }[record?.action] ?? 'Webhook'),
  targetKey: (record) => `webhook:${record?.webhookId ?? ''}`,
};

module.exports = webhook;
