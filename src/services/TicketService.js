'use strict';

const { ChannelType, PermissionFlagsBits } = require('discord.js');
const { button, row, selectMenu, ButtonStyle } = require('../utils/components');
const { logSection } = require('./LoggingService');
const { card, field, wide, ICONS, userLine, code, subtext, bullets, status } = require('../utils/ui');
const { discordTimestamp, formatDuration } = require('../utils/time');
const { UserError } = require('../core/errors');

/** Nombre maximal de messages repris dans un transcript. */
const TRANSCRIPT_MAX = 1000;
/** Délai minimal entre deux ouvertures de ticket d'un même membre (évite les boucles qui pinguent le staff). */
const OPEN_COOLDOWN_MS = 60_000;
/** Mention de transcript : les fichiers ne sont pas copiés, seuls leurs liens figurent. */
const ATTACHMENTS_NOTE = 'Les pièces jointes ne sont pas archivées : seuls leurs liens figurent, et ils expirent une fois le salon supprimé.';

/**
 * Création refusée parce que la catégorie est pleine (50 salons, 50035) ou le
 * serveur au maximum de salons (30013) : on retente une fois sans catégorie.
 */
const PARENT_FULL_CODES = new Set([50035, 30013]);

/**
 * Crée un salon dans `parent`, puis sans catégorie si celle-ci est pleine.
 * Partagé par les tickets et le ModMail.
 * @returns {Promise<import('discord.js').GuildChannel>}
 */
async function createInCategory(guild, options) {
  try {
    return await guild.channels.create(options);
  } catch (err) {
    if (!options.parent || !PARENT_FULL_CODES.has(err?.code)) throw err;
    return guild.channels.create({ ...options, parent: null });
  }
}

/**
 * Une ligne de transcript : contenu, puis en-tête et texte de chaque embed (les
 * cartes du bot et les messages relayés sont des embeds), puis liens des pièces jointes. Pur.
 */
function transcriptLine(m) {
  const parts = [];
  if (m.content) parts.push(m.content);
  for (const e of m.embeds ?? []) {
    const head = [e.author?.name ?? e.data?.author?.name, e.title ?? e.data?.title].filter(Boolean).join(' — ');
    const body = e.description ?? e.data?.description;
    parts.push(`[${head || 'embed'}]${body ? ` ${body.replace(/\s+/g, ' ')}` : ''}`);
  }
  const files = m.attachments?.size ? [...m.attachments.values()].map((a) => a.url) : [];
  if (files.length) parts.push(`[pièces jointes : ${files.join(', ')}]`);
  const at = new Date(m.createdTimestamp ?? Date.now()).toISOString();
  return `[${at}] ${m.author?.tag ?? m.author?.username ?? 'inconnu'}: ${parts.join(' ')}`;
}

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

/** Nombre maximal de motifs proposés à l'ouverture. */
const MAX_REASONS = 15;

/**
 * Rôles staff configurés : `supportRoleIds` (tableau de bord) + l'ancien
 * `supportRoleId`, sans doublon. Pur.
 * @param {{ supportRoleIds?: string[], supportRoleId?: string|null }} [cfg] config `tickets`
 */
function supportRoles(cfg) {
  return [...new Set([...(cfg?.supportRoleIds ?? []), cfg?.supportRoleId].filter(Boolean))];
}

/** Motif extrait du sujet d'un salon de ticket (« … · Motif : X »). Pur. */
function reasonFromTopic(topic) {
  const m = String(topic ?? '').match(/Motif : (.+)$/);
  return m ? m[1].trim() : null;
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
    /**
     * Fermetures en cours (délai avant suppression) : `flush()` les termine
     * immédiatement à l'arrêt du bot.
     * @type {Map<string, { flushed: boolean, skip: (() => void) | null, done: Promise<void> | null }>}
     */
    this.closeJobs = new Map();
    /** Dernière ouverture par membre (`guildId:userId` → horodatage). */
    this.lastOpened = new Map();
    this.openCooldownMs = OPEN_COOLDOWN_MS;
  }

  /** Refuse une nouvelle ouverture trop rapprochée de la précédente (boucle ouverture/fermeture). */
  #assertOpenCooldown(key, now = Date.now()) {
    const last = this.lastOpened.get(key);
    if (last && now - last < this.openCooldownMs) {
      throw new UserError(`Vous venez d'ouvrir un ticket : patientez avant d'en ouvrir un nouveau (${discordTimestamp(last + this.openCooldownMs, 'R')}).`);
    }
  }

  #rememberOpened(key, now = Date.now()) {
    // Mémoire bornée : purge des entrées expirées quand la table grossit.
    if (this.lastOpened.size >= 1000) {
      for (const [k, at] of this.lastOpened) if (now - at >= this.openCooldownMs) this.lastOpened.delete(k);
    }
    this.lastOpened.set(key, now);
  }

  /** Le membre fait-il partie du support (rôle support configuré ou Gérer les salons) ? */
  isStaff(member) {
    if (!member?.permissions) return false;
    if (member.permissions.has(PermissionFlagsBits.ManageChannels)) return true;
    const roles = supportRoles(this.config.get(member.guild.id).tickets);
    return roles.some((id) => member.roles?.cache?.has(id));
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
    const reasons = cfg.reasons ?? [];
    const custom = cfg.panel ?? {};
    const label = custom.buttonLabel || 'Ouvrir un ticket';
    return {
      embeds: [
        card({
          tone: 'brand',
          section: 'tickets',
          icon: ICONS.ticket,
          title: custom.title || 'Besoin d\'aide ? Contactez le support',
          description: custom.description || [
            'Une question, un problème, un signalement ? Ouvrez un ticket : un salon **privé** sera créé, visible uniquement par vous et l\'équipe.',
            '',
            '**Comment ça se passe ?**',
            bullets([
              reasons.length ? 'Choisissez le **motif** de votre demande dans le menu ci-dessous.' : `Cliquez sur **${label}** ci-dessous.`,
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
      components: reasons.length
        ? [this.reasonMenu(reasons, custom.buttonLabel)]
        : [row(button({ id: 'ticket:create', label, style: ButtonStyle.Primary, emoji: ICONS.ticket }))],
    };
  }

  /** Menu des motifs d'ouverture (customId `ticket:open`). */
  reasonMenu(reasons, placeholder) {
    return row(
      selectMenu({
        id: 'ticket:open',
        placeholder: String(placeholder || 'Choisissez le motif de votre demande…').slice(0, 150),
        options: reasons.slice(0, MAX_REASONS).map((r) => ({ value: r.value, label: r.label, emoji: r.emoji || ICONS.ticket, description: r.description })),
      }),
    );
  }

  /** Incrémente un compteur de statistiques (`tickets.stats`), sans jamais faire échouer l'action. */
  bumpStat(guildId, key) {
    try {
      const stats = this.config.get(guildId).tickets?.stats ?? {};
      this.config.update?.(guildId, { tickets: { stats: { [key]: (stats[key] ?? 0) + 1 } } });
    } catch {
      /* statistique perdue : sans gravité */
    }
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
  welcome(ticket, { user, supportRoleId, supportRoleIds, reason } = {}) {
    const claimed = ticket.status === 'claimed' && ticket.claimed_by;
    const author = user ? userLine(user) : `<@${ticket.user_id}>`;
    const team = supportRoleIds?.length ? supportRoleIds : supportRoleId ? [supportRoleId] : [];
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
              : `L'équipe${team.length ? ` ${team.map((id) => `<@&${id}>`).join(' ')}` : ''} a été prévenue et vous répondra dès que possible.`,
          ],
          fields: [
            field(ICONS.user, 'Auteur', author),
            field(ICONS.date, 'Ouvert', discordTimestamp(ticket.created_at ?? Date.now(), 'R')),
            field(ICONS.status, 'Statut', claimed ? `${STATUS_LABELS.claimed}\npar <@${ticket.claimed_by}>` : STATUS_LABELS.open),
            reason ? field(ICONS.tag, 'Motif', reason) : null,
          ],
          thumbnail: user?.displayAvatarURL?.({ size: 128 }) ?? null,
          footer: `Ticket #${ticket.id}`,
        }),
      ],
      components: this.controls(Boolean(claimed)),
    };
  }

  /**
   * @param {import('discord.js').Guild} guild
   * @param {import('discord.js').User} user
   * @param {{ reason?: string|null }} [opts] motif choisi à l'ouverture
   */
  async create(guild, user, { reason = null } = {}) {
    const lockKey = `${guild.id}:${user.id}`;
    if (this.creating.has(lockKey)) throw new UserError('Votre ticket est déjà en cours de création…');
    // « Ticket déjà ouvert » est plus utile que « patientez » : contrôlé avant le délai anti-boucle.
    const cfg = this.config.get(guild.id).tickets;
    const max = cfg.maxPerUser || 1;
    const open = this.tickets.countOpenByUser(guild.id, user.id);
    if (open >= max) {
      throw new UserError(`Vous avez déjà **${open}** ticket(s) ouvert(s) (limite : ${max}). Terminez-en un avant d'en ouvrir un nouveau.`);
    }
    this.#assertOpenCooldown(lockKey);
    this.creating.add(lockKey);
    try {
      const channel = await this.#create(guild, user, reason);
      this.#rememberOpened(lockKey);
      return channel;
    } finally {
      this.creating.delete(lockKey);
    }
  }

  async #create(guild, user, reason) {
    const cfg = this.config.get(guild.id).tickets;
    const max = cfg.maxPerUser || 1;
    const open = this.tickets.countOpenByUser(guild.id, user.id);
    if (open >= max) {
      throw new UserError(`Vous avez déjà **${open}** ticket(s) ouvert(s) (limite : ${max}). Terminez-en un avant d'en ouvrir un nouveau.`);
    }

    // Catégorie / rôle supprimés depuis la configuration : on les ignore.
    const staffRoles = supportRoles(cfg).filter((id) => guild.roles.cache.has(id));
    const supportRoleId = staffRoles[0] ?? null;
    const parent = cfg.categoryId && guild.channels.cache.get(cfg.categoryId)?.type === ChannelType.GuildCategory ? cfg.categoryId : null;

    const overwrites = [
      { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
      { id: user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.AttachFiles] },
      { id: guild.members.me.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ManageChannels] },
    ];
    for (const id of staffRoles) {
      overwrites.push({ id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] });
    }

    // Catégorie pleine (50 salons) : le ticket est créé hors catégorie plutôt que refusé.
    const channel = await createInCategory(guild, {
      name: `ticket-${user.username}`.slice(0, 90),
      type: ChannelType.GuildText,
      parent,
      topic: `Ticket de ${user.username}${reason ? ` · Motif : ${reason}` : ''}`.slice(0, 1024),
      permissionOverwrites: overwrites,
    });

    const id = this.tickets.create({ guildId: guild.id, channelId: channel.id, userId: user.id });
    const ticket = this.tickets.getByChannel(channel.id) ?? { id, user_id: user.id, status: 'open', created_at: Date.now() };
    this.bumpStat(guild.id, 'opened');

    // La mention (hors embed) notifie l'auteur et le support.
    // Mentions autorisées explicitement (le client n'autorise que les utilisateurs par défaut).
    await channel.send({
      content: [`${user}`, ...staffRoles.map((r) => `<@&${r}>`)].join(' '),
      allowedMentions: { users: [user.id], roles: staffRoles.filter((id) => id !== guild.id) },
      ...this.welcome(ticket, { user, supportRoleId, supportRoleIds: staffRoles, reason }),
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
        fields: [field(ICONS.id, 'Ticket', code(`#${ticket.id}`)), field(ICONS.channel, 'Salon', `${channel}`), reason ? field(ICONS.tag, 'Motif', reason) : null],
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
      const cfg = this.config.get(channel.guild.id).tickets;
      const { embeds, components } = this.welcome(updated, {
        user: user ?? undefined,
        supportRoleId: cfg?.supportRoleId ?? null,
        supportRoleIds: supportRoles(cfg),
        reason: reasonFromTopic(channel.topic),
      });
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
    return (await this.#transcript(channel)).content;
  }

  /** Transcript texte + nombre réel de messages repris (pas de comptage de lignes). */
  async #transcript(channel) {
    const history = await this.fetchHistory(channel);
    if (!history) return { content: 'Transcript indisponible.', count: 0 };
    const { messages, truncated } = history;
    const ticket = this.tickets.getByChannel(channel.id);
    const header = [
      `Transcript — #${channel.name ?? channel.id}${ticket ? ` (ticket #${ticket.id})` : ''}`,
      `Généré le ${new Date().toISOString()} · ${messages.length} message(s)`,
      truncated ? `⚠ Transcript tronqué : seuls les ${messages.length} derniers messages sont inclus.` : null,
      messages.some((m) => m.attachments?.size) ? `⚠ ${ATTACHMENTS_NOTE}` : null,
      '─'.repeat(60),
    ].filter(Boolean);
    // Embeds (cartes du bot) repris avec leur titre et leur texte, comme le ModMail.
    return { content: [...header, ...messages.map(transcriptLine)].join('\n'), count: messages.length };
  }

  /**
   * Transcript prêt à envoyer (carte + fichier), pour un ticket ouvert.
   * @param {import('discord.js').TextChannel} channel
   */
  async transcriptPayload(channel) {
    const ticket = this.tickets.getByChannel(channel.id);
    if (!ticket) throw new UserError('Ce salon n\'est pas un ticket.');
    const { content, count } = await this.#transcript(channel);
    return {
      embeds: [
        card({
          tone: 'info',
          section: 'tickets',
          icon: '📄',
          title: `Transcript du ticket #${ticket.id}`,
          description: [
            'Voici l\'historique du ticket au format texte.',
            subtext(`Les ${TRANSCRIPT_MAX} derniers messages au maximum sont inclus.`),
            subtext(ATTACHMENTS_NOTE),
          ],
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
    const job = { flushed: false, skip: null, done: null };
    this.closeJobs.set(channel.id, job);
    job.done = this.#close(channel, closedBy, ticket, { delayMs, onAccepted }, job).finally(() => {
      this.closing.delete(channel.id);
      this.closeJobs.delete(channel.id);
    });
    return job.done;
  }

  /**
   * Arrêt du bot : termine immédiatement les fermetures en attente (délai de
   * suppression écourté : transcript archivé, salon supprimé) et les attend.
   */
  async flush() {
    const jobs = [...this.closeJobs.values()];
    for (const job of jobs) {
      job.flushed = true;
      job.skip?.();
    }
    await Promise.allSettled(jobs.map((j) => j.done));
  }

  async #close(channel, closedBy, ticket, { delayMs, onAccepted }, job) {
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
    // Délai écourtable : flush() (arrêt du bot) termine la fermeture tout de suite.
    if (delayMs && !job.flushed) {
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, delayMs);
        job.skip = () => {
          clearTimeout(timer);
          resolve();
        };
      });
    }
    const cfg = this.config.get(channel.guild.id).tickets;
    const transcript = await this.generateTranscript(channel);
    const closedAt = Date.now();
    this.tickets.setStatus(channel.id, 'closed', { claimedBy: ticket.claimed_by ?? null, closedAt });
    this.bumpStat(channel.guild.id, 'closed');

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

module.exports = {
  TicketService,
  STATUS_LABELS,
  TRANSCRIPT_MAX,
  MAX_REASONS,
  OPEN_COOLDOWN_MS,
  supportRoles,
  reasonFromTopic,
  fetchChannelHistory,
  channelGone,
  createInCategory,
  transcriptLine,
};
