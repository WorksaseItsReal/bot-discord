'use strict';

const { SlashCommandBuilder, ChannelType } = require('discord.js');
const { discordTimestamp } = require('../../utils/time');
const { card, field, wide, ICONS, code, subtext, userLine, linkButton, actionButton, buttonRows } = require('../../utils/ui');
const { UserError } = require('../../core/errors');

const VERIFICATION = ['Aucune', 'Faible', 'Moyenne', 'Élevée', 'Très élevée'];
const fr = (n) => Number(n || 0).toLocaleString('fr-FR');

/** Comptage des salons par famille. Pur. */
function channelCounts(channels) {
  const count = (...types) => channels.filter((c) => types.includes(c.type)).size;
  return {
    text: count(ChannelType.GuildText),
    voice: count(ChannelType.GuildVoice, ChannelType.GuildStageVoice),
    announcement: count(ChannelType.GuildAnnouncement),
    forum: count(ChannelType.GuildForum, ChannelType.GuildMedia),
    category: count(ChannelType.GuildCategory),
    threads: count(ChannelType.PublicThread, ChannelType.PrivateThread, ChannelType.AnnouncementThread),
  };
}

/** Liste de mentions bornée à `max` caractères (sans couper une mention). */
function fitList(items, max = 1000, sep = ' ') {
  let out = '';
  for (let i = 0; i < items.length; i++) {
    const next = (out ? sep : '') + items[i];
    if (out.length + next.length > max - 16) return `${out}${sep}*+${items.length - i}*`;
    out += next;
  }
  return out;
}

function guildOnlyCheck(interaction) {
  if (!interaction.guild) throw new UserError('Ce serveur n\'est plus accessible. Relancez `/serverinfo`.');
  return interaction.guild;
}

module.exports = {
  category: 'information',
  channelCounts,
  data: new SlashCommandBuilder()
    .setName('serverinfo')
    .setDescription('Affiche les informations détaillées du serveur.'),
  /** @param {import('discord.js').ChatInputCommandInteraction} interaction */
  async execute(interaction) {
    const { guild } = interaction;
    const c = channelCounts(guild.channels.cache);
    const owner = await guild.fetchOwner().catch(() => null);
    const icon = guild.iconURL({ size: 1024 });
    const banner = guild.bannerURL({ size: 2048 });
    const features = [
      guild.features?.includes('PARTNERED') ? '🤝 Partenaire' : null,
      guild.features?.includes('VERIFIED') ? `${ICONS.success} Vérifié` : null,
      guild.features?.includes('COMMUNITY') ? `${ICONS.members} Communauté` : null,
      guild.vanityURLCode ? `${ICONS.link} discord.gg/${guild.vanityURLCode}` : null,
    ].filter(Boolean);

    const embed = card({
      tone: 'brand',
      section: 'information',
      icon: ICONS.server,
      title: guild.name,
      description: [guild.description || null, features.length ? features.join('  ·  ') : null, subtext(`Créé ${discordTimestamp(guild.createdTimestamp, 'R')}`)],
      thumbnail: icon,
      image: banner,
      fields: [
        field(ICONS.id, 'Identifiant', code(guild.id)),
        field(ICONS.owner, 'Propriétaire', owner ? userLine(owner.user) : `<@${guild.ownerId}>`),
        field(ICONS.date, 'Créé le', discordTimestamp(guild.createdTimestamp, 'D')),
        field(ICONS.members, 'Membres', `**${fr(guild.memberCount)}**`),
        field(ICONS.channel, 'Salons', `**${c.text + c.announcement + c.forum}** écrits · **${c.voice}** vocaux`),
        field(ICONS.role, 'Rôles', `**${guild.roles.cache.size - 1}**`),
        field(ICONS.emoji, 'Emojis', `**${guild.emojis.cache.size}**${guild.stickers?.cache?.size ? ` · ${guild.stickers.cache.size} stickers` : ''}`),
        field(ICONS.boost, 'Boosts', `**${guild.premiumSubscriptionCount ?? 0}** · niveau ${guild.premiumTier}`),
        field(ICONS.shield, 'Vérification', VERIFICATION[guild.verificationLevel] ?? '—'),
      ],
    });

    await interaction.reply({
      embeds: [embed],
      components: buttonRows(
        actionButton({ command: 'serverinfo', action: 'roles', label: 'Rôles', emoji: ICONS.role }),
        actionButton({ command: 'serverinfo', action: 'channels', label: 'Salons', emoji: ICONS.channel }),
        guild.emojis.cache.size ? actionButton({ command: 'serverinfo', action: 'emojis', label: 'Emojis', emoji: ICONS.emoji }) : null,
        icon ? linkButton('Icône', icon, ICONS.image) : null,
        banner ? linkButton('Bannière', banner, ICONS.image) : null,
      ),
    });
  },
  buttons: {
    /** cmd:serverinfo:roles — rôles du serveur, du plus haut au plus bas (éphémère). */
    async roles(interaction) {
      const guild = guildOnlyCheck(interaction);
      const roles = [...guild.roles.cache.values()].filter((r) => r.id !== guild.id).sort((a, b) => b.position - a.position);
      await interaction.reply({
        embeds: [
          card({
            tone: 'brand',
            section: 'information',
            icon: ICONS.role,
            title: `Rôles de ${guild.name}`,
            description: roles.length ? fitList(roles.map((r) => `${r}`), 4000) : '*Aucun rôle (hors @everyone).*',
            fields: [
              field(ICONS.count, 'Total', `**${roles.length}**`),
              field(ICONS.bot, 'Intégrations', `**${roles.filter((r) => r.managed).length}**`),
              field(ICONS.status, 'Séparés', `**${roles.filter((r) => r.hoist).length}**`),
            ],
            footer: 'Liste détaillée : /roles',
          }),
        ],
        ephemeral: true,
      });
    },

    /** cmd:serverinfo:channels — répartition des salons (éphémère). */
    async channels(interaction) {
      const guild = guildOnlyCheck(interaction);
      const c = channelCounts(guild.channels.cache);
      const categories = [...guild.channels.cache.filter((ch) => ch.type === ChannelType.GuildCategory).values()]
        .sort((a, b) => a.rawPosition - b.rawPosition)
        .map((cat) => `${ICONS.category} **${cat.name}** · ${cat.children?.cache?.size ?? 0}`);
      const rules = guild.rulesChannelId ? `<#${guild.rulesChannelId}>` : null;
      const system = guild.systemChannelId ? `<#${guild.systemChannelId}>` : null;
      const afk = guild.afkChannelId ? `<#${guild.afkChannelId}>` : null;
      await interaction.reply({
        embeds: [
          card({
            tone: 'brand',
            section: 'information',
            icon: ICONS.channel,
            title: `Salons de ${guild.name}`,
            description: `**${guild.channels.cache.size}** salons au total.`,
            fields: [
              field('#️⃣', 'Textuels', `**${c.text}**`),
              field(ICONS.voice, 'Vocaux', `**${c.voice}**`),
              field('📢', 'Annonces', `**${c.announcement}**`),
              field('🗨️', 'Forums', `**${c.forum}**`),
              field(ICONS.category, 'Catégories', `**${c.category}**`),
              field('🧵', 'Fils actifs', `**${c.threads}**`),
              rules || system || afk ? wide(ICONS.status, 'Salons clés', [rules && `Règles · ${rules}`, system && `Système · ${system}`, afk && `AFK · ${afk}`].filter(Boolean).join('\n')) : null,
              categories.length ? wide(ICONS.category, 'Catégories', fitList(categories, 1000, '\n')) : null,
            ],
          }),
        ],
        ephemeral: true,
      });
    },

    /** cmd:serverinfo:emojis — aperçu des emojis du serveur (éphémère). */
    async emojis(interaction) {
      const guild = guildOnlyCheck(interaction);
      const all = [...guild.emojis.cache.values()];
      if (!all.length) throw new UserError('Ce serveur n\'a plus d\'emoji personnalisé.');
      const animated = all.filter((e) => e.animated).length;
      await interaction.reply({
        embeds: [
          card({
            tone: 'brand',
            section: 'information',
            icon: ICONS.emoji,
            title: `Emojis de ${guild.name}`,
            description: fitList(all.map((e) => `${e}`), 4000),
            fields: [
              field(ICONS.count, 'Total', `**${all.length}**`),
              field(ICONS.image, 'Statiques', `**${all.length - animated}**`),
              field('✨', 'Animés', `**${animated}**`),
            ],
            footer: 'Détail d\'un emoji : /emoji',
          }),
        ],
        ephemeral: true,
      });
    },
  },
};
