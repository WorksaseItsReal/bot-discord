'use strict';

const { SlashCommandBuilder, PermissionFlagsBits, ChannelType } = require('discord.js');
const { card, field, wide, ICONS, subtext, userLine, linkButton, buttonRows } = require('../../utils/ui');
const { truncate } = require('../../utils/embeds');
const { discordTimestamp } = require('../../utils/time');
const { logCard } = require('../../services/LoggingService');
const { requirePermission } = require('../../services/ModerationService');
const { UserError } = require('../../core/errors');

/**
 * /snipe supprime [salon] · /snipe modifie [salon] (« Gérer les messages ») : dernier message
 * supprimé ou dernière modification d'un salon, gardés en mémoire 10 minutes (SnipeService).
 * Réponse éphémère ; chaque consultation est journalisée (logs Modération, événement « snipe »).
 */

const CHANNEL_TYPES = [
  ChannelType.GuildText,
  ChannelType.GuildAnnouncement,
  ChannelType.GuildVoice,
  ChannelType.GuildStageVoice,
  ChannelType.PublicThread,
  ChannelType.PrivateThread,
  ChannelType.AnnouncementThread,
];
const NEEDED = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.ManageMessages];
const KINDS = { supprime: 'deleted', modifie: 'edited' };

/** Texte saisi par un membre, affiché tel quel dans un bloc (jamais interprété). */
const block = (text, max = 1000) => (text ? `\`\`\`\n${truncate(String(text).replace(/```/g, 'ˋˋˋ'), max)}\n\`\`\`` : '*Vide*');

function authorOf(entry) {
  return `<@${entry.authorId}> · \`${entry.authorName}\``;
}

/** Carte d'un message supprimé. */
function deletedCard(entry, channel) {
  return card({
    tone: 'danger',
    section: 'moderation',
    icon: ICONS.delete,
    title: 'Dernier message supprimé',
    description: [entry.content ? truncate(entry.content.replace(/```/g, 'ˋˋˋ'), 3500) : '*Aucun texte*'],
    fields: [
      field(ICONS.user, 'Auteur', authorOf(entry)),
      field(ICONS.channel, 'Salon', `${channel}`),
      field(ICONS.date, 'Envoyé', entry.createdAt ? discordTimestamp(entry.createdAt, 'R') : '—'),
      field(ICONS.delete, 'Supprimé', discordTimestamp(entry.at, 'R')),
      entry.filesCount ? wide('📎', `Pièces jointes (${entry.filesCount})`, truncate(entry.files.map((f) => `\`${f.replace(/`/g, 'ˋ')}\``).join(' · '), 1000)) : null,
    ],
    thumbnail: entry.authorAvatar,
    footer: `ID : ${entry.authorId} · gardé 10 min en mémoire`,
    timestamp: entry.at,
  });
}

/** Carte d'un message modifié (avant / après). */
function editedCard(entry, channel) {
  return card({
    tone: 'info',
    section: 'moderation',
    icon: '✏️',
    title: 'Dernière modification',
    fields: [
      field(ICONS.user, 'Auteur', authorOf(entry)),
      field(ICONS.channel, 'Salon', `${channel}`),
      field(ICONS.time, 'Modifié', discordTimestamp(entry.at, 'R')),
      wide('⬅️', 'Avant', block(entry.before)),
      wide('➡️', 'Après', block(entry.after)),
    ],
    thumbnail: entry.authorAvatar,
    footer: `ID : ${entry.authorId} · gardé 10 min en mémoire`,
    timestamp: entry.at,
  });
}

module.exports = {
  category: 'moderation',
  data: new SlashCommandBuilder()
    .setName('snipe')
    .setDescription('Affiche le dernier message supprimé ou modifié d\'un salon (10 dernières minutes).')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
    .addSubcommand((s) => s.setName('supprime').setDescription('Dernier message supprimé du salon.')
      .addChannelOption((o) => o.setName('salon').setDescription('Salon à inspecter (par défaut : celui-ci)').addChannelTypes(...CHANNEL_TYPES)))
    .addSubcommand((s) => s.setName('modifie').setDescription('Dernière modification de message du salon.')
      .addChannelOption((o) => o.setName('salon').setDescription('Salon à inspecter (par défaut : celui-ci)').addChannelTypes(...CHANNEL_TYPES))),

  async execute(interaction, client) {
    requirePermission(interaction, 'ManageMessages');
    const snipe = client.services.snipe;
    if (!snipe.enabled(interaction.guildId)) throw new UserError('Le snipe est désactivé sur ce serveur (/alertes config).');
    const kind = KINDS[interaction.options.getSubcommand()] ?? 'deleted';
    const picked = interaction.options.getChannel('salon');
    const channel = picked ? interaction.guild.channels.cache.get(picked.id) ?? null : interaction.channel;
    if (!channel?.guild || channel.guild.id !== interaction.guildId) throw new UserError('Choisissez un salon de ce serveur.');
    // Seulement un salon que le modérateur peut lire et modérer lui-même.
    const perms = channel.permissionsFor?.(interaction.member);
    if (!perms?.has(NEEDED)) throw new UserError(`Il vous faut **Voir le salon**, **Voir les anciens messages** et **Gérer les messages** dans ${channel}.`);

    const entry = snipe.get(channel.id, kind);
    if (!entry) {
      await interaction.reply({
        embeds: [
          card({
            tone: 'info',
            section: 'moderation',
            icon: ICONS.info,
            title: 'Rien à afficher',
            description: [
              `Aucun message ${kind === 'deleted' ? 'supprimé' : 'modifié'} dans ${channel} ces 10 dernières minutes.`,
              subtext('Jamais retenus : les messages des bots, ceux supprimés par l\'AutoMod et ceux des salons ignorés par les logs.'),
            ],
          }),
        ],
        ephemeral: true,
      });
      return;
    }
    await interaction.reply({
      embeds: [kind === 'deleted' ? deletedCard(entry, channel) : editedCard(entry, channel)],
      components: kind === 'edited' && entry.url ? buttonRows(linkButton('Aller au message', entry.url, ICONS.link)) : [],
      ephemeral: true,
    });

    // Réponse d'abord (délai de 3 s), puis la trace de consultation.
    await client.services.logging.send(
      interaction.guildId,
      'moderation',
      logCard({
        category: 'moderation',
        tone: 'info',
        icon: ICONS.search,
        title: 'Snipe consulté',
        description: `${interaction.user} a consulté le dernier message ${kind === 'deleted' ? 'supprimé' : 'modifié'} de ${channel}.`,
        user: interaction.user,
        fields: [field(ICONS.moderator, 'Modérateur', userLine(interaction.user)), field(ICONS.channel, 'Salon', `${channel}`), field(ICONS.user, 'Auteur du message', authorOf(entry))],
      }),
      undefined,
      { event: 'snipe' },
    );
  },
};
