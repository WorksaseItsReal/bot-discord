'use strict';

const { SlashCommandBuilder, PermissionFlagsBits, ChannelType } = require('discord.js');
const { card, field, ICONS, userLine, actionButton, deleteButton, buttonRows } = require('../../utils/ui');
const { assertCanModerate } = require('../../utils/permissions');
const { UserError } = require('../../core/errors');

function requirePermission(interaction, flag, label) {
  if (!interaction.memberPermissions?.has(flag)) throw new UserError(`Il faut la permission **${label}** pour faire cela.`);
}

/** L'auteur doit pouvoir rejoindre le salon cible ET y déplacer des membres (pas de déplacement « par procuration »). */
function assertCanMoveTo(interaction, channel) {
  if (!channel.permissionsFor?.(interaction.member)?.has([PermissionFlagsBits.Connect, PermissionFlagsBits.MoveMembers])) {
    throw new UserError(`Vous ne pouvez pas déplacer de membres vers ${channel}.`);
  }
}

/** Même contrôle de hiérarchie que kick/mute (sauf sur soi-même). */
function assertCanActOn(interaction, member, action) {
  if (member.id !== interaction.user.id) assertCanModerate(interaction.member, member, interaction.guild.members.me, { action });
}

/** true si l'auteur peut agir sur ce membre (hiérarchie), sans lever d'erreur. */
function canActOn(interaction, member) {
  try {
    assertCanActOn(interaction, member, 'déconnecter');
    return true;
  } catch {
    return false;
  }
}

/** Membre connecté en vocal, ou erreur claire. */
async function voiceMember(guild, userId) {
  const member = await guild.members.fetch(userId).catch(() => null);
  if (!member) throw new UserError('Membre introuvable.');
  if (!member.voice.channel) throw new UserError(`${member} n'est pas connecté en vocal.`);
  return member;
}

/** Carte micro coupé / réactivé + bouton inverse. */
function muteView(muted, { member, moderator, ownerId }) {
  return {
    embeds: [
      card({
        tone: muted ? 'caution' : 'success',
        section: 'voice',
        icon: muted ? ICONS.mute : ICONS.unmute,
        title: muted ? 'Micro coupé' : 'Micro réactivé',
        description: muted ? `${member} ne peut plus parler en vocal.` : `${member} peut de nouveau parler en vocal.`,
        fields: [
          field(ICONS.user, 'Membre', userLine(member.user ?? member)),
          field(ICONS.voice, 'Salon', member.voice.channel ? `${member.voice.channel}` : '—'),
          field(ICONS.moderator, 'Par', `${moderator}`),
        ],
      }),
    ],
    components: buttonRows(
      muted
        ? actionButton({ command: 'voice', action: 'unmute', args: [member.id, ownerId], label: 'Réactiver', emoji: ICONS.unmute })
        : actionButton({ command: 'voice', action: 'mute', args: [member.id, ownerId], label: 'Couper', emoji: ICONS.mute }),
      deleteButton(ownerId),
    ),
  };
}

/** Carte « membre déplacé » (+ bouton pour le ramener). */
function moveView({ member, from, to, moderator, ownerId, back = false }) {
  return {
    embeds: [
      card({
        tone: 'info',
        section: 'voice',
        icon: back ? '↩️' : '🔀',
        title: back ? 'Membre ramené' : 'Membre déplacé',
        description: `${member} est maintenant dans ${to}.`,
        fields: [
          field(ICONS.user, 'Membre', userLine(member.user ?? member)),
          field('📤', 'Depuis', from ? `${from}` : '—'),
          field('📥', 'Vers', `${to}`),
          field(ICONS.moderator, 'Par', `${moderator}`),
        ],
      }),
    ],
    components: buttonRows(
      from && !back ? actionButton({ command: 'voice', action: 'moveback', args: [member.id, from.id, ownerId], label: 'Ramener', emoji: '↩️' }) : null,
      deleteButton(ownerId),
    ),
  };
}

module.exports = {
  category: 'voice',
  data: new SlashCommandBuilder()
    .setName('voice')
    .setDescription('Gestion des salons vocaux.')
    .setDefaultMemberPermissions(PermissionFlagsBits.MoveMembers)
    .addSubcommand((s) =>
      s.setName('move').setDescription('Déplace un membre vers un salon vocal.')
        .addUserOption((o) => o.setName('membre').setDescription('Membre').setRequired(true))
        .addChannelOption((o) => o.setName('salon').setDescription('Salon vocal').addChannelTypes(ChannelType.GuildVoice).setRequired(true)))
    .addSubcommand((s) =>
      s.setName('kick').setDescription('Déconnecte un membre du vocal.')
        .addUserOption((o) => o.setName('membre').setDescription('Membre').setRequired(true)))
    .addSubcommand((s) =>
      s.setName('mute').setDescription('Coupe le micro d\'un membre en vocal.')
        .addUserOption((o) => o.setName('membre').setDescription('Membre').setRequired(true)))
    .addSubcommand((s) =>
      s.setName('unmute').setDescription('Réactive le micro d\'un membre.')
        .addUserOption((o) => o.setName('membre').setDescription('Membre').setRequired(true)))
    .addSubcommand((s) =>
      s.setName('disconnect').setDescription('Déconnecte un membre (alias de kick).')
        .addUserOption((o) => o.setName('membre').setDescription('Membre').setRequired(true)))
    .addSubcommand((s) =>
      s.setName('cleanup').setDescription('Déconnecte tous les membres d\'un salon vocal.')
        .addChannelOption((o) => o.setName('salon').setDescription('Salon vocal').addChannelTypes(ChannelType.GuildVoice).setRequired(true))),

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();
    const ownerId = interaction.user.id;

    if (sub === 'cleanup') {
      const channel = interaction.options.getChannel('salon');
      await interaction.deferReply({ ephemeral: true });
      let n = 0;
      let failed = 0;
      let protectedCount = 0;
      for (const m of channel.members.values()) {
        // Membres au rôle supérieur ou égal (ou propriétaire, ou le bot) : ignorés.
        if (!canActOn(interaction, m)) {
          protectedCount += 1;
          continue;
        }
        await m.voice.disconnect(`Cleanup vocal par ${interaction.user.tag}`).then(() => (n += 1)).catch(() => (failed += 1));
      }
      return interaction.editReply({
        embeds: [
          card({
            tone: n ? 'caution' : 'neutral',
            section: 'voice',
            icon: '🧹',
            title: n ? 'Salon vocal vidé' : 'Salon déjà vide',
            description: n
              ? `**${n}** membre${n > 1 ? 's' : ''} déconnecté${n > 1 ? 's' : ''} de ${channel}.`
              : protectedCount ? `Aucun membre de ${channel} ne pouvait être déconnecté par vous.` : `Personne n'était connecté à ${channel}.`,
            fields: [
              field(ICONS.voice, 'Salon', `${channel}`),
              field(ICONS.success, 'Déconnectés', `**${n}**`),
              field(ICONS.error, 'Échecs', `**${failed}**`),
              protectedCount ? field(ICONS.shield, 'Ignorés (hiérarchie)', `**${protectedCount}**`) : null,
            ],
          }),
        ],
      });
    }

    const user = interaction.options.getUser('membre');
    const member = await voiceMember(interaction.guild, user.id);
    const me = interaction.guild.members.me;

    if (sub === 'move') {
      const channel = interaction.options.getChannel('salon');
      const from = member.voice.channel;
      if (from?.id === channel.id) throw new UserError(`${user} est déjà dans ${channel}.`);
      assertCanActOn(interaction, member, 'déplacer');
      assertCanMoveTo(interaction, channel);
      await member.voice.setChannel(channel, `Par ${interaction.user.tag}`);
      return interaction.reply(moveView({ member, from, to: channel, moderator: interaction.user, ownerId }));
    }
    if (sub === 'kick' || sub === 'disconnect') {
      assertCanActOn(interaction, member, 'déconnecter');
      const from = member.voice.channel;
      await member.voice.disconnect(`Par ${interaction.user.tag}`);
      return interaction.reply({
        embeds: [
          card({
            tone: 'caution',
            section: 'voice',
            icon: ICONS.kick,
            title: 'Membre déconnecté',
            description: `${user} a été déconnecté du vocal.`,
            fields: [field(ICONS.user, 'Membre', userLine(user)), field(ICONS.voice, 'Salon', `${from}`), field(ICONS.moderator, 'Par', `${interaction.user}`)],
          }),
        ],
      });
    }
    if (sub === 'mute' || sub === 'unmute') {
      requirePermission(interaction, PermissionFlagsBits.MuteMembers, 'Couper le micro des membres');
      if (member.id !== interaction.user.id) assertCanModerate(interaction.member, member, me, { action: sub === 'mute' ? 'rendre muet' : 'réactiver le micro de' });
      const muted = sub === 'mute';
      if (member.voice.serverMute === muted) throw new UserError(muted ? `Le micro de ${user} est déjà coupé.` : `Le micro de ${user} n'est pas coupé.`);
      await member.voice.setMute(muted, `Par ${interaction.user.tag}`);
      return interaction.reply(muteView(muted, { member, moderator: interaction.user, ownerId }));
    }
  },

  buttons: {
    /** cmd:voice:mute:<memberId>:<ownerId> */
    async mute(interaction, client, [memberId, ownerId]) {
      return toggleMute(interaction, memberId, ownerId, true);
    },
    /** cmd:voice:unmute:<memberId>:<ownerId> */
    async unmute(interaction, client, [memberId, ownerId]) {
      return toggleMute(interaction, memberId, ownerId, false);
    },
    /** cmd:voice:moveback:<memberId>:<channelId>:<ownerId> — ramène le membre dans son salon d'origine. */
    async moveback(interaction, client, [memberId, channelId, ownerId]) {
      requirePermission(interaction, PermissionFlagsBits.MoveMembers, 'Déplacer des membres');
      const member = await voiceMember(interaction.guild, memberId);
      assertCanActOn(interaction, member, 'déplacer');
      const target = interaction.guild.channels.cache.get(channelId);
      if (!target?.isVoiceBased?.()) throw new UserError('Le salon d\'origine n\'existe plus.');
      assertCanMoveTo(interaction, target);
      const from = member.voice.channel;
      if (from?.id === target.id) throw new UserError(`${member} est déjà dans ${target}.`);
      await member.voice.setChannel(target, `Par ${interaction.user.tag}`);
      await interaction.update(moveView({ member, from, to: target, moderator: interaction.user, ownerId, back: true }));
    },
  },
};

async function toggleMute(interaction, memberId, ownerId, muted) {
  requirePermission(interaction, PermissionFlagsBits.MuteMembers, 'Couper le micro des membres');
  const member = await voiceMember(interaction.guild, memberId);
  if (member.id !== interaction.user.id) {
    assertCanModerate(interaction.member, member, interaction.guild.members.me, { action: muted ? 'rendre muet' : 'réactiver le micro de' });
  }
  if (member.voice.serverMute === muted) throw new UserError(muted ? `Le micro de ${member} est déjà coupé.` : `Le micro de ${member} n'est pas coupé.`);
  await member.voice.setMute(muted, `Par ${interaction.user.tag}`);
  await interaction.update(muteView(muted, { member, moderator: interaction.user, ownerId }));
}
