'use strict';

const { embeds, truncate } = require('../utils/embeds');
const { button, row, ButtonStyle } = require('../utils/components');
const { UserError } = require('../core/errors');

/**
 * Suggestions communautaires avec votes 👍/👎 (boutons) et statut.
 */
class SuggestionService {
  /**
   * @param {object} deps
   * @param {import('discord.js').Client} deps.client
   * @param {import('../database/repositories/SuggestionRepository').SuggestionRepository} deps.suggestions
   * @param {import('./ConfigService').ConfigService} deps.config
   */
  constructor({ client, suggestions, config }) {
    this.client = client;
    this.suggestions = suggestions;
    this.config = config;
  }

  #render(s, tally) {
    const statusLabel = { pending: '🕐 En attente', approved: '✅ Approuvée', denied: '❌ Refusée' }[s.status] ?? s.status;
    const closed = s.status !== 'pending';
    const embed = embeds.neutral(`💡 Suggestion #${s.id}`)
      .setDescription(truncate(s.content, 4096))
      .addFields(
        { name: 'Auteur', value: `<@${s.author_id}>`, inline: true },
        { name: 'Statut', value: statusLabel, inline: true },
        { name: 'Votes', value: `👍 ${tally.up}  •  👎 ${tally.down}`, inline: true },
      );
    const components = [
      row(
        button({ id: `suggestion:up:${s.id}`, label: `${tally.up}`, style: ButtonStyle.Success, emoji: '👍', disabled: closed }),
        button({ id: `suggestion:down:${s.id}`, label: `${tally.down}`, style: ButtonStyle.Danger, emoji: '👎', disabled: closed }),
      ),
    ];
    return { embeds: [embed], components };
  }

  async create(guild, author, content) {
    const cfg = this.config.get(guild.id).suggestions;
    const channelId = cfg.channelId;
    if (!channelId) throw new UserError('Aucun salon de suggestions configuré (voir /settings ... ou /suggestion setup).');
    const channel = await guild.channels.fetch(channelId).catch(() => null);
    if (!channel?.isTextBased()) throw new UserError('Le salon de suggestions est introuvable.');
    content = String(content ?? '').trim();
    if (!content) throw new UserError('La suggestion ne peut pas être vide.');
    if (content.length > 2000) throw new UserError('La suggestion est trop longue (2000 caractères max).');

    const id = this.suggestions.create({ guildId: guild.id, channelId, messageId: null, authorId: author.id, content });
    const s = this.suggestions.get(id);
    let message;
    try {
      message = await channel.send(this.#render(s, { up: 0, down: 0 }));
    } catch (err) {
      this.suggestions.delete(id);
      throw err;
    }
    this.suggestions.setMessage(id, message.id);
    return id;
  }

  async vote(interaction, suggestionId, value) {
    const s = this.suggestions.get(suggestionId);
    if (!s || s.guild_id !== interaction.guildId) throw new UserError('Suggestion introuvable.');
    if (s.status !== 'pending') throw new UserError('Les votes sont clos pour cette suggestion.');
    const tally = this.suggestions.vote(suggestionId, interaction.user.id, value);
    await interaction.update(this.#render(s, tally));
  }

  async setStatus(guild, suggestionId, status) {
    const s = this.suggestions.get(suggestionId);
    if (!s || s.guild_id !== guild.id) throw new UserError('Suggestion introuvable sur ce serveur.');
    this.suggestions.setStatus(suggestionId, status);
    const updated = this.suggestions.get(suggestionId);
    const tally = this.suggestions.tally(suggestionId);
    const channel = await guild.channels.fetch(s.channel_id).catch(() => null);
    if (channel && s.message_id) {
      const msg = await channel.messages.fetch(s.message_id).catch(() => null);
      if (msg) await msg.edit(this.#render(updated, tally)).catch(() => {});
    }
  }
}

module.exports = { SuggestionService };
