'use strict';

const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const { truncate } = require('../../utils/embeds');
const { discordTimestamp } = require('../../utils/time');
const { permissionLabel } = require('../../utils/permissionNames');
const { card, field, wide, ICONS, code, linkButton, actionButton, buttonRows, status } = require('../../utils/ui');
const { UserError } = require('../../core/errors');

const SANCTION_ICONS = { warn: ICONS.warn, mute: ICONS.mute, timeout: ICONS.mute, kick: ICONS.kick, ban: ICONS.ban, tempban: ICONS.ban };

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

module.exports = {
  data: new SlashCommandBuilder()
    .setName('user')
    .setDescription('Affiche les informations d\'un utilisateur ou membre.')
    .addUserOption((o) => o.setName('cible').setDescription('L\'utilisateur à inspecter (par défaut vous-même).')),
  /** @param {import('discord.js').ChatInputCommandInteraction} interaction */
  async execute(interaction) {
    const target = interaction.options.getUser('cible') || interaction.user;
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
    await interaction.reply({
      embeds: [embed],
      components: buttonRows(
        linkButton('Avatar', avatar, ICONS.image),
        banner ? linkButton('Bannière', banner, ICONS.color) : null,
        member && isModerator ? actionButton({ command: 'user', action: 'sanctions', args: [user.id], label: 'Sanctions', emoji: ICONS.history }) : null,
      ),
    });
  },

  buttons: {
    /** cmd:user:sanctions:<userId> — historique éphémère, réservé aux modérateurs. */
    async sanctions(interaction, client, [userId]) {
      if (!interaction.memberPermissions?.has(PermissionFlagsBits.ModerateMembers)) {
        throw new UserError('Il faut la permission **Exclure temporairement des membres** pour voir les sanctions.');
      }
      const list = client.repositories.sanctions.listByUser(interaction.guildId, userId, 10);
      const strikes = client.repositories.strikes.get(interaction.guildId, userId);
      if (!list.length) {
        return interaction.reply({ embeds: [status.note(`<@${userId}> n'a aucune sanction. ✨`, 'Casier vierge')], ephemeral: true });
      }
      const lines = list.map((s) => {
        const icon = SANCTION_ICONS[s.type] ?? ICONS.history;
        const reason = s.reason ? ` — ${truncate(s.reason, 80)}` : '';
        return `${icon} **${s.type}** · ${discordTimestamp(s.created_at, 'd')} · par <@${s.moderator_id}>${reason}`;
      });
      await interaction.reply({
        embeds: [
          card({
            tone: 'caution',
            section: 'moderation',
            icon: ICONS.history,
            title: 'Dernières sanctions',
            description: [`<@${userId}>`, '', ...lines],
            fields: [field(ICONS.count, 'Strikes', `**${strikes}**`), field(ICONS.list, 'Affichées', `${list.length}`)],
            footer: 'Historique complet : /sanctions list',
          }),
        ],
        ephemeral: true,
      });
    },
  },
};
