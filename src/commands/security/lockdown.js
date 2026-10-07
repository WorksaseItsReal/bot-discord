'use strict';

const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const { confirm } = require('../../utils/confirmation');
const { card, field, ICONS, actionButton, buttonRows, ButtonStyle } = require('../../utils/ui');
const { serverLockCard } = require('../../services/LockdownService');
const { assertAdmin } = require('../../services/ModerationService');

function enableButton() {
  return actionButton({ command: 'lockdown', action: 'enable', label: 'Activer le lockdown', emoji: '🚨', style: ButtonStyle.Danger });
}

function disableButton() {
  return actionButton({ command: 'lockdown', action: 'disable', label: 'Lever le lockdown', emoji: ICONS.unlock, style: ButtonStyle.Success });
}

/** Panneau d'état : nombre de salons verrouillés + bouton d'action adapté. */
function renderStatus(lockdown, guild) {
  const n = lockdown.status(guild);
  return {
    embeds: [
      card({
        tone: n ? 'caution' : 'neutral',
        section: 'security',
        icon: n ? ICONS.lock : ICONS.unlock,
        title: 'Lockdown',
        description: n
          ? `🔴 Lockdown **en cours** : ${n > 1 ? `**${n}** salons sont` : '**1** salon est'} en lecture seule.`
          : '🟢 Aucun salon n\'est verrouillé. Le serveur fonctionne normalement.',
        fields: [field(ICONS.count, 'Salons verrouillés', `**${n}**`)],
      }),
    ],
    components: buttonRows(n ? disableButton() : enableButton()),
  };
}

/** Demande confirmation puis verrouille tout ; la carte remplace la confirmation. */
async function runEnable(interaction, client) {
  const ok = await confirm(interaction, { description: 'Verrouiller **tous** les salons écrits du serveur ?', confirmLabel: 'Lockdown' });
  if (!ok) return;
  const n = await client.services.lockdown.enable(interaction.guild, interaction.member, `Lockdown par ${interaction.user.tag}`);
  await interaction.editReply({ embeds: [serverLockCard({ enabled: true, count: n, moderator: interaction.user })], components: buttonRows(disableButton()) });
}

async function runDisable(interaction, client) {
  await interaction.deferReply({ ephemeral: true });
  const n = await client.services.lockdown.disable(interaction.guild, interaction.member);
  await interaction.editReply({ embeds: [serverLockCard({ enabled: false, count: n, moderator: interaction.user })], components: buttonRows(enableButton()) });
}

module.exports = {
  category: 'security',
  data: new SlashCommandBuilder()
    .setName('lockdown')
    .setDescription('Verrouillage d\'urgence de tout le serveur.')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommand((s) => s.setName('enable').setDescription('Active le lockdown (verrouille tous les salons).'))
    .addSubcommand((s) => s.setName('disable').setDescription('Désactive le lockdown (restaure les salons).'))
    .addSubcommand((s) => s.setName('status').setDescription('Affiche l\'état du lockdown.')),

  async execute(interaction, client) {
    const sub = interaction.options.getSubcommand();
    if (sub === 'status') return interaction.reply({ ...renderStatus(client.services.lockdown, interaction.guild), ephemeral: true });
    if (sub === 'enable') return runEnable(interaction, client);
    if (sub === 'disable') return runDisable(interaction, client);
  },

  buttons: {
    /** cmd:lockdown:enable — avec confirmation, réservé aux administrateurs. */
    async enable(interaction, client) {
      assertAdmin(interaction);
      return runEnable(interaction, client);
    },
    /** cmd:lockdown:disable — aussi proposé sur les alertes AntiRaid ; réservé aux administrateurs. */
    async disable(interaction, client) {
      assertAdmin(interaction);
      return runDisable(interaction, client);
    },
  },
};
