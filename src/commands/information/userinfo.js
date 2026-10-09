'use strict';

const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const { truncate } = require('../../utils/embeds');
const { discordTimestamp } = require('../../utils/time');
const { permissionLabel } = require('../../utils/permissionNames');
const { card, field, wide, ICONS, code, linkButton, actionButton, buttonRows } = require('../../utils/ui');

const KEY_PERMISSIONS = ['Administrator', 'ManageGuild', 'ManageRoles', 'ManageChannels', 'ManageMessages', 'BanMembers', 'KickMembers', 'ModerateMembers', 'MentionEveryone'];

/** Liste de mentions qui tient dans `max` caractères sans couper une mention. */
function fitMentions(items, max = 1000) {
  const out = [];
  let used = 0;
  for (let i = 0; i < items.length; i++) {
    const rest = items.length - i;
    if (used + items[i].length + 1 > max - 20) {
      out.push(`+${rest}`);
      break;
    }
    out.push(items[i]);
    used += items[i].length + 1;
  }
  return out.join(' ');
}

/**
 * Carte « fiche membre » (partagée par /user et le menu contextuel « Infos du membre »).
 * @param {import('discord.js').CommandInteraction} interaction
 * @param {import('discord.js').User} target
 * @returns {Promise<{ embeds: object[], components: object[] }>}
 */
async function userCard(interaction, target) {
  const user = await target.fetch().catch(() => target);
  const member = await interaction.guild.members.fetch(user.id).catch(() => null);
  const avatar = (member ?? user).displayAvatarURL({ size: 1024 });
  const banner = user.bannerURL?.({ size: 1024 });

  const badges = [
    user.id === interaction.guild.ownerId ? `${ICONS.owner} Propriétaire` : null,
    user.bot ? `${ICONS.bot} Bot` : null,
    member?.premiumSince ? `${ICONS.boost} Booster` : null,
  ].filter(Boolean);

  const fields = [
    field(ICONS.id, 'Identifiant', code(user.id)),
    field(ICONS.date, 'Compte créé', `${discordTimestamp(user.createdTimestamp, 'D')}\n${discordTimestamp(user.createdTimestamp, 'R')}`),
  ];

  if (member) {
    const roles = member.roles.cache
      .filter((r) => r.id !== interaction.guild.id)
      .sort((a, b) => b.position - a.position)
      .map((r) => r.toString());
    const perms = KEY_PERMISSIONS.filter((p) => member.permissions.has(p));
    fields.push(
      field('📥', 'Arrivée', member.joinedTimestamp ? `${discordTimestamp(member.joinedTimestamp, 'D')}\n${discordTimestamp(member.joinedTimestamp, 'R')}` : 'Inconnue'),
      field('✏️', 'Surnom', truncate(member.nickname || '—', 100)),
      field(ICONS.role, 'Rôle principal', member.roles.highest.id === interaction.guild.id ? '—' : `${member.roles.highest}`),
      field(ICONS.color, 'Couleur', member.displayHexColor && member.displayColor ? code(member.displayHexColor.toUpperCase()) : '—'),
    );
    if (member.communicationDisabledUntilTimestamp > Date.now()) {
      fields.push(wide(ICONS.mute, 'Exclu temporairement', `Jusqu'au ${discordTimestamp(member.communicationDisabledUntilTimestamp, 'f')}`));
    }
    fields.push(wide(ICONS.role, `Rôles (${roles.length})`, roles.length ? fitMentions(roles) : 'Aucun rôle'));
    if (perms.length) {
      fields.push(wide('🔑', 'Permissions clés', perms.includes('Administrator') ? '**Administrateur** · toutes les permissions' : perms.map(permissionLabel).join(' · ')));
    }
  } else {
    fields.push(field(ICONS.server, 'Serveur', '*Pas membre*'));
  }

  const embed = card({
    tone: member?.displayColor || user.accentColor || 'brand',
    section: 'information',
    icon: ICONS.user,
    title: user.displayName ?? user.username,
    description: [`${user} · \`@${user.username}\``, badges.length ? badges.join('  ·  ') : null],
    thumbnail: avatar,
    image: banner,
    fields,
  });

  const isModerator = interaction.memberPermissions?.has(PermissionFlagsBits.ModerateMembers);
  return {
    embeds: [embed],
    components: buttonRows(
      linkButton('Avatar', avatar, ICONS.image),
      banner ? linkButton('Bannière', banner, ICONS.color) : null,
      // Visible des modérateurs uniquement, même si l'utilisateur n'est plus membre (banni, parti).
      isModerator ? actionButton({ command: 'sanctions', action: 'history', args: [user.id], label: 'Historique de modération', emoji: ICONS.history }) : null,
    ),
  };
}

module.exports = {
  userCard,
  data: new SlashCommandBuilder()
    .setName('user')
    .setDescription('Affiche les informations d\'un utilisateur ou membre.')
    .addUserOption((o) => o.setName('cible').setDescription('L\'utilisateur à inspecter (par défaut vous-même).')),
  /** @param {import('discord.js').ChatInputCommandInteraction} interaction */
  async execute(interaction) {
    const target = interaction.options.getUser('cible') || interaction.user;
    await interaction.reply(await userCard(interaction, target));
  },

  buttons: {
    /**
     * cmd:user:sanctions:<userId> — ancien bouton (messages déjà publiés) : ouvre
     * désormais la fiche historique de /sanctions (mêmes vérifications).
     */
    async sanctions(interaction, client, args) {
      return require('../moderation/sanctions').buttons.history(interaction, client, args);
    },
  },
};
