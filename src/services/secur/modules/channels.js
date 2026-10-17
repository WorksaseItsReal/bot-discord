'use strict';

const { PermissionFlagsBits, Routes } = require('discord.js');
const channelRemap = require('../../../utils/channelRemap');
const St = require('../structure');

/**
 * Modules Secur « salons » (SEC4) : channelCreate (audit 10), channelDelete (12) et
 * channelUpdate (11 modification, 13/14/15 surcharges).
 *
 *  - Création : le salon est supprimé (jamais un fil).
 *  - Suppression : recréation depuis l'instantané pris AVANT tout nettoyage (src/events/securStructure.js,
 *    ou cache encore intact si l'audit arrive avant l'événement) : champs, catégorie (recréée d'abord
 *    si elle a été supprimée dans le même incident), surcharges (cibles disparues ignorées), enfants
 *    rattachés (tampon des orphelins), puis channelRemap.restore (configuration et base, messages
 *    épinglés republiés). Jamais recréés : ticket, ModMail, vocal temporaire, compteur, fil, salon
 *    d'entretien, et tout salon dont le type n'est pas déterminable. 50 recréations par incident.
 *  - Modification : PUT exact sur /channels/:id/permissions/:cible (jamais permissionOverwrites.set),
 *    PATCH des anciennes valeurs, seulement si la valeur actuelle est encore la nouvelle. En « on »
 *    (ignoreBenign) : nom, NSFW, type, catégorie, et surcharges qui accordent une permission
 *    DANGEROUS ou retirent un refus Voir/Écrire d'@everyone ; en « max » : tout.
 */

const REASON = 'Secur : annulation (anti-nuke)';

/** Messages épinglés (sticky) supprimés avec le salon : republiés dans le salon recréé. */
async function republishStickies(client, guild, rows, channel) {
  const sticky = client.services?.sticky;
  if (!sticky?.set || !rows?.length) return 0;
  let n = 0;
  for (const row of rows) {
    try {
      await sticky.set({ guildId: guild.id, channel, title: row.title ?? null, content: row.content, threshold: row.threshold, authorId: row.author_id ?? null });
      n += 1;
    } catch {
      /* au mieux : la ligne est déjà réinsérée en base */
    }
  }
  return n;
}

/** Enfants restés orphelins (sortis de la catégorie supprimée) : rattachés à la catégorie recréée. */
async function reattachChildren(guild, snap, newId, store) {
  let n = 0;
  for (const childId of new Set([...(snap.children ?? []), ...store.orphansOf(guild.id, snap.id)])) {
    const child = guild.channels.cache.get(childId);
    if (!child || child.isThread?.() || child.parentId) continue; // supprimé (recréé à part) ou déplacé depuis
    try {
      await child.setParent(newId, { lockPermissions: false, reason: REASON });
      n += 1;
    } catch {
      /* au mieux */
    }
  }
  return n;
}

/**
 * Recrée un salon depuis son instantané. Une catégorie supprimée dans le même incident (même
 * auteur) est recréée d'abord, quel que soit l'ordre des tâches.
 * @returns {Promise<{ ok: boolean, note?: string }>}
 */
async function recreate(guild, snap, ctx, store, executorId) {
  const label = `#${snap.name ?? snap.id}`;
  const already = ctx.idMap?.get(snap.id);
  if (already && guild.channels.cache.has(already)) return { ok: true };
  // Déjà recréé hors de cet incident (restauration /backup, incident précédent), suivi par
  // l'identifiant d'origine (jamais par le nom) : configuration rebranchée sur cette copie.
  const twin = store.remapOf(guild.id, snap.id);
  if (twin && guild.channels.cache.has(twin)) {
    ctx.idMap?.set(snap.id, twin);
    if (snap.bundle) {
      try {
        channelRemap.restore(snap.bundle, twin);
        St.replugConfig(ctx.client?.services?.config, guild.id, snap.bundle.configPaths, snap.id, twin);
      } catch {
        /* au mieux */
      }
    }
    St.noteSummary(ctx, 'channels:twin', (d) => {
      d.count = (d.count ?? 0) + 1;
    }, (d) => `Salons déjà restaurés (par /backup) : ${d.count} — configuration rebranchée sur ces copies, aucun doublon créé.`);
    return { ok: true };
  }
  if (snap.kind !== 'normal') {
    const why = snap.kind ? `c'était un ${St.KIND_LABELS[snap.kind] ?? snap.kind}` : 'son type (ticket, ModMail…) n\'a pas pu être déterminé';
    return { ok: false, note: `Salon ${label} jamais recréé : ${why}.` };
  }
  const me = guild.members?.me;
  if (me?.permissions && !me.permissions.has(PermissionFlagsBits.ManageChannels)) return { ok: false, note: `Salon ${label} non recréé : il me manque « Gérer les salons ».` };
  if (!St.takeBudget(ctx, 'channels', St.MAX_CHANNEL_RECREATIONS)) return { ok: false, note: `Plafond de ${St.MAX_CHANNEL_RECREATIONS} recréations de salons atteint pour cet incident : restaurez le reste avec /backup.` };

  // Catégorie : celle de l'instantané, ou celle qu'il venait de perdre (catégorie supprimée juste avant).
  const parentRef = snap.type === 4 ? null : snap.parentId ?? store.orphanParentOf(guild.id, snap.id);
  let parentId = null;
  if (parentRef) {
    parentId = St.resolveChannelId(guild, ctx, store, parentRef);
    if (!parentId) {
      const parent = store.get(guild.id, 'channel', parentRef);
      if (parent && parent.type === 4 && executorId && store.deletedBy(guild.id, parentRef) === executorId) {
        const res = await recreate(guild, parent, ctx, store, executorId);
        if (res.ok) parentId = St.resolveChannelId(guild, ctx, store, parentRef);
      }
    }
  }
  const mask = St.botMask(guild);
  // Surcharges membre : jamais rendues à l'auteur d'un incident à sanctionner (sanction défaite).
  const memberTarget = (id) => (St.sanctionedIncidentOf(ctx, guild.id, id) ? null : guild.members?.cache?.has?.(id) || guild.client?.users?.cache?.has?.(id) ? id : null);
  const overwrites = St.mapOverwrites(snap.overwrites, (id, type) => (type === 0 ? St.resolveRoleId(guild, ctx, store, id) : memberTarget(id)), mask);
  const options = St.buildChannelCreate(snap, {
    community: Boolean(guild.features?.includes?.('COMMUNITY')),
    maximumBitrate: guild.maximumBitrate ?? 96_000,
    parentId,
    overwrites,
    reason: REASON,
  });
  let created;
  try {
    created = await guild.channels.create(options);
  } catch (e) {
    return { ok: false, note: `Salon ${label} non recréé : ${String(e?.message ?? e).slice(0, 120)}.` };
  }
  ctx.idMap?.set(snap.id, created.id);
  store.setRemap(guild.id, snap.id, created.id);

  // Configuration et base (channelRemap), salons de logs débranchés rebranchés, épinglés republiés.
  let losses = '';
  if (snap.bundle) {
    try {
      channelRemap.restore(snap.bundle, created.id);
      St.replugConfig(ctx.client?.services?.config, guild.id, snap.bundle.configPaths, snap.id, created.id);
      await republishStickies(ctx.client, guild, snap.bundle.rows?.['sticky_messages.channel_id'], created);
      losses = channelRemap.lossSummary(snap.bundle);
    } catch (e) {
      losses = `report de configuration incomplet (${String(e?.message ?? e).slice(0, 80)})`;
    }
  }
  const reattached = snap.type === 4 ? await reattachChildren(guild, snap, created.id, store) : 0;
  St.noteSummary(ctx, 'channels', (d) => {
    d.count = (d.count ?? 0) + 1;
    d.children = (d.children ?? 0) + reattached;
    if (losses) d.losses = [...new Set([...(d.losses ?? []), losses])].slice(0, 3);
  }, (d) => `Salons recréés : ${d.count}${d.children ? ` (${d.children} salon(s) rattaché(s) à leur catégorie)` : ''} — nouveaux identifiants : messages, fils et liens perdus${d.losses?.length ? ` ; ${d.losses.join(' ; ')}` : ''}.`);
  return { ok: true };
}

/* -------------------------------------------------------------------- */
/* channelUpdate : surcharges et champs                                   */
/* -------------------------------------------------------------------- */

/** Type de cible d'une surcharge (audit 13/14/15) : 0 rôle, 1 membre. */
function overwriteType(entry, guild, targetId) {
  const fromChanges = St.changeValue(entry, 'type', entry.action === 15 ? 'old' : 'new');
  if (fromChanges != null) return Number(fromChanges);
  if (entry.extra?.type != null) return Number(entry.extra.type);
  return targetId === guild.id || guild.roles?.cache?.has?.(targetId) ? 0 : 1;
}

/** Avant / après d'une surcharge (audit 13 création, 14 modification, 15 suppression). */
function overwriteRecord(entry, guild) {
  const channelId = entry.targetId;
  const targetId = entry.extra?.id ?? St.changeValue(entry, 'id', entry.action === 15 ? 'old' : 'new');
  if (!channelId || !targetId) return null;
  const current = guild.channels?.cache?.get?.(channelId)?.permissionOverwrites?.cache?.get?.(targetId);
  const cur = { allow: St.toBig(current?.allow).toString(), deny: St.toBig(current?.deny).toString() };
  const get = (key, side) => {
    const v = St.changeValue(entry, key, side);
    return v == null ? null : String(v);
  };
  let before = null;
  let after = null;
  if (entry.action === 13) after = { allow: get('allow', 'new') ?? '0', deny: get('deny', 'new') ?? '0' };
  else if (entry.action === 15) before = { allow: get('allow', 'old') ?? '0', deny: get('deny', 'old') ?? '0' };
  else {
    after = { allow: get('allow', 'new') ?? cur.allow, deny: get('deny', 'new') ?? cur.deny };
    before = { allow: get('allow', 'old') ?? after.allow, deny: get('deny', 'old') ?? after.deny };
  }
  return { channelId, targetId, targetType: overwriteType(entry, guild, targetId), isEveryone: targetId === guild.id, before, after };
}

/** Valeur actuelle d'une clé de salon (forme API), undefined si non comparable. */
function channelApiValue(ch, key) {
  switch (key) {
    case 'name': return ch.name;
    case 'topic': return ch.topic ?? null;
    case 'nsfw': return Boolean(ch.nsfw);
    case 'rate_limit_per_user': return ch.rateLimitPerUser ?? 0;
    case 'bitrate': return ch.bitrate ?? null;
    case 'user_limit': return ch.userLimit ?? null;
    case 'type': return ch.type;
    case 'parent_id': return ch.parentId ?? null;
    case 'rtc_region': return ch.rtcRegion ?? null;
    case 'video_quality_mode': return ch.videoQualityMode ?? null;
    case 'default_auto_archive_duration': return ch.defaultAutoArchiveDuration ?? null;
    case 'default_thread_rate_limit_per_user': return ch.defaultThreadRateLimitPerUser ?? null;
    case 'default_sort_order': return ch.defaultSortOrder ?? null;
    case 'default_forum_layout': return ch.defaultForumLayout ?? null;
    case 'flags': return ch.flags?.bitfield ?? 0;
    default: return undefined;
  }
}

async function undoOverwrite(guild, record, ctx) {
  const cached = guild.channels?.cache?.get?.(record.channelId);
  if (!cached) return { ok: false, note: 'Surcharge non rétablie : le salon n\'existe plus.' };
  // Relecture forcée : après un PUT précédent du bot, le cache n'est pas encore à jour.
  const channel = (typeof guild.channels.fetch === 'function' ? await guild.channels.fetch(cached.id, { force: true }).catch(() => null) : null) ?? cached;
  const current = channel.permissionOverwrites?.cache?.get?.(record.targetId) ?? null;
  // En bits, sur l'état relu : ce que CETTE modification a accordé est retiré, ce qu'elle a retiré
  // est rendu, le reste (retouche suivante, autre auteur) est laissé.
  const big = (o) => ({ allow: St.toBig(o?.allow), deny: St.toBig(o?.deny) });
  const now = big(current);
  const before = big(record.before);
  const after = big(record.after);
  const next = {
    allow: (now.allow & ~(after.allow & ~before.allow)) | (before.allow & ~after.allow),
    deny: (now.deny & ~(after.deny & ~before.deny)) | (before.deny & ~after.deny),
  };
  const remove = !record.before && next.allow === 0n && next.deny === 0n;
  if (remove ? !current : current && next.allow === now.allow && next.deny === now.deny) return { ok: true }; // déjà rétablie
  const route = Routes.channelPermission(channel.id, record.targetId);
  try {
    if (remove) await ctx.client.rest.delete(route, { reason: REASON });
    else {
      if (record.targetType === 0 && !St.resolveRoleId(guild, ctx, St.storeFor(ctx.client), record.targetId)) return { ok: false, note: `Surcharge de #${channel.name} non rétablie : le rôle n'existe plus.` };
      await ctx.client.rest.put(route, { body: { type: record.targetType, allow: next.allow.toString(), deny: next.deny.toString() }, reason: REASON });
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, note: `Surcharge de #${channel.name} non rétablie : ${String(e?.message ?? e).slice(0, 100)}.` };
  }
}

async function undoFields(guild, record, ctx) {
  const channel = guild.channels?.cache?.get?.(record.channelId);
  if (!channel) return { ok: false, note: 'Modification non annulée : le salon n\'existe plus.' };
  const store = St.storeFor(ctx.client);
  const body = {};
  const skipped = [];
  const changed = [];
  for (const c of record.changes ?? []) {
    if (!St.CHANNEL_RESTORABLE.includes(c.key)) {
      skipped.push(c.key);
      continue;
    }
    const now = channelApiValue(channel, c.key);
    if (St.sameValue(now, c.old)) continue; // déjà rétabli
    // Valeur due à une modification suivante du même auteur (chaîne) : l'origine est rétablie.
    if (!St.chainMatches(store, guild.id, `channel:${channel.id}`, c, now)) {
      changed.push(c.key);
      continue;
    }
    let value = c.old ?? null;
    if (c.key === 'parent_id' && value) {
      value = St.resolveChannelId(guild, ctx, store, value);
      if (!value) {
        skipped.push('catégorie disparue');
        continue;
      }
    }
    body[c.key] = value;
  }
  if (Object.keys(body).length) {
    try {
      await ctx.client.rest.patch(Routes.channel(channel.id), { body, reason: REASON });
    } catch (e) {
      return { ok: false, note: `#${channel.name} non rétabli : ${String(e?.message ?? e).slice(0, 100)}.` };
    }
  }
  if (skipped.length) St.noteSummary(ctx, `channel:${channel.id}`, () => {}, () => `#${channel.name} : non rétabli automatiquement (${[...new Set(skipped)].join(', ')}).`);
  // Modifié depuis par quelqu'un d'autre : laissé tel quel, compté comme non annulé.
  if (changed.length) return { ok: false, note: `#${channel.name} : ${[...new Set(changed)].join(', ')} modifié depuis par quelqu'un d'autre, laissé tel quel.` };
  return { ok: true };
}

/* -------------------------------------------------------------------- */
/* Modules                                                                */
/* -------------------------------------------------------------------- */

const channelCreate = {
  key: 'channelCreate',
  auditTypes: [10],
  priority: 3,
  classify(entry, guild) {
    const id = entry.targetId;
    if (!id) return null;
    const channel = guild.channels?.cache?.get?.(id);
    if (channel?.isThread?.()) return null;
    return { weight: 1, record: { channelId: id, name: channel?.name ?? St.changeValue(entry, 'name') ?? null } };
  },
  async undo(guild, record) {
    const id = record?.channelId ?? record?.targetId;
    const channel = id ? guild.channels?.cache?.get?.(id) : null;
    if (!channel) return { ok: true }; // déjà supprimé
    if (channel.isThread?.()) return { ok: false, note: 'Un fil n\'est jamais supprimé par Secur.' };
    try {
      await channel.delete(REASON);
      return { ok: true };
    } catch (e) {
      if (e?.code === 10003) return { ok: true };
      return { ok: false, note: `Salon #${channel.name} non supprimé : ${String(e?.message ?? e).slice(0, 100)}.` };
    }
  },
  describe: (record) => `Salon créé${record?.name ? ` : #${record.name}` : ''}`,
  targetKey: (record) => `create:${record?.channelId ?? record?.targetId ?? ''}`,
};

const channelDelete = {
  key: 'channelDelete',
  auditTypes: [12],
  priority: 3,
  classify(entry, guild, ctx) {
    const id = entry.targetId;
    if (!id) return null;
    const store = St.storeFor(ctx.client);
    let snap = store.get(guild.id, 'channel', id);
    if (!snap) {
      // Audit reçu AVANT l'événement : le cache et la base sont encore intacts.
      const channel = guild.channels?.cache?.get?.(id);
      if (channel && !channel.isThread?.()) snap = store.put(guild.id, 'channel', id, St.captureChannel(ctx.client, channel));
    }
    if (!snap) snap = St.channelFromChanges(entry); // dernier recours : jamais recréé
    if (entry.executorId) store.markDeleted(guild.id, id, entry.executorId);
    return { weight: 1, record: { channelId: id, originId: store.originOf(guild.id, id), name: snap.name ?? null, type: snap.type ?? null, executorId: entry.executorId ?? null, snapshot: snap } };
  },
  async undo(guild, record, ctx) {
    const store = St.storeFor(ctx.client);
    const id = record?.channelId ?? record?.targetId;
    const snap = record?.snapshot ?? (id ? store.get(guild.id, 'channel', id) : null);
    if (!snap) return { ok: false, note: 'Salon supprimé sans instantané : non recréé.' };
    return recreate(guild, snap, ctx, store, record.executorId ?? null);
  },
  describe: (record) => `Salon supprimé${record?.name ? ` : #${record.name}` : ''}`,
  // Par identifiant d'ORIGINE (suivi à travers les recréations) : un autre bot qui supprime en boucle
  // le salon recréé déclenche le disjoncteur, mais trois homonymes supprimés par un nuke restent
  // trois objets distincts.
  targetKey: (record) => `delete:${record?.originId ?? record?.channelId ?? record?.targetId ?? ''}`,
};

const channelUpdate = {
  key: 'channelUpdate',
  auditTypes: [11, 13, 14, 15],
  priority: 4,
  classify(entry, guild, ctx) {
    const lenient = St.isLenient(ctx, 'channelUpdate', 'ignoreBenign');
    const channel = guild.channels?.cache?.get?.(entry.targetId);
    if (channel?.isThread?.()) return null;
    if (entry.action === 11) {
      const filtered = St.filterChannelChanges(entry.changes, { lenient });
      if (!filtered.length) return null;
      // Modifications successives du même champ par le même auteur : old ← valeur d'origine.
      const changes = St.chainChanges(St.storeFor(ctx.client), guild.id, `channel:${entry.targetId}`, entry.executorId, filtered);
      return { weight: 1, record: { action: 11, channelId: entry.targetId, name: channel?.name ?? null, changes } };
    }
    const ow = overwriteRecord(entry, guild);
    if (!ow) return null;
    if (lenient && !St.overwriteRisk(ow)) return null;
    return { weight: 1, record: { action: entry.action, name: channel?.name ?? null, ...ow } };
  },
  async undo(guild, record, ctx) {
    if (!record?.channelId) return { ok: false };
    return record.action === 11 ? undoFields(guild, record, ctx) : undoOverwrite(guild, record, ctx);
  },
  describe: (record) => (record?.action === 11 ? `Salon modifié${record?.name ? ` : #${record.name}` : ''}` : `Surcharge modifiée${record?.name ? ` sur #${record.name}` : ''}`),
  targetKey: (record) => `${record?.channelId ?? ''}:${record?.action === 11 ? (record.changes ?? []).map((c) => c.key).sort().join(',') : record?.targetId ?? ''}`,
};

module.exports = [channelCreate, channelDelete, channelUpdate];
