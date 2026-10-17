'use strict';

const { PermissionFlagsBits } = require('discord.js');
const St = require('../structure');

/**
 * Module Secur « emojis et autocollants » (SEC4) : suppression d'emoji (audit 62) et
 * d'autocollant (92). Limite par défaut 3 en 10 s (2 en « max »).
 *
 * Annulation AU MIEUX : ré-upload depuis l'instantané (pris à la suppression, ou dans le cache si
 * l'audit arrive avant l'événement) via discordCdn, chargé paresseusement, 10 au plus par incident ;
 * exige « Gérer les expressions ». Le CDN ne garantit pas l'image d'un objet supprimé : en cas
 * d'échec, ou si CDN_NETWORK=off, sanction seule (l'alerte le dit). Les autocollants Lottie ne
 * sont jamais ré-uploadés.
 */

const REASON = 'Secur : annulation (anti-nuke)';
const EMOJI_MAX_BYTES = 256 * 1024;
const STICKER_MAX_BYTES = 512 * 1024;

function snapshotFor(entry, guild, store, kind) {
  const id = entry.targetId;
  let snap = store.get(guild.id, kind, id);
  if (snap) return snap;
  // Audit reçu AVANT l'événement : l'objet est encore dans le cache.
  const cached = kind === 'emoji' ? guild.emojis?.cache?.get?.(id) : guild.stickers?.cache?.get?.(id);
  if (cached) return store.put(guild.id, kind, id, kind === 'emoji' ? St.captureEmoji(cached) : St.captureSticker(cached));
  // Dernier recours : nom seulement (pas d'image fiable).
  snap = { kind, id, name: St.changeValue(entry, 'name', 'old') ?? null, url: null, roles: [] };
  return snap;
}

/** Synthèse de l'incident : ré-uploads et échecs. */
function summarize(ctx, ok, reason = null) {
  St.noteSummary(ctx, 'expressions', (d) => {
    d.done = (d.done ?? 0) + (ok ? 1 : 0);
    d.failed = (d.failed ?? 0) + (ok ? 0 : 1);
    if (reason) d.reasons = [...new Set([...(d.reasons ?? []), reason])].slice(0, 2);
  }, (d) => `Emojis et autocollants : ${d.done} ré-uploadé(s)${d.failed ? `, ${d.failed} non restauré(s) (${(d.reasons ?? []).join(' ; ') || 'image indisponible'}) — sanction seule pour ceux-là` : ''}.`);
}

const expressions = {
  key: 'expressions',
  auditTypes: [62, 92],
  priority: 5,
  classify(entry, guild, ctx) {
    if (!entry.targetId) return null;
    const kind = entry.action === 62 ? 'emoji' : 'sticker';
    const snap = snapshotFor(entry, guild, St.storeFor(ctx.client), kind);
    return { weight: 1, record: { kind, id: entry.targetId, name: snap.name ?? null, snapshot: snap } };
  },
  async undo(guild, record, ctx) {
    const snap = record?.snapshot;
    if (!snap) return { ok: false };
    const me = guild.members?.me;
    if (me?.permissions && !me.permissions.has(PermissionFlagsBits.ManageGuildExpressions)) {
      summarize(ctx, false, 'il me manque « Gérer les expressions »');
      return { ok: false };
    }
    if (snap.kind === 'emoji' && snap.name && guild.emojis?.cache?.some?.((e) => e.name === snap.name)) return { ok: true }; // déjà remis
    if (snap.kind === 'sticker' && snap.name && guild.stickers?.cache?.some?.((s) => s.name === snap.name)) return { ok: true };
    if (!snap.url || !snap.name) {
      summarize(ctx, false, snap.kind === 'sticker' && snap.format === 3 ? 'autocollant animé Lottie' : 'aucun instantané de l\'image');
      return { ok: false };
    }
    if (!St.takeBudget(ctx, 'expressions', St.MAX_EXPRESSION_UPLOADS)) {
      summarize(ctx, false, `plafond de ${St.MAX_EXPRESSION_UPLOADS} ré-uploads par incident`);
      return { ok: false };
    }
    const image = await St.fetchImageDataUri(snap.url, { maxBytes: snap.kind === 'emoji' ? EMOJI_MAX_BYTES : STICKER_MAX_BYTES });
    if (!image.ok) {
      summarize(ctx, false, image.reason);
      return { ok: false };
    }
    try {
      if (snap.kind === 'emoji') {
        const roles = (snap.roles ?? []).map((id) => St.resolveRoleId(guild, ctx, St.storeFor(ctx.client), id)).filter(Boolean);
        await guild.emojis.create({ attachment: image.data, name: snap.name, ...(roles.length ? { roles } : {}), reason: REASON });
      } else {
        const ext = snap.format === 4 ? 'gif' : 'png';
        await guild.stickers.create({ file: { attachment: image.buffer, name: `${snap.name}.${ext}` }, name: snap.name, tags: snap.tags || '⭐', description: snap.description ?? '', reason: REASON });
      }
    } catch (e) {
      summarize(ctx, false, String(e?.message ?? e).slice(0, 80));
      return { ok: false };
    }
    summarize(ctx, true);
    return { ok: true };
  },
  describe: (record) => `${record?.kind === 'sticker' ? 'Autocollant' : 'Emoji'} supprimé${record?.name ? ` : ${record.name}` : ''}`,
  targetKey: (record) => `${record?.kind ?? 'emoji'}:${record?.name ?? record?.id ?? ''}`,
};

module.exports = expressions;
