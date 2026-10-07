'use strict';

const { ChannelType, PermissionFlagsBits } = require('discord.js');
const { embeds } = require('../utils/embeds');
const { button, row, ButtonStyle } = require('../utils/components');
const { UserError } = require('../core/errors');

/**
 * Système de tickets : création (salon privé), claim, transcript, fermeture.
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

  panel() {
    return {
      embeds: [embeds.neutral('🎫 Support').setDescription('Besoin d\'aide ? Cliquez sur le bouton ci-dessous pour ouvrir un ticket.')],
      components: [row(button({ id: 'ticket:create', label: 'Ouvrir un ticket', style: ButtonStyle.Primary, emoji: '🎫' }))],
    };
  }

  controls(claimed = false) {
    return [
      row(
        button({ id: 'ticket:claim', label: claimed ? 'Réclamé' : 'Réclamer', style: ButtonStyle.Success, emoji: '🙋', disabled: claimed }),
        button({ id: 'ticket:close', label: 'Fermer', style: ButtonStyle.Danger, emoji: '🔒' }),
      ),
    ];
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
    const open = this.tickets.countOpenByUser(guild.id, user.id);
    if (open >= (cfg.maxPerUser || 1)) {
      throw new UserError(`Vous avez déjà ${open} ticket(s) ouvert(s) (limite: ${cfg.maxPerUser || 1}).`);
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

    this.tickets.create({ guildId: guild.id, channelId: channel.id, userId: user.id });

    const welcome = embeds.neutral(`Ticket de ${user.username}`)
      .setDescription(`${user}, l'équipe va vous répondre.${supportRoleId ? ` <@&${supportRoleId}>` : ''}`);
    await channel.send({ content: `${user}`, embeds: [welcome], components: this.controls() });
    await this.logging.send(guild.id, 'moderation', embeds.info(`Ticket ouvert par ${user.tag} → ${channel}`, '🎫 Ticket'));
    return channel;
  }

  /**
   * @param {import('discord.js').TextChannel} channel
   * @param {import('discord.js').GuildMember} staff membre qui réclame (doit être du support)
   */
  async claim(channel, staff) {
    const ticket = this.tickets.getByChannel(channel.id);
    if (!ticket) throw new UserError('Ce salon n\'est pas un ticket.');
    this.assertStaff(staff);
    if (ticket.status === 'claimed') throw new UserError('Ce ticket est déjà réclamé.');
    this.tickets.setStatus(channel.id, 'claimed', { claimedBy: staff.id });
    await channel.send({ embeds: [embeds.success(`Ticket réclamé par ${staff}.`)] });
  }

  async generateTranscript(channel) {
    const messages = await channel.messages.fetch({ limit: 100 }).catch(() => null);
    if (!messages) return 'Transcript indisponible.';
    return [...messages.values()]
      .reverse()
      .map((m) => `[${new Date(m.createdTimestamp).toISOString()}] ${m.author.tag}: ${m.content}`)
      .join('\n');
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
      if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
      const cfg = this.config.get(channel.guild.id).tickets;
      const transcript = await this.generateTranscript(channel);
      this.tickets.setStatus(channel.id, 'closed', { closedAt: Date.now() });

      if (cfg.logChannel) {
        const logCh = await channel.guild.channels.fetch(cfg.logChannel).catch(() => null);
        if (logCh?.isTextBased()) {
          await logCh
            .send({
              embeds: [embeds.info(`Ticket fermé par ${closedBy}`, '🎫 Transcript')],
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
}

module.exports = { TicketService };
