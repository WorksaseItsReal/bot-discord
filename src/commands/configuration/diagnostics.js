'use strict';

const {
  SlashCommandBuilder,
  PermissionFlagsBits,
  GuildVerificationLevel,
  GuildExplicitContentFilter,
  GuildDefaultMessageNotifications,
} = require('discord.js');
const { truncate, progressBar } = require('../../utils/embeds');
const { card, field, wide, subtext, ICONS, actionButton, buttonRows, ButtonStyle, userLine } = require('../../utils/ui');
const { UserError } = require('../../core/errors');
const { permissionLabel } = require('../../utils/permissionNames');
const { INVITE_PERMISSIONS } = require('../utility/invite');
const { auditSecurity, fixPlan, securGroup, FIXES, AUDIT_LIMITS } = require('../../utils/securityAudit');
const { createLogger } = require('../../core/logger');

const logger = createLogger('diagnostics');

/** Libellés propres au diagnostic (sinon : libellé français commun). */
const PERM_LABELS = { ModerateMembers: 'Exclure temporairement', ViewAuditLog: 'Voir les logs d\'audit' };

/** Permissions contrôlées = exactement celles demandées à l'invitation (/invite). */
const RECOMMENDED_PERMS = INVITE_PERMISSIONS.map((name) => [PERM_LABELS[name] ?? permissionLabel(name), PermissionFlagsBits[name]]);

/** Le salon « Créer un vocal » : il suffit de le voir, de s'y connecter et d'en déplacer les membres. */
const HUB_PERMS = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect, PermissionFlagsBits.MoveMembers];

/** Niveau d'un contrôle → pastille. Seuls ok / warn / fail comptent dans le score. */
const LEVEL = Object.freeze({ ok: ICONS.success, warn: ICONS.warning, fail: ICONS.error, info: ICONS.info });

const WRITE_PERMS = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks];

/**
 * Analyse la configuration d'un serveur. Pur vis-à-vis de Discord (lit seulement les caches).
 * @returns {Array<{ icon: string, label: string, checks: Array<{ level: keyof LEVEL, text: string, tip?: string }> }>}
 */
function analyze(guild, cfg) {
  const me = guild.members.me;
  const groups = [];

  // 1) Permissions du bot
  const perms = { icon: '🔑', label: 'Permissions du bot', checks: [] };
  if (me?.permissions.has(PermissionFlagsBits.Administrator, false)) {
    perms.checks.push({ level: 'ok', text: '**Administrateur** : toutes les permissions' });
  } else {
    for (const [label, flag] of RECOMMENDED_PERMS) {
      const ok = Boolean(me?.permissions.has(flag));
      perms.checks.push({ level: ok ? 'ok' : 'warn', text: label, tip: ok ? null : `Accordez-moi **${label}** dans les paramètres de mon rôle.` });
    }
  }
  groups.push(perms);

  // 2) Hiérarchie des rôles
  const hierarchy = { icon: ICONS.role, label: 'Hiérarchie des rôles', checks: [] };
  if (me) {
    const above = guild.roles.cache.filter((r) => r.position > me.roles.highest.position).size;
    hierarchy.checks.push(
      above === 0
        ? { level: 'ok', text: `Mon rôle ${me.roles.highest} est en haut de la liste` }
        : { level: 'warn', text: `**${above}** rôle${above > 1 ? 's' : ''} au-dessus du mien : je ne peux pas modérer leurs membres`, tip: 'Remontez mon rôle dans **Paramètres du serveur › Rôles**.' },
    );
  }
  for (const [id, label, cmd, assign] of roleRefs(cfg)) hierarchy.checks.push(roleCheck(guild, me, id, label, cmd, assign));
  groups.push(hierarchy);

  // 3) Salons de logs
  const logs = { icon: ICONS.list, label: 'Salons de logs', checks: [] };
  const logEntries = Object.entries(cfg.logChannels || {}).filter(([, id]) => id);
  if (!logEntries.length) {
    logs.checks.push({ level: 'info', text: 'Aucun salon de logs configuré', tip: 'Configurez au moins les logs de modération : `/logs`.' });
  }
  for (const [cat, id] of logEntries) logs.checks.push(channelCheck(guild, me, id, `Logs « ${cat} »`, '/logs'));
  groups.push(logs);

  // 4) Modules : salons configurés encore valides + état
  const modules = { icon: ICONS.settings, label: 'Modules', checks: [] };
  modules.checks.push({ level: 'info', text: `Strikes ${cfg.strikes?.enabled ? 'activés' : 'désactivés'} · AutoMod ${cfg.automod?.enabled ? 'actif' : 'inactif'} · AntiRaid ${cfg.antiraid?.enabled ? 'actif' : 'inactif'}` });
  const refs = [
    [cfg.antiraid?.alertChannel, 'Alertes AntiRaid', '/antiraid'],
    [cfg.tickets?.categoryId, 'Catégorie des tickets', '/tickets'],
    [cfg.tickets?.logChannel, 'Transcripts des tickets', '/tickets'],
    [cfg.tickets?.panelChannelId, 'Panneau des tickets', '/tickets'],
    [cfg.modmail?.categoryId, 'Catégorie du modmail', '/modmail'],
    [cfg.modmail?.logChannel, 'Transcripts du modmail', '/modmail'],
    [cfg.suggestions?.channelId, 'Salon des suggestions', '/suggestion'],
    [cfg.projects?.channelId, 'Salon des projets', '/projet config'],
    [cfg.welcome?.join?.channelId, 'Salon de bienvenue', '/bienvenue'],
    [cfg.welcome?.leave?.channelId, 'Salon des départs', '/bienvenue'],
    [cfg.welcome?.verification?.channelId, 'Salon de vérification', '/bienvenue'],
    [cfg.levels?.announce?.mode === 'channel' ? cfg.levels.announce.channelId : null, 'Annonces de niveau', '/niveaux'],
  ];
  for (const [id, label, cmd] of refs) if (id) modules.checks.push(channelCheck(guild, me, id, label, cmd));
  if (cfg.tempVoice?.enabled && cfg.tempVoice.hubChannelId) {
    modules.checks.push(channelCheck(guild, me, cfg.tempVoice.hubChannelId, 'Salon « Créer un vocal »', '/tempvoice', { perms: HUB_PERMS, need: 'voir, me connecter et déplacer des membres' }));
  }
  // Catégorie supprimée : les vocaux se créent alors à côté du salon créateur, sans prévenir.
  if (cfg.tempVoice?.enabled && cfg.tempVoice.categoryId) modules.checks.push(channelCheck(guild, me, cfg.tempVoice.categoryId, 'Catégorie des vocaux temporaires', '/tempvoice'));
  // Signalements (menu « Signaler le message ») : salon dédié, sinon salon de logs Modération.
  if (cfg.reports?.enabled !== false) {
    if (cfg.reports?.channelId) modules.checks.push(channelCheck(guild, me, cfg.reports.channelId, 'Salon des signalements', '/signalements'));
    else if (!cfg.logChannels?.moderation) {
      modules.checks.push({ level: 'warn', text: 'Signalements actifs sans salon : ils sont refusés aux membres', tip: 'Choisissez un salon avec `/signalements` (ou configurez les logs Modération : `/logs`).' });
    }
  }
  if (cfg.antiraid?.enabled && !cfg.antiraid.alertChannel) {
    modules.checks.push({ level: 'warn', text: 'AntiRaid actif sans salon d\'alerte', tip: 'Définissez un salon d\'alerte : `/antiraid` › **Alertes**.' });
  }
  // Archive des transcripts (tickets, ModMail) : le .txt part en pièce jointe.
  for (const check of transcriptAttachChecks(guild, me, cfg)) modules.checks.push(check);
  groups.push(modules);

  // 5) Secur : permissions requises par les modules actifs, raid ping non mentionnable.
  const secur = securGroup(guild, cfg);
  if (secur) groups.push(secur);

  return groups;
}

/**
 * Salons de transcripts (tickets, ModMail) où je peux écrire mais pas « Joindre des fichiers » :
 * l'archive .txt échouerait. Un seul contrôle par salon. Pur.
 */
function transcriptAttachChecks(guild, me, cfg) {
  const targets = new Map();
  for (const [id, label, command] of [[cfg.tickets?.logChannel, 'tickets', '/tickets'], [cfg.modmail?.logChannel, 'ModMail', '/modmail']]) {
    if (!id) continue;
    const t = targets.get(id) ?? { labels: [], commands: [] };
    t.labels.push(label);
    t.commands.push(command);
    targets.set(id, t);
  }
  const out = [];
  for (const [id, { labels, commands }] of targets) {
    const channel = guild.channels?.cache?.get?.(id);
    if (!channel || !me || typeof channel.permissionsFor !== 'function') continue;
    const perms = channel.permissionsFor(me);
    if (!perms?.has || !perms.has(WRITE_PERMS) || perms.has(PermissionFlagsBits.AttachFiles)) continue;
    out.push({
      level: 'warn',
      text: `Transcripts (${labels.join(' et ')}) : ${channel} · je ne peux pas joindre de fichiers`,
      tip: `Autorisez-moi à **Joindre des fichiers** dans ${channel} : sans cela, les transcripts (.txt) ne sont pas archivés (${commands.join(', ')}).`,
    });
  }
  return out;
}

/**
 * Vérifie qu'un salon configuré existe encore et que j'y ai les permissions utiles
 * (par défaut : écrire et intégrer des liens, contrôlé seulement sur un salon textuel).
 */
function channelCheck(guild, me, id, label, command, { perms: required = WRITE_PERMS, need = 'écrire et intégrer des liens' } = {}) {
  const channel = guild.channels.cache.get(id);
  if (!channel) return { level: 'fail', text: `${label} : salon introuvable (supprimé ?)`, tip: `Reconfigurez **${label}** avec \`${command}\`.` };
  const applies = required !== WRITE_PERMS || channel.isTextBased?.();
  if (applies && me && typeof channel.permissionsFor === 'function') {
    const perms = channel.permissionsFor(me);
    if (perms && !perms.has(required)) {
      return { level: 'warn', text: `${label} : ${channel} · accès refusé`, tip: `Autorisez-moi à ${need} dans ${channel}.` };
    }
  }
  return { level: 'ok', text: `${label} : ${channel}` };
}

/**
 * Rôles référencés par la configuration : [id, libellé, commande, attribué par le bot ?].
 * Les rôles que j'attribue doivent être sous mon rôle le plus haut ; les rôles staff
 * servent seulement aux permissions des salons (pas de contrainte de hiérarchie).
 */
function roleRefs(cfg) {
  const out = [];
  const w = cfg.welcome || {};
  for (const id of w.autoRoles?.humans || []) out.push([id, 'Rôle auto (membres)', '/bienvenue', true]);
  for (const id of w.autoRoles?.bots || []) out.push([id, 'Rôle auto (bots)', '/bienvenue', true]);
  if (w.verification?.roleId) out.push([w.verification.roleId, 'Rôle de vérification', '/bienvenue', true]);
  for (const r of cfg.levels?.rewards || []) if (r?.roleId) out.push([r.roleId, `Récompense niveau ${r.level}`, '/niveaux', true]);
  if (cfg.moderation?.mutedRoleId) out.push([cfg.moderation.mutedRoleId, 'Rôle muet', '/settings moderation', true]);
  const support = new Set([...(cfg.tickets?.supportRoleIds || []), cfg.tickets?.supportRoleId].filter(Boolean));
  for (const id of support) out.push([id, 'Rôle staff des tickets', '/tickets', false]);
  if (cfg.logs?.staffRoleId) out.push([cfg.logs.staffRoleId, 'Rôle staff des logs', '/logs', false]);
  if (cfg.modmail?.staffRoleId) out.push([cfg.modmail.staffRoleId, 'Rôle staff du modmail', '/modmail', false]);
  if (cfg.projects?.managerRoleId) out.push([cfg.projects.managerRoleId, 'Rôle gestionnaire des projets', '/projet config', false]);
  if (cfg.reports?.pingRoleId) out.push([cfg.reports.pingRoleId, 'Rôle mentionné aux signalements', '/signalements', false]);
  return out;
}

/** Vérifie qu'un rôle configuré existe encore (et, si je l'attribue, qu'il est sous mon rôle le plus haut). */
function roleCheck(guild, me, id, label, command, assign) {
  const role = guild.roles.cache.get(id);
  if (!role) return { level: 'fail', text: `${label} : rôle introuvable (supprimé ?)`, tip: `Reconfigurez **${label}** avec \`${command}\`.` };
  if (assign && me?.roles?.highest && role.position >= me.roles.highest.position) {
    return { level: 'warn', text: `${label} : ${role} · au-dessus de mon rôle`, tip: `Placez mon rôle au-dessus de ${role} pour que je puisse l'attribuer.` };
  }
  return { level: 'ok', text: `${label} : ${role}` };
}

/** Score (0-100) : un avertissement compte pour moitié, une erreur pour zéro. */
function score(groups) {
  const all = groups.flatMap((g) => g.checks);
  const ok = all.filter((c) => c.level === 'ok').length;
  const warn = all.filter((c) => c.level === 'warn').length;
  const fail = all.filter((c) => c.level === 'fail').length;
  const total = ok + warn + fail;
  return { ok, warn, fail, percent: total ? Math.round(((ok + warn * 0.5) / total) * 100) : 100 };
}

function grade(s) {
  if (s.fail) return ['🔴', 'Problèmes détectés', 'danger'];
  if (s.warn) return ['🟡', 'Quelques points d\'attention', 'warning'];
  return ['🟢', 'Tout est en ordre', 'success'];
}

/** Le membre a-t-il « Administrateur » ? (audit de sécurité et corrections) */
const isAdministrator = (interaction) => Boolean(interaction.memberPermissions?.has?.(PermissionFlagsBits.Administrator));

function render(guild, cfg, { admin = false } = {}) {
  const groups = analyze(guild, cfg);
  const s = score(groups);
  const [dot, label, tone] = grade(s);
  const tips = groups.flatMap((g) => g.checks).filter((c) => c.tip && c.level !== 'ok').map((c) => `› ${c.tip}`);
  const plural = (n, w) => `${n} ${w}${n > 1 ? 's' : ''}`;
  return {
    embeds: [
      card({
        tone,
        section: 'configuration',
        icon: ICONS.search,
        title: 'Diagnostic du serveur',
        description: [
          `${dot} **${label}** · score **${s.percent} %**`,
          `\`${progressBar(s.percent / 100, 18)}\``,
          subtext(`${plural(s.ok, 'contrôle')} OK · ${plural(s.warn, 'avertissement')} · ${plural(s.fail, 'erreur')}`),
        ],
        thumbnail: guild.iconURL?.({ size: 128 }) ?? null,
        fields: [
          ...groups.filter((g) => g.checks.length).map((g) => {
            const bad = g.checks.filter((c) => c.level === 'warn' || c.level === 'fail').length;
            const name = `${g.label}${bad ? ` · ${bad} à corriger` : ''}`;
            return wide(g.icon, name, truncate(g.checks.map((c) => `${LEVEL[c.level]} ${c.text}`).join('\n'), 1024));
          }),
          tips.length ? wide(ICONS.idea, 'À faire', truncate([...tips.slice(0, 6), tips.length > 6 ? subtext(`… et ${tips.length - 6} autre(s)`) : null].filter(Boolean).join('\n'), 1024)) : null,
        ],
        footer: 'Analyse en direct',
      }),
    ],
    components: buttonRows(
      actionButton({ command: 'diagnostics', action: 'rerun', label: 'Relancer l\'analyse', emoji: ICONS.refresh, style: ButtonStyle.Primary }),
      // Audit de sécurité (et ses corrections) : réservé aux administrateurs.
      admin ? actionButton({ command: 'diagnostics', action: 'audit', label: 'Audit de sécurité', emoji: ICONS.shield }) : null,
    ),
  };
}

// ---------------------------------------------------------------- audit de sécurité

/** Dernière lecture complète des membres par serveur (audit) : une toutes les 10 min au plus. */
const lastMemberFetch = new Map();
const MEMBER_FETCH_EVERY_MS = 10 * 60_000;
const MEMBER_FETCH_TIMEOUT_MS = 15_000;
/** Corrections en cours (verrou par serveur). */
const fixing = new Set();

/** Champs de l'audit (6 au plus) : contrôles regroupés par thème. */
const AUDIT_FIELDS = [
  ['🔑', 'Permissions et hiérarchie', ['C1', 'C2', 'C11']],
  [ICONS.members, 'Membres et rôles', ['C3', 'C4', 'C5', 'C13']],
  [ICONS.server, 'Paramètres du serveur', ['C6', 'C7', 'C8', 'C9', 'C10']],
  [ICONS.settings, 'Configuration du bot', ['C12']],
  [ICONS.shield, 'Secur', ['C14']],
];

/**
 * Lit les membres avant l'audit (rôles larges, administrateurs, bots) : seulement sur un serveur
 * de 25 000 membres au plus et si la dernière lecture date de plus de 10 min (15 s au plus).
 * @returns {Promise<boolean>} vrai si le cache est probablement partiel
 */
async function refreshMembers(guild, now = Date.now()) {
  const total = Number(guild.memberCount ?? 0);
  if (total <= AUDIT_LIMITS.fetchMaxMembers && now - (lastMemberFetch.get(guild.id) ?? 0) > MEMBER_FETCH_EVERY_MS && typeof guild.members?.fetch === 'function') {
    lastMemberFetch.delete(guild.id);
    lastMemberFetch.set(guild.id, now);
    while (lastMemberFetch.size > 1_000) lastMemberFetch.delete(lastMemberFetch.keys().next().value);
    await guild.members.fetch({ time: MEMBER_FETCH_TIMEOUT_MS }).catch((e) => logger.debug('Audit : lecture des membres impossible :', e?.message));
  }
  return (guild.members?.cache?.size ?? 0) < total;
}

/** Audit complet d'un serveur (analyze + accès en attente). */
function runAudit(client, guild, { partial = false } = {}) {
  const cfg = client.services.config.get(guild.id);
  return auditSecurity(guild, cfg, { groups: analyze(guild, cfg), pending: client.services.secur?.pendingGrants?.(guild.id) ?? [], partial });
}

const AUDIT_ICON = { ok: ICONS.success, warn: ICONS.warning, fail: ICONS.error, info: ICONS.info };

/** Ligne d'un contrôle (détails en retrait). Pur. */
function checkLine(c) {
  const head = `${AUDIT_ICON[c.level] ?? ICONS.info} **${c.id}** ${c.text}`;
  if (c.level === 'ok' || c.level === 'info' || !c.details?.length) return head;
  return `${head}\n${c.details.slice(0, 4).map((d) => subtext(truncate(String(d), 120))).join('\n')}${c.details.length > 4 ? `\n${subtext(`… et ${c.details.length - 4} autre(s)`)}` : ''}`;
}

/** Vue de l'audit de sécurité : 6 champs et 5 rangées au plus. Pure. */
function renderAudit(audit, { notice = null } = {}) {
  const byId = new Map(audit.checks.map((c) => [c.id, c]));
  const counts = { ok: 0, warn: 0, fail: 0 };
  for (const c of audit.checks) if (c.level in counts) counts[c.level] += 1;
  const tips = audit.checks.filter((c) => c.tip && c.level !== 'ok').map((c) => `› **${c.id}** ${c.tip}`);
  const fields = AUDIT_FIELDS.map(([icon, label, ids]) => {
    const list = ids.map((id) => byId.get(id)).filter(Boolean);
    const bad = list.filter((c) => c.level === 'warn' || c.level === 'fail').length;
    return wide(icon, `${label}${bad ? ` · ${bad} à corriger` : ''}`, truncate(list.map(checkLine).join('\n'), 1024));
  });
  fields.push(wide(ICONS.idea, `Corrections en un clic (${audit.fixes.length})`, truncate([
    ...audit.fixes.map((f) => `› ${f.label}`),
    ...(audit.fixes.length ? [] : ['*Aucune correction automatique disponible.*']),
    ...tips.slice(0, 4),
  ].join('\n'), 1024)));
  const g = audit.grade;
  return {
    embeds: [
      card({
        tone: g.tone,
        section: 'security',
        icon: ICONS.shield,
        title: 'Audit de sécurité',
        description: [
          notice ? `${notice}\n` : null,
          `Note **${g.letter}** (${g.label}) · score **${audit.score} %**`,
          `\`${progressBar(audit.score / 100, 18)}\``,
          subtext(`${counts.ok} OK · ${counts.warn} avertissement(s) · ${counts.fail} problème(s)${audit.partial ? ' · ≈ cache partiel des membres' : ''}`),
        ],
        fields: fields.slice(0, 6),
        footer: 'Chaque correction est confirmée, puis journalisée',
      }),
    ],
    components: buttonRows(
      ...audit.fixes.slice(0, 8).map((f) => actionButton({ command: 'diagnostics', action: 'fix', args: [f.id], label: truncate(f.label, 80), emoji: '🔧' })),
      actionButton({ command: 'diagnostics', action: 'audit', label: 'Relancer l\'audit', emoji: ICONS.refresh, style: ButtonStyle.Primary }),
      actionButton({ command: 'diagnostics', action: 'rerun', label: 'Diagnostic', emoji: ICONS.search }),
    ),
  };
}

/** Confirmation d'une correction : changements exacts. Pure. */
function renderFixConfirm(plan, user) {
  const shown = plan.changes.slice(0, 20);
  return {
    embeds: [
      card({
        tone: 'warning',
        section: 'security',
        icon: '🔧',
        title: `Correction : ${plan.label}`,
        description: [
          'Voici **exactement** ce qui sera modifié :',
          shown.map((c) => `› ${c}`).join('\n'),
          plan.changes.length > shown.length ? subtext(`… et ${plan.changes.length - shown.length} autre(s)`) : null,
          plan.remaining ? subtext(`${plan.remaining} autre(s) salon(s) au prochain clic (${AUDIT_LIMITS.overwritesPerFix} par correction).`) : null,
        ],
        fields: [field(ICONS.reason, 'Raison d\'audit', truncate(`Audit de sécurité par ${user.tag ?? user.username ?? user.id}`, 200))],
        footer: 'Le contrôle est recalculé juste avant d\'agir',
      }),
    ],
    components: buttonRows(
      actionButton({ command: 'diagnostics', action: 'fixok', args: [plan.id], label: 'Appliquer', emoji: ICONS.success, style: ButtonStyle.Danger }),
      actionButton({ command: 'diagnostics', action: 'audit', label: 'Retour', emoji: ICONS.back }),
    ),
  };
}

/** Administrateur exigé (audit et corrections). */
function assertAuditor(interaction) {
  if (!isAdministrator(interaction)) throw new UserError('L\'audit de sécurité est réservé aux membres ayant la permission **Administrateur**.');
}

/** Correction connue (catalogue FIXES, jamais une clé héritée). */
function fixOf(id) {
  if (typeof id !== 'string' || !Object.hasOwn(FIXES, id)) throw new UserError('Correction inconnue.');
  return FIXES[id];
}

/** Permissions du bot pour une correction (revérifiées au clic). */
function assertBotCan(guild, def) {
  const perms = guild.members?.me?.permissions;
  const missing = def.botPerms.filter((p) => !perms?.has?.(PermissionFlagsBits[p]));
  if (missing.length) throw new UserError(`Il me manque ${missing.map((p) => `**${permissionLabel(p)}**`).join(', ')} pour appliquer cette correction.`);
}

/**
 * Applique un plan de correction. Jamais un rôle au niveau ou au-dessus du bot, un rôle géré, ni
 * le propriétaire (aucune correction ne vise un membre). Raison d'audit sur chaque requête.
 * @returns {Promise<{ done: number, failed: number, errors: string[] }>}
 */
async function applyFix(guild, plan, reason) {
  const out = { done: 0, failed: 0, errors: [] };
  const run = async (fn) => {
    try {
      await fn();
      out.done += 1;
    } catch (e) {
      out.failed += 1;
      if (out.errors.length < 3) out.errors.push(String(e?.message ?? e).slice(0, 120));
    }
  };
  const top = guild.members?.me?.roles?.highest?.position ?? 0;
  switch (plan.id) {
    case 'everyone_perms': {
      const everyone = guild.roles.everyone;
      await run(() => everyone.setPermissions(everyone.permissions.remove(plan.bits.map((b) => PermissionFlagsBits[b])), reason));
      break;
    }
    case 'everyone_overwrites':
      for (const { channelId, bits } of plan.items ?? []) {
        const channel = guild.channels.cache.get(channelId);
        if (!channel?.permissionOverwrites) {
          out.failed += 1;
          continue;
        }
        await run(() => channel.permissionOverwrites.edit(guild.id, Object.fromEntries(bits.map((b) => [b, null])), { reason, type: 0 }));
      }
      break;
    case 'mentionable_roles':
      for (const id of plan.roleIds ?? []) {
        const role = guild.roles.cache.get(id);
        if (!role || role.managed || role.position >= top || role.id === guild.id) {
          out.failed += 1;
          continue;
        }
        await run(() => role.setMentionable(false, reason));
      }
      break;
    case 'verification_level':
      await run(() => guild.setVerificationLevel(GuildVerificationLevel.Medium, reason));
      break;
    case 'explicit_filter':
      await run(() => guild.setExplicitContentFilter(GuildExplicitContentFilter.AllMembers, reason));
      break;
    case 'default_notifications':
      await run(() => guild.setDefaultMessageNotifications(GuildDefaultMessageNotifications.OnlyMentions, reason));
      break;
    case 'safety_alerts':
      await run(() => guild.setSafetyAlertsChannel(plan.channelId, reason));
      break;
    default:
      throw new UserError('Correction inconnue.');
  }
  return out;
}

/**
 * Les réponses REST de discord.js ne mettent pas le cache à jour (rôle, serveur : c'est la
 * passerelle qui le fait) : la vue recalculée attend que le plan change, 2 s au plus.
 */
async function waitForCache(guild, recompute, plan, { timeout = 2_000, step = 50 } = {}) {
  const before = JSON.stringify(plan.changes);
  const until = Date.now() + timeout;
  for (let i = 0; Date.now() < until; i += 1) {
    const next = recompute();
    if (!next || JSON.stringify(next.changes) !== before) return true;
    // Les événements de la passerelle arrivent en général dans les tours suivants de la boucle.
    await new Promise((resolve) => (i < 20 ? setImmediate(resolve) : setTimeout(resolve, step)));
  }
  return false;
}

/** Carte du log server.securityFix. Pure. */
function fixLogCard(plan, user, res) {
  return card({
    tone: res.failed ? 'warning' : 'info',
    section: 'server',
    icon: '🔧',
    title: 'Correction de l\'audit de sécurité',
    description: truncate(plan.changes.slice(0, 15).map((c) => `• ${c}`).join('\n') + (plan.changes.length > 15 ? `\n… et ${plan.changes.length - 15} autre(s)` : ''), 3_000),
    fields: [
      field(ICONS.moderator, 'Par', userLine(user)),
      field(ICONS.check, 'Appliqué', `${res.done}${res.failed ? ` · ${res.failed} échec(s)` : ''}`),
      res.errors.length ? wide(ICONS.warning, 'Erreurs', res.errors.join('\n')) : null,
    ],
    footer: `ID : ${user.id}`,
  });
}

module.exports = {
  category: 'configuration',
  analyze,
  score,
  render,
  renderAudit,
  renderFixConfirm,
  applyFix,
  RECOMMENDED_PERMS,
  data: new SlashCommandBuilder()
    .setName('diagnostics')
    .setDescription('Analyse la configuration du serveur et détecte les problèmes.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
  /** @param {import('discord.js').ChatInputCommandInteraction} interaction */
  async execute(interaction, client) {
    const { guild } = interaction;
    await interaction.reply({ ...render(guild, client.services.config.get(guild.id), { admin: isAdministrator(interaction) }), ephemeral: true });
  },
  buttons: {
    /** cmd:diagnostics:rerun — relance l'analyse (Gérer le serveur requis). */
    async rerun(interaction, client) {
      if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
        throw new UserError('Il faut la permission **Gérer le serveur** pour relancer le diagnostic.');
      }
      await interaction.update(render(interaction.guild, client.services.config.get(interaction.guildId), { admin: isAdministrator(interaction) }));
    },
    /** cmd:diagnostics:audit — audit de sécurité (Administrateur ; lecture des membres : deferUpdate d'abord). */
    async audit(interaction, client) {
      assertAuditor(interaction);
      await interaction.deferUpdate();
      const partial = await refreshMembers(interaction.guild);
      await interaction.editReply(renderAudit(runAudit(client, interaction.guild, { partial })));
    },
    /** cmd:diagnostics:fix:<id> — confirmation : changements exacts (rien n'est modifié). */
    async fix(interaction, client, [id]) {
      assertAuditor(interaction);
      const def = fixOf(id);
      assertBotCan(interaction.guild, def);
      const cfg = client.services.config.get(interaction.guildId);
      const plan = fixPlan(interaction.guild, cfg, id, { groups: analyze(interaction.guild, cfg) });
      if (!plan) {
        await interaction.update(renderAudit(runAudit(client, interaction.guild), { notice: `${ICONS.info} Plus rien à corriger pour « ${def.label} ».` }));
        return;
      }
      await interaction.update(renderFixConfirm(plan, interaction.user));
    },
    /**
     * cmd:diagnostics:fixok:<id> — applique la correction : Administrateur et permissions du bot
     * revérifiés, verrou par serveur, contrôle recalculé juste avant d'agir ; réponse puis log.
     */
    async fixok(interaction, client, [id]) {
      assertAuditor(interaction);
      const def = fixOf(id);
      const { guild } = interaction;
      assertBotCan(guild, def);
      if (fixing.has(guild.id)) throw new UserError('Une correction est déjà en cours sur ce serveur : patientez un instant.');
      fixing.add(guild.id);
      try {
        await interaction.deferUpdate();
        const cfg = client.services.config.get(guild.id);
        const plan = fixPlan(guild, cfg, id, { groups: analyze(guild, cfg) });
        if (!plan) {
          await interaction.editReply(renderAudit(runAudit(client, guild), { notice: `${ICONS.info} Déjà corrigé : « ${def.label} ».` }));
          return;
        }
        const reason = truncate(`Audit de sécurité par ${interaction.user.tag ?? interaction.user.username ?? interaction.user.id}`, 400);
        const res = await applyFix(guild, plan, reason);
        if (res.done) await waitForCache(guild, () => fixPlan(guild, client.services.config.get(guild.id), id, { groups: analyze(guild, client.services.config.get(guild.id)) }), plan);
        const notice = res.failed
          ? `${ICONS.warning} « ${def.label} » : ${res.done} modification(s), ${res.failed} échec(s).`
          : `${ICONS.success} « ${def.label} » : ${res.done} modification(s) appliquée(s).`;
        await interaction.editReply(renderAudit(runAudit(client, guild), { notice }));
        if (res.done || res.failed) await Promise.resolve(client.services.logging?.send?.(guild.id, 'server', fixLogCard(plan, interaction.user, res), undefined, { event: 'securityFix' })).catch(() => {});
      } finally {
        fixing.delete(guild.id);
      }
    },
  },
};
