'use strict';

const { ButtonBuilder, ButtonStyle } = require('discord.js');
const { card, field, wide, ICONS, userLine, actionButton, buttonRows } = require('../../utils/ui');
const { discordTimestamp } = require('../../utils/time');
const { SECUR_MODULES, own } = require('../../utils/secur');

/** Libellés des sanctions Secur. */
const PUNISH_LABELS = Object.freeze({ none: 'Aucune (alerte seule)', derank: 'Rôles retirés', kick: 'Expulsion', ban: 'Bannissement', pending: 'En cours…' });

const moduleLabel = (key) => (own(SECUR_MODULES, key) ? `${SECUR_MODULES[key].emoji} ${SECUR_MODULES[key].label}` : key);

/** Bouton persistant du préfixe « secur: » (src/components/secur.js). */
function securButton(id, label, emoji, style = ButtonStyle.Secondary) {
  return new ButtonBuilder().setCustomId(id).setLabel(label).setEmoji(emoji).setStyle(style);
}

/** Bouton « Ouvrir Secur » : réponse éphémère (jamais de remplacement de la carte publique). */
function openSecurButton(view = 'home') {
  return actionButton({ command: 'secur', action: 'open', args: [view], label: 'Ouvrir Secur', emoji: ICONS.shield });
}

/**
 * Carte d'incident Secur. Pure.
 * @param {{ id: number, executorId: string, executor?: object|null, modules: string[], actions: number, punishment: string,
 *   details?: string[], undone?: number, undoFailed?: number, undoTotal?: number|null, restoredBy?: string|null, restoredAt?: number|null,
 *   restoreKind?: 'roles'|'unban'|null, botPending?: boolean, botKicked?: string|null, createdAt?: number }} view
 */
function incidentCard(view) {
  const undoTotal = view.undoTotal ?? ((view.undone ?? 0) + (view.undoFailed ?? 0));
  const bot = view.botPending && !view.botKicked;
  return card({
    tone: 'danger',
    section: 'security',
    icon: bot ? ICONS.bot : '🚨',
    title: bot ? 'Bot non neutralisé automatiquement' : 'Incident Secur',
    description: bot
      ? `<@${view.executorId}> (bot) a déclenché la protection anti-nuke. Il est arrivé il y a longtemps : il n'a **pas** été expulsé automatiquement (réglage « bot auteur »). Vérifiez-le et expulsez-le si besoin.`
      : `<@${view.executorId}> a déclenché la protection anti-nuke.`,
    fields: [
      field(ICONS.user, 'Auteur', view.executor ? userLine(view.executor) : `<@${view.executorId}>`),
      field('💣', 'Actions', `×**${view.actions ?? 1}**`),
      field(ICONS.shield, 'Sanction', PUNISH_LABELS[view.punishment] ?? view.punishment),
      wide('🧩', 'Modules', (view.modules ?? []).map(moduleLabel).join(', ') || '—'),
      field(ICONS.refresh, 'Annulations', undoTotal ? `**${view.undone ?? 0}**/${undoTotal}${view.undoFailed ? ` · ${view.undoFailed} échec(s)` : ''}` : 'Aucune'),
      view.details?.length ? wide(ICONS.warning, 'Détails', view.details.join('\n').slice(0, 1_000)) : null,
      view.botKicked ? wide(ICONS.kick, 'Bot expulsé', `Par <@${view.botKicked}>.`) : null,
      view.restoredBy ? wide(ICONS.success, view.restoreKind === 'unban' ? 'Débanni' : 'Rôles rendus', `Par <@${view.restoredBy}>${view.restoredAt ? ` ${discordTimestamp(view.restoredAt, 'R')}` : ''}.`) : null,
    ],
    footer: `Incident #${view.id} · ID : ${view.executorId}`,
  });
}

/** Boutons d'une carte d'incident. Pur. */
function incidentButtons(view) {
  const buttons = [];
  if (!view.restoredBy && view.restoreKind === 'roles') buttons.push(securButton(`secur:restore:${view.id}`, 'Rendre les rôles', '🎭', ButtonStyle.Success));
  if (!view.restoredBy && view.restoreKind === 'unban') buttons.push(securButton(`secur:restore:${view.id}`, 'Débannir', ICONS.unlock, ButtonStyle.Success));
  if (view.botPending && !view.botKicked) buttons.push(securButton(`secur:kickbot:${view.executorId}`, 'Expulser ce bot', ICONS.kick, ButtonStyle.Danger));
  buttons.push(openSecurButton('home'));
  return buttonRows(...buttons);
}

/** Vue d'une carte d'incident à partir de sa ligne en base. Pure. */
function viewFromRow(row) {
  const removed = Array.isArray(row.removed_roles) ? row.removed_roles : [];
  return {
    id: row.id,
    executorId: row.executor_id,
    modules: row.modules ?? [],
    actions: row.actions,
    punishment: row.punishment,
    details: String(row.outcome ?? '').split('\n').filter((l) => l && l !== 'ok'),
    undone: row.undone,
    undoFailed: row.undo_failed,
    restoredBy: row.restored_by,
    restoredAt: row.restored_at,
    restoreKind: row.punishment === 'ban' ? 'unban' : row.punishment === 'derank' && removed.length ? 'roles' : null,
  };
}

/** Description d'un accès de whitelist en attente. Pure. */
function grantText(g) {
  if (g.kind === 'role') return `<@${g.granted_by}> a donné le rôle whitelisté <@&${g.role_id}> à <@${g.subject_id}>.`;
  if (g.kind === 'user') return `<@${g.granted_by}> a ajouté <@${g.subject_id}> à la whitelist.`;
  return `<@${g.granted_by}> a ajouté le rôle <@&${g.subject_id}> à la whitelist.`;
}

/**
 * Carte d'un accès de whitelist en attente (ou tranché). Pure.
 * @param {object} g ligne security_grants
 * @param {{ ttlMs: number }} opts
 */
function grantCard(g, { ttlMs }) {
  const decided = g.approved_at ? 'approved' : g.revoked_at ? 'revoked' : null;
  return card({
    tone: decided === 'approved' ? 'success' : decided === 'revoked' ? 'neutral' : 'warning',
    section: 'security',
    icon: '🔐',
    title: decided === 'approved' ? 'Accès de whitelist approuvé' : decided === 'revoked' ? 'Accès de whitelist révoqué' : 'Accès de whitelist en attente',
    description: [
      grantText(g),
      decided
        ? null
        : `Tant qu'un owner ne l'approuve pas (24 h au plus), cet accès **n'exempte pas** de l'AntiRaid ni de Secur.`,
    ],
    fields: [
      field(ICONS.user, 'Bénéficiaire', g.kind === 'wlrole' ? `<@&${g.subject_id}>` : `<@${g.subject_id}>`),
      field(ICONS.moderator, 'Par', `<@${g.granted_by}>`),
      decided
        ? field(decided === 'approved' ? ICONS.success : ICONS.delete, decided === 'approved' ? 'Approuvé par' : 'Révoqué par', `<@${g.approved_by ?? g.revoked_by}>`)
        : field(ICONS.expires, 'Exempte au plus tard', discordTimestamp(g.granted_at + ttlMs, 'R')),
    ],
    footer: `Accès #${g.id}`,
  });
}

/** Boutons d'un accès en attente (aucun une fois tranché). Pur. */
function grantButtons(g) {
  if (g.approved_at || g.revoked_at) return [];
  return buttonRows(
    securButton(`secur:grant:${g.id}:approve`, 'Approuver', ICONS.success, ButtonStyle.Success),
    securButton(`secur:grant:${g.id}:revoke`, 'Révoquer', ICONS.delete, ButtonStyle.Danger),
  );
}

/** Carte « conflit d'annulation » (disjoncteur). Pure. */
function conflictCard({ moduleKey, targetKey, until }) {
  return card({
    tone: 'warning',
    section: 'security',
    icon: ICONS.warning,
    title: 'Conflit d\'annulation : un autre bot défait-il nos corrections ?',
    description: `Le même objet a été restauré **3 fois en une minute** : le module **${moduleLabel(moduleKey)}** suspend ses annulations sur ce serveur jusqu'à ${discordTimestamp(until, 'T')} (la détection et les sanctions continuent).`,
    fields: [
      wide(ICONS.info, 'Que faire ?', 'Un autre bot de sécurité annule probablement nos corrections. Ajoutez-le aux bots de confiance (/secur confiance) ou coupez l\'un des deux anti-nuke.'),
      targetKey ? field(ICONS.id, 'Objet', `\`${String(targetKey).slice(0, 60)}\``) : null,
    ],
  });
}

/** Carte du journal « tentative bloquée » (pré-contrôle). Pure. */
function blockedCard({ userId, label, count, limit }) {
  return card({
    tone: 'warning',
    section: 'security',
    icon: ICONS.lock,
    title: 'Action bloquée par la sécurité',
    description: `<@${userId}> a tenté **${count}** action(s) « ${label} » : le seuil (${limit}) aurait été atteint. Rien n'a été fait.`,
    fields: [field(ICONS.user, 'Auteur', `<@${userId}>`), field(ICONS.count, 'Actions demandées', String(count)), field(ICONS.warning, 'Seuil', String(limit))],
    footer: `ID : ${userId}`,
  });
}

/** Carte du journal : bot expulsé depuis une alerte (bouton secur:kickbot). Pure. */
function botKickedCard({ botId, by }) {
  return card({
    tone: 'caution',
    section: 'security',
    icon: ICONS.kick,
    title: 'Bot expulsé depuis une alerte',
    description: `<@${by}> a expulsé le bot <@${botId}> depuis une alerte de sécurité.`,
    fields: [field(ICONS.bot, 'Bot', `<@${botId}>`), field(ICONS.moderator, 'Par', `<@${by}>`)],
    footer: `ID : ${botId}`,
  });
}

module.exports = {
  PUNISH_LABELS,
  botKickedCard,
  moduleLabel,
  securButton,
  openSecurButton,
  incidentCard,
  incidentButtons,
  viewFromRow,
  grantText,
  grantCard,
  grantButtons,
  conflictCard,
  blockedCard,
};
