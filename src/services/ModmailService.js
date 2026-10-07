'use strict';

const { ChannelType, PermissionFlagsBits } = require('discord.js');
const { truncate } = require('../utils/embeds');
const { card, field, wide, ICONS, userLine, code, subtext, status, actionButton, buttonRows, ButtonStyle } = require('../utils/ui');
const { discordTimestamp } = require('../utils/time');
const { UserError } = require('../core/errors');

/** Durée du cache négatif « aucun serveur ModMail commun ». */
const NO_GUILD_TTL_MS = 10 * 60_000;

/** Section « nom du serveur » pour les cartes envoyées en MP. */
function guildSection(guild) {
  return { emoji: ICONS.mail, label: guild?.name ? `ModMail · ${guild.name}` : 'ModMail' };
}

/** Liste des pièces jointes d'un message (liens). */
function attachmentsList(message) {
  const list = message.attachments ? [...message.attachments.values()] : [];
  if (!list.length) return null;
  return list.slice(0, 10).map((a) => `[${truncate(a.name ?? 'fichier', 60)}](${a.url})`).join('\n');
}

/**
 * ModMail : un membre écrit au bot en DM → une conversation est créée côté
 * serveur ; le staff répond (commande ou bouton), le membre reçoit la réponse en DM.
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

  /** Le membre fait-il partie du staff ModMail (rôle staff ou Gérer les messages) ? */
  isStaff(member) {
    if (!member?.permissions) return false;
    if (member.permissions.has(PermissionFlagsBits.ManageMessages)) return true;
    const roleId = this.config.get(member.guild.id).modmail?.staffRoleId;
    return Boolean(roleId && member.roles?.cache?.has(roleId));
  }

  assertStaff(member) {
    if (!this.isStaff(member)) throw new UserError('Seul le staff ModMail (ou un membre pouvant gérer les messages) peut faire cela.');
  }

  /** Boutons du message d'ouverture côté staff. */
  controls() {
    return buttonRows(
      actionButton({ command: 'modmail', action: 'reply', label: 'Répondre', emoji: '✉️', style: ButtonStyle.Primary }),
      actionButton({ command: 'modmail', action: 'close', label: 'Fermer', emoji: ICONS.lock, style: ButtonStyle.Danger }),
    );
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

  /**
   * Cache négatif : utilisateur → expiration. Évite de rescanner tous les serveurs
   * (et d'appeler guild.members.fetch sur chacun) à chaque MP d'un inconnu.
   * @type {Map<string, number>}
   */
  #noGuildUntil = new Map();

  /** L'utilisateur est-il connu pour n'avoir aucun serveur ModMail commun ? */
  isNoGuildCached(userId, now = Date.now()) {
    const until = this.#noGuildUntil.get(userId);
    if (until && until > now) return true;
    if (until) this.#noGuildUntil.delete(userId);
    return false;
  }

  #rememberNoGuild(userId, now = Date.now()) {
    // Mémoire bornée : on purge les entrées expirées quand la table grossit.
    if (this.#noGuildUntil.size >= 1000) {
      for (const [id, until] of this.#noGuildUntil) if (until <= now) this.#noGuildUntil.delete(id);
    }
    this.#noGuildUntil.set(userId, now + NO_GUILD_TTL_MS);
  }

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

    if (!guild) {
      // Déjà cherché récemment sans succès (et déjà prévenu) : on ignore sans rescanner.
      if (this.isNoGuildCached(userId)) return;
      guild = await this.#findGuild(userId);
    }
    if (!guild) {
      this.#rememberNoGuild(userId);
      await message
        .reply({
          embeds: [
            status.warn(
              'Aucun serveur commun avec le ModMail activé n\'a été trouvé : votre message n\'a pas été transmis.',
              'Message non transmis',
            ),
          ],
        })
        .catch(() => {});
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
      const staffRoleId = cfg.staffRoleId && guild.roles.cache.has(cfg.staffRoleId) ? cfg.staffRoleId : null;
      if (staffRoleId) {
        overwrites.push({ id: staffRoleId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] });
      }
      const parent = cfg.categoryId && guild.channels.cache.get(cfg.categoryId)?.type === ChannelType.GuildCategory ? cfg.categoryId : null;
      channel = await guild.channels.create({
        name: `modmail-${message.author.username}`.slice(0, 90),
        type: ChannelType.GuildText,
        parent,
        permissionOverwrites: overwrites,
      });
      this.modmail.create({ guildId: guild.id, userId, channelId: channel.id });

      const member = await guild.members.fetch(userId).catch(() => null);
      await channel.send({
        content: staffRoleId ? `<@&${staffRoleId}>` : undefined,
        embeds: [this.#openingCard(message.author, member)],
        components: this.controls(),
      });

      // Accusé de réception côté membre (une seule fois, à l'ouverture).
      await message.author
        .send({
          embeds: [
            card({
              tone: 'brand',
              section: guildSection(guild),
              icon: ICONS.success,
              title: 'Message transmis au staff',
              description: [
                `Votre message a bien été transmis à l'équipe de **${guild.name}**.`,
                'La réponse vous parviendra ici, en message privé.',
                subtext('Vous pouvez continuer à écrire ici pour compléter votre demande.'),
              ],
              thumbnail: guild.iconURL?.({ size: 128 }) ?? null,
            }),
          ],
        })
        .catch(() => {});
    }

    await channel.send({ embeds: [this.#incomingCard(message)] });
    await message.react(ICONS.mail).catch(() => {});
  }

  /** Carte d'ouverture côté staff : qui écrit, depuis quand il est là. */
  #openingCard(user, member) {
    return card({
      tone: 'brand',
      section: 'tickets',
      icon: ICONS.mail,
      title: 'Nouvelle conversation ModMail',
      description: [`${userLine(user)} a écrit au bot en message privé.`, subtext('Vos réponses lui sont envoyées en MP, signées de votre pseudo.')],
      fields: [
        field(ICONS.user, 'Utilisateur', userLine(user)),
        field(ICONS.id, 'Identifiant', code(user.id)),
        field(ICONS.date, 'Compte créé', user.createdTimestamp ? discordTimestamp(user.createdTimestamp, 'R') : '—'),
        field('📥', 'Arrivée', member?.joinedTimestamp ? discordTimestamp(member.joinedTimestamp, 'R') : '*Inconnue*'),
        field(ICONS.role, 'Rôle principal', member && member.roles?.highest && member.roles.highest.id !== member.guild?.id ? `${member.roles.highest}` : '—'),
        field(ICONS.status, 'Statut', '🟢 Ouverte'),
        wide(ICONS.help, 'Répondre', 'Bouton **✉️ Répondre** ou `/modmail reply`. Fermez avec **🔒 Fermer** ou `/modmail close`.'),
      ],
      thumbnail: user.displayAvatarURL?.({ size: 256 }) ?? null,
      footer: `Utilisateur ${user.id}`,
    });
  }

  /** Message du membre relayé côté staff. */
  #incomingCard(message) {
    const author = message.author;
    const files = attachmentsList(message);
    return card({
      tone: 'neutral',
      section: { emoji: '📥', label: `${author.tag ?? author.username} a écrit` },
      description: truncate(message.content || '*(pièce jointe uniquement)*', 4000),
      fields: files ? [wide('📎', 'Pièces jointes', files)] : [],
      thumbnail: author.displayAvatarURL?.({ size: 64 }) ?? null,
      footer: `Utilisateur ${author.id}`,
    });
  }

  async reply(channel, staff, content) {
    const thread = this.modmail.getByChannel(channel.id);
    if (!thread || thread.status !== 'open') throw new UserError('Ce salon n\'est pas une conversation ModMail ouverte.');
    const user = await this.client.users.fetch(thread.user_id).catch(() => null);
    if (!user) throw new UserError('Impossible de contacter cet utilisateur.');
    const guild = channel.guild ?? this.client.guilds.cache.get(thread.guild_id);
    const staffName = staff.displayName ?? staff.globalName ?? staff.username;
    await user
      .send({
        embeds: [
          card({
            tone: 'info',
            section: guildSection(guild),
            icon: ICONS.mail,
            title: 'Réponse du staff',
            description: truncate(content, 4000),
            fields: [field(ICONS.moderator, 'Répondu par', `**${truncate(staffName, 80)}**`)],
            thumbnail: guild?.iconURL?.({ size: 128 }) ?? null,
            footer: 'Répondez ici pour poursuivre la conversation',
          }),
        ],
      })
      .catch(() => {
        throw new UserError('L\'utilisateur a fermé ses MP : impossible de lui répondre.');
      });
    await channel.send({
      embeds: [
        card({
          tone: 'success',
          section: { emoji: '📤', label: `Réponse de ${staff.tag ?? staff.username}` },
          description: truncate(content, 4000),
          thumbnail: staff.displayAvatarURL?.({ size: 64 }) ?? null,
          footer: `Envoyé en MP à ${user.tag ?? user.username}`,
        }),
      ],
    });
  }

  /** @returns {Promise<boolean>} false si la conversation était déjà fermée (double clic) */
  async close(channel) {
    const thread = this.modmail.getByChannel(channel.id);
    if (!thread) throw new UserError('Ce salon n\'est pas une conversation ModMail.');
    // Garde atomique : seul le premier appel prévient le membre et supprime le salon.
    if (!this.modmail.close(channel.id)) return false;
    const user = await this.client.users.fetch(thread.user_id).catch(() => null);
    const guild = channel.guild ?? this.client.guilds.cache.get(thread.guild_id);
    if (user) {
      await user
        .send({
          embeds: [
            card({
              tone: 'neutral',
              section: guildSection(guild),
              icon: ICONS.lock,
              title: 'Conversation fermée',
              description: [
                `Votre conversation avec l'équipe de **${guild?.name ?? 'ce serveur'}** est terminée. Merci pour votre message !`,
                subtext('Besoin d\'autre chose ? Écrivez-moi à nouveau pour ouvrir une nouvelle conversation.'),
              ],
            }),
          ],
        })
        .catch(() => {});
    }
    await channel.delete().catch(() => {});
    return true;
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

module.exports = { ModmailService, NO_GUILD_TTL_MS };
