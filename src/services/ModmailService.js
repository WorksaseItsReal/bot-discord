'use strict';

const { ChannelType, PermissionFlagsBits } = require('discord.js');
const { embeds, truncate } = require('../utils/embeds');
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
    // Verrou par utilisateur : les DM d'un même membre sont traités en série
    // pour ne jamais créer deux salons ModMail en parallèle.
    const userId = message.author.id;
    const previous = this.#locks.get(userId) ?? Promise.resolve();
    const run = previous.catch(() => {}).then(() => this.#handleUserDM(message));
    this.#locks.set(userId, run);
    try {
      return await run;
    } finally {
      if (this.#locks.get(userId) === run) this.#locks.delete(userId);
    }
  }

  /** @type {Map<string, Promise<void>>} */
  #locks = new Map();

  /** @type {Map<string, number>} dernier avertissement « aucun serveur » par utilisateur */
  #noticeAt = new Map();

  async #handleUserDM(message) {
    const userId = message.author.id;
    let guild = null;
    let channel = null;

    // Conversation déjà ouverte : on la réutilise (si son salon existe encore).
    const thread = this.modmail.getOpenByUser(userId);
    if (thread) {
      guild = this.client.guilds.cache.get(thread.guild_id) ?? null;
      channel = guild ? await guild.channels.fetch(thread.channel_id).catch(() => null) : null;
      if (!channel) {
        // Salon supprimé (ou serveur quitté) : on ferme la ligne périmée.
        this.modmail.close(thread.channel_id);
        guild = null;
      }
    }

    if (!guild) guild = await this.#findGuild(userId);
    if (!guild) {
      const last = this.#noticeAt.get(userId) ?? 0;
      if (Date.now() - last > 10 * 60_000) {
        this.#noticeAt.set(userId, Date.now());
        await message.reply({ embeds: [embeds.warning('Aucun serveur commun avec le ModMail activé n\'a été trouvé : votre message n\'a pas été transmis.')] }).catch(() => {});
      }
      return;
    }
    const cfg = this.config.get(guild.id).modmail;

    if (!channel) {
      if (!cfg?.enabled) return;
      const overwrites = [
        { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
        { id: guild.members.me.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] },
      ];
      // Rôle/catégorie supprimés depuis la configuration : on les ignore.
      if (cfg.staffRoleId && guild.roles.cache.has(cfg.staffRoleId)) {
        overwrites.push({ id: cfg.staffRoleId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] });
      }
      const parent = cfg.categoryId && guild.channels.cache.get(cfg.categoryId)?.type === ChannelType.GuildCategory ? cfg.categoryId : null;
      channel = await guild.channels.create({
        name: `modmail-${message.author.username}`.slice(0, 90),
        type: ChannelType.GuildText,
        parent,
        permissionOverwrites: overwrites,
      });
      this.modmail.create({ guildId: guild.id, userId, channelId: channel.id });
      await channel.send({ embeds: [embeds.info(`Nouvelle conversation ModMail avec ${message.author.tag} (${userId}). Répondez avec \`/modmail reply\`.`, '📬 ModMail')] });
    }

    await channel.send({
      embeds: [embeds.neutral(`✉️ ${message.author.tag}`).setDescription(truncate(message.content || '*(pièce jointe)*', 4096))],
    });
    await message.react('📨').catch(() => {});
  }

  async reply(channel, staff, content) {
    const thread = this.modmail.getByChannel(channel.id);
    if (!thread || thread.status !== 'open') throw new UserError('Ce salon n\'est pas une conversation ModMail ouverte.');
    const user = await this.client.users.fetch(thread.user_id).catch(() => null);
    if (!user) throw new UserError('Impossible de contacter cet utilisateur.');
    await user.send({ embeds: [embeds.neutral(`Réponse du staff`).setDescription(truncate(content, 4096))] }).catch(() => {
      throw new UserError('L\'utilisateur a fermé ses DM : impossible de répondre.');
    });
    await channel.send({ embeds: [embeds.success(truncate(`Répondu par ${staff} : ${content}`, 4000))] });
  }

  async close(channel) {
    const thread = this.modmail.getByChannel(channel.id);
    if (!thread) throw new UserError('Ce salon n\'est pas une conversation ModMail.');
    this.modmail.close(channel.id);
    const user = await this.client.users.fetch(thread.user_id).catch(() => null);
    if (user) await user.send({ embeds: [embeds.warning('Votre conversation avec le staff a été fermée.')] }).catch(() => {});
    await channel.delete().catch(() => {});
  }

  /**
   * Trouve le serveur (avec ModMail activé) dont l'utilisateur est réellement
   * membre. Aucun repli sur « le premier serveur » : cela ferait fuiter ses
   * messages vers un serveur dont il ne fait pas partie.
   */
  async #findGuild(userId) {
    for (const guild of this.client.guilds.cache.values()) {
      if (!this.config.get(guild.id).modmail?.enabled) continue;
      const member = guild.members.cache.get(userId) ?? (await guild.members.fetch(userId).catch(() => null));
      if (member) return guild;
    }
    return null;
  }
}

module.exports = { ModmailService };
