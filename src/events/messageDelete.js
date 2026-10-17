'use strict';

const { truncate } = require('../utils/embeds');
const { discordTimestamp } = require('../utils/time');
const { field, wide, ICONS, userLine } = require('../utils/ui');
const { logCard, truncateContent, PRIVATE_CONTENT } = require('../services/LoggingService');

module.exports = {
  name: 'messageDelete',
  /** @param {import('../core/GadgetClient').GadgetClient} client */
  async execute(client, message) {
    if (!message.guild) return;
    const logging = client.services.logging;
    // Supprimé par le bot (AutoMod…) : la carte AutoMod contient déjà le message. Sauf si cette carte
    // ne part pas (logs AutoMod en pause, désactivés ou débranchés) : il est alors journalisé ici.
    // Les messages du bot lui-même (sticky, starboard) ne sont jamais journalisés en double.
    if (logging.isSuppressed?.(message.id) && (message.author?.bot || logging.wouldLog?.(message.guild.id, 'automod', { event: 'automod', channelId: message.channelId }) !== false)) return;
    const ctx = {
      event: 'messageDelete',
      channelId: message.channelId,
      parentId: message.channel?.parentId,
      categoryId: message.channel?.parent?.parentId ?? null,
      bot: Boolean(message.author?.bot),
    };
    if (logging.wouldLog?.(message.guild.id, 'messages', ctx) === false) return;
    // Salon (ou fil) privé que certains lecteurs des logs ne voient pas : contenu masqué.
    const hidden = logging.hidesContent?.(message.guild.id, 'messages', message.channel) ?? false;
    const author = message.author;
    const files = [...(message.attachments?.values?.() ?? [])].map((a) => a.name ?? 'fichier');
    const embed = logCard({
      category: 'messages',
      tone: 'danger',
      icon: ICONS.delete,
      title: 'Message supprimé',
      description: author ? `Un message de ${author} a été supprimé dans ${message.channel}.` : `Un message a été supprimé dans ${message.channel}.`,
      user: author,
      fields: [
        field(ICONS.user, 'Auteur', author ? userLine(author) : '*Inconnu (hors cache)*'),
        field(ICONS.channel, 'Salon', `${message.channel}`),
        field(ICONS.date, 'Envoyé', message.createdTimestamp ? discordTimestamp(message.createdTimestamp, 'R') : '—'),
        wide('📄', 'Contenu', hidden ? PRIVATE_CONTENT : message.content ? truncateContent(message.content, 1024) : '*Aucun contenu texte*'),
        files.length ? wide('📎', `Pièces jointes (${files.length})`, hidden ? '*Noms masqués (salon privé).*' : truncate(files.join(' · '), 1024)) : null,
      ],
      id: author?.id ?? message.id,
    });
    await logging.send(message.guild.id, 'messages', embed, undefined, ctx);
  },
};
