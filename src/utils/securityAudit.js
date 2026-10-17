'use strict';

const { PermissionFlagsBits, PermissionsBitField, ChannelType } = require('discord.js');
const { permissionLabel } = require('./permissionNames');
const S = require('./secur');

/**
 * Audit de sécurité (/diagnostics › 🛡️ Audit de sécurité) : contrôles C1 à C14, score, plans de
 * correction. PUR : lit seulement les caches de la guild et la configuration (aucun appel réseau).
 * L'exécution des corrections (et la lecture des membres) est faite par
 * src/commands/configuration/diagnostics.js, qui recalcule le plan juste avant d'agir.
 */

const P = PermissionFlagsBits;

/** Permission du bot requise par module actif (annulation comprise), en plus de « Voir les logs ». */
const MODULE_PERMS = Object.freeze({
  channelCreate: ['ManageChannels'],
  channelDelete: ['ManageChannels', 'ManageRoles'],
  channelUpdate: ['ManageChannels', 'ManageRoles'],
  roleCreate: ['ManageRoles'],
  roleDelete: ['ManageRoles'],
  roleUpdate: ['ManageRoles'],
  roleAdd: ['ManageRoles'],
  roleRemove: ['ManageRoles'],
  webhook: ['ManageWebhooks'],
  serverUpdate: ['ManageGuild'],
  expressions: ['ManageGuildExpressions'],
  ban: ['BanMembers'],
  unban: ['BanMembers'],
  kick: [],
  bot: ['KickMembers'],
  voiceKick: [],
  everyone: ['ManageMessages'],
  messagePurge: [],
  timeout: ['ModerateMembers'],
  threadDelete: [],
});
/** Permission du bot requise par la sanction d'un module. */
const PUNISH_PERMS = Object.freeze({ none: [], derank: ['ManageRoles'], kick: ['KickMembers'], ban: ['BanMembers'] });

/** Seuils de l'audit. */
const AUDIT_LIMITS = Object.freeze({
  listed: 10,
  overwritesPerFix: 50,
  mentionablePerFix: 10,
  mentionableMembers: 50,
  admins: 5,
  adminsListed: 15,
  notificationsMembers: 1_000,
  whitelistRoleMembers: 20,
  fetchMaxMembers: 25_000,
});

/** Niveaux comptés dans le score (info : non compté). */
const LEVEL_VALUE = Object.freeze({ ok: 1, warn: 0.5, fail: 0 });
/** Poids des contrôles dans le score (1 par défaut). */
const WEIGHTS = Object.freeze({ C1: 3, C2: 2, C3: 2, C11: 2, C12: 2 });

/** Corrections proposées : libellé et permissions du bot nécessaires. */
const FIXES = Object.freeze({
  everyone_perms: { label: 'Retirer les permissions dangereuses d\'@everyone', check: 'C1', botPerms: ['ManageRoles'] },
  everyone_overwrites: { label: 'Retirer les surcharges dangereuses d\'@everyone', check: 'C2', botPerms: ['ManageRoles', 'ManageChannels'] },
  mentionable_roles: { label: 'Rendre les gros rôles non mentionnables', check: 'C5', botPerms: ['ManageRoles'] },
  verification_level: { label: 'Passer la vérification à « Moyen »', check: 'C6', botPerms: ['ManageGuild'] },
  explicit_filter: { label: 'Activer le filtre de contenu explicite', check: 'C7', botPerms: ['ManageGuild'] },
  default_notifications: { label: 'Notifications par défaut : mentions seulement', check: 'C9', botPerms: ['ManageGuild'] },
  safety_alerts: { label: 'Choisir un salon d\'alertes de sécurité', check: 'C10', botPerms: ['ManageGuild'] },
});

const values = (coll) => (coll?.values ? [...coll.values()] : Array.isArray(coll) ? coll : []);
const has = (perms, flag) => Boolean(perms?.has?.(flag));
const isAdmin = (perms) => has(perms, P.Administrator);
const plural = (n, word) => `${n} ${word}${n > 1 ? 's' : ''}`;

/** Bits DANGEROUS présents dans un champ de bits (Administrateur seul s'il y est). Pur. */
function dangerousBits(perms) {
  if (!perms?.has) return [];
  return new PermissionsBitField(S.DANGEROUS).toArray().filter((name) => perms.has(P[name], false));
}

/** Liste « a, b, c et N autre(s) ». Pur. */
function listOrMore(items, max = AUDIT_LIMITS.listed) {
  if (!items.length) return '';
  const shown = items.slice(0, max).join(', ');
  return items.length > max ? `${shown} et ${items.length - max} autre(s)` : shown;
}

/** Rôle le plus haut du bot (position), 0 s'il est inconnu. */
function botTop(guild) {
  return guild?.members?.me?.roles?.highest?.position ?? 0;
}

/** Nombre de membres d'un rôle (cache). */
function memberCountOf(role) {
  return role?.members?.size ?? 0;
}

/* ------------------------------------------------------------------ */
/* Exigences de Secur (diagnostic : groupe « Secur »)                   */
/* ------------------------------------------------------------------ */

/**
 * Permissions du bot exigées par les modules Secur ACTIFS (mode ≠ off) : « Voir les logs du
 * serveur » pour les modules à journal d'audit, annulation et sanction. Pur.
 * @returns {Map<string, string[]>} permission → libellés des modules
 */
function securRequirements(cfg) {
  const out = new Map();
  const add = (perm, label) => {
    const list = out.get(perm) ?? [];
    if (!list.includes(label)) list.push(label);
    out.set(perm, list);
  };
  for (const key of S.MODULE_KEYS) {
    if (S.moduleMode(cfg, key) === 'off') continue;
    const meta = S.SECUR_MODULES[key];
    const mc = S.moduleConfig(cfg, key);
    if (meta.auditTypes.length) add('ViewAuditLog', meta.label);
    if (mc.undo === true && meta.undoable) for (const perm of MODULE_PERMS[key] ?? []) add(perm, meta.label);
    for (const perm of PUNISH_PERMS[S.modulePunish(cfg, key)] ?? []) add(perm, meta.label);
  }
  return out;
}

/**
 * Groupe « Secur » du diagnostic (analyze) : permissions requises par les modules actifs et raid
 * ping non mentionnable. null si Secur est entièrement coupé et sans raid ping. Pur.
 */
function securGroup(guild, cfg) {
  const req = securRequirements(cfg);
  const pingId = cfg?.secur?.raidPingRoleId ?? null;
  if (!req.size && !pingId) return null;
  const group = { icon: '🛡️', label: 'Secur', checks: [] };
  const perms = guild?.members?.me?.permissions;
  if (req.size) {
    if (isAdmin(perms)) group.checks.push({ level: 'ok', text: '**Administrateur** : toutes les permissions requises par les modules actifs' });
    else {
      for (const [perm, labels] of req) {
        const ok = has(perms, P[perm]);
        const label = permissionLabel(perm);
        group.checks.push({
          level: ok ? 'ok' : 'warn',
          text: `${label}${ok ? '' : ` · requise par ${listOrMore(labels, 3)}`}`,
          tip: ok ? null : `Accordez-moi **${label}** : sans elle, Secur ne peut ni détecter ni corriger ces actions.`,
        });
      }
    }
  }
  if (pingId) {
    const role = guild?.roles?.cache?.get?.(pingId);
    if (guild?.roles?.cache && !role) group.checks.push({ level: 'fail', text: 'Raid ping : rôle introuvable (supprimé ?)', tip: 'Choisissez un autre rôle : `/secur panneau` › **Accès et alertes**.' });
    else if (role && !role.mentionable && !has(perms, P.MentionEveryone)) {
      group.checks.push({ level: 'warn', text: `Raid ping : ${role} n'est pas mentionnable et je n'ai pas « Mentionner @everyone »`, tip: `Rendez ${role} mentionnable ou accordez-moi **Mentionner @everyone** : sinon le raid ping ne notifie personne.` });
    } else if (role) group.checks.push({ level: 'ok', text: `Raid ping : ${role}` });
  }
  return group.checks.length ? group : null;
}

/* ------------------------------------------------------------------ */
/* Contrôles                                                            */
/* ------------------------------------------------------------------ */

function everyoneRole(guild) {
  return guild?.roles?.everyone ?? guild?.roles?.cache?.get?.(guild?.id) ?? null;
}

/** C2 : salons où @everyone reçoit une permission DANGEROUS par surcharge. Pur. */
function dangerousEveryoneOverwrites(guild) {
  const out = [];
  for (const channel of values(guild?.channels?.cache)) {
    const ow = channel.permissionOverwrites?.cache?.get?.(guild.id);
    if (!ow?.allow?.has) continue;
    const bits = dangerousBits(ow.allow);
    if (bits.length) out.push({ channel, bits });
  }
  return out.sort((a, b) => (a.channel.rawPosition ?? a.channel.position ?? 0) - (b.channel.rawPosition ?? b.channel.position ?? 0));
}

/** Bot pouvant retirer ces permissions (Discord : on ne modifie que ce que l'on possède). */
function canTouchBits(perms, bits) {
  return isAdmin(perms) || bits.every((b) => has(perms, P[b]));
}

/** Plan de correction C2 : 50 salons au plus, où le bot peut gérer les permissions. Pur. */
function overwritesPlan(guild) {
  const me = guild?.members?.me;
  const items = [];
  for (const { channel, bits } of dangerousEveryoneOverwrites(guild)) {
    const perms = me && typeof channel.permissionsFor === 'function' ? channel.permissionsFor(me) : me?.permissions;
    if (!has(perms, P.ManageRoles) || !has(perms, P.ViewChannel) || !canTouchBits(perms, bits)) continue;
    items.push({ channelId: channel.id, channel, bits });
    if (items.length >= AUDIT_LIMITS.overwritesPerFix) break;
  }
  return items;
}

/** Plan de correction C5 : 10 rôles mentionnables au plus, sous le bot, jamais gérés. Pur. */
function mentionablePlan(guild, roles) {
  const top = botTop(guild);
  return roles.filter((r) => !r.managed && r.id !== guild.id && r.position < top).slice(0, AUDIT_LIMITS.mentionablePerFix);
}

/** Salon candidat pour les alertes de sécurité de Discord (C10). Pur. */
function safetyAlertsTarget(guild, cfg) {
  const candidates = [cfg?.antiraid?.alertChannel, cfg?.logChannels?.security, guild?.publicUpdatesChannelId].filter(Boolean);
  for (const id of candidates) {
    const ch = guild?.channels?.cache?.get?.(id);
    if (ch && (ch.type === ChannelType.GuildText || ch.type === ChannelType.GuildAnnouncement)) return ch;
  }
  return null;
}

/**
 * Audit de sécurité. Pur.
 * @param {import('discord.js').Guild} guild
 * @param {object} cfg configuration du serveur
 * @param {{ now?: number, groups?: Array<object>|null, pending?: Array<object>, partial?: boolean }} [opts]
 *   groups : groupes d'analyze() (C12) ; pending : accès de whitelist en attente (C14)
 * @returns {{ score: number, grade: { letter: string, label: string, tone: string }, checks: Array<object>, fixes: Array<object>, partial: boolean }}
 */
function auditSecurity(guild, cfg = {}, { now = Date.now(), groups = null, pending = [], partial = false } = {}) {
  const checks = [];
  const me = guild?.members?.me ?? null;
  const myPerms = me?.permissions ?? null;
  const top = botTop(guild);
  const members = values(guild?.members?.cache);
  const roles = values(guild?.roles?.cache);
  const wl = cfg?.whitelist ?? {};
  const trusted = cfg?.secur?.trustedBots ?? [];
  const push = (c) => checks.push({ details: [], fix: null, ...c });
  const fixFor = (id, changes, extra = {}) => {
    const def = FIXES[id];
    if (!def) return null;
    const missing = def.botPerms.filter((p) => !has(myPerms, P[p]));
    if (missing.length || !changes.length) return null;
    return { id, label: def.label, changes, ...extra };
  };

  // C1 — @everyone a une permission dangereuse.
  const everyone = everyoneRole(guild);
  const evBits = dangerousBits(everyone?.permissions);
  // Bits que le bot ne tient QUE via @everyone (sans Administrateur) : la correction les lui retire.
  const selfLost = isAdmin(myPerms) ? [] : evBits.filter((b) => !values(me?.roles?.cache).some((r) => r.id !== guild?.id && has(r.permissions, P[b])));
  const myRole = me?.roles?.highest && me.roles.highest.id !== guild?.id ? ` ${me.roles.highest}` : '';
  const selfWarning = selfLost.length
    ? [`⚠️ Je perdrai moi-même ${selfLost.map((b) => `« ${permissionLabel(b)} »`).join(', ')} (je ne la tiens que par @everyone) : accordez-la d'abord à mon rôle${myRole}.`]
    : [];
  push(evBits.length
    ? {
      id: 'C1', level: 'fail', label: '@everyone',
      text: `@everyone a des permissions dangereuses : ${evBits.map(permissionLabel).join(', ')}`,
      fix: canTouchBits(myPerms, evBits) ? fixFor('everyone_perms', [`@everyone : retirer ${evBits.map((b) => `« ${permissionLabel(b)} »`).join(', ')}`, ...selfWarning], { bits: evBits }) : null,
    }
    : { id: 'C1', level: 'ok', label: '@everyone', text: '@everyone n\'a aucune permission dangereuse' });

  // C2 — surcharges dangereuses accordées à @everyone.
  const overwrites = dangerousEveryoneOverwrites(guild);
  if (overwrites.length) {
    const plan = overwritesPlan(guild);
    push({
      id: 'C2', level: 'fail', label: 'Surcharges d\'@everyone',
      text: `${plural(overwrites.length, 'salon')} donne${overwrites.length > 1 ? 'nt' : ''} une permission dangereuse à @everyone`,
      details: overwrites.slice(0, AUDIT_LIMITS.listed).map(({ channel, bits }) => `${channel} : ${bits.map(permissionLabel).join(', ')}`),
      fix: fixFor('everyone_overwrites', plan.map(({ channel, bits }) => `${channel} : @everyone, retirer ${bits.map((b) => `« ${permissionLabel(b)} »`).join(', ')}`), { items: plan.map(({ channelId, bits }) => ({ channelId, bits })), remaining: Math.max(0, overwrites.length - plan.length) }),
    });
  } else push({ id: 'C2', level: 'ok', label: 'Surcharges d\'@everyone', text: 'Aucune surcharge de salon dangereuse pour @everyone' });

  // C3 — bots tiers Administrateur, ni whitelistés ni de confiance.
  const meId = me?.id ?? guild?.client?.user?.id ?? null;
  const adminBots = members.filter((m) => m.user?.bot && m.id !== meId && isAdmin(m.permissions) && !trusted.includes(m.id) && !(wl.users ?? []).includes(m.id));
  push(adminBots.length
    ? { id: 'C3', level: 'warn', label: 'Bots Administrateur', text: `${plural(adminBots.length, 'bot')} tiers Administrateur, ni whitelisté${adminBots.length > 1 ? 's' : ''} ni de confiance`, details: adminBots.slice(0, AUDIT_LIMITS.listed).map((m) => `${m}`), tip: 'Retirez-leur « Administrateur » ou ajoutez-les aux bots de confiance (`/secur confiance ajouter`).' }
    : { id: 'C3', level: 'ok', label: 'Bots Administrateur', text: 'Aucun bot tiers Administrateur non traité' });

  // C4 — plus de 5 administrateurs humains (propriétaire exclu).
  const admins = members.filter((m) => !m.user?.bot && m.id !== guild?.ownerId && isAdmin(m.permissions));
  push(admins.length > AUDIT_LIMITS.admins
    ? { id: 'C4', level: 'warn', label: 'Administrateurs', text: `${admins.length} administrateurs humains (${AUDIT_LIMITS.admins} au plus recommandés)`, details: admins.slice(0, AUDIT_LIMITS.adminsListed).map((m) => `${m}`), tip: 'Chaque compte Administrateur compromis peut détruire le serveur : réservez ce droit à quelques personnes.' }
    : { id: 'C4', level: 'ok', label: 'Administrateurs', text: `${plural(admins.length, 'administrateur')} humain${admins.length > 1 ? 's' : ''} (propriétaire exclu)` });

  // C5 — rôles mentionnables de plus de 50 membres.
  const bigMentionable = roles.filter((r) => r.mentionable && r.id !== guild?.id && memberCountOf(r) > AUDIT_LIMITS.mentionableMembers).sort((a, b) => memberCountOf(b) - memberCountOf(a));
  if (bigMentionable.length) {
    const plan = mentionablePlan(guild, bigMentionable);
    push({
      id: 'C5', level: 'warn', label: 'Rôles mentionnables',
      text: `${plural(bigMentionable.length, 'rôle')} mentionnable${bigMentionable.length > 1 ? 's' : ''} par tous, de plus de ${AUDIT_LIMITS.mentionableMembers} membres`,
      details: bigMentionable.slice(0, AUDIT_LIMITS.listed).map((r) => `${r} (${memberCountOf(r)})`),
      fix: fixFor('mentionable_roles', plan.map((r) => `${r} : non mentionnable`), { roleIds: plan.map((r) => r.id) }),
    });
  } else push({ id: 'C5', level: 'ok', label: 'Rôles mentionnables', text: `Aucun rôle mentionnable de plus de ${AUDIT_LIMITS.mentionableMembers} membres` });

  // C6 — niveau de vérification inférieur à « Moyen ».
  const verification = Number(guild?.verificationLevel ?? 0);
  push(verification < 2
    ? { id: 'C6', level: 'warn', label: 'Vérification', text: `Niveau de vérification ${['aucun', 'faible'][verification] ?? 'faible'} : les comptes jetables écrivent tout de suite`, fix: fixFor('verification_level', ['Niveau de vérification : « Moyen » (compte inscrit depuis plus de 5 minutes)']) }
    : { id: 'C6', level: 'ok', label: 'Vérification', text: 'Niveau de vérification « Moyen » ou plus' });

  // C7 — filtre de contenu explicite désactivé.
  const filter = Number(guild?.explicitContentFilter ?? 0);
  push(filter === 0
    ? { id: 'C7', level: 'warn', label: 'Filtre de contenu', text: 'Filtre de contenu explicite désactivé', fix: fixFor('explicit_filter', ['Filtre de contenu explicite : analyser les médias de tous les membres']) }
    : { id: 'C7', level: 'ok', label: 'Filtre de contenu', text: 'Filtre de contenu explicite actif' });

  // C8 — 2FA de modération (conseil : seul le propriétaire peut l'exiger).
  push(Number(guild?.mfaLevel ?? 0) === 0
    ? { id: 'C8', level: 'warn', label: '2FA', text: 'Double authentification non exigée pour la modération', tip: 'Le propriétaire peut l\'exiger : **Paramètres du serveur › Sécurité › Exiger la 2FA**.' }
    : { id: 'C8', level: 'ok', label: '2FA', text: 'Double authentification exigée pour la modération' });

  // C9 — notifications « tous les messages » sur plus de 1 000 membres.
  const memberCount = Number(guild?.memberCount ?? members.length) || members.length;
  push(Number(guild?.defaultMessageNotifications ?? 1) === 0 && memberCount > AUDIT_LIMITS.notificationsMembers
    ? { id: 'C9', level: 'warn', label: 'Notifications', text: `Notifications par défaut sur « tous les messages » avec ${memberCount} membres`, fix: fixFor('default_notifications', ['Notifications par défaut : « mentions seulement »']) }
    : { id: 'C9', level: 'ok', label: 'Notifications', text: 'Notifications par défaut raisonnables' });

  // C10 — pas de salon d'alertes de sécurité (serveur communauté).
  const community = Boolean(guild?.features?.includes?.('COMMUNITY'));
  if (community && !guild?.safetyAlertsChannelId) {
    const target = safetyAlertsTarget(guild, cfg);
    push({ id: 'C10', level: 'warn', label: 'Alertes de sécurité', text: 'Aucun salon ne reçoit les alertes de sécurité de Discord (activité inhabituelle)', tip: target ? null : 'Définissez un salon d\'alerte (`/antiraid` › Alertes), puis relancez l\'audit.', fix: target ? fixFor('safety_alerts', [`Salon des alertes de sécurité de Discord : ${target}`], { channelId: target.id }) : null });
  } else push({ id: 'C10', level: community ? 'ok' : 'info', label: 'Alertes de sécurité', text: community ? 'Salon des alertes de sécurité de Discord défini' : 'Alertes de sécurité de Discord : réservé aux serveurs communauté' });

  // C11 — rôles dangereux au-dessus du rôle du bot.
  const myRoleIds = new Set(me?.roles?.cache?.keys?.() ?? []);
  const above = roles.filter((r) => r.position >= top && !myRoleIds.has(r.id) && r.id !== guild?.id && dangerousBits(r.permissions).length).sort((a, b) => b.position - a.position);
  push(above.length
    ? { id: 'C11', level: 'warn', label: 'Hiérarchie', text: `${plural(above.length, 'rôle')} dangereux au-dessus du mien : je ne peux pas retirer les rôles de leurs membres`, details: above.slice(0, AUDIT_LIMITS.listed).map((r) => `${r}`), tip: 'Remontez mon rôle au-dessus des rôles d\'administration (**Paramètres du serveur › Rôles**).' }
    : { id: 'C11', level: 'ok', label: 'Hiérarchie', text: 'Aucun rôle dangereux au-dessus du mien' });

  // C12 — configuration du bot (groupes d'analyze()).
  const all = (groups ?? []).flatMap((g) => g.checks ?? []);
  const bad = all.filter((c) => c.level === 'warn' || c.level === 'fail');
  push(bad.length
    ? { id: 'C12', level: bad.some((c) => c.level === 'fail') ? 'fail' : 'warn', label: 'Configuration du bot', text: `${plural(bad.length, 'point')} du diagnostic à corriger`, details: bad.slice(0, AUDIT_LIMITS.listed).map((c) => c.text) }
    : { id: 'C12', level: groups ? 'ok' : 'info', label: 'Configuration du bot', text: groups ? 'Diagnostic du serveur sans problème' : 'Diagnostic non disponible' });

  // C13 — rôle whitelisté porté par plus de 20 membres.
  const wideWl = (wl.roles ?? []).map((id) => guild?.roles?.cache?.get?.(id)).filter((r) => r && memberCountOf(r) > AUDIT_LIMITS.whitelistRoleMembers);
  push(wideWl.length
    ? { id: 'C13', level: 'warn', label: 'Whitelist', text: `${plural(wideWl.length, 'rôle')} whitelisté${wideWl.length > 1 ? 's' : ''} porté${wideWl.length > 1 ? 's' : ''} par plus de ${AUDIT_LIMITS.whitelistRoleMembers} membres`, details: wideWl.map((r) => `${r} (${memberCountOf(r)})`), tip: 'Whitelistez des membres précis plutôt qu\'un rôle large (`/whitelist`).' }
    : { id: 'C13', level: 'ok', label: 'Whitelist', text: 'Aucun rôle whitelisté trop large' });

  // C14 — accès de whitelist en attente.
  push(pending.length
    ? { id: 'C14', level: 'warn', label: 'Accès en attente', text: `${plural(pending.length, 'accès')} de whitelist en attente d'approbation`, details: pending.slice(0, AUDIT_LIMITS.listed).map((g) => `#${g.id} · ${g.kind === 'wlrole' ? `<@&${g.subject_id}>` : `<@${g.subject_id}>`} · par <@${g.granted_by}>`), tip: 'Approuvez ou révoquez-les : `/secur panneau` › **Accès en attente**.' }
    : { id: 'C14', level: 'ok', label: 'Accès en attente', text: 'Aucun accès de whitelist en attente' });

  const result = scoreOf(checks);
  return { ...result, checks, fixes: checks.map((c) => c.fix).filter(Boolean), partial: Boolean(partial), at: now };
}

/** Score 0-100 (pondéré, info non compté) et note. Pur, borné et stable. */
function scoreOf(checks) {
  let total = 0;
  let got = 0;
  for (const c of checks) {
    if (!(c.level in LEVEL_VALUE)) continue;
    const w = WEIGHTS[c.id] ?? 1;
    total += w;
    got += w * LEVEL_VALUE[c.level];
  }
  const score = total ? Math.max(0, Math.min(100, Math.round((got / total) * 100))) : 100;
  return { score, grade: gradeOf(score) };
}

/** Note d'un score. Pure. */
function gradeOf(score) {
  if (score >= 90) return { letter: 'A', label: 'Excellent', tone: 'success' };
  if (score >= 75) return { letter: 'B', label: 'Bon', tone: 'success' };
  if (score >= 55) return { letter: 'C', label: 'Moyen', tone: 'warning' };
  if (score >= 35) return { letter: 'D', label: 'Faible', tone: 'warning' };
  return { letter: 'E', label: 'Critique', tone: 'danger' };
}

/** Plan d'une correction (recalculé juste avant d'agir), ou null si plus rien à corriger. Pur. */
function fixPlan(guild, cfg, fixId, opts = {}) {
  if (!Object.hasOwn(FIXES, fixId)) return null;
  const audit = auditSecurity(guild, cfg, opts);
  return audit.fixes.find((f) => f.id === fixId) ?? null;
}

module.exports = {
  AUDIT_LIMITS,
  FIXES,
  MODULE_PERMS,
  PUNISH_PERMS,
  auditSecurity,
  dangerousBits,
  dangerousEveryoneOverwrites,
  fixPlan,
  gradeOf,
  scoreOf,
  securGroup,
  securRequirements,
  safetyAlertsTarget,
};
