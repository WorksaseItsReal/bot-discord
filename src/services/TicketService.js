'use strict';

const { ChannelType, PermissionFlagsBits } = require('discord.js');
const { button, row, ButtonStyle } = require('../utils/components');
const { logSection } = require('./LoggingService');
const { card, field, wide, ICONS, userLine, code, subtext, bullets, status } = require('../utils/ui');
const { discordTimestamp, formatDuration } = require('../utils/time');
const { UserError } = require('../core/errors');

/** Nombre maximal de messages repris dans un transcript. */
const TRANSCRIPT_MAX = 1000;

/**
 * Historique d'un salon, du plus ancien au plus récent, en remontant par pages
 * de 100 (`before` : plus ancien identifiant reçu) jusqu'à `max` messages.
 * Partagé par les tickets et le ModMail.
 * @returns {Promise<{ messages: import('discord.js').Message[], truncated: boolean } | null>}
 */
async function fetchChannelHistory(channel, max = TRANSCRIPT_MAX) {
  const collected = [];
  let before;
  let full = false;
  while (collected.length < max) {
    const limit = Math.min(100, max - collected.length);
    const page = await channel.messages.fetch(before ? { limit, before } : { limit }).catch(() => null);
    if (!page) {
      if (!collected.length) return null;
      break;
    }
    const batch = [...page.values()];
    collected.push(...batch);
    full = batch.length === limit;
    if (!full || !batch.length) break;
    // Les pages arrivent du plus récent au plus ancien : on remonte depuis le plus ancien.
    before = batch.reduce((oldest, m) => ((m.createdTimestamp ?? 0) < (oldest.createdTimestamp ?? 0) ? m : oldest)).id;
  }
  // Limite atteinte : reste-t-il des messages plus anciens ?
  let truncated = false;
  if (collected.length >= max && full) {
    const more = await channel.messages.fetch({ limit: 1, before }).catch(() => null);
    truncated = Boolean(more?.size);
  }
  collected.sort((a, b) => (a.createdTimestamp ?? 0) - (b.createdTimestamp ?? 0));
  return { messages: collected, truncated };
}

/**
 * true seulement si Discord confirme que le salon n'existe plus (10003 Unknown
 * Channel). Une erreur transitoire (réseau, permissions) ne doit jamais faire
 * fermer un ticket ou une conversation encore actifs.
 */
async function channelGone(guild, channelId) {
  if (!channelId) return true;
  if (guild.channels?.cache?.has?.(channelId)) return false;
  try {
    const channel = await guild.channels.fetch(channelId);
    return !channel;
  } catch (err) {
    return err?.code === 10003;
  }
}

/** Libellés de statut d'un ticket (pastille). */
const STATUS_LABELS = {
  open: '🟢 Ouvert · en attente',
  claimed: '🟡 Pris en charge',
  closed: '⚫ Fermé',
};

/**
 * Système de tickets : création (salon privé), prise en charge, transcript, fermeture.
 *
 * customIds persistants (rétrocompatibles avec les messages déjà publiés) :
 *   ticket:create      panneau d'ouverture
 *   ticket:claim       prise en charge (support)
 *   ticket:close       fermeture
 *   ticket:transcript  transcript éphémère (auteur ou support)
 */
class TicketService {
  /**
   * @param {object} deps
   * @param {import('../database/repositories/TicketRepository').TicketRepository} deps.tickets
   * @param {import('./ConfigService').ConfigService} deps.config
   * @param {import('./LoggingService').LoggingService} deps.logging
   */
  constructor({ tickets, config, logging }) {
    this.tickets = tickets;
    this.config = config;
    this.logging = logging;
    /** Créations en cours (`guildId:userId`) : évite les doublons sur double-clic. */
    this.creating = new Set();
    /** Salons de ticket en cours de fermeture. */
    this.closing = new Set();
  }

  /** Le membre fait-il partie du support (rôle support configuré ou Gérer les salons) ? */
  isStaff(member) {
    if (!member?.permissions) return false;
    if (member.permissions.has(PermissionFlagsBits.ManageChannels)) return true;
    const roleId = this.config.get(member.guild.id).tickets?.supportRoleId;
    return Boolean(roleId && member.roles.cache.has(roleId));
  }

  assertStaff(member) {
    if (!this.isStaff(member)) throw new UserError('Seul le support (ou un membre pouvant gérer les salons) peut faire cela.');
  }

  /** Auteur du ticket ou support. */
  assertParticipant(member, ticket) {
    if (member?.id === ticket.user_id || this.isStaff(member)) return;
    throw new UserError('Seuls l\'auteur du ticket et le support peuvent faire cela.');
  }

  /**
   * Panneau public d'ouverture de ticket.
   * @param {import('discord.js').Guild} [guild]
   */
  panel(guild) {
    const cfg = guild ? this.config.get(guild.id).tickets ?? {} : {};
    const max = cfg.maxPerUser || 1;
    return {
      embeds: [
        card({
          tone: 'brand',
          section: 'tickets',
          icon: ICONS.ticket,
          title: 'Besoin d\'aide ? Contactez le support',
          description: [
            'Une question, un problème, un signalement ? Ouvrez un ticket : un salon **privé** sera créé, visible uniquement par vous et l\'équipe.',
            '',
            '**Comment ça se passe ?**',
            bullets([
              'Cliquez sur **Ouvrir un ticket** ci-dessous.',
              'Décrivez votre demande dans le salon créé, captures à l\'appui.',
              'Un membre du support la prend en charge et vous répond.',
            ]),
          ],
          fields: [
            field(ICONS.time, 'Délai de réponse', 'Quelques heures en général'),
            field(ICONS.lock, 'Confidentialité', 'Vous + le support'),
            field(ICONS.count, 'Limite', `${max} ticket${max > 1 ? 's' : ''} ouvert${max > 1 ? 's' : ''}`),
          ],
          thumbnail: guild?.iconURL?.({ size: 256 }) ?? null,
          footer: 'Merci de ne pas ouvrir de ticket sans raison',
          timestamp: false,
        }),
      ],
      components: [row(button({ id: 'ticket:create', label: 'Ouvrir un ticket', style: ButtonStyle.Primary, emoji: ICONS.ticket }))],
    };
  }

  /** Boutons du message d'accueil d'un ticket. */
  controls(claimed = false) {
    return [
      row(
        button({ id: 'ticket:claim', label: claimed ? 'Pris en charge' : 'Prendre en charge', style: ButtonStyle.Success, emoji: '🙋', disabled: claimed }),
        button({ id: 'ticket:close', label: 'Fermer', style: ButtonStyle.Danger, emoji: ICONS.lock }),
        button({ id: 'ticket:transcript', label: 'Transcript', style: ButtonStyle.Secondary, emoji: '📄' }),
      ),
    ];
  }

  /**
   * Carte d'accueil d'un ticket (rendue depuis la ligne en base).
   * @param {object} ticket ligne `tickets`
   * @param {{ user?: import('discord.js').User, supportRoleId?: string|null }} [opts]
   */
  welcome(ticket, { user, supportRoleId } = {}) {
    const claimed = ticket.status === 'claimed' && ticket.claimed_by;
    const author = user ? userLine(user) : `<@${ticket.user_id}>`;
    return {
      embeds: [
        card({
          tone: claimed ? 'info' : 'brand',
          section: 'tickets',
          icon: ICONS.ticket,
          title: `Ticket #${ticket.id}`,
          description: [
            `Bienvenue ${user ?? `<@${ticket.user_id}>`} ! Décrivez votre demande le plus précisément possible : contexte, étapes, captures d'écran…`,
            claimed
              ? `Votre demande est suivie par <@${ticket.claimed_by}>.`
              : `L'équipe${supportRoleId ? ` <@&${supportRoleId}>` : ''} a été prévenue et vous répondra dès que possible.`,
          ],
          fields: [
            field(ICONS.user, 'Auteur', author),
            field(ICONS.date, 'Ouvert', discordTimestamp(ticket.created_at ?? Date.now(), 'R')),
            field(ICONS.status, 'Statut', claimed ? `${STATUS_LABELS.claimed}\npar <@${ticket.claimed_by}>` : STATUS_LABELS.open),
          ],
          thumbnail: user?.displayAvatarURL?.({ size: 128 }) ?? null,
          footer: `Ticket #${ticket.id}`,
        }),
      ],
      components: this.controls(Boolean(claimed)),
    };
  }

  async create(guild, user) {
    const lockKey = `${guild.id}:${user.id}`;
    if (this.creating.has(lockKey)) throw new UserError('Votre ticket est déjà en cours de création…');
    this.creating.add(lockKey);
    try {
      return await this.#create(guild, user);
    } finally {
      this.creating.delete(lockKey);
    }
  }

  async #create(guild, user) {
    const cfg = this.config.get(guild.id).tickets;
    const max = cfg.maxPerUser || 1;
    const open = this.tickets.countOpenByUser(guild.id, user.id);
    if (open >= max) {
      throw new UserError(`Vous avez déjà **${open}** ticket(s) ouvert(s) (limite : ${max}). Terminez-en un avant d'en ouvrir un nouveau.`);
    }

    // Catégorie / rôle supprimés depuis la configuration : on les ignore.
    const supportRoleId = cfg.supportRoleId && guild.roles.cache.has(cfg.supportRoleId) ? cfg.supportRoleId : null;
    const parent = cfg.categoryId && guild.channels.cache.get(cfg.categoryId)?.type === ChannelType.GuildCategory ? cfg.categoryId : null;

    const overwrites = [
      { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
      { id: user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.AttachFiles] },
      { id: guild.members.me.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ManageChannels] },
    ];
    if (supportRoleId) {
      overwrites.push({ id: supportRoleId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] });
    }

    const channel = await guild.channels.create({
      name: `ticket-${user.username}`.slice(0, 90),
      type: ChannelType.GuildText,
      parent,
      permissionOverwrites: overwrites,
    });

    const id = this.tickets.create({ guildId: guild.id, channelId: channel.id, userId: user.id });
    const ticket = this.tickets.getByChannel(channel.id) ?? { id, user_id: user.id, status: 'open', created_at: Date.now() };

    // La mention (hors embed) notifie l'auteur et le support.
    await channel.send({
      content: [`${user}`, supportRoleId ? `<@&${supportRoleId}>` : null].filter(Boolean).join(' '),
      ...this.welcome(ticket, { user, supportRoleId }),
    });
    await this.logging.send(
      guild.id,
      'moderation',
      card({
        tone: 'brand',
        section: logSection('moderation'),
        icon: ICONS.ticket,
        title: 'Ticket ouvert',
        description: `${userLine(user)} a ouvert un ticket : ${channel}.`,
        fields: [field(ICONS.id, 'Ticket', code(`#${ticket.id}`)), field(ICONS.channel, 'Salon', `${channel}`)],
      }), undefined, { event: 'ticket' });
    return channel;
  }

  /**
   * Prend en charge un ticket.
   * @param {import('discord.js').TextChannel} channel
   * @param {import('discord.js').GuildMember} staff membre qui prend en charge (doit être du support)
   * @param {{ message?: import('discord.js').Message }} [opts] message d'accueil à mettre à jour (sinon recherché)
   */
  async claim(channel, staff, { message } = {}) {
    const ticket = this.tickets.getByChannel(channel.id);
    if (!ticket) throw new UserError('Ce salon n\'est pas un ticket.');
    this.assertStaff(staff);
    if (ticket.status === 'claimed') {
      throw new UserError(ticket.claimed_by ? `Ce ticket est déjà pris en charge par <@${ticket.claimed_by}>.` : 'Ce ticket est déjà pris en charge.');
    }
    this.tickets.setStatus(channel.id, 'claimed', { claimedBy: staff.id });
    const updated = this.tickets.getByChannel(channel.id) ?? { ...ticket, status: 'claimed', claimed_by: staff.id };

    // Met à jour la carte d'accueil (statut + bouton désactivé).
    const welcomeMessage = message ?? (await this.#findWelcome(channel));
    if (welcomeMessage?.edit) {
      const user = await channel.client?.users?.fetch(ticket.user_id).catch(() => null);
      const supportRoleId = this.config.get(channel.guild.id).tickets?.supportRoleId ?? null;
      const { embeds, components } = this.welcome(updated, { user: user ?? undefined, supportRoleId });
      await welcomeMessage.edit({ embeds, components }).catch(() => {});
    }

    await channel.send({
      embeds: [
        card({
          tone: 'info',
          section: 'tickets',
          icon: '🙋',
          title: 'Ticket pris en charge',
          description: `${staff} s'occupe de votre demande. Merci de patienter, une réponse arrive.`,
          fields: [field(ICONS.moderator, 'Support', userLine(staff.user ?? staff)), field(ICONS.time, 'Depuis', discordTimestamp(Date.now(), 'R'))],
        }),
      ],
    });
  }

  /** Retrouve le message d'accueil du ticket (premier message du bot avec le bouton ticket:claim). */
  async #findWelcome(channel) {
    const messages = await channel.messages?.fetch({ limit: 50 }).catch(() => null);
    if (!messages) return null;
    return [...messages.values()].find((m) =>
      m.author?.id === channel.client?.user?.id && m.components?.some((r) => r.components?.some((c) => c.customId === 'ticket:claim')),
    ) ?? null;
  }

  /**
   * Historique du salon, du plus ancien au plus récent, en remontant par pages
   * de 100 (`before` : plus ancien identifiant reçu) jusqu'à `max` messages.
   * @returns {Promise<{ messages: import('discord.js').Message[], truncated: boolean } | null>}
   */
  async fetchHistory(channel, max = TRANSCRIPT_MAX) {
    return fetchChannelHistory(channel, max);
  }

  async generateTranscript(channel) {
    const history = await this.fetchHistory(channel);
    if (!history) return 'Transcript indisponible.';
    const { messages, truncated } = history;
    const ticket = this.tickets.getByChannel(channel.id);
    const header = [
      `Transcript — #${channel.name ?? channel.id}${ticket ? ` (ticket #${ticket.id})` : ''}`,
      `Généré le ${new Date().toISOString()} · ${messages.length} message(s)`,
      truncated ? `⚠ Transcript tronqué : seuls les ${messages.length} derniers messages sont inclus.` : null,
      '─'.repeat(60),
    ].filter(Boolean);
    const lines = messages.map((m) => {
      const extras = [
        m.embeds?.length ? `[${m.embeds.length} embed(s)]` : null,
        m.attachments?.size ? `[pièces jointes : ${[...m.attachments.values()].map((a) => a.url).join(', ')}]` : null,
      ].filter(Boolean);
      return `[${new Date(m.createdTimestamp).toISOString()}] ${m.author.tag}: ${m.content}${extras.length ? ` ${extras.join(' ')}` : ''}`;
    });
    return [...header, ...lines].join('\n');
  }

  /**
   * Transcript prêt à envoyer (carte + fichier), pour un ticket ouvert.
   * @param {import('discord.js').TextChannel} channel
   */
  async transcriptPayload(channel) {
    const ticket = this.tickets.getByChannel(channel.id);
    if (!ticket) throw new UserError('Ce salon n\'est pas un ticket.');
    const content = await this.generateTranscript(channel);
    const count = content.split('\n').filter((l) => l.startsWith('[')).length;
    return {
      embeds: [
        card({
          tone: 'info',
          section: 'tickets',
          icon: '📄',
          title: `Transcript du ticket #${ticket.id}`,
          description: ['Voici l\'historique du ticket au format texte.', subtext(`Les ${TRANSCRIPT_MAX} derniers messages au maximum sont inclus.`)],
          fields: [
            field(ICONS.user, 'Auteur', `<@${ticket.user_id}>`),
            field(ICONS.count, 'Messages', `**${count}**`),
            field(ICONS.date, 'Ouvert', discordTimestamp(ticket.created_at, 'R')),
          ],
        }),
      ],
      files: [{ attachment: Buffer.from(content, 'utf8'), name: `transcript-${ticket.id}.txt` }],
    };
  }

  /**
   * Ferme un ticket. Protégé contre les doubles clics : la vérification et le
   * marquage sont synchrones, avant toute attente.
   * @param {{ delayMs?: number, onAccepted?: () => Promise<unknown> }} [opts]
   *   onAccepted : appelé une fois la fermeture acceptée (ex : répondre à l'interaction)
   */
  async close(channel, closedBy, { delayMs = 0, onAccepted } = {}) {
    const ticket = this.tickets.getByChannel(channel.id);
    if (!ticket) throw new UserError('Ce salon n\'est pas un ticket.');
    if (this.closing.has(channel.id)) throw new UserError('Ce ticket est déjà en cours de fermeture.');
    this.closing.add(channel.id);
    try {
      if (onAccepted) await onAccepted();
      if (delayMs && typeof channel.send === 'function') {
        await channel
          .send({
            embeds: [
              card({
                tone: 'neutral',
                section: 'tickets',
                icon: ICONS.lock,
                title: 'Fermeture du ticket',
                description: [`${closedBy} a fermé ce ticket.`, `Le salon sera supprimé ${discordTimestamp(Date.now() + delayMs, 'R')}.`],
                footer: 'Le transcript est archivé par le support',
              }),
            ],
          })
          .catch(() => {});
      }
      if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
      const cfg = this.config.get(channel.guild.id).tickets;
      const transcript = await this.generateTranscript(channel);
      const closedAt = Date.now();
      this.tickets.setStatus(channel.id, 'closed', { claimedBy: ticket.claimed_by ?? null, closedAt });

      if (cfg.logChannel) {
        const logCh = await channel.guild.channels.fetch(cfg.logChannel).catch(() => null);
        if (logCh?.isTextBased()) {
          await logCh
            .send({
              embeds: [this.closureCard(ticket, closedBy, closedAt, channel)],
              files: [{ attachment: Buffer.from(transcript, 'utf8'), name: `ticket-${ticket.id}.txt` }],
            })
            .catch(() => {});
        }
      }
      this.tickets.delete(channel.id);
      await channel.delete().catch(() => {});
    } finally {
      this.closing.delete(channel.id);
    }
  }

  /** Carte d'archive d'un ticket fermé (salon de logs). */
  closureCard(ticket, closedBy, closedAt = Date.now(), channel) {
    return card({
      tone: 'neutral',
      section: 'tickets',
      icon: ICONS.lock,
      title: `Ticket #${ticket.id} fermé`,
      description: [`Ticket de <@${ticket.user_id}>${channel?.name ? ` (\`#${channel.name}\`)` : ''}.`, subtext('Le transcript complet est joint à ce message.')],
      fields: [
        field(ICONS.user, 'Auteur', `<@${ticket.user_id}>`),
        field(ICONS.lock, 'Fermé par', closedBy ? `${closedBy}` : '—'),
        field('🙋', 'Pris en charge', ticket.claimed_by ? `<@${ticket.claimed_by}>` : '*Personne*'),
        field(ICONS.date, 'Ouvert', ticket.created_at ? discordTimestamp(ticket.created_at, 'f') : '—'),
        field(ICONS.duration, 'Durée', ticket.created_at ? formatDuration(closedAt - ticket.created_at) : '—'),
        field(ICONS.id, 'Identifiant', code(`#${ticket.id}`)),
      ],
      footer: `Ticket #${ticket.id}`,
    });
  }

  /**
   * Réconciliation (démarrage) : oublie les tickets dont le salon a été
   * supprimé pendant que le bot était hors ligne (sinon ils comptent à vie dans
   * la limite de tickets ouverts du membre).
   * @returns {Promise<number>} tickets fermés
   */
  async reconcile(guild) {
    let closed = 0;
    for (const ticket of this.tickets.listByGuild?.(guild.id) ?? []) {
      if (!(await channelGone(guild, ticket.channel_id))) continue;
      this.tickets.delete(ticket.channel_id);
      closed += 1;
    }
    return closed;
  }

  /** Retour éphémère standard après création. */
  createdReply(channel) {
    return status.ok(`Votre ticket est prêt : ${channel}. L'équipe a été prévenue.`, 'Ticket ouvert');
  }
}

module.exports = { TicketService, STATUS_LABELS, TRANSCRIPT_MAX, fetchChannelHistory, channelGone };
