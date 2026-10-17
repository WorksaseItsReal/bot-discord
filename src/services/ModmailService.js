'use strict';

const { ChannelType, PermissionFlagsBits } = require('discord.js');
const { truncate } = require('../utils/embeds');
const { card, field, wide, ICONS, userLine, code, subtext, status, actionButton, buttonRows, ButtonStyle } = require('../utils/ui');
const { discordTimestamp, formatDuration } = require('../utils/time');
const { UserError } = require('../core/errors');
// transcriptLine : partagée avec les tickets (les messages ModMail sont surtout des cartes).
const {
  fetchChannelHistory,
  channelGone,
  createInCategory,
  transcriptLine,
  TRANSCRIPT_MAX,
  attachmentFields,
  archiveContinuationCard,
  resolveArchiveChannel,
  archiveFailedPayload,
  snapshotsOf,
} = require('./TicketService');
const { sendTranscriptArchive } = require('../utils/transcriptArchive');
const { selectMenu, row } = require('../utils/components');
const { createLogger } = require('../core/logger');

const logger = createLogger('modmail');

/** Durée du cache négatif « aucun serveur ModMail commun ». */
const NO_GUILD_TTL_MS = 10 * 60_000;
/** Délai pour choisir le serveur à contacter (membre de plusieurs serveurs ModMail). */
const PICK_TTL_MS = 10 * 60_000;
/** MP mis en attente au plus pendant ce choix. */
const PICK_MAX_MESSAGES = 10;
/** Serveurs proposés au plus (limite d'un menu Discord). */
const PICK_MAX_GUILDS = 25;

/** Section « nom du serveur » pour les cartes envoyées en MP. */
function guildSection(guild) {
  return { emoji: ICONS.mail, label: guild?.name ? `ModMail · ${guild.name}` : 'ModMail' };
}

/** Pièces jointes au plus reprises d'un MP (fichiers du message et des messages transférés). */
const MAX_ATTACHMENT_LINKS = 40;
/** Budget de caractères d'une carte relayée (limite Discord : 6000 par message, marge comprise). */
const CARD_BUDGET = 5600;

/** Liens des pièces jointes d'un MP, messages transférés compris (une ligne par fichier). Pur. */
function attachmentLinks(message) {
  const list = [message, ...snapshotsOf(message)].flatMap((m) => (m?.attachments?.values ? [...m.attachments.values()] : []));
  return list.slice(0, MAX_ATTACHMENT_LINKS).map((a) => `[${truncate(String(a.name ?? 'fichier').replace(/[[\]\n]/g, '_'), 60)}](${a.url})`);
}

/** Lignes regroupées en blocs d'au plus `max` caractères (une ligne n'est jamais coupée). Pur. */
function chunkLines(lines, max = 1024) {
  const chunks = [];
  for (const line of lines) {
    const last = chunks[chunks.length - 1];
    if (last && last.length + 1 + line.length <= max) chunks[chunks.length - 1] = `${last}\n${line}`;
    else chunks.push(line.slice(0, max));
  }
  return chunks;
}

/** Transcript texte d'une conversation ModMail. Pur. */
function buildTranscript(thread, channel, history) {
  if (!history) return 'Transcript indisponible.';
  const { messages, truncated } = history;
  return [
    `Transcript ModMail — #${channel?.name ?? thread.channel_id} (conversation #${thread.id}, utilisateur ${thread.user_id})`,
    `Généré le ${new Date().toISOString()} · ${messages.length} message(s)`,
    truncated ? `⚠ Transcript tronqué : seuls les ${messages.length} derniers messages sont inclus.` : null,
    '─'.repeat(60),
    ...messages.map(transcriptLine),
  ].filter((l) => l !== null).join('\n');
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
    /** Téléchargement des pièces jointes archivées (fetch natif ; injectable pour les tests). */
    this.fetch = (...args) => globalThis.fetch(...args);
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

  /**
   * Traite un DM entrant : crée le thread si besoin, relaie au salon staff.
   * @param {{ guild?: import('discord.js').Guild }} [opts] guild : serveur choisi par le membre
   */
  async handleUserDM(message, opts = {}) {
    // Verrou par utilisateur : les DM d'un même membre sont traités en série
    // pour ne jamais créer deux salons ModMail en parallèle.
    const userId = message.author.id;
    const previous = this.#locks.get(userId) ?? Promise.resolve();
    const run = previous.catch(() => {}).then(() => this.#handleUserDM(message, opts));
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

  /**
   * Relaie le DM ; en cas d'échec (salon impossible à créer, catégorie pleine,
   * permissions…), le membre est prévenu que son message n'est pas parti, puis
   * l'erreur remonte (journalisée par l'événement messageCreate).
   */
  async #handleUserDM(message, opts = {}) {
    try {
      await this.#relay(message, opts);
    } catch (err) {
      await message
        .reply({
          embeds: [
            status.warn(
              'Votre message n\'a pas pu être transmis au staff à cause d\'un problème côté serveur. Réessayez dans quelques minutes.',
              'Message non transmis',
            ),
          ],
        })
        .catch(() => {});
      throw err;
    }
  }

  /**
   * @param {import('discord.js').Message} message
   * @param {{ lost?: object|null, guild?: import('discord.js').Guild|null }} [opts] lost : conversation
   *   précédente dont le salon est devenu inaccessible au bot (signalée au staff dans la nouvelle
   *   conversation) · guild : serveur choisi (sinon cherché parmi les serveurs communs)
   */
  async #relay(message, { lost = null, guild: chosen = null } = {}) {
    const userId = message.author.id;
    let guild = null;
    let channel = null;
    /** Conversation précédente devenue inaccessible (signalée dans la carte d'ouverture). */
    let previous = lost;

    // Conversation déjà ouverte : on la réutilise (si son salon existe encore).
    const thread = lost ? null : this.modmail.getOpenByUser(userId);
    if (thread) {
      guild = this.client.guilds.cache.get(thread.guild_id) ?? null;
      channel = guild ? guild.channels.cache?.get?.(thread.channel_id) ?? (await guild.channels.fetch(thread.channel_id).catch(() => null)) : null;
      if (!channel) {
        // Seul un salon CONFIRMÉ supprimé (10003) ou un serveur quitté ferme la
        // conversation : une erreur transitoire ne doit pas en ouvrir une seconde.
        if (guild && !(await channelGone(guild, thread.channel_id))) {
          // Accès perdu au salon (permission retirée, 50001) : sans issue, chaque MP échouerait
          // indéfiniment. On ferme cette conversation et on en ouvre une nouvelle ailleurs.
          const err = await guild.channels.fetch(thread.channel_id).then(() => null, (e) => e);
          if (err?.code !== 50001 && err?.code !== 50013) {
            throw new Error(`Salon ModMail ${thread.channel_id} momentanément inaccessible (conversation #${thread.id}).`);
          }
          logger.warn(`ModMail : accès perdu au salon ${thread.channel_id} (conversation #${thread.id}), nouvelle conversation.`);
          previous = thread;
        }
        this.modmail.close(thread.channel_id);
        // Accès perdu : la nouvelle conversation s'ouvre sur le même serveur (sans redemander).
        if (previous) chosen = guild;
        guild = null;
      }
    }

    if (!guild) {
      if (chosen) {
        guild = chosen;
      } else {
        // Déjà cherché récemment sans succès (et déjà prévenu) : on ignore sans rescanner.
        if (this.isNoGuildCached(userId)) return;
        const guilds = await this.#eligibleGuilds(userId);
        // Plusieurs serveurs possibles : le membre choisit AVANT tout relais (jamais « le premier
        // du cache » : son message privé partirait chez le staff d'une autre communauté).
        if (guilds.length > 1) return this.#askGuild(message, guilds);
        guild = guilds[0] ?? null;
      }
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
      // Catégorie pleine (50 salons) : conversation créée hors catégorie plutôt que perdue.
      channel = await createInCategory(guild, {
        name: `modmail-${message.author.username}`.slice(0, 90),
        type: ChannelType.GuildText,
        parent,
        permissionOverwrites: overwrites,
      });
      this.modmail.create({ guildId: guild.id, userId, channelId: channel.id });

      const member = await guild.members.fetch(userId).catch(() => null);
      await channel.send({
        content: staffRoleId ? `<@&${staffRoleId}>` : undefined,
        // Le client n'autorise que les mentions d'utilisateurs par défaut : le rôle staff doit être explicite.
        allowedMentions: { roles: staffRoleId && staffRoleId !== guild.id ? [staffRoleId] : [] },
        embeds: [this.#openingCard(message.author, member, previous)],
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

    const [first, ...more] = this.#incomingCards(message);
    try {
      await channel.send({ embeds: [first] });
    } catch (err) {
      // Salon encore en cache mais devenu inaccessible au bot (surcharge retirée, Envoyer refusé) :
      // sans issue, chaque MP échouerait indéfiniment. On ferme cette conversation et on en ouvre
      // une nouvelle, où le staff est prévenu (une seule fois : jamais en boucle).
      if (!thread || lost || (err?.code !== 50001 && err?.code !== 50013)) throw err;
      logger.warn(`ModMail : accès perdu au salon ${thread.channel_id} (conversation #${thread.id}), nouvelle conversation.`);
      this.modmail.close(thread.channel_id);
      return this.#relay(message, { lost: thread, guild });
    }
    // Pièces jointes qui ne tiennent pas dans la première carte (6000 caractères par message).
    for (const extra of more) await channel.send({ embeds: [extra] });
    await message.react(ICONS.mail).catch(() => {});
  }

  /** Carte d'ouverture côté staff : qui écrit, depuis quand il est là. */
  #openingCard(user, member, lost = null) {
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
        lost
          ? wide(ICONS.warning, 'Conversation précédente', `La conversation #${lost.id} (<#${lost.channel_id}>) m'est devenue inaccessible : elle a été fermée sans archive.`)
          : null,
        wide(ICONS.help, 'Répondre', 'Bouton **✉️ Répondre** ou `/modmail reply`. Fermez avec **🔒 Fermer** ou `/modmail close`.'),
      ],
      thumbnail: user.displayAvatarURL?.({ size: 256 }) ?? null,
      footer: `Utilisateur ${user.id}`,
    });
  }

  /**
   * Message du membre relayé côté staff : texte (et texte des messages transférés), puis liens
   * des pièces jointes répartis en champs de 1024 caractères ; ce qui ne tient pas dans la carte
   * (6000 caractères par message) part dans des cartes de suite. Jamais de lien perdu.
   * @returns {object[]} cartes (la première porte le texte)
   */
  #incomingCards(message) {
    const author = message.author;
    const section = { emoji: '📥', label: `${author.tag ?? author.username} a écrit` };
    const forwarded = snapshotsOf(message)
      .map((snap) => snap?.content)
      .filter(Boolean)
      .map((content) => `**↪️ Message transféré**\n${content.split('\n').map((l) => `> ${l}`).join('\n')}`);
    const description = truncate([message.content, ...forwarded].filter(Boolean).join('\n\n') || '*(pièce jointe uniquement)*', 4000);
    const chunks = chunkLines(attachmentLinks(message), 1024);
    const label = (i) => (chunks.length > 1 ? `Pièces jointes (${i + 1}/${chunks.length})` : 'Pièces jointes');
    const avatar = author.displayAvatarURL?.({ size: 64 }) ?? null;
    const cards = [];
    let fields = [];
    let budget = CARD_BUDGET - description.length - section.label.length;
    const push = () => {
      const first = !cards.length;
      cards.push(card({ tone: 'neutral', section, description: first ? description : subtext('Suite des pièces jointes.'), fields, thumbnail: first ? avatar : null, footer: `Utilisateur ${author.id}` }));
      fields = [];
      budget = CARD_BUDGET - section.label.length - 40;
    };
    for (const [i, chunk] of chunks.entries()) {
      const cost = chunk.length + 40;
      if (fields.length >= 10 || cost > budget) push();
      fields.push(wide('📎', label(i), chunk));
      budget -= cost;
    }
    push();
    return cards;
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

  /** Salons ModMail en cours de fermeture (double clic, nouvelle tentative d'archive). */
  #closing = new Set();

  /**
   * Conversation fermable depuis ce salon : ouverte, ou déjà fermée mais dont le salon a été
   * conservé faute d'archive (nouvelle tentative). Lève une UserError sinon.
   */
  assertClosable(channelId) {
    const thread = this.modmail.getByChannel(channelId);
    if (!thread) throw new UserError('Ce salon n\'est pas une conversation ModMail.');
    if (this.#closing.has(channelId)) throw new UserError('Cette conversation ModMail est déjà en cours de fermeture.');
    return thread;
  }

  /**
   * @param {import('discord.js').TextChannel} channel
   * @param {import('discord.js').User} [closedBy] auteur de la fermeture (pour l'archive)
   * @returns {Promise<boolean>} false si la conversation était déjà fermée (double clic)
   */
  async close(channel, closedBy) {
    const thread = this.modmail.getByChannel(channel.id);
    if (!thread) throw new UserError('Ce salon n\'est pas une conversation ModMail.');
    if (this.#closing.has(channel.id)) return false;
    // Conversation déjà fermée dont le salon a été conservé (archive impossible) : nouvelle
    // tentative d'archive, sans nouveau MP au membre.
    const retry = thread.status === 'closed';
    // Garde atomique : seul le premier appel prévient le membre et supprime le salon.
    if (!retry && !this.modmail.close(channel.id)) return false;
    this.#closing.add(channel.id);
    try {
      return await this.#close(channel, thread, closedBy, retry);
    } finally {
      this.#closing.delete(channel.id);
    }
  }

  async #close(channel, thread, closedBy, retry) {
    const user = await this.client.users.fetch(thread.user_id).catch(() => null);
    const guild = channel.guild ?? this.client.guilds.cache.get(thread.guild_id);
    // Archive AVANT la suppression du salon (sinon l'historique est perdu).
    let archiveError = null;
    await this.#archive(channel, thread, guild, user, closedBy).catch((e) => {
      archiveError = e;
    });
    if (user && !retry) {
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
    if (archiveError) {
      // Jamais de suppression sans archive : la conversation reste fermée, le salon est conservé
      // et le staff prévenu (refermer après correction publie l'archive et supprime le salon).
      const logChannelId = this.config.get(guild.id).modmail?.logChannel;
      logger.warn(`Archive ModMail #${thread.id} impossible, salon conservé :`, archiveError?.message ?? archiveError);
      if (typeof channel.send === 'function') {
        await channel
          .send(archiveFailedPayload({
            logChannelId,
            error: archiveError,
            what: 'Cette conversation',
            components: buttonRows(actionButton({ command: 'modmail', action: 'close', label: 'Refermer', emoji: ICONS.lock, style: ButtonStyle.Danger })),
          }))
          .catch(() => {});
      }
      return true;
    }
    await channel.delete().catch(() => {});
    return true;
  }

  /**
   * Publie le transcript (.txt) dans le salon de logs ModMail configuré (`modmail.logChannel`).
   * @returns {Promise<boolean>} false : aucune archive à publier (pas de salon, ou salon supprimé) ;
   *   lève une erreur si l'archive n'a pas pu être publiée.
   */
  async #archive(channel, thread, guild, user, closedBy) {
    const logChannelId = guild ? this.config.get(guild.id).modmail?.logChannel : null;
    if (!logChannelId || typeof channel.messages?.fetch !== 'function') return false;
    // null : salon d'archive supprimé (confirmé par Discord) ; accès refusé ou panne : levé.
    const logCh = await resolveArchiveChannel(guild, logChannelId);
    if (!logCh) return false;
    if (!logCh.isTextBased?.()) throw new Error('le salon des transcripts n\'est pas un salon textuel');
    const history = await fetchChannelHistory(channel, TRANSCRIPT_MAX);
    const transcript = buildTranscript(thread, channel, history);
    const count = history?.messages.length ?? 0;
    // Même option que les tickets : pièces jointes (fichiers et liens relayés des MP) re-téléversées.
    await sendTranscriptArchive(logCh, {
      transcript: { name: `modmail-${thread.id}.txt`, content: transcript },
      messages: history?.messages ?? [],
      archiveAttachments: this.config.get(guild.id).tickets?.archiveAttachments === true,
      guild,
      fetchImpl: this.fetch,
      card: (attachments) => this.archiveCard(thread, { user, closedBy, count, channel, attachments }),
      continuation: (part, total) => archiveContinuationCard(`ModMail #${thread.id}`, part, total),
    });
    return true;
  }

  /** Carte d'archive d'une conversation fermée (salon de logs ModMail). Pure. */
  archiveCard(thread, { user, closedBy, count = 0, channel, closedAt = Date.now(), attachments = null } = {}) {
    return card({
      tone: 'neutral',
      section: 'tickets',
      icon: ICONS.mail,
      title: `Conversation ModMail #${thread.id} fermée`,
      description: [
        `Conversation avec ${user ? userLine(user) : `<@${thread.user_id}>`}${channel?.name ? ` (\`#${channel.name}\`)` : ''}.`,
        subtext('Le transcript complet est joint à ce message.'),
      ],
      fields: [
        field(ICONS.user, 'Utilisateur', `<@${thread.user_id}>`),
        field(ICONS.lock, 'Fermée par', closedBy ? `${closedBy}` : '—'),
        field(ICONS.count, 'Messages', `**${count}**`),
        field(ICONS.date, 'Ouverte', thread.created_at ? discordTimestamp(thread.created_at, 'f') : '—'),
        field(ICONS.duration, 'Durée', thread.created_at ? formatDuration(closedAt - thread.created_at) : '—'),
        field(ICONS.id, 'Identifiant', code(`#${thread.id}`)),
        ...attachmentFields(attachments),
      ],
      footer: `Utilisateur ${thread.user_id}`,
    });
  }

  /**
   * Réconciliation (démarrage) : ferme les conversations ouvertes dont le salon
   * a été supprimé pendant que le bot était hors ligne.
   * @returns {Promise<number>} conversations fermées
   */
  async reconcile(guild) {
    let closed = 0;
    for (const thread of this.modmail.listOpenByGuild?.(guild.id) ?? []) {
      if (!(await channelGone(guild, thread.channel_id))) continue;
      if (this.modmail.close(thread.channel_id)) closed += 1;
    }
    return closed;
  }

  /**
   * Serveurs (avec ModMail activé) dont l'utilisateur est réellement membre. Aucun repli sur
   * « le premier serveur » : cela ferait fuiter ses messages vers un serveur dont il ne fait pas partie.
   * @returns {Promise<import('discord.js').Guild[]>}
   */
  async #eligibleGuilds(userId) {
    const out = [];
    for (const guild of this.client.guilds.cache.values()) {
      if (!this.config.get(guild.id).modmail?.enabled) continue;
      const member = guild.members.cache.get(userId) ?? (await guild.members.fetch(userId).catch(() => null));
      if (member) out.push(guild);
    }
    return out;
  }

  /** MP en attente du choix du serveur : utilisateur → { messages, until }. @type {Map<string, { messages: object[], until: number }>} */
  #pending = new Map();

  /** Met le MP en attente et demande (une fois) au membre quel serveur contacter. */
  async #askGuild(message, guilds) {
    const userId = message.author.id;
    const now = Date.now();
    const entry = this.#pending.get(userId);
    if (entry && entry.until > now) {
      if (entry.messages.length < PICK_MAX_MESSAGES) entry.messages.push(message);
      return;
    }
    // Mémoire bornée : purge des choix expirés quand la table grossit.
    if (this.#pending.size >= 1000) {
      for (const [id, e] of this.#pending) if (e.until <= now) this.#pending.delete(id);
    }
    this.#pending.set(userId, { messages: [message], until: now + PICK_TTL_MS });
    await message
      .reply({
        embeds: [
          card({
            tone: 'info',
            section: guildSection(null),
            icon: ICONS.mail,
            title: 'Quel serveur voulez-vous contacter ?',
            description: [
              'Vous êtes membre de plusieurs serveurs qui utilisent ce ModMail.',
              'Choisissez celui dont vous voulez joindre l\'équipe : votre message ne sera transmis qu\'après votre choix.',
              subtext('Choix valable 10 minutes. Vos messages suivants seront transmis au même serveur.'),
            ],
          }),
        ],
        components: [
          row(
            selectMenu({
              id: 'cmd:modmail:pick',
              placeholder: 'Choisissez un serveur…',
              options: guilds.slice(0, PICK_MAX_GUILDS).map((g) => ({ value: g.id, label: truncate(g.name ?? g.id, 100), emoji: ICONS.server })),
            }),
          ),
        ],
      })
      .catch(() => {});
  }

  /**
   * Choix du serveur par le membre (menu envoyé en MP) : revérifie qu'il est éligible, puis relaie
   * les MP en attente à ce serveur.
   * @returns {Promise<{ guild: import('discord.js').Guild, relayed: number, failed: number }>}
   */
  async choose(userId, guildId) {
    const entry = this.#pending.get(userId);
    if (!entry || entry.until <= Date.now()) {
      this.#pending.delete(userId);
      throw new UserError('Ce choix a expiré : écrivez-moi à nouveau pour contacter un serveur.');
    }
    const guild = (await this.#eligibleGuilds(userId)).find((g) => g.id === guildId);
    if (!guild) throw new UserError('Ce serveur n\'est plus disponible pour le ModMail (ModMail désactivé ou vous n\'en êtes plus membre).');
    this.#pending.delete(userId);
    let relayed = 0;
    let failed = 0;
    for (const message of entry.messages) {
      try {
        await this.handleUserDM(message, { guild });
        relayed += 1;
      } catch (err) {
        failed += 1;
        logger.warn('ModMail : MP non transmis après le choix du serveur :', err?.message ?? err);
      }
    }
    return { guild, relayed, failed };
  }
}

module.exports = { ModmailService, NO_GUILD_TTL_MS, PICK_TTL_MS, buildTranscript, transcriptLine };
