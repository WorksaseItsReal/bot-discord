'use strict';

const { SlashCommandBuilder, ChannelType, PermissionFlagsBits } = require('discord.js');
const { card, field, wide, ICONS, code, subtext, linkButton, buttonRows } = require('../../utils/ui');
const { discordTimestamp, formatDuration } = require('../../utils/time');

/** Type de salon → [icône, libellé]. */
const TYPES = {
  [ChannelType.GuildText]: ['#️⃣', 'Textuel'],
  [ChannelType.GuildVoice]: [ICONS.voice, 'Vocal'],
  [ChannelType.GuildCategory]: [ICONS.category, 'Catégorie'],
  [ChannelType.GuildAnnouncement]: ['📢', 'Annonces'],
  [ChannelType.GuildForum]: ['🗨️', 'Forum'],
  [ChannelType.GuildMedia]: [ICONS.image, 'Médias'],
  [ChannelType.GuildStageVoice]: ['🎙️', 'Conférence'],
  [ChannelType.PublicThread]: ['🧵', 'Fil public'],
  [ChannelType.PrivateThread]: ['🧵', 'Fil privé'],
  [ChannelType.AnnouncementThread]: ['🧵', 'Fil d\'annonces'],
};

const VOICE_TYPES = new Set([ChannelType.GuildVoice, ChannelType.GuildStageVoice]);

function typeMeta(channel) {
  return TYPES[channel.type] ?? [ICONS.channel, `Type ${channel.type}`];
}

/** Champs propres au type de salon. */
function specificFields(channel) {
  if (VOICE_TYPES.has(channel.type)) {
    return [
      field(ICONS.members, 'Connectés', `**${channel.members?.size ?? 0}**${channel.userLimit ? ` / ${channel.userLimit}` : ''}`),
      field('🎚️', 'Débit', channel.bitrate ? `\`${Math.round(channel.bitrate / 1000)} kbps\`` : null),
      field(ICONS.count, 'Limite', channel.userLimit ? `**${channel.userLimit}** membres` : 'Illimitée'),
    ];
  }
  if (channel.type === ChannelType.GuildCategory) {
    return [field(ICONS.channel, 'Salons', `**${channel.children?.cache?.size ?? 0}**`)];
  }
  const out = [];
  if ('rateLimitPerUser' in channel) {
    out.push(field(ICONS.duration, 'Mode lent', channel.rateLimitPerUser ? `\`${formatDuration(channel.rateLimitPerUser * 1000)}\`` : 'Désactivé'));
  }
  if ('nsfw' in channel) out.push(field('🔞', 'NSFW', channel.nsfw ? 'Oui' : 'Non'));
  if (channel.threads?.cache) out.push(field('🧵', 'Fils actifs', `**${channel.threads.cache.filter((t) => !t.archived).size}**`));
  return out;
}

module.exports = {
  category: 'information',
  data: new SlashCommandBuilder()
    .setName('channel')
    .setDescription('Affiche les informations d\'un salon.')
    .addChannelOption((o) => o.setName('salon').setDescription('Le salon à inspecter (par défaut: actuel)')),
  /** @param {import('discord.js').ChatInputCommandInteraction} interaction */
  async execute(interaction) {
    const picked = interaction.options.getChannel('salon') || interaction.channel;
    const channel = interaction.guild.channels.cache.get(picked.id) ?? picked;
    const [typeIcon, typeLabel] = typeMeta(channel);
    const everyone = interaction.guild.roles.everyone;
    const isPublic = channel.permissionsFor?.(everyone)?.has(PermissionFlagsBits.ViewChannel);
    const url = `https://discord.com/channels/${interaction.guild.id}/${channel.id}`;

    const fields = [
      field(ICONS.id, 'Identifiant', code(channel.id)),
      field(ICONS.status, 'Type', `${typeIcon} ${typeLabel}`),
      field(ICONS.category, 'Catégorie', channel.parent ? channel.parent.name : '*Aucune*'),
      field(ICONS.date, 'Créé', channel.createdTimestamp ? `${discordTimestamp(channel.createdTimestamp, 'D')}\n${discordTimestamp(channel.createdTimestamp, 'R')}` : null),
      field(isPublic === false ? ICONS.lock : ICONS.visible, 'Visibilité', isPublic == null ? null : isPublic ? 'Public' : 'Privé'),
      field(ICONS.list, 'Position', channel.rawPosition != null ? `**${channel.rawPosition + 1}**` : null),
      ...specificFields(channel),
    ];
    if (channel.topic) fields.push(wide(ICONS.reason, 'Sujet', channel.topic));

    await interaction.reply({
      embeds: [
        card({
          tone: 'brand',
          section: 'information',
          icon: typeIcon,
          title: channel.name,
          description: [`${channel}`, subtext(`${typeLabel}${channel.parent ? ` dans ${channel.parent.name}` : ''}`)],
          fields,
        }),
      ],
      components: buttonRows(linkButton('Ouvrir', url, ICONS.link)),
    });
  },
};
