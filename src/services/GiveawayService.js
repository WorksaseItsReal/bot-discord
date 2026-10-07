'use strict';

const { embeds, truncate } = require('../utils/embeds');
const { button, row, ButtonStyle } = require('../utils/components');
const { discordTimestamp } = require('../utils/time');
const { pickWinners } = require('../utils/random');
const { UserError } = require('../core/errors');

/**
 * Giveaways persistants : création, participation par bouton, fin automatique
 * (via scheduler) et reroll. Tout survit au redémarrage.
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
  }

  #render(g) {
    const entries = this.giveaways.countEntries(g.id);
    const embed = embeds.neutral(`🎉 ${g.prize}`)
      .setDescription(
        [
          `Cliquez sur 🎉 pour participer !`,
          `Fin : ${discordTimestamp(g.ends_at)} (${discordTimestamp(g.ends_at, 'R')})`,
          `Gagnant(s) : **${g.winners}**`,
          `Organisé par : <@${g.host_id}>`,
          g.required_role ? `Rôle requis : <@&${g.required_role}>` : null,
          `Participants : **${entries}**`,
        ]
          .filter(Boolean)
          .join('\n'),
      );
    const components = [row(button({ id: `giveaway:enter:${g.id}`, label: 'Participer', style: ButtonStyle.Primary, emoji: '🎉' }))];
    return { embeds: [embed], components };
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
      message = await channel.send(this.#render(g));
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

  /** Tire les gagnants en excluant les bots (et les comptes introuvables). */
  async #drawWinners(entries, count) {
    const shuffled = pickWinners(entries, entries.length);
    const winners = [];
    for (const userId of shuffled) {
      if (winners.length >= count) break;
      const user = await this.client.users.fetch(userId).catch(() => null);
      if (!user || user.bot) continue;
      winners.push(userId);
    }
    return winners;
  }

  async toggleEntry(interaction, giveawayId) {
    const g = this.giveaways.get(giveawayId);
    if (!g || g.guild_id !== interaction.guildId || g.ended) throw new UserError('Ce giveaway est terminé.');
    if (interaction.user.bot) throw new UserError('Les bots ne peuvent pas participer.');
    const member = interaction.member;
    if (g.required_role && !member.roles.cache.has(g.required_role)) {
      throw new UserError('Vous n\'avez pas le rôle requis pour participer.');
    }
    if (g.forbidden_role && member.roles.cache.has(g.forbidden_role)) {
      throw new UserError('Vous ne pouvez pas participer à ce giveaway.');
    }
    const joined = this.giveaways.toggleEntry(giveawayId, member.id);
    // Met à jour le compteur affiché
    const channel = await this.client.channels.fetch(g.channel_id).catch(() => null);
    if (channel && g.message_id) {
      const msg = await channel.messages.fetch(g.message_id).catch(() => null);
      if (msg) await msg.edit(this.#render(g)).catch(() => {});
    }
    return joined;
  }

  /**
   * Termine (ou reroll) un giveaway.
   * @param {number} giveawayId
   * @param {{ reroll?: boolean, guildId?: string }} [opts] guildId : serveur appelant (obligatoire côté commandes)
   */
  async end(giveawayId, { reroll = false, guildId } = {}) {
    const g = this.#getForGuild(giveawayId, guildId);
    if (reroll) {
      if (!g.ended) throw new UserError('Ce giveaway est encore en cours : terminez-le avant de faire un reroll.');
    } else if (!this.giveaways.markEnded(giveawayId)) {
      // Garde atomique : un seul appel (commande, scheduler…) peut terminer le giveaway.
      throw new UserError('Ce giveaway est déjà terminé.');
    }

    const entries = this.giveaways.entries(giveawayId);
    const winners = await this.#drawWinners(entries, g.winners);
    if (reroll && !winners.length) throw new UserError('Aucun participant éligible pour un reroll.');
    const channel = await this.client.channels.fetch(g.channel_id).catch(() => null);

    if (channel?.isTextBased()) {
      if (!winners.length) {
        await channel.send({ embeds: [embeds.warning(`Aucun participant pour **${truncate(g.prize, 200)}**.`, '🎉 Giveaway terminé')] });
      } else {
        const mention = winners.map((w) => `<@${w}>`).join(', ');
        await channel.send({
          content: mention,
          embeds: [embeds.success(`Félicitations ${mention} ! Vous gagnez **${truncate(g.prize, 200)}** 🎉`, reroll ? '🎉 Reroll' : '🎉 Giveaway terminé')],
        });
      }
      if (g.message_id && !reroll) {
        const msg = await channel.messages.fetch(g.message_id).catch(() => null);
        if (msg) {
          await msg
            .edit({
              embeds: [embeds.neutral(`🎉 ${g.prize}`).setDescription(`Terminé — gagnant(s) : ${winners.length ? winners.map((w) => `<@${w}>`).join(', ') : 'aucun'}`)],
              components: [],
            })
            .catch(() => {});
        }
      }
    }
    return winners;
  }

  listActive(guildId) {
    return this.giveaways.listActive(guildId);
  }
}

module.exports = { GiveawayService };
