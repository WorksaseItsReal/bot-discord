'use strict';

const { PermissionFlagsBits, Routes } = require('discord.js');
const { applyRoles } = require('../../../utils/memberRoles');
const channelRemap = require('../../../utils/channelRemap');
const S = require('../../../utils/secur');
const St = require('../structure');

/**
 * Modules Secur « rôles » (SEC4) : roleCreate (30), roleDelete (32), roleUpdate (31), roleAdd et
 * roleRemove (25 $add / $remove).
 *
 *  - Création : le rôle est supprimé (rôles gérés ignorés).
 *  - Suppression : recréation depuis l'instantané (nom, couleurs, séparé, mentionnable ; permissions
 *    limitées à celles du bot s'il n'est pas Administrateur ; emoji Unicode si ROLE_ICONS ; position
 *    sous le bot), puis membres (250 au plus, applyRoles), surcharges (PUT exact) et références de
 *    configuration. JAMAIS recréés (critique §4.11) : rôles gérés (bot, intégration, booster), rôles
 *    d'abonnement ou liés, et tout rôle sans instantané. Un rôle géré supprimé (bot expulsé) n'est
 *    même pas compté.
 *  - Modification : retour aux anciennes valeurs si la valeur actuelle est encore la nouvelle. En
 *    « on » (dangerousOnly) : seulement si les permissions gagnent un bit DANGEROUS. Rôle au niveau
 *    du bot ou au-dessus, ou rôle géré : « non annulable », mais compté (alerte et sanction).
 *    Permissions retirées au rôle géré du bot : compté d'emblée au seuil.
 *  - roleAdd : rôle sensible donné → retiré à la cible. Prédicat isSensitiveRole de SEC1, JAMAIS
 *    hasForbiddenPermissions ; un rôle de whitelist sans permission dangereuse relève des accès en
 *    attente de SEC1 (pas de double traitement).
 *  - roleRemove : rôles sensibles retirés à des TIERS (dérank du staff) → rendus. Rôles retirés AU
 *    BOT : compté d'emblée au seuil (alerte prioritaire avec ping, sanction).
 */

const REASON = 'Secur : annulation (anti-nuke)';

const levelOpts = (ctx) => {
  const permissions = ctx?.client?.services?.permissions;
  return typeof permissions?.levelOf === 'function' ? { levelOf: (guildId, roleId) => permissions.levelOf(guildId, roleId) } : {};
};

/** Identifiants des rôles d'une entrée 25 ($add ou $remove). Pur. */
function changedRoles(entry, key) {
  return [...new Set((entry?.changes ?? []).filter((c) => c?.key === key).flatMap((c) => (Array.isArray(c.new) ? c.new : [])).map((r) => r?.id).filter(Boolean))];
}

/** Valeur actuelle d'une clé de rôle (forme API). */
function roleApiValue(role, key) {
  switch (key) {
    case 'name': return role.name;
    case 'permissions': return St.toBig(role.permissions).toString();
    case 'color': return role.color ?? role.colors?.primaryColor ?? 0; // champ d'API « color » (déprécié mais encore renvoyé)
    case 'colors': return { primary_color: role.colors?.primaryColor ?? 0, secondary_color: role.colors?.secondaryColor ?? null, tertiary_color: role.colors?.tertiaryColor ?? null };
    case 'hoist': return Boolean(role.hoist);
    case 'mentionable': return Boolean(role.mentionable);
    case 'unicode_emoji': return role.unicodeEmoji ?? null;
    default: return undefined;
  }
}

/** Rôle relu chez Discord (le PATCH précédent du bot n'est pas encore dans le cache), ou celui du cache. */
async function freshRole(guild, role) {
  if (typeof guild.roles?.fetch !== 'function') return role;
  return (await guild.roles.fetch(role.id, { force: true }).catch(() => null)) ?? role;
}

/** Le rôle est-il modifiable par le bot (sous son rôle le plus haut, non géré) ? */
function editable(guild, role) {
  if (!role || role.managed) return false;
  if (typeof role.editable === 'boolean') return role.editable;
  const me = guild.members?.me;
  return Boolean(me?.permissions?.has?.(PermissionFlagsBits.ManageRoles) && me.roles?.highest && me.roles.highest.comparePositionTo(role) > 0);
}

/* -------------------------------------------------------------------- */
/* Recréation                                                             */
/* -------------------------------------------------------------------- */

async function recreate(guild, snap, ctx, store) {
  const label = `@${snap.name ?? snap.id}`;
  const already = ctx.idMap?.get(snap.id);
  if (already && guild.roles.cache.has(already)) return { ok: true };
  // Déjà recréé hors de cet incident (restauration /backup), suivi par l'identifiant d'origine
  // (jamais par le nom) : cette copie reçoit membres, surcharges et références, sans doublon.
  const twinId = store.remapOf(guild.id, snap.id);
  const twin = twinId ? guild.roles.cache.get(twinId) ?? null : null;
  const protectedKind = St.protectedRoleKind(snap);
  if (protectedKind) return { ok: false, note: `Rôle ${label} jamais recréé : ${protectedKind === 'managed' ? 'rôle géré (bot, intégration ou booster)' : 'rôle d\'abonnement ou lié'}.` };
  if (snap.source !== 'cache') return { ok: false, note: `Rôle ${label} jamais recréé : aucun instantané fiable.` };
  const me = guild.members?.me;
  if (!me?.permissions?.has?.(PermissionFlagsBits.ManageRoles)) return { ok: false, note: `Rôle ${label} non recréé : il me manque « Gérer les rôles ».` };
  if (!twin && !St.takeBudget(ctx, 'roles', St.MAX_ROLE_RECREATIONS)) return { ok: false, note: `Plafond de ${St.MAX_ROLE_RECREATIONS} recréations de rôles atteint pour cet incident : restaurez le reste avec /backup.` };
  const botAdmin = me.permissions.has(PermissionFlagsBits.Administrator);
  const options = St.buildRoleCreate(snap, {
    botAdmin,
    botPermissions: St.toBig(me.permissions),
    roleIcons: Boolean(guild.features?.includes?.('ROLE_ICONS')),
    enhancedColors: Boolean(guild.features?.includes?.('ENHANCED_ROLE_COLORS')),
    maxPosition: (me.roles?.highest?.position ?? 1) - 1,
    reason: REASON,
  });
  let role = twin;
  if (!role) {
    try {
      role = await guild.roles.create(options);
    } catch (e) {
      return { ok: false, note: `Rôle ${label} non recréé : ${String(e?.message ?? e).slice(0, 120)}.` };
    }
  }
  ctx.idMap?.set(snap.id, role.id);
  store.setRemap(guild.id, snap.id, role.id);

  // Membres (cache, 250 au plus, un par un).
  let members = 0;
  for (const id of (snap.members ?? []).slice(0, St.MAX_ROLE_MEMBERS_RESTORED)) {
    const member = guild.members.cache.get(id);
    if (!member || member.roles.cache.has(role.id)) continue;
    const res = await applyRoles(member, { add: [role.id] }, REASON);
    if (res.added.length) members += 1;
  }
  // Surcharges : PUT exact sur chaque salon (recréé ou non), cibles disparues ignorées.
  const mask = botAdmin ? null : St.toBig(me.permissions);
  let overwrites = 0;
  for (const o of snap.overwrites ?? []) {
    const channelId = St.resolveChannelId(guild, ctx, store, o.channelId);
    if (!channelId) continue;
    const allow = mask == null ? St.toBig(o.allow) : St.toBig(o.allow) & mask;
    const deny = mask == null ? St.toBig(o.deny) : St.toBig(o.deny) & mask;
    try {
      await ctx.client.rest.put(Routes.channelPermission(channelId, role.id), { body: { type: 0, allow: allow.toString(), deny: deny.toString() }, reason: REASON });
      overwrites += 1;
    } catch {
      /* au mieux */
    }
  }
  // Références de configuration (remplacement profond des valeurs exactement égales).
  let configRefs = 0;
  try {
    const config = ctx.client?.services?.config;
    const stored = St.storedConfig(config, guild.id) ?? {};
    const paths = [...new Set([...(snap.configPaths ?? []), ...channelRemap.findPaths(stored, snap.id)])];
    configRefs = St.replugConfig(config, guild.id, paths, snap.id, role.id, { nulls: false }).length;
  } catch {
    /* au mieux */
  }
  St.noteSummary(ctx, 'roles', (d) => {
    d.count = (d.count ?? 0) + 1;
    d.members = (d.members ?? 0) + members;
    d.total = (d.total ?? 0) + (snap.members?.length ?? 0);
    d.overwrites = (d.overwrites ?? 0) + overwrites;
    d.refs = (d.refs ?? 0) + configRefs;
    d.lost = (d.lost ?? 0) + (!twin && !botAdmin && St.toBig(snap.permissions) !== options.permissions ? 1 : 0);
  }, (d) => `Rôles recréés : ${d.count} (membres rendus : ${d.members}/${d.total}${d.total > St.MAX_ROLE_MEMBERS_RESTORED ? `, ${St.MAX_ROLE_MEMBERS_RESTORED} au plus par rôle` : ''} ; surcharges : ${d.overwrites} ; références de configuration : ${d.refs})${d.lost ? ` — ${d.lost} rôle(s) recréé(s) avec moins de permissions (je ne peux pas donner celles que je n'ai pas)` : ''}.`);
  return { ok: true };
}

/* -------------------------------------------------------------------- */
/* Modules                                                                */
/* -------------------------------------------------------------------- */

const roleCreate = {
  key: 'roleCreate',
  auditTypes: [30],
  priority: 1,
  classify(entry, guild) {
    const id = entry.targetId;
    if (!id) return null;
    const role = guild.roles?.cache?.get?.(id);
    if (role?.managed || role?.tags?.botId || role?.tags?.integrationId) return null;
    if (!role && St.changeValue(entry, 'managed') === true) return null;
    return { weight: 1, record: { roleId: id, name: role?.name ?? St.changeValue(entry, 'name') ?? null } };
  },
  async undo(guild, record) {
    const role = guild.roles?.cache?.get?.(record?.roleId ?? record?.targetId);
    if (!role) return { ok: true }; // déjà supprimé
    if (role.managed) return { ok: false, note: `Rôle @${role.name} géré : jamais supprimé par Secur.` };
    if (!editable(guild, role)) return { ok: false, note: `Rôle @${role.name} non supprimé : il est au-dessus de moi.` };
    try {
      await role.delete(REASON);
      return { ok: true };
    } catch (e) {
      if (e?.code === 10011) return { ok: true };
      return { ok: false, note: `Rôle @${role.name} non supprimé : ${String(e?.message ?? e).slice(0, 100)}.` };
    }
  },
  describe: (record) => `Rôle créé${record?.name ? ` : @${record.name}` : ''}`,
  targetKey: (record) => `create:${record?.roleId ?? record?.targetId ?? ''}`,
};

const roleDelete = {
  key: 'roleDelete',
  auditTypes: [32],
  priority: 1,
  classify(entry, guild, ctx) {
    const id = entry.targetId;
    if (!id) return null;
    const store = St.storeFor(ctx.client);
    let snap = store.get(guild.id, 'role', id);
    if (!snap) {
      // Audit reçu AVANT l'événement : rôle, membres et surcharges encore dans le cache.
      const role = guild.roles?.cache?.get?.(id);
      if (role) snap = store.put(guild.id, 'role', id, St.captureRole(ctx.client, role, store));
    }
    // Rôle géré (bot expulsé, intégration retirée, booster) : action de Discord, jamais comptée.
    if (St.protectedRoleKind(snap) === 'managed') return null;
    if (!snap && St.changeValue(entry, 'managed', 'old') === true) return null;
    return { weight: 1, record: { roleId: id, originId: store.originOf(guild.id, id), name: snap?.name ?? St.changeValue(entry, 'name', 'old') ?? null, snapshot: snap ?? null } };
  },
  async undo(guild, record, ctx) {
    const store = St.storeFor(ctx.client);
    const id = record?.roleId ?? record?.targetId;
    const snap = record?.snapshot ?? (id ? store.get(guild.id, 'role', id) : null);
    if (!snap) return { ok: false, note: `Rôle ${record?.name ? `@${record.name} ` : ''}jamais recréé : aucun instantané.` };
    return recreate(guild, snap, ctx, store);
  },
  describe: (record) => `Rôle supprimé${record?.name ? ` : @${record.name}` : ''}`,
  // Par identifiant d'ORIGINE (suivi à travers les recréations, disjoncteur contre un autre bot) :
  // des rôles homonymes (séparateurs) restent des objets distincts.
  targetKey: (record) => `delete:${record?.originId ?? record?.roleId ?? record?.targetId ?? ''}`,
};

const roleUpdate = {
  key: 'roleUpdate',
  auditTypes: [31],
  priority: 1,
  classify(entry, guild, ctx) {
    const id = entry.targetId;
    if (!id) return null;
    const role = guild.roles?.cache?.get?.(id) ?? null;
    const botId = ctx.client?.user?.id;
    const perms = (entry.changes ?? []).find((c) => c?.key === 'permissions');
    // Rôle géré du bot privé de permissions : on ne peut pas l'annuler (hiérarchie), mais l'auteur
    // est sanctionné tout de suite.
    if (botId && role?.tags?.botId === botId) {
      if (perms && St.gainedBits(perms.new, perms.old) !== 0n) {
        return { weight: S.effectiveLimit(ctx.cfg, 'roleUpdate'), record: { roleId: id, name: role.name, changes: [perms], botRole: true, noUndo: true } };
      }
      return null; // permissions DONNÉES à ce bot (réglage par un admin) : jamais comptées
    }
    const filtered = St.filterRoleChanges(entry.changes, { lenient: St.isLenient(ctx, 'roleUpdate', 'dangerousOnly') });
    if (!filtered.length) return null;
    // Modifications successives du même champ par le même auteur : old ← valeur d'origine.
    const changes = St.chainChanges(St.storeFor(ctx.client), guild.id, `role:${id}`, entry.executorId, filtered);
    const noUndo = Boolean(role && (role.managed || !editable(guild, role)));
    return { weight: 1, record: { roleId: id, name: role?.name ?? null, changes, noUndo } };
  },
  async undo(guild, record, ctx) {
    if (!record?.roleId) return { ok: false }; // action faite via le bot (reportBotAction) : rien à relire
    const role = guild.roles.cache.get(record.roleId);
    const label = `@${role?.name ?? record?.name ?? record?.roleId}`;
    if (!role) return { ok: false, note: `Rôle ${label} : il n'existe plus.` };
    if (record.noUndo || !editable(guild, role)) {
      return { ok: false, note: record.botRole ? `Permissions retirées à mon rôle ${label} : non annulable (je ne peux pas modifier mon propre rôle). Rendez-les à la main.` : `Rôle ${label} : non annulable (rôle géré, ou au niveau du mien ou au-dessus).` };
    }
    const store = St.storeFor(ctx.client);
    const current = (record.changes ?? []).some((c) => St.ROLE_RESTORABLE.includes(c.key)) ? await freshRole(guild, role) : role;
    const body = {};
    const skipped = [];
    const changed = [];
    for (const c of record.changes ?? []) {
      if (!St.ROLE_RESTORABLE.includes(c.key)) {
        skipped.push(c.key === 'icon_hash' || c.key === 'icon' ? 'icône' : c.key);
        continue;
      }
      if (c.key === 'permissions') {
        // En bits, sur l'état relu : les bits gagnés par cette modification sont retirés, ceux
        // qu'elle a retirés sont rendus, le reste est laissé (deux PATCH successifs, file occupée).
        const now = St.toBig(current.permissions);
        const next = (now & ~St.gainedBits(c.old, c.new)) | St.gainedBits(c.new, c.old);
        if (next !== now) body.permissions = next.toString();
        continue;
      }
      const now = roleApiValue(current, c.key);
      if (St.sameValue(now, c.old)) continue; // déjà rétabli
      if (!St.chainMatches(store, guild.id, `role:${role.id}`, c, now)) {
        changed.push(c.key);
        continue;
      }
      body[c.key] = c.old ?? null;
    }
    if (Object.keys(body).length) {
      try {
        await ctx.client.rest.patch(Routes.guildRole(guild.id, role.id), { body, reason: REASON });
      } catch (e) {
        return { ok: false, note: `Rôle ${label} non rétabli : ${String(e?.message ?? e).slice(0, 100)}.` };
      }
    }
    if (skipped.length) St.noteSummary(ctx, `role:${role.id}`, () => {}, () => `Rôle ${label} : non rétabli automatiquement (${[...new Set(skipped)].join(', ')}).`);
    // Modifié depuis par quelqu'un d'autre : laissé tel quel, compté comme non annulé.
    if (changed.length) return { ok: false, note: `Rôle ${label} : ${[...new Set(changed)].join(', ')} modifié depuis par quelqu'un d'autre, laissé tel quel.` };
    return { ok: true };
  },
  describe: (record) => `Rôle modifié${record?.name ? ` : @${record.name}` : ''}`,
  targetKey: (record) => `update:${record?.roleId ?? ''}`,
};

const roleAdd = {
  key: 'roleAdd',
  auditTypes: [25],
  priority: 5,
  classify(entry, guild, ctx) {
    const targetId = entry.targetId;
    if (!targetId || targetId === guild.ownerId || targetId === ctx.client?.user?.id) return null;
    // Un rôle de whitelist sans permission dangereuse relève des accès en attente de SEC1.
    const cfg = { ...ctx.cfg, whitelist: { ...(ctx.cfg?.whitelist ?? {}), roles: [] } };
    const opts = levelOpts(ctx);
    const roles = changedRoles(entry, '$add').filter((id) => {
      const role = guild.roles?.cache?.get?.(id);
      return role && !role.managed && S.isSensitiveRole(role, cfg, opts);
    });
    if (!roles.length) return null;
    return { weight: 1, record: { targetId, roles } };
  },
  async undo(guild, record) {
    if (!record?.roles?.length) return { ok: false };
    const member = guild.members?.cache?.get?.(record.targetId) ?? (await guild.members?.fetch?.(record.targetId).catch(() => null));
    if (!member) return { ok: true }; // parti : plus rien à retirer
    const roles = record.roles.filter((id) => member.roles.cache.has(id));
    if (!roles.length) return { ok: true };
    const blocked = roles.filter((id) => !editable(guild, guild.roles.cache.get(id)));
    const res = await applyRoles(member, { remove: roles.filter((id) => !blocked.includes(id)) }, REASON);
    const failed = blocked.length + res.failed.length;
    if (failed) return { ok: false, note: `${failed} rôle(s) sensible(s) non retiré(s) à <@${record.targetId}> (hiérarchie ou permission).` };
    return { ok: true };
  },
  describe: (record) => `Rôle sensible donné à <@${record?.targetId}>`,
  targetKey: (record) => `add:${record?.targetId ?? ''}:${[...(record?.roles ?? [])].sort().join(',')}`,
};

const roleRemove = {
  key: 'roleRemove',
  auditTypes: [25],
  priority: 5,
  classify(entry, guild, ctx) {
    const targetId = entry.targetId;
    if (!targetId || targetId === entry.executorId) return null;
    const removed = changedRoles(entry, '$remove').filter((id) => !guild.roles?.cache?.get?.(id)?.managed);
    if (!removed.length) return null;
    if (targetId === ctx.client?.user?.id) {
      // Rôles retirés AU BOT : alerte prioritaire et sanction d'emblée.
      return { weight: S.effectiveLimit(ctx.cfg, 'roleRemove'), record: { targetId, roles: removed, bot: true } };
    }
    const opts = levelOpts(ctx);
    const roles = removed.filter((id) => {
      const role = guild.roles?.cache?.get?.(id);
      return role && S.isSensitiveRole(role, ctx.cfg, opts);
    });
    if (!roles.length) return null;
    return { weight: 1, record: { targetId, roles } };
  },
  async undo(guild, record) {
    if (!record?.roles?.length) return { ok: false };
    const member = record.bot ? guild.members?.me : guild.members?.cache?.get?.(record.targetId) ?? (await guild.members?.fetch?.(record.targetId).catch(() => null));
    if (!member) return { ok: false, note: `<@${record.targetId}> a quitté le serveur : rôles non rendus.` };
    const roles = record.roles.filter((id) => guild.roles.cache.has(id) && !member.roles.cache.has(id));
    if (!roles.length) return { ok: true };
    const blocked = roles.filter((id) => !editable(guild, guild.roles.cache.get(id)));
    const res = await applyRoles(member, { add: roles.filter((id) => !blocked.includes(id)) }, REASON);
    const failed = blocked.length + res.failed.length;
    if (failed) return { ok: false, note: `${failed} rôle(s) non rendu(s) à <@${record.targetId}> (hiérarchie ou permission).` };
    return { ok: true };
  },
  describe: (record) => (record?.bot ? 'Rôles retirés au bot' : `Rôles sensibles retirés à <@${record?.targetId}>`),
  targetKey: (record) => `remove:${record?.targetId ?? ''}:${[...(record?.roles ?? [])].sort().join(',')}`,
};

module.exports = [roleCreate, roleDelete, roleUpdate, roleAdd, roleRemove];
