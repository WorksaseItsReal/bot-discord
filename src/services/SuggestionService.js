'use strict';

const { truncate, progressBar } = require('../utils/embeds');
const { button, row, ButtonStyle } = require('../utils/components');
const { card, field, wide, ICONS, subtext } = require('../utils/ui');
const { discordTimestamp } = require('../utils/time');
const { UserError } = require('../core/errors');

/** Apparence de chaque statut : pastille, ton, titre de décision. */
const STATUS = {
  pending: { pill: '🕐 En attente', tone: 'info', label: 'En attente' },
  approved: { pill: '✅ Approuvée', tone: 'success', label: 'Approuvée' },
  denied: { pill: '❌ Refusée', tone: 'danger', label: 'Refusée' },
};

/** Ligne de votes : barre de progression + pourcentage d'avis favorables. Pure. */
function voteSummary({ up = 0, down = 0 } = {}) {
  const total = up + down;
  const ratio = total ? up / total : 0;
  return [
    `👍 **${up}** · 👎 **${down}** · ${total} vote${total > 1 ? 's' : ''}`,
    `\`${progressBar(ratio, 16)}\` ${total ? `${Math.round(ratio * 100)} % pour` : 'Aucun vote'}`,
  ].join('\n');
}

/** Récupère les informations déjà affichées sur le message (miniature, décision). */
function fromMessage(message) {
  const embed = message?.embeds?.[0];
  return { avatar: embed?.thumbnail?.url ?? null };
}

/**
 * Suggestions communautaires avec votes 👍/👎 (boutons) et statut.
 * customIds (rétrocompatibles) : suggestion:up:<id> | suggestion:down:<id>
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

  /**
   * @param {object} s ligne `suggestions`
   * @param {{ up: number, down: number }} tally
   * @param {{ avatar?: string|null, decision?: { by?: string, reason?: string|null } }} [opts]
   */
  render(s, tally, { avatar, decision } = {}) {
    const meta = STATUS[s.status] ?? { pill: s.status, tone: 'info', label: s.status };
    const closed = s.status !== 'pending';
    const thumbnail = avatar ?? this.client?.users?.cache?.get(s.author_id)?.displayAvatarURL?.({ size: 128 }) ?? null;
    const fields = [
      field(ICONS.user, 'Auteur', `<@${s.author_id}>`),
      field(ICONS.status, 'Statut', meta.pill),
      field(ICONS.date, 'Proposée', s.created_at ? discordTimestamp(s.created_at, 'R') : '—'),
      wide(ICONS.stats, closed ? 'Votes (clos)' : 'Votes', voteSummary(tally)),
    ];
    if (closed && decision) {
      fields.push(
        wide(
          closed && s.status === 'approved' ? ICONS.success : ICONS.error,
          `Décision : ${meta.label.toLowerCase()}`,
          [decision.reason ? truncate(decision.reason, 900) : '*Aucune raison précisée.*', decision.by ? subtext(`Par ${decision.by}`) : null]
            .filter(Boolean)
            .join('\n'),
        ),
      );
    }
    const embed = card({
      tone: meta.tone,
      section: 'suggestions',
      icon: ICONS.idea,
      title: `Suggestion #${s.id}`,
      description: [truncate(s.content, 3800), closed ? null : '', closed ? null : subtext('Votez avec les boutons ci-dessous. Vous pouvez changer d\'avis à tout moment.')],
      fields,
      thumbnail,
      footer: `Suggestion #${s.id}`,
    });
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
    if (!channelId) throw new UserError('Aucun salon de suggestions n\'est configuré. Un administrateur peut le définir avec `/suggestion setup`.');
    const channel = await guild.channels.fetch(channelId).catch(() => null);
    if (!channel?.isTextBased()) throw new UserError('Le salon de suggestions est introuvable.');
    content = String(content ?? '').trim();
    if (!content) throw new UserError('La suggestion ne peut pas être vide.');
    if (content.length > 2000) throw new UserError('La suggestion est trop longue (2000 caractères max).');

    const id = this.suggestions.create({ guildId: guild.id, channelId, messageId: null, authorId: author.id, content });
    const s = this.suggestions.get(id);
    let message;
    try {
      message = await channel.send(this.render(s, { up: 0, down: 0 }, { avatar: author.displayAvatarURL?.({ size: 128 }) ?? null }));
    } catch (err) {
      this.suggestions.delete(id);
      throw err;
    }
    this.suggestions.setMessage(id, message.id);
    return id;
  }

  /** Lien direct vers le message d'une suggestion. */
  url(s) {
    return s?.message_id ? `https://discord.com/channels/${s.guild_id}/${s.channel_id}/${s.message_id}` : null;
  }

  async vote(interaction, suggestionId, value) {
    const s = this.suggestions.get(suggestionId);
    if (!s || s.guild_id !== interaction.guildId) throw new UserError('Suggestion introuvable.');
    if (s.status !== 'pending') throw new UserError('Les votes sont clos pour cette suggestion.');
    const tally = this.suggestions.vote(suggestionId, interaction.user.id, value);
    await interaction.update(this.render(s, tally, fromMessage(interaction.message)));
  }

  /**
   * Change le statut d'une suggestion et met à jour son message.
   * @param {{ by?: string, reason?: string|null }} [decision] auteur (mention) et raison de la décision
   * @returns {Promise<object>} la suggestion mise à jour
   */
  async setStatus(guild, suggestionId, status, decision = {}) {
    const s = this.suggestions.get(suggestionId);
    if (!s || s.guild_id !== guild.id) throw new UserError('Suggestion introuvable sur ce serveur.');
    this.suggestions.setStatus(suggestionId, status);
    const updated = this.suggestions.get(suggestionId);
    const tally = this.suggestions.tally(suggestionId);
    const channel = await guild.channels.fetch(s.channel_id).catch(() => null);
    if (channel && s.message_id) {
      const msg = await channel.messages.fetch(s.message_id).catch(() => null);
      if (msg) await msg.edit(this.render(updated, tally, { ...fromMessage(msg), decision })).catch(() => {});
    }
    return updated;
  }
}

module.exports = { SuggestionService, STATUS, voteSummary };
