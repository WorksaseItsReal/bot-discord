'use strict';

const { embeds } = require('../utils/embeds');
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
    const message = await channel.send(this.#render(g));
    this.giveaways.setMessage(id, message.id);
    return { id, message };
  }

  async toggleEntry(interaction, giveawayId) {
    const g = this.giveaways.get(giveawayId);
    if (!g || g.ended) throw new UserError('Ce giveaway est terminé.');
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

  async end(giveawayId, { reroll = false } = {}) {
    const g = this.giveaways.get(giveawayId);
    if (!g) throw new UserError('Giveaway introuvable.');
    if (!reroll) this.giveaways.markEnded(giveawayId);

    const entries = this.giveaways.entries(giveawayId);
    const winners = pickWinners(entries, g.winners);
    const channel = await this.client.channels.fetch(g.channel_id).catch(() => null);

    if (channel?.isTextBased()) {
      if (!winners.length) {
        await channel.send({ embeds: [embeds.warning(`Aucun participant pour **${g.prize}**.`, '🎉 Giveaway terminé')] });
      } else {
        const mention = winners.map((w) => `<@${w}>`).join(', ');
        await channel.send({
          content: mention,
          embeds: [embeds.success(`Félicitations ${mention} ! Vous gagnez **${g.prize}** 🎉`, reroll ? '🎉 Reroll' : '🎉 Giveaway terminé')],
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
