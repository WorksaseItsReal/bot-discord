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
    const cfg = this.config.get(guild.id).tickets;
    const open = this.tickets.countOpenByUser(guild.id, user.id);
    if (open >= (cfg.maxPerUser || 1)) {
      throw new UserError(`Vous avez déjà ${open} ticket(s) ouvert(s) (limite: ${cfg.maxPerUser || 1}).`);
    }

    const overwrites = [
      { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
      { id: user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.AttachFiles] },
      { id: guild.members.me.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ManageChannels] },
    ];
    if (cfg.supportRoleId) {
      overwrites.push({ id: cfg.supportRoleId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] });
    }

    const channel = await guild.channels.create({
      name: `ticket-${user.username}`.slice(0, 90),
      type: ChannelType.GuildText,
      parent: cfg.categoryId || null,
      permissionOverwrites: overwrites,
    });

    this.tickets.create({ guildId: guild.id, channelId: channel.id, userId: user.id });

    const welcome = embeds.neutral(`Ticket de ${user.username}`)
      .setDescription(`${user}, l'équipe va vous répondre.${cfg.supportRoleId ? ` <@&${cfg.supportRoleId}>` : ''}`);
    await channel.send({ content: `${user}`, embeds: [welcome], components: this.controls() });
    await this.logging.send(guild.id, 'moderation', embeds.info(`Ticket ouvert par ${user.tag} → ${channel}`, '🎫 Ticket'));
    return channel;
  }

  async claim(channel, staff) {
    const ticket = this.tickets.getByChannel(channel.id);
    if (!ticket) throw new UserError('Ce salon n\'est pas un ticket.');
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

  async close(channel, closedBy) {
    const ticket = this.tickets.getByChannel(channel.id);
    if (!ticket) throw new UserError('Ce salon n\'est pas un ticket.');
    const cfg = this.config.get(channel.guild.id).tickets;
    const transcript = await this.generateTranscript(channel);
    this.tickets.setStatus(channel.id, 'closed', { closedAt: Date.now() });

    if (cfg.logChannel) {
      const logCh = await channel.guild.channels.fetch(cfg.logChannel).catch(() => null);
      if (logCh?.isTextBased()) {
        await logCh.send({
          embeds: [embeds.info(`Ticket fermé par ${closedBy}`, '🎫 Transcript')],
          files: [{ attachment: Buffer.from(transcript, 'utf8'), name: `ticket-${ticket.id}.txt` }],
        });
      }
    }
    this.tickets.delete(channel.id);
    await channel.delete().catch(() => {});
  }
}

module.exports = { TicketService };
