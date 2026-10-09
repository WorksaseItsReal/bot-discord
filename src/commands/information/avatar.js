'use strict';

const { SlashCommandBuilder } = require('discord.js');
const { card, ICONS, subtext, userLine, actionButton, linkButton, deleteButton, buttonRows } = require('../../utils/ui');
const { assertInvoker } = require('../../utils/buttonGuard');
const { UserError } = require('../../core/errors');

const SNOWFLAKE = /^\d{17,20}$/;

/**
 * Rendu de /avatar. `mode` : « g » (avatar global) ou « s » (avatar de serveur).
 * Le bouton de bascule n'apparaît que si le membre a un avatar propre au serveur.
 */
function render({ user, member, mode, ownerId }) {
  const hasGuildAvatar = Boolean(member?.avatar);
  const useGuild = mode === 's' && hasGuildAvatar;
  const source = useGuild ? member : user;
  const url = source.displayAvatarURL({ size: 4096 });
  const animated = Boolean(source.avatar?.startsWith('a_'));
  const formats = ['png', 'jpg', 'webp'].map((ext) =>
    linkButton(ext.toUpperCase(), source.displayAvatarURL({ size: 4096, extension: ext, forceStatic: true })),
  );
  if (animated) formats.push(linkButton('GIF', source.displayAvatarURL({ size: 4096, extension: 'gif' })));

  const toggle = hasGuildAvatar
    ? actionButton({
        command: 'avatar',
        action: 'show',
        args: [ownerId, user.id, useGuild ? 'g' : 's'],
        label: useGuild ? 'Avatar global' : 'Avatar du serveur',
        emoji: useGuild ? ICONS.user : ICONS.server,
      })
    : null;

  return {
    embeds: [
      card({
        tone: member?.displayColor || user.accentColor || 'brand',
        section: 'information',
        icon: ICONS.image,
        title: `Avatar de ${member?.displayName ?? user.displayName ?? user.username}`,
        url,
        description: [
          userLine(user),
          subtext(
            useGuild
              ? 'Avatar propre à ce serveur.'
              : hasGuildAvatar
                ? 'Avatar global — ce membre a aussi un avatar sur ce serveur.'
                : `Avatar global${animated ? ' animé' : ''}.`,
          ),
        ],
        image: url,
      }),
    ],
    components: buttonRows(toggle, ...formats, deleteButton(ownerId)),
  };
}

module.exports = {
  guildOnly: false,
  render,
  data: new SlashCommandBuilder()
    .setName('avatar')
    .setDescription('Affiche l\'avatar d\'un utilisateur en grand.')
    .addUserOption((o) => o.setName('cible').setDescription('L\'utilisateur (par défaut vous-même).'))
    .addBooleanOption((o) => o.setName('serveur').setDescription('Afficher l\'avatar spécifique au serveur s\'il existe')),
  /** @param {import('discord.js').ChatInputCommandInteraction} interaction */
  async execute(interaction) {
    const user = interaction.options.getUser('cible') || interaction.user;
    const member = interaction.guild ? await interaction.guild.members.fetch(user.id).catch(() => null) : null;
    const mode = interaction.options.getBoolean('serveur') ? 's' : 'g';
    await interaction.reply(render({ user, member, mode, ownerId: interaction.user.id }));
  },
  buttons: {
    /** cmd:avatar:show:<ownerId>:<userId>:<g|s> — bascule avatar global / avatar de serveur. */
    async show(interaction, client, [ownerId, userId, mode]) {
      assertInvoker(interaction, ownerId);
      if (!SNOWFLAKE.test(userId ?? '') || !['g', 's'].includes(mode)) {
        throw new UserError('Ce bouton est invalide. Relancez `/avatar`.');
      }
      const user = await client.users.fetch(userId).catch(() => null);
      if (!user) throw new UserError('Cet utilisateur est introuvable.');
      const member = interaction.guild ? await interaction.guild.members.fetch(userId).catch(() => null) : null;
      if (mode === 's' && !member?.avatar) throw new UserError('Ce membre n\'a plus d\'avatar propre à ce serveur.');
      await interaction.update(render({ user, member, mode, ownerId }));
    },
  },
};
