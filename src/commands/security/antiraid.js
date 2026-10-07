'use strict';

const { SlashCommandBuilder, PermissionFlagsBits, ChannelType } = require('discord.js');
const { card, field, wide, kv, ICONS, status, actionButton, buttonRows, ButtonStyle } = require('../../utils/ui');
const { assertAdmin } = require('../../services/ModerationService');
const { newAccountAction } = require('../../services/AntiRaidService');

const ACTION_LABELS = { kick: `${ICONS.kick} Expulsion`, ban: `${ICONS.ban} Bannissement`, lockdown: '🚨 Lockdown' };
const EXECUTOR_LABELS = { strip: 'Retrait des rôles', ban: 'Bannissement', none: 'Aucune' };
const threshold = (n) => (n ? `**${n}**` : 'Désactivé');

/** Option de commande → clé de configuration `antiraid.*` (entiers). */
const INTEGER_OPTIONS = {
  join_seuil: 'joinThreshold',
  join_fenetre: 'joinWindowSeconds',
  age_min_jours: 'minAccountAgeDays',
  seuil_salons: 'channelDeleteThreshold',
  seuil_roles: 'roleDeleteThreshold',
  seuil_bans: 'banThreshold',
  fenetre_destructive: 'destructiveWindowSeconds',
};
/** Option de commande → clé de configuration `antiraid.*` (choix). */
const STRING_OPTIONS = { action: 'action', nouveaux_comptes: 'newAccountAction', sanction_auteur: 'punishExecutor' };

const onOff = (v) => (v ? '🟢 Oui' : '🔴 Non');

/** Panneau d'état AntiRaid (éphémère) avec ses interrupteurs rapides. */
function renderPanel(client, guildId, notice) {
  const cfg = client.services.config.get(guildId);
  const c = cfg.antiraid;
  const wl = cfg.whitelist ?? { users: [], roles: [] };
  const wlCount = (wl.users?.length ?? 0) + (wl.roles?.length ?? 0);
  return {
    embeds: [
      card({
        tone: c.enabled ? 'success' : 'neutral',
        section: 'security',
        icon: ICONS.shield,
        title: 'AntiRaid',
        description: [
          notice ? `${ICONS.success} ${notice}` : null,
          c.enabled ? '🟢 La protection est **active**.' : '🔴 La protection est **désactivée**.',
        ],
        fields: [
          field('⚡', 'Action (vague)', ACTION_LABELS[c.action] ?? c.action),
          field(ICONS.user, 'Comptes récents / bots', ACTION_LABELS[newAccountAction(c)]),
          field(ICONS.bot, 'Anti-bot', onOff(c.antiBot)),
          field(ICONS.members, 'Vague d\'arrivées', `**${c.joinThreshold}** en **${c.joinWindowSeconds} s**`),
          field(ICONS.date, 'Âge min. du compte', c.minAccountAgeDays ? `**${c.minAccountAgeDays}** j` : 'Aucun'),
          field(ICONS.channel, 'Alertes', c.alertChannel ? `<#${c.alertChannel}>` : 'Logs sécurité'),
          field(ICONS.check, 'Whitelist', `**${wlCount}** entrée${wlCount > 1 ? 's' : ''}`),
          wide('💣', `Actions destructrices (en ${c.destructiveWindowSeconds} s)`, kv([
            ['Salons supprimés', threshold(c.channelDeleteThreshold)],
            ['Rôles supprimés', threshold(c.roleDeleteThreshold)],
            ['Bannissements', threshold(c.banThreshold)],
            ['Sanction de l\'auteur', EXECUTOR_LABELS[c.punishExecutor] ?? c.punishExecutor],
          ])),
        ],
        footer: 'Réglages : /antiraid set · Whitelist : /whitelist',
      }),
    ],
    components: buttonRows(
      c.enabled
        ? actionButton({ command: 'antiraid', action: 'toggle', args: ['off'], label: 'Désactiver', emoji: '🔴', style: ButtonStyle.Danger })
        : actionButton({ command: 'antiraid', action: 'toggle', args: ['on'], label: 'Activer', emoji: '🟢', style: ButtonStyle.Success }),
      actionButton({ command: 'antiraid', action: 'antibot', args: [c.antiBot ? 'off' : 'on'], label: c.antiBot ? 'Anti-bot : oui' : 'Anti-bot : non', emoji: ICONS.bot }),
    ),
  };
}

module.exports = {
  category: 'security',
  renderPanel,
  INTEGER_OPTIONS,
  STRING_OPTIONS,
  data: new SlashCommandBuilder()
    .setName('antiraid')
    .setDescription('Configuration de l\'AntiRaid.')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommand((s) => s.setName('enable').setDescription('Active l\'AntiRaid.'))
    .addSubcommand((s) => s.setName('disable').setDescription('Désactive l\'AntiRaid.'))
    .addSubcommand((s) => s.setName('status').setDescription('Affiche la configuration AntiRaid.'))
    .addSubcommand((s) =>
      s.setName('set').setDescription('Règle les paramètres AntiRaid.')
        .addIntegerOption((o) => o.setName('join_seuil').setDescription('Nb d\'arrivées déclenchant une alerte').setMinValue(2))
        .addIntegerOption((o) => o.setName('join_fenetre').setDescription('Fenêtre en secondes').setMinValue(1))
        .addIntegerOption((o) => o.setName('age_min_jours').setDescription('Âge de compte minimal (jours)').setMinValue(0))
        .addBooleanOption((o) => o.setName('anti_bot').setDescription('Sanctionner les bots ajoutés'))
        .addStringOption((o) => o.setName('action').setDescription('Action sur vague d\'arrivées').addChoices({ name: 'Expulsion des arrivants', value: 'kick' }, { name: 'Bannissement des arrivants', value: 'ban' }, { name: 'Lockdown', value: 'lockdown' }))
        .addStringOption((o) => o.setName('nouveaux_comptes').setDescription('Sanction des comptes trop récents et bots').addChoices({ name: 'Expulsion', value: 'kick' }, { name: 'Bannissement', value: 'ban' }))
        .addChannelOption((o) => o.setName('alertes').setDescription('Salon d\'alertes').addChannelTypes(ChannelType.GuildText))
        .addIntegerOption((o) => o.setName('seuil_salons').setDescription('Suppressions de salons déclenchant une alerte (0 = désactivé)').setMinValue(0).setMaxValue(100))
        .addIntegerOption((o) => o.setName('seuil_roles').setDescription('Suppressions de rôles déclenchant une alerte (0 = désactivé)').setMinValue(0).setMaxValue(100))
        .addIntegerOption((o) => o.setName('seuil_bans').setDescription('Bannissements déclenchant une alerte (0 = désactivé)').setMinValue(0).setMaxValue(100))
        .addIntegerOption((o) => o.setName('fenetre_destructive').setDescription('Fenêtre des actions destructrices (secondes)').setMinValue(1).setMaxValue(3600))
        .addStringOption((o) => o.setName('sanction_auteur').setDescription('Sanction de l\'auteur d\'actions destructrices').addChoices({ name: 'Retrait des rôles', value: 'strip' }, { name: 'Bannissement', value: 'ban' }, { name: 'Aucune', value: 'none' }))),

  async execute(interaction, client) {
    const sub = interaction.options.getSubcommand();
    const { config } = client.services;
    const guildId = interaction.guild.id;

    if (sub === 'enable' || sub === 'disable') {
      config.update(guildId, { antiraid: { enabled: sub === 'enable' } });
      return interaction.reply({ ...renderPanel(client, guildId, `AntiRaid **${sub === 'enable' ? 'activé' : 'désactivé'}**.`), ephemeral: true });
    }
    if (sub === 'status') {
      return interaction.reply({ ...renderPanel(client, guildId), ephemeral: true });
    }
    if (sub === 'set') {
      const patch = {};
      for (const [opt, key] of Object.entries(INTEGER_OPTIONS)) {
        const v = interaction.options.getInteger(opt);
        if (v !== null) patch[key] = v;
      }
      for (const [opt, key] of Object.entries(STRING_OPTIONS)) {
        const v = interaction.options.getString(opt);
        if (v) patch[key] = v;
      }
      const antiBot = interaction.options.getBoolean('anti_bot');
      if (antiBot !== null) patch.antiBot = antiBot;
      const alerts = interaction.options.getChannel('alertes');
      if (alerts) patch.alertChannel = alerts.id;
      if (!Object.keys(patch).length) {
        return interaction.reply({ embeds: [status.warn('Aucune option fournie : rien n\'a été modifié.')], ephemeral: true });
      }
      config.update(guildId, { antiraid: patch });
      const n = Object.keys(patch).length;
      return interaction.reply({ ...renderPanel(client, guildId, `${n} paramètre${n > 1 ? 's' : ''} mis à jour.`), ephemeral: true });
    }
  },

  buttons: {
    /** cmd:antiraid:toggle:<on|off> — réservé aux administrateurs (permission de la commande). */
    async toggle(interaction, client, [state]) {
      assertAdmin(interaction);
      const enabled = state === 'on';
      client.services.config.update(interaction.guildId, { antiraid: { enabled } });
      await interaction.update(renderPanel(client, interaction.guildId, `AntiRaid **${enabled ? 'activé' : 'désactivé'}**.`));
    },
    /** cmd:antiraid:antibot:<on|off> — réservé aux administrateurs. */
    async antibot(interaction, client, [state]) {
      assertAdmin(interaction);
      const antiBot = state === 'on';
      client.services.config.update(interaction.guildId, { antiraid: { antiBot } });
      await interaction.update(renderPanel(client, interaction.guildId, `Anti-bot **${antiBot ? 'activé' : 'désactivé'}**.`));
    },
  },
};
