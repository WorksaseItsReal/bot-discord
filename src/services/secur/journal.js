'use strict';

const { escapeMarkdown } = require('discord.js');
const { card, field, wide, ICONS, userLine, fitEmbeds } = require('../../utils/ui');
const { MODULE_KEYS, SECUR_MODULES, MODES, PUNISH_ORDER, moduleConfig, effectiveLimit } = require('../../utils/secur');

/** Événements de la catégorie Sécurité dont la coupure est critique. */
const SECURITY_EVENTS = ['antiraid', 'secur', 'securConfig', 'securGrant'];
/** Seuils de destruction historiques. */
const THRESHOLDS = { channelDeleteThreshold: 'Salons supprimés', roleDeleteThreshold: 'Rôles supprimés', banThreshold: 'Bannissements', kickThreshold: 'Expulsions' };

const arr = (v) => (Array.isArray(v) ? v : []);
const added = (before, after) => arr(after).filter((x) => !arr(before).includes(x));
const sameSet = (a, b) => arr(a).length === arr(b).length && arr(a).every((x) => arr(b).includes(x));

/**
 * Changements CRITIQUES entre deux configurations (complètes ou partielles). Pur.
 * Liste : AntiRaid coupé, sanction de l'auteur passée à « Aucune », seuil de destruction mis à
 * 0, ajout dans la whitelist, module Secur abaissé (mode, sanction, annulation, limite) ou
 * préréglage off, owners ou bots de confiance modifiés, verrou retiré, notifyOwner coupé, logs
 * coupés, catégorie Sécurité ou événements antiraid/secur coupés, salon des logs sécurité ou
 * salon d'alerte modifié.
 * @returns {string[]} libellés français (vide : rien de critique)
 */
function classifyCritical(before = {}, after = {}) {
  const out = [];
  const ab = before.antiraid ?? {};
  const aa = after.antiraid ?? {};
  if (ab.enabled === true && aa.enabled === false) out.push('AntiRaid désactivé');
  if (aa.punishExecutor === 'none' && ab.punishExecutor !== 'none' && ab.punishExecutor !== undefined) out.push('Sanction de l\'auteur d\'actions destructrices : Aucune');
  for (const [key, label] of Object.entries(THRESHOLDS)) {
    if (Number(ab[key]) > 0 && aa[key] === 0) out.push(`Seuil « ${label} » désactivé (0)`);
  }
  const wb = before.whitelist ?? {};
  const wa = after.whitelist ?? {};
  const users = added(wb.users, wa.users);
  const roles = added(wb.roles, wa.roles);
  if (users.length) out.push(`Whitelist : ${users.map((u) => `<@${u}>`).join(', ')} ajouté(s)`);
  if (roles.length) out.push(`Whitelist : ${roles.map((r) => `<@&${r}>`).join(', ')} ajouté(s)`);

  const sb = before.secur ?? {};
  const sa = after.secur ?? {};
  if (sb.modules || sa.modules) {
    const lowered = [];
    for (const key of MODULE_KEYS) {
      if (!sa.modules?.[key] && !sb.modules?.[key]) continue;
      const mb = moduleConfig(before, key);
      const ma = moduleConfig(after, key);
      const reasons = [];
      if (MODES.indexOf(ma.mode) < MODES.indexOf(mb.mode)) reasons.push(`${mb.mode} → ${ma.mode}`);
      if (PUNISH_ORDER.indexOf(ma.punish) < PUNISH_ORDER.indexOf(mb.punish)) reasons.push(`sanction ${mb.punish} → ${ma.punish}`);
      if (mb.undo === true && ma.undo === false) reasons.push('annulation coupée');
      const lb = effectiveLimit(before, key);
      const la = effectiveLimit(after, key);
      if (la > lb) reasons.push(`limite ${lb} → ${la}`);
      if (reasons.length) lowered.push(`${SECUR_MODULES[key].label} (${reasons.join(', ')})`);
    }
    const allOff = MODULE_KEYS.every((k) => moduleConfig(after, k).mode === 'off') && MODULE_KEYS.some((k) => moduleConfig(before, k).mode !== 'off');
    if (allOff) out.push('Secur : préréglage off (tous les modules coupés)');
    else if (lowered.length) out.push(`Secur abaissé : ${lowered.slice(0, 6).join(' ; ')}${lowered.length > 6 ? ` ; +${lowered.length - 6}` : ''}`);
  }
  if ((sb.owners !== undefined || sa.owners !== undefined) && !sameSet(sb.owners, sa.owners)) out.push('Owners de sécurité modifiés');
  if ((sb.trustedBots !== undefined || sa.trustedBots !== undefined) && !sameSet(sb.trustedBots, sa.trustedBots)) out.push('Bots de confiance modifiés');
  if (sb.verrou === true && sa.verrou === false) out.push('Verrou de Secur retiré');
  if (sb.notifyOwner !== false && sa.notifyOwner === false && 'notifyOwner' in sa) out.push('Messages privés au propriétaire coupés');

  const lb = before.logs ?? {};
  const la = after.logs ?? {};
  if (lb.enabled !== false && la.enabled === false) out.push('Logs désactivés');
  if (added(lb.disabledCategories, la.disabledCategories).includes('security')) out.push('Catégorie de logs Sécurité mise en pause');
  const cut = added(lb.disabledEvents, la.disabledEvents).filter((e) => SECURITY_EVENTS.includes(e));
  if (cut.length) out.push(`Événements de sécurité coupés : ${cut.join(', ')}`);
  const cb = before.logChannels ?? {};
  const ca = after.logChannels ?? {};
  if ('security' in ca && (cb.security ?? null) !== (ca.security ?? null)) out.push('Salon des logs Sécurité modifié');
  if ('alertChannel' in aa && (ab.alertChannel ?? null) !== (aa.alertChannel ?? null)) out.push('Salon d\'alerte AntiRaid modifié');
  return out;
}

/** Valeur lisible d'un réglage (journal). Pur. */
function show(value) {
  if (value === null || value === undefined || value === '') return '—';
  if (Array.isArray(value)) return value.length ? value.slice(0, 5).map((v) => (/^\d{17,20}$/.test(String(v)) ? `\`${v}\`` : String(v))).join(', ') + (value.length > 5 ? ` +${value.length - 5}` : '') : 'aucun';
  if (typeof value === 'boolean') return value ? 'oui' : 'non';
  if (typeof value === 'object') return '…';
  return String(value).slice(0, 60);
}

/**
 * Lignes « chemin : avant → après » des réglages de sécurité modifiés (antiraid, whitelist,
 * secur, logs, salons sécurité). Pur. Au plus 25 lignes.
 */
function diffLines(before = {}, after = {}) {
  const lines = [];
  const walk = (b, a, path) => {
    if (lines.length >= 25) return;
    const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
    if (isObj(b) || isObj(a)) {
      for (const key of new Set([...Object.keys(b ?? {}), ...Object.keys(a ?? {})])) {
        if (isObj(a) && !(key in a)) continue; // patch partiel : clé non modifiée
        walk(b?.[key], a?.[key], path ? `${path}.${key}` : key);
      }
      return;
    }
    if (JSON.stringify(b ?? null) === JSON.stringify(a ?? null)) return;
    lines.push(`${path} : ${show(b)} → ${show(a)}`);
  };
  for (const section of ['antiraid', 'whitelist', 'secur', 'logs']) {
    if (after[section] !== undefined) walk(before[section], after[section], section);
  }
  if (after.logChannels && 'security' in after.logChannels) walk(before.logChannels?.security, after.logChannels.security, 'logChannels.security');
  return lines;
}

/** Carte du journal des réglages de sécurité. Pure. */
function journalCard({ actor, actorId, source, lines, critical }) {
  return card({
    tone: critical.length ? 'danger' : 'caution',
    section: 'security',
    icon: critical.length ? ICONS.warning : ICONS.settings,
    title: critical.length ? 'Réglage de sécurité critique modifié' : 'Réglages de sécurité modifiés',
    description: [
      critical.length ? critical.map((c) => `**${c}**`).join('\n') : null,
      lines.length ? lines.map((l) => `• ${l}`).join('\n').slice(0, 3_000) : null,
    ].filter(Boolean).join('\n\n') || 'Aucun changement lisible.',
    fields: [
      field(ICONS.moderator, 'Par', actor ? userLine(actor) : actorId ? `<@${actorId}>` : '*Inconnu*'),
      source ? field(ICONS.settings, 'Depuis', String(source).slice(0, 100)) : null,
      critical.length ? wide(ICONS.info, 'Si ce n\'était pas prévu', 'Revenez sur le réglage avec /secur ou /antiraid, et vérifiez qui a accès à l\'administration du serveur.') : null,
    ],
    footer: actorId ? `ID : ${actorId}` : undefined,
  });
}

/**
 * Publie le journal d'un changement de réglages de sécurité (log security « securConfig »). Un
 * changement critique part EN PLUS comme alerte (hors filtres des logs) dans le salon tel qu'il
 * était AVANT le changement, avec MP (jamais au propriétaire s'il en est l'auteur). Couper
 * notifyOwner vaut un dernier MP au propriétaire.
 * @param {{ client: object, logging: object, notifier: import('./notify').SecurNotifier, config: object }} deps
 * @param {import('discord.js').Guild} guild
 * @param {{ actorId?: string|null, actor?: object|null, source?: string, before?: object, after?: object, changes?: string[] }} entry
 *   before / after : configurations complètes (config.get) ou partielles avec les mêmes clés
 * @returns {Promise<{ critical: string[], lines: string[] }>}
 */
async function record({ client, logging, notifier, config }, guild, { actorId = null, actor = null, source = null, before = {}, after = {}, changes = null } = {}) {
  const lines = (Array.isArray(changes) && changes.length ? changes : diffLines(before, after)).filter(Boolean);
  const critical = classifyCritical(before, after);
  if (!guild?.id || (!lines.length && !critical.length)) return { critical, lines };
  const embed = journalCard({ actor, actorId, source, lines, critical });
  if (!critical.length) {
    await Promise.resolve(logging?.send?.(guild.id, 'security', embed, undefined, { event: 'securConfig' })).catch(() => false);
    return { critical, lines };
  }
  const current = config?.get?.(guild.id) ?? {};
  const pick = (b, c) => (b !== undefined ? b : c);
  await notifier?.deliver?.(guild, { embed }, {
    critical: true,
    fallback: true,
    event: 'securConfig',
    fingerprint: `journal:${critical.join('|')}:${lines.join('|')}`.slice(0, 500),
    channels: {
      alert: pick(before.antiraid?.alertChannel, current.antiraid?.alertChannel ?? null),
      security: pick(before.logChannels?.security, current.logChannels?.security ?? null),
    },
    skipDm: actorId && actorId === guild.ownerId ? [guild.ownerId] : [],
  });
  // Dernier MP au propriétaire quand il coupe ses propres MP de sécurité.
  if (before.secur?.notifyOwner !== false && after.secur?.notifyOwner === false && guild.ownerId) {
    const owner = await client?.users?.fetch?.(guild.ownerId).catch(() => null);
    await owner?.send?.({
      content: `${ICONS.info} Vous ne recevrez plus de messages privés de sécurité pour **${escapeMarkdown(String(guild.name ?? guild.id)).slice(0, 100)}**. Réactivez-les avec /secur.`,
      embeds: fitEmbeds([embed]),
      allowedMentions: { parse: [] },
    }).catch(() => {});
  }
  return { critical, lines };
}

module.exports = { classifyCritical, diffLines, journalCard, record, SECURITY_EVENTS };
