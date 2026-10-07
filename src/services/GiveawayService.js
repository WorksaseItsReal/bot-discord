'use strict';

const { truncate, listOrMore } = require('../utils/embeds');
const { button, row, ButtonStyle } = require('../utils/components');
const { card, field, wide, ICONS, subtext, actionButton, linkButton, buttonRows } = require('../utils/ui');
const { discordTimestamp } = require('../utils/time');
const { pickWinners } = require('../utils/random');
const { UserError } = require('../core/errors');
const { createLogger } = require('../core/logger');

const logger = createLogger('giveaways');
/** Plafond du nombre de gagnants d'un reroll (option `gagnants`). */
const MAX_REROLL_WINNERS = 20;

/** Délai de regroupement des mises à jour du compteur de participants. */
const EDIT_DEBOUNCE_MS = 5_000;

/** Lien direct vers le message d'un giveaway (null si pas encore publié). */
function giveawayUrl(g) {
  return g?.message_id ? `https://discord.com/channels/${g.guild_id}/${g.channel_id}/${g.message_id}` : null;
}

/** Conditions de participation lisibles. */
function conditions(g) {
  const parts = [
    g.required_role ? `${ICONS.check} Rôle requis : <@&${g.required_role}>` : null,
    g.forbidden_role ? `${ICONS.ban} Rôle exclu : <@&${g.forbidden_role}>` : null,
  ].filter(Boolean);
  return parts.length ? parts.join('\n') : 'Aucune : ouvert à tous les membres.';
}

const plural = (n, word) => `${n} ${word}${n > 1 ? 's' : ''}`;

/**
 * Giveaways persistants : création, participation par bouton, fin automatique
 * (via scheduler) et reroll. Tout survit au redémarrage.
 *
 * customIds : giveaway:enter:<id> (participation, rétrocompatible)
 *             cmd:giveaway:reroll:<id> (nouveau tirage, réservé aux organisateurs)
 */
class GiveawayService {
  /**
   * @param {object} deps
   * @param {import('discord.js').Client} deps.client
   * @param {import('../database/repositories/GiveawayRepository').GiveawayRepository} deps.giveaways
   */
  constructor({ client, giveaways }) {
    this.client = client;
    this.giveaways = giveaways;
    /** @type {Map<number, NodeJS.Timeout>} giveaways dont la carte doit être réactualisée */
    this.pendingEdits = new Map();
    /** @type {Map<number, Promise<void>>} réactualisations en cours (end() les attend) */
    this.inflightEdits = new Map();
    /** @type {Map<number, Promise<unknown>>} fin / reroll en cours, par giveaway (exécutés en série) */
    this.locks = new Map();
  }

  /** Carte du giveaway en cours. */
  render(g) {
    const entries = this.giveaways.countEntries(g.id);
    const embed = card({
      tone: 'celebrate',
      section: 'giveaways',
      icon: ICONS.gift,
      title: truncate(g.prize, 200),
      description: [
        `Cliquez sur **${ICONS.gift} Participer** pour tenter votre chance !`,
        subtext('Cliquez à nouveau pour retirer votre participation.'),
      ],
      fields: [
        field('🏆', 'Gagnants', `**${g.winners}**`),
        field(ICONS.expires, 'Fin', `${discordTimestamp(g.ends_at, 'R')}\n${discordTimestamp(g.ends_at, 'f')}`),
        field(ICONS.owner, 'Organisateur', `<@${g.host_id}>`),
        field(ICONS.members, 'Participants', `**${entries}**`),
        wide(ICONS.list, 'Conditions', conditions(g)),
      ],
      footer: `Giveaway #${g.id} · Fin`,
      timestamp: g.ends_at,
    });
    const components = [
      row(button({ id: `giveaway:enter:${g.id}`, label: entries ? `Participer · ${entries}` : 'Participer', style: ButtonStyle.Primary, emoji: ICONS.gift })),
    ];
    return { embeds: [embed], components };
  }

  /** Carte du giveaway terminé (remplace le message d'origine). */
  renderEnded(g, winners) {
    const entries = this.giveaways.countEntries(g.id);
    const list = winners.map((w) => `<@${w}>`);
    return {
      embeds: [
        card({
          tone: winners.length ? 'celebrate' : 'neutral',
          section: 'giveaways',
          icon: winners.length ? '🏆' : ICONS.gift,
          title: truncate(g.prize, 200),
          description: winners.length
            ? [`Giveaway terminé ! Bravo à ${listOrMore(list, 20)} 🎉`]
            : ['Giveaway terminé, sans participant éligible.'],
          fields: [
            wide('🏆', winners.length > 1 ? 'Gagnants' : 'Gagnant', winners.length ? listOrMore(list, 20, '\n') : '*Aucun*'),
            field(ICONS.members, 'Participants', `**${entries}**`),
            field(ICONS.owner, 'Organisateur', `<@${g.host_id}>`),
            field(ICONS.date, 'Terminé', discordTimestamp(Date.now(), 'R')),
          ],
          footer: `Giveaway #${g.id} · Terminé`,
        }),
      ],
      components: buttonRows(
        actionButton({ command: 'giveaway', action: 'reroll', args: [g.id], label: 'Relancer', emoji: ICONS.dice, disabled: !entries }),
      ),
    };
  }

  /** Annonce des gagnants (nouveau message dans le salon). */
  #announcement(g, winners, reroll) {
    const url = giveawayUrl(g);
    const list = winners.map((w) => `<@${w}>`);
    if (!winners.length) {
      return {
        embeds: [
          card({
            tone: 'neutral',
            section: 'giveaways',
            icon: ICONS.gift,
            title: 'Giveaway terminé sans gagnant',
            description: `Aucun participant éligible pour **${truncate(g.prize, 200)}**.`,
            footer: `Giveaway #${g.id}`,
          }),
        ],
        components: url ? buttonRows(linkButton('Voir le giveaway', url, ICONS.link)) : [],
      };
    }
    return {
      content: list.join(' '),
      embeds: [
        card({
          tone: 'celebrate',
          section: 'giveaways',
          icon: reroll ? ICONS.dice : '🏆',
          title: reroll ? 'Nouveau tirage !' : 'Félicitations !',
          description: [
            `${listOrMore(list, 20)} ${winners.length > 1 ? 'remportent' : 'remporte'} **${truncate(g.prize, 200)}** ! 🎉`,
            subtext(`Contactez ${g.host_id ? `<@${g.host_id}>` : 'l\'organisateur'} pour récupérer votre lot.`),
          ],
          fields: [
            field(ICONS.gift, 'Récompense', truncate(g.prize, 200)),
            field('🏆', 'Gagnants', `**${winners.length}**`),
            field(ICONS.owner, 'Organisateur', `<@${g.host_id}>`),
          ],
          footer: `Giveaway #${g.id}${reroll ? ' · Reroll' : ''}`,
        }),
      ],
      components: url ? buttonRows(linkButton('Voir le giveaway', url, ICONS.link)) : [],
    };
  }

  async create(channel, host, { prize, winners, durationMs, requiredRole, forbiddenRole }) {
    prize = String(prize ?? '').trim();
    if (!prize) throw new UserError('La récompense ne peut pas être vide.');
    if (prize.length > 200) throw new UserError('La récompense est trop longue (200 caractères max).');
    if (!channel?.isTextBased?.()) throw new UserError('Ce salon ne permet pas d\'envoyer de messages.');
    const endsAt = Date.now() + durationMs;
    const id = this.giveaways.create({
      guildId: channel.guild.id,
      channelId: channel.id,
      messageId: null,
      prize,
      winners,
      hostId: host.id,
      requiredRole: requiredRole ?? null,
      forbiddenRole: forbiddenRole ?? null,
      endsAt,
    });
    const g = this.giveaways.get(id);
    let message;
    try {
      message = await channel.send(this.render(g));
    } catch (err) {
      // Pas de ligne orpheline si le message n'a pas pu être publié.
      this.giveaways.delete(id);
      throw err;
    }
    this.giveaways.setMessage(id, message.id);
    return { id, message };
  }

  /** Récupère un giveaway en vérifiant (si fourni) qu'il appartient bien au serveur. */
  #getForGuild(giveawayId, guildId) {
    const g = this.giveaways.get(giveawayId);
    if (!g || (guildId && g.guild_id !== guildId)) throw new UserError('Giveaway introuvable sur ce serveur.');
    return g;
  }

  /**
   * Tire les gagnants en excluant les bots, les comptes introuvables et, au
   * moment du tirage, les membres partis du serveur ou qui ne remplissent plus
   * les conditions de rôles (requis / interdit).
   */
  async #drawWinners(g, entries, count) {
    const shuffled = pickWinners(entries, entries.length);
    const guild = this.client.guilds?.cache?.get?.(g.guild_id) ?? null;
    const winners = [];
    for (const userId of shuffled) {
      if (winners.length >= count) break;
      const user = await this.client.users.fetch(userId).catch(() => null);
      if (!user || user.bot) continue;
      if (guild && !(await this.#isEligibleMember(guild, g, userId))) continue;
      winners.push(userId);
    }
    return winners;
  }

  /** Le participant est-il encore membre et conforme aux rôles requis / interdits ? */
  async #isEligibleMember(guild, g, userId) {
    const member = guild.members?.cache?.get(userId) ?? (await guild.members?.fetch?.(userId).catch(() => null));
    if (!member) return false; // parti du serveur
    return isEligible(g, member);
  }

  /**
   * Bascule la participation du membre.
   * @returns {Promise<boolean>} true si le membre participe désormais
   */
  async toggleEntry(interaction, giveawayId) {
    const g = this.giveaways.get(giveawayId);
    if (!g || g.guild_id !== interaction.guildId || g.ended) throw new UserError('Ce giveaway est terminé.');
    if (interaction.user.bot) throw new UserError('Les bots ne peuvent pas participer.');
    const member = interaction.member;
    if (g.required_role && !member.roles.cache.has(g.required_role)) {
      throw new UserError(`Il faut le rôle <@&${g.required_role}> pour participer à ce giveaway.`);
    }
    if (g.forbidden_role && member.roles.cache.has(g.forbidden_role)) {
      throw new UserError(`Les membres ayant le rôle <@&${g.forbidden_role}> ne peuvent pas participer à ce giveaway.`);
    }
    const joined = this.giveaways.toggleEntry(giveawayId, member.id);
    // Compteur affiché : une seule édition groupée toutes les ~5 s (pas une par clic).
    this.scheduleEdit(giveawayId);
    return joined;
  }

  /** Programme la réactualisation de la carte (regroupe les participations rapprochées). */
  scheduleEdit(giveawayId) {
    if (this.pendingEdits.has(giveawayId)) return;
    const timer = setTimeout(() => {
      this.pendingEdits.delete(giveawayId);
      const job = this.#refreshLive(giveawayId)
        .catch(() => {})
        .finally(() => this.inflightEdits.delete(giveawayId));
      this.inflightEdits.set(giveawayId, job);
    }, EDIT_DEBOUNCE_MS);
    timer.unref?.();
    this.pendingEdits.set(giveawayId, timer);
  }

  /** Annule une réactualisation programmée et attend celle en cours. */
  async #cancelEdit(giveawayId) {
    clearTimeout(this.pendingEdits.get(giveawayId));
    this.pendingEdits.delete(giveawayId);
    await this.inflightEdits.get(giveawayId);
  }

  /** Réédite la carte en direct, sauf si le giveaway s'est terminé entre-temps (jamais de « résurrection »). */
  async #refreshLive(giveawayId) {
    const current = this.giveaways.get(giveawayId);
    if (!current || current.ended || !current.message_id) return;
    const channel = await this.client.channels.fetch(current.channel_id).catch(() => null);
    const msg = channel?.messages ? await channel.messages.fetch(current.message_id).catch(() => null) : null;
    if (!msg) return;
    // Relecture juste avant l'édition : end() a pu passer pendant les appels réseau.
    const fresh = this.giveaways.get(giveawayId);
    if (!fresh || fresh.ended) return;
    await msg.edit(this.render(fresh));
  }

  /** Nombre de participants (affichage). */
  countEntries(giveawayId) {
    return this.giveaways.countEntries(giveawayId);
  }

  get(giveawayId) {
    return this.giveaways.get(giveawayId);
  }

  /**
   * Termine (ou reroll) un giveaway. Les appels sur un même giveaway sont
   * exécutés en série (verrou par giveaway) : deux rerolls simultanés ne
   * peuvent pas tirer les mêmes gagnants.
   * @param {number} giveawayId
   * @param {{ reroll?: boolean, guildId?: string, count?: number|null }} [opts]
   *   guildId : serveur appelant (obligatoire côté commandes) ; count : nombre de gagnants d'un reroll
   */
  async end(giveawayId, opts = {}) {
    const previous = this.locks.get(giveawayId) ?? Promise.resolve();
    const run = previous.catch(() => {}).then(() => this.#end(giveawayId, opts));
    this.locks.set(giveawayId, run);
    try {
      return await run;
    } finally {
      if (this.locks.get(giveawayId) === run) this.locks.delete(giveawayId);
    }
  }

  async #end(giveawayId, { reroll = false, guildId, count = null } = {}) {
    const g = this.#getForGuild(giveawayId, guildId);
    let entries = this.giveaways.entries(giveawayId);
    let retry = false;
    if (reroll) {
      if (!g.ended) throw new UserError('Ce giveaway est encore en cours : terminez-le avant de faire un reroll.');
    } else if (!this.giveaways.markEnded(giveawayId)) {
      // Garde atomique : un seul appel (commande, scheduler…) peut terminer le giveaway.
      // Exception (reprise) : terminé, avec des participants, mais aucun gagnant
      // enregistré → l'annonce avait échoué ; on retente le tirage et l'annonce.
      retry = entries.length > 0 && !(this.giveaways.winners?.(giveawayId) ?? []).length;
      if (!retry) throw new UserError('Ce giveaway est déjà terminé.');
    }
    // Une édition « en direct » tardive ne doit jamais écraser la carte de fin.
    await this.#cancelEdit(giveawayId);

    const channel = await this.client.channels.fetch(g.channel_id).catch(() => null);
    const message = g.message_id && channel?.messages ? await channel.messages.fetch(g.message_id).catch(() => null) : null;

    if (reroll) {
      // Tous les gagnants déjà tirés sont exclus : ceux mémorisés en base (premier tirage
      // et relances) + ceux lus sur la carte de fin (giveaways antérieurs à la mémorisation).
      const previous = new Set([...(this.giveaways.winners?.(giveawayId) ?? []), ...previousWinners(message)]);
      entries = entries.filter((id) => !previous.has(id));
    }
    const wanted = reroll && count ? Math.min(Math.max(1, count), MAX_REROLL_WINNERS) : g.winners;
    const winners = await this.#drawWinners(g, entries, wanted);
    if (reroll && !winners.length) throw new UserError('Aucun participant éligible pour un reroll (les gagnants précédents, les membres partis et ceux qui ne remplissent plus les conditions sont exclus).');

    // Les gagnants ne sont mémorisés qu'une fois l'annonce publiée : sinon
    // /giveaway end peut la retenter (voir `retry` ci-dessus).
    let announced = false;
    if (channel?.isTextBased?.()) {
      announced = await channel.send(this.#announcement(g, winners, reroll)).then(() => true, (err) => {
        logger.warn(`Annonce du giveaway #${giveawayId} impossible :`, err?.message ?? err);
        return false;
      });
    } else {
      logger.warn(`Annonce du giveaway #${giveawayId} impossible : salon ${g.channel_id} introuvable ou non textuel.`);
    }
    if (!announced) {
      throw new UserError(reroll
        ? 'Le nouveau tirage n\'a pas pu être annoncé (salon introuvable ou permissions manquantes). Corrigez puis relancez.'
        : `Le giveaway est terminé mais l'annonce des gagnants a échoué (salon introuvable ou permissions manquantes). Corrigez puis relancez \`/giveaway end id:${giveawayId}\` pour retenter.`);
    }
    this.giveaways.addWinners?.(giveawayId, winners);
    if (message && !reroll) await message.edit(this.renderEnded(g, winners)).catch(() => {});
    if (retry) logger.info(`Giveaway #${giveawayId} : annonce retentée avec succès.`);
    return winners;
  }

  listActive(guildId) {
    return this.giveaways.listActive(guildId);
  }
}

/** Le membre remplit-il les conditions de rôles du giveaway ? Pur. */
function isEligible(g, member) {
  const has = (roleId) => Boolean(member?.roles?.cache?.has?.(roleId));
  if (g.required_role && !has(g.required_role)) return false;
  if (g.forbidden_role && has(g.forbidden_role)) return false;
  return true;
}

/**
 * Gagnants affichés sur la carte de fin (champ « Gagnant(s) »), seule trace
 * persistée du tirage : la base ne stocke pas les gagnants.
 */
function previousWinners(message) {
  const embed = message?.embeds?.[0];
  const fieldValue = embed?.fields?.find((f) => /Gagnant/.test(f.name))?.value ?? '';
  return [...fieldValue.matchAll(/<@!?(\d{17,20})>/g)].map((m) => m[1]);
}

module.exports = { GiveawayService, giveawayUrl, conditions, previousWinners, isEligible, EDIT_DEBOUNCE_MS, MAX_REROLL_WINNERS };
