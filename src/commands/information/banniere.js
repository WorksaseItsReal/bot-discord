'use strict';

const { SlashCommandBuilder } = require('discord.js');
const { card, field, ICONS, code, subtext, userLine, linkButton, buttonRows } = require('../../utils/ui');
const { formatColor } = require('../../utils/projectFormat');

module.exports = {
  guildOnly: false,
  data: new SlashCommandBuilder()
    .setName('banniere')
    .setDescription('Affiche la bannière de profil d\'un utilisateur.')
    .addUserOption((o) => o.setName('cible').setDescription('L\'utilisateur (par défaut vous-même)')),
  async execute(interaction, client) {
    const target = interaction.options.getUser('cible') || interaction.user;
    const user = await client.users.fetch(target.id, { force: true }).catch(() => target);
    const name = user.displayName ?? user.username;
    const avatar = user.displayAvatarURL({ size: 1024 });
    const url = user.bannerURL?.({ size: 4096 });

    if (!url) {
      const hasAccent = user.accentColor != null;
      return interaction.reply({
        embeds: [
          card({
            tone: hasAccent ? user.accentColor : 'neutral',
            section: 'information',
            icon: ICONS.image,
            title: `Bannière de ${name}`,
            description: [
              userLine(user),
              hasAccent ? 'Pas d\'image de bannière, mais une **couleur de profil** (visible sur la bande de cette carte).' : 'Cet utilisateur n\'a **pas de bannière**.',
              subtext('Les bannières de profil sont réservées aux abonnés Nitro.'),
            ],
            thumbnail: avatar,
            fields: hasAccent ? [field(ICONS.color, 'Couleur de profil', code(formatColor(user.accentColor)))] : [],
          }),
        ],
        components: buttonRows(linkButton('Avatar', avatar, ICONS.image)),
      });
    }

    const animated = Boolean(user.banner?.startsWith('a_'));
    await interaction.reply({
      embeds: [
        card({
          tone: user.accentColor ?? 'brand',
          section: 'information',
          icon: ICONS.image,
          title: `Bannière de ${name}`,
          url,
          description: [userLine(user), subtext(animated ? 'Bannière animée.' : 'Bannière de profil.')],
          thumbnail: avatar,
          image: url,
        }),
      ],
      components: buttonRows(
        linkButton('Ouvrir', url, ICONS.link),
        animated ? linkButton('PNG', user.bannerURL({ size: 4096, extension: 'png', forceStatic: true })) : null,
        linkButton('Avatar', avatar, ICONS.image),
      ),
    });
  },
};
