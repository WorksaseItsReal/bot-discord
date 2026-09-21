'use strict';

const { ChannelType, PermissionFlagsBits } = require('discord.js');
const { embeds } = require('../utils/embeds');
const { UserError } = require('../core/errors');

/**
 * ModMail : un membre écrit au bot en DM → une conversation est créée côté
 * serveur ; le staff répond via une commande, le membre reçoit la réponse en DM.
 */
class ModmailService {
  /**
   * @param {object} deps
   * @param {import('discord.js').Client} deps.client
   * @param {import('../database/repositories/ModmailRepository').ModmailRepository} deps.modmail
   * @param {import('./ConfigService').ConfigService} deps.config
   */
  constructor({ client, modmail, config }) {
    this.client = client;
    this.modmail = modmail;
    this.config = config;
  }

  /** Traite un DM entrant : crée le thread si besoin, relaie au salon staff. */
  async handleUserDM(message) {
    // Trouve un serveur commun avec ModMail activé
    const guild = this.#findGuild(message.author.id);
    if (!guild) return;
    const cfg = this.config.get(guild.id).modmail;
    if (!cfg?.enabled) return;

    let thread = this.modmail.getOpenByUser(message.author.id);
    let channel = thread ? await guild.channels.fetch(thread.channel_id).catch(() => null) : null;

    if (!thread || !channel) {
      const overwrites = [
        { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
        { id: guild.members.me.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] },
      ];
      if (cfg.staffRoleId) overwrites.push({ id: cfg.staffRoleId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] });
      channel = await guild.channels.create({
        name: `modmail-${message.author.username}`.slice(0, 90),
        type: ChannelType.GuildText,
        parent: cfg.categoryId || null,
        permissionOverwrites: overwrites,
      });
      this.modmail.create({ guildId: guild.id, userId: message.author.id, channelId: channel.id });
      await channel.send({ embeds: [embeds.info(`Nouvelle conversation ModMail avec ${message.author.tag} (${message.author.id}). Répondez avec \`/modmail reply\`.`, '📬 ModMail')] });
    }

    await channel.send({
      embeds: [embeds.neutral(`✉️ ${message.author.tag}`).setDescription(message.content || '*(pièce jointe)*')],
    });
    await message.react('📨').catch(() => {});
  }

  async reply(channel, staff, content) {
    const thread = this.modmail.getByChannel(channel.id);
    if (!thread || thread.status !== 'open') throw new UserError('Ce salon n\'est pas une conversation ModMail ouverte.');
    const user = await this.client.users.fetch(thread.user_id).catch(() => null);
    if (!user) throw new UserError('Impossible de contacter cet utilisateur.');
    await user.send({ embeds: [embeds.neutral(`Réponse du staff`).setDescription(content)] }).catch(() => {
      throw new UserError('L\'utilisateur a fermé ses DM : impossible de répondre.');
    });
    await channel.send({ embeds: [embeds.success(`Répondu par ${staff} : ${content}`)] });
  }

  async close(channel) {
    const thread = this.modmail.getByChannel(channel.id);
    if (!thread) throw new UserError('Ce salon n\'est pas une conversation ModMail.');
    this.modmail.close(channel.id);
    const user = await this.client.users.fetch(thread.user_id).catch(() => null);
    if (user) await user.send({ embeds: [embeds.warning('Votre conversation avec le staff a été fermée.')] }).catch(() => {});
    await channel.delete().catch(() => {});
  }

  #findGuild(userId) {
    for (const guild of this.client.guilds.cache.values()) {
      const cfg = this.config.get(guild.id).modmail;
      if (cfg?.enabled && guild.members.cache.has(userId)) return guild;
    }
    // fallback : premier serveur avec modmail activé
    for (const guild of this.client.guilds.cache.values()) {
      if (this.config.get(guild.id).modmail?.enabled) return guild;
    }
    return null;
  }
}

module.exports = { ModmailService };
