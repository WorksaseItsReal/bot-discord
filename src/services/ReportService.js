'use strict';

const { ChannelType } = require('discord.js');
const { truncate } = require('../utils/embeds');
const { discordTimestamp } = require('../utils/time');
const { card, field, wide, ICONS, code, subtext, actionButton, linkButton, buttonRows, ButtonStyle, fitEmbeds } = require('../utils/ui');
const { historyButton } = require('./ModerationService');
const { logCard, REQUIRED_PERMISSIONS } = require('./LoggingService');
const { UserError } = require('../core/errors');
const { createLogger } = require('../core/logger');

const logger = createLogger('reports');

/** Délai minimal entre deux signalements d'un même membre. */
const REPORT_COOLDOWN_MS = 30_000;
/** Longueur maximale de la raison donnée par le signaleur. */
const MAX_REPORT_REASON = 500;
/** Longueur de la copie du message conservée (base et carte). */
const MAX_CONTENT = 1500;
const MAX_ATTACHMENTS = 10;
/** Durée du timeout appliqué depuis la carte d'un signalement. */
const REPORT_TIMEOUT_MS = 10 * 60 * 1000;
const REPORT_ICON = '🚩';
const ANONYMOUS = '🕵️ *Anonyme*';

/** Présentation des statuts. */
const STATUS = {
  open: { emoji: '🟢', label: 'Ouvert', tone: 'warning' },
  handled: { emoji: ICONS.success, label: 'Traité', tone: 'success' },
  dismissed: { emoji: '🚫', label: 'Rejeté', tone: 'neutral' },
};

/** Actions du staff enregistrées sur un signalement. */
const ACTIONS = {
  delete: { emoji: ICONS.delete, label: 'Message supprimé' },
  warn: { emoji: ICONS.warn, label: 'Membre averti' },
  timeout: { emoji: ICONS.mute, label: 'Timeout de 10 min' },
};

const TEXT_TYPES = [ChannelType.GuildText, ChannelType.GuildAnnouncement];

/** Lien vers un message. Pur. */
function messageLink(guildId, channelId, messageId) {
  return `https://discord.com/channels/${guildId}/${channelId}/${messageId}`;
}

/** Copie d'un message pour le signalement : texte tronqué + noms des pièces jointes. Pur. */
function excerpt(message) {
  let content = String(message?.content ?? '').trim();
  const embeds = message?.embeds?.length ?? 0;
  if (!content && embeds) content = `[${embeds} intégration(s) sans texte]`;
  const attachments = [...(message?.attachments?.values?.() ?? [])].map((a) => truncate(a.name ?? 'fichier', 100)).slice(0, MAX_ATTACHMENTS);
  return { content: content ? truncate(content, MAX_CONTENT) : null, attachments };
}

/** Raison du signaleur nettoyée (facultative, ≤ 500 caractères). Pur. */
function normalizeReportReason(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return null;
  if (text.length > MAX_REPORT_REASON) throw new UserError(`La raison est trop longue (${MAX_REPORT_REASON} caractères maximum).`);
  return text;
}

/** Texte cité (« > ») qui tient dans un champ d'embed. Pur. */
function quote(text, max = 1000) {
  return truncate(text, max - 40).split('\n').map((l) => `> ${l}`).join('\n');
}

/**
 * Signalements de messages : destination (salon du staff), carte, enregistrement et logs.
 * Les actions de modération (avertir, timeout) passent par ModerationService (hiérarchie,
 * DM, sanction enregistrée, log) depuis les boutons de /signalements.
 */
class ReportService {
  /**
   * @param {object} deps
   * @param {import('../database/repositories/ReportRepository').ReportRepository} deps.reports
   * @param {import('./ConfigService').ConfigService} deps.config
   * @param {import('./LoggingService').LoggingService} deps.logging
   */
  constructor({ reports, config, logging }) {
    this.reports = reports;
    this.config = config;
    this.logging = logging;
    /** Actions en cours (anti double clic) : `<guildId>:<id>:<action>`. */
    this.pending = new Set();
  }

  settings(guildId) {
    return this.config.get(guildId).reports ?? {};
  }

  /**
   * Salon qui reçoit les cartes : salon des signalements, sinon salon de logs Modération.
   * @returns {{ channel: object|null, channelId: string|null, fallback: boolean, status: 'ok'|'unset'|'missing'|'noperm' }}
   */
  destination(guild) {
    const cfg = this.config.get(guild.id);
    const fallback = !cfg.reports?.channelId;
    const channelId = cfg.reports?.channelId ?? cfg.logChannels?.moderation ?? null;
    if (!channelId) return { channel: null, channelId: null, fallback, status: 'unset' };
    const channel = guild.channels?.cache?.get(channelId);
    if (!channel || !TEXT_TYPES.includes(channel.type)) return { channel: null, channelId, fallback, status: 'missing' };
    const me = guild.members?.me;
    const perms = me && typeof channel.permissionsFor === 'function' ? channel.permissionsFor(me) : null;
    if (perms && !perms.has(REQUIRED_PERMISSIONS)) return { channel: null, channelId, fallback, status: 'noperm' };
    return { channel, channelId, fallback, status: 'ok' };
  }

  /** Lève une UserError si les signalements ne peuvent pas être reçus sur ce serveur. */
  assertAvailable(guild) {
    if (this.settings(guild.id).enabled === false) throw new UserError('Les signalements sont désactivés sur ce serveur.');
    const dest = this.destination(guild);
    if (dest.status === 'ok') return dest;
    if (dest.status === 'unset') throw new UserError('Les signalements ne sont pas encore configurés sur ce serveur. Prévenez un administrateur (`/signalements`).');
    throw new UserError('Le salon des signalements est introuvable ou inaccessible pour moi. Prévenez un administrateur (`/signalements`).');
  }

  /**
   * Refus anti-abus avant d'ouvrir le formulaire ou d'enregistrer : bot, soi-même,
   * message système, signalement déjà ouvert.
   */
  assertReportable(guildId, reporterId, message) {
    const author = message?.author;
    if (!author) throw new UserError('Ce message est introuvable.');
    if (message.system) throw new UserError('Impossible de signaler un message système.');
    if (author.bot || message.webhookId) throw new UserError('Impossible de signaler le message d\'un bot ou d\'un webhook.');
    if (author.id === reporterId) throw new UserError('Vous ne pouvez pas signaler votre propre message.');
    if (this.reports.findOpen(guildId, reporterId, message.id)) {
      throw new UserError('Vous avez déjà signalé ce message : l\'équipe de modération va l\'examiner.');
    }
  }

  /**
   * Enregistre un signalement, publie sa carte dans le salon du staff et le journalise.
   * Carte impossible à publier : le signalement est supprimé et une UserError est levée.
   * @returns {Promise<object>} signalement enregistré
   */
  async submit(guild, { reporter, message, reason }) {
    const dest = this.assertAvailable(guild);
    const { content, attachments } = excerpt(message);
    const id = this.reports.create({
      guildId: guild.id,
      reporterId: reporter.id,
      targetId: message.author.id,
      channelId: message.channelId ?? message.channel?.id,
      messageId: message.id,
      content,
      attachments,
      reason,
    });
    if (!id) throw new UserError('Vous avez déjà signalé ce message : l\'équipe de modération va l\'examiner.');
    const report = this.reports.get(guild.id, id);
    const settings = this.settings(guild.id);
    const role = settings.pingRoleId && settings.pingRoleId !== guild.id && guild.roles?.cache?.has(settings.pingRoleId) ? settings.pingRoleId : null;
    try {
      const sent = await dest.channel.send({
        ...(role ? { content: `<@&${role}>` } : {}),
        ...this.cardPayload(guild, report, { fit: true }),
        allowedMentions: role ? { parse: [], roles: [role] } : { parse: [] },
      });
      this.reports.setCard(guild.id, id, sent.channelId ?? dest.channel.id, sent.id);
    } catch (err) {
      logger.debug(`Carte de signalement non publiée (${guild.id}) :`, err?.message);
      this.reports.delete(guild.id, id);
      throw new UserError('Je n\'ai pas pu transmettre le signalement au salon du staff. Prévenez un administrateur (`/signalements`).');
    }
    const saved = this.reports.get(guild.id, id);
    await this.log(guild, saved, { title: 'Nouveau signalement', description: `<@${saved.reporter_id}> a signalé un message de <@${saved.target_id}>.` });
    return saved;
  }

  /**
   * Carte du signalement (salon du staff) : auteur, signaleur (ou anonyme), contenu,
   * pièces jointes, raison, statut et actions déjà effectuées, boutons du staff.
   * @param {{ fit?: boolean }} [opts] fit : embeds prêts pour un envoi direct (channel.send)
   */
  cardPayload(guild, report, { fit = false } = {}) {
    const showReporter = this.settings(guild.id).showReporter !== false;
    const st = STATUS[report.status] ?? STATUS.open;
    const done = new Set(report.actions.map((a) => a.type));
    const deleted = done.has('delete');
    const closedBy = report.handled_by ? ` par <@${report.handled_by}> ${discordTimestamp(report.handled_at, 'R')}` : '';
    const link = messageLink(guild.id, report.channel_id, report.message_id);
    const embed = card({
      tone: st.tone,
      section: 'moderation',
      icon: REPORT_ICON,
      title: `Signalement #${report.id}`,
      description: [
        `${st.emoji} **${st.label}**${report.status === 'open' ? '' : closedBy}`,
        deleted ? `${ICONS.delete} Le message a été supprimé.` : `${ICONS.link} [Aller au message](${link})`,
      ],
      fields: [
        field(ICONS.user, 'Auteur du message', `<@${report.target_id}>\n${code(report.target_id)}`),
        field(REPORT_ICON, 'Signalé par', showReporter ? `<@${report.reporter_id}>` : ANONYMOUS),
        field(ICONS.channel, 'Salon', `<#${report.channel_id}>`),
        wide('💬', 'Contenu', report.content ? quote(report.content) : '*Aucun texte*'),
        report.attachments.length ? wide('📎', `Pièces jointes (${report.attachments.length})`, report.attachments.map((n) => `\`${n.replace(/`/g, 'ˋ')}\``).join('\n')) : null,
        wide(ICONS.reason, 'Raison du signalement', report.reason ? truncate(report.reason, 1000) : '*Aucune raison fournie*'),
        report.actions.length
          ? wide('🛠️', 'Actions du staff', report.actions.map((a) => `${ACTIONS[a.type]?.emoji ?? '•'} ${ACTIONS[a.type]?.label ?? a.type} · <@${a.by}> ${discordTimestamp(a.at, 'R')}${a.note ? `\n${subtext(truncate(a.note, 200))}` : ''}`).join('\n'))
          : null,
      ],
      footer: `Signalement #${report.id}${showReporter ? '' : ' · signaleur masqué'}`,
      timestamp: report.created_at,
    });
    const dismissed = report.status === 'dismissed';
    const act = (action, label, emoji, style = ButtonStyle.Secondary) => actionButton({ command: 'signalements', action, args: [report.id], label, emoji, style });
    const components = buttonRows(
      !dismissed && !deleted ? act('del', 'Supprimer le message', ICONS.delete, ButtonStyle.Danger) : null,
      !dismissed && !done.has('warn') ? act('warn', 'Avertir', ICONS.warn) : null,
      !dismissed && !done.has('timeout') ? act('mute', 'Timeout 10 min', ICONS.mute) : null,
      report.status === 'open' ? actionButton({ command: 'signalements', action: 'resolve', args: [report.id, 'handled'], label: 'Classer', emoji: ICONS.success, style: ButtonStyle.Success }) : null,
      report.status === 'open' ? actionButton({ command: 'signalements', action: 'resolve', args: [report.id, 'dismissed'], label: 'Rejeter', emoji: '🚫' }) : null,
      deleted ? null : linkButton('Message', link, ICONS.link),
      historyButton(report.target_id),
    );
    return { embeds: fit ? fitEmbeds([embed]) : [embed], components };
  }

  /** Signalement de ce serveur, ou UserError. */
  get(guildId, id) {
    const report = this.reports.get(guildId, id);
    if (!report) throw new UserError(`Le signalement ${code(`#${id}`)} est introuvable.`);
    return report;
  }

  /**
   * Exécute une action du staff une seule fois à la fois (double clic) et l'enregistre :
   * le signalement encore ouvert passe « traité » par son auteur.
   * @param {{ type: 'delete'|'warn'|'timeout', moderator: { id: string }, run: () => Promise<string|void> }} opts
   *   run renvoie une précision facultative (ex. escalade appliquée)
   * @returns {Promise<object>} signalement mis à jour
   */
  async act(guild, report, { type, moderator, run }) {
    if (report.status === 'dismissed') throw new UserError('Ce signalement a été rejeté : rouvrez-en un nouveau si nécessaire.');
    if (report.actions.some((a) => a.type === type)) throw new UserError(`Déjà fait : ${ACTIONS[type].label.toLowerCase()}.`);
    const key = `${guild.id}:${report.id}:${type}`;
    if (this.pending.has(key)) throw new UserError('Cette action est déjà en cours.');
    this.pending.add(key);
    try {
      const note = await run();
      this.reports.close(guild.id, report.id, 'handled', moderator.id);
      const updated = this.reports.recordAction(guild.id, report.id, { type, by: moderator.id, ...(note ? { note: truncate(String(note), 300) } : {}) });
      await this.log(guild, updated, { title: ACTIONS[type].label, description: `${ACTIONS[type].emoji} Action sur le signalement \`#${report.id}\` par <@${moderator.id}>.` });
      return updated;
    } finally {
      this.pending.delete(key);
    }
  }

  /**
   * Classe (traité) ou rejette un signalement ouvert.
   * @param {'handled'|'dismissed'} status
   */
  async resolve(guild, report, status, moderator) {
    if (!this.reports.close(guild.id, report.id, status, moderator.id)) throw new UserError('Ce signalement a déjà été traité.');
    const updated = this.reports.get(guild.id, report.id);
    await this.log(guild, updated, { title: status === 'handled' ? 'Signalement classé' : 'Signalement rejeté', description: `${STATUS[status].emoji} Signalement \`#${report.id}\` ${status === 'handled' ? 'classé' : 'rejeté'} par <@${moderator.id}>.` });
    return updated;
  }

  /**
   * Log « Signalements » de la catégorie Modération. Ignoré quand la carte est elle-même
   * publiée dans le salon de logs Modération (pas de doublon).
   */
  async log(guild, report, { title, description }) {
    const cfg = this.config.get(guild.id);
    if (report.card_channel_id && report.card_channel_id === cfg.logChannels?.moderation) return false;
    const showReporter = cfg.reports?.showReporter !== false;
    const fields = [
      field(ICONS.user, 'Auteur du message', `<@${report.target_id}>`),
      field(REPORT_ICON, 'Signalé par', showReporter ? `<@${report.reporter_id}>` : ANONYMOUS),
      field(ICONS.status, 'Statut', `${STATUS[report.status]?.emoji ?? ''} ${STATUS[report.status]?.label ?? report.status}`),
      report.reason ? wide(ICONS.reason, 'Raison', truncate(report.reason, 500)) : null,
      report.card_channel_id && report.card_message_id ? wide(ICONS.link, 'Carte', messageLink(guild.id, report.card_channel_id, report.card_message_id)) : null,
    ];
    const text = showReporter ? description : description.replace(`<@${report.reporter_id}>`, 'Un membre');
    return this.logging.send(guild.id, 'moderation', logCard({ category: 'moderation', tone: 'warning', icon: REPORT_ICON, title: `${title} · #${report.id}`, description: text, fields, id: report.target_id }), undefined, { event: 'report' });
  }
}

module.exports = {
  ReportService,
  REPORT_COOLDOWN_MS,
  REPORT_TIMEOUT_MS,
  MAX_REPORT_REASON,
  REPORT_ICON,
  STATUS,
  ACTIONS,
  TEXT_TYPES,
  excerpt,
  messageLink,
  normalizeReportReason,
};
