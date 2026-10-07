'use strict';

const { SlashCommandBuilder, version: djsVersion } = require('discord.js');
const { wsLatency } = require('../../utils/latency');
const { formatDuration } = require('../../utils/time');
const { card, field, subtext, ICONS, actionButton, buttonRows, ButtonStyle } = require('../../utils/ui');
const { assertInvoker } = require('../../utils/buttonGuard');

/** Mesure la base de données : { ok, ms }. */
function probeDatabase(client) {
  const started = process.hrtime.bigint();
  try {
    client.database.raw.prepare('SELECT 1').get();
    return { ok: true, ms: Number(process.hrtime.bigint() - started) / 1e6 };
  } catch {
    return { ok: false, ms: null };
  }
}

/** Latence WebSocket → [pastille, libellé]. */
function latencyState(ms) {
  if (ms < 0) return ['⚪', 'inconnue'];
  if (ms < 150) return ['🟢', 'excellente'];
  if (ms < 300) return ['🟡', 'correcte'];
  return ['🔴', 'élevée'];
}

function render(client, ownerId) {
  const db = probeDatabase(client);
  const ws = wsLatency(client);
  const [wsDot, wsLabel] = latencyState(ws);
  const schedulerOn = Boolean(client.services.scheduler?.timer);
  const mem = process.memoryUsage();
  const mb = (n) => `${(n / 1024 / 1024).toFixed(1)} Mo`;

  const tone = !db.ok ? 'danger' : !schedulerOn || ws >= 300 ? 'warning' : 'success';
  const headline = {
    success: '🟢 **Tous les systèmes sont opérationnels.**',
    warning: '🟡 **Service dégradé** : certains composants demandent attention.',
    danger: '🔴 **Incident** : la base de données ne répond pas.',
  }[tone];

  return {
    embeds: [
      card({
        tone,
        section: 'configuration',
        icon: '🩺',
        title: 'État de santé',
        description: [headline, subtext(`Version ${client.config?.version ?? '—'} · Node ${process.version} · discord.js v${djsVersion}`)],
        fields: [
          field(ICONS.latency, 'Latence WebSocket', ws < 0 ? '`N/A`' : `\`${ws} ms\`\n${subtext(`${wsDot} ${wsLabel}`)}`),
          field('🗄️', 'Base de données', db.ok ? `${ICONS.success} OK\n${subtext(`${db.ms.toFixed(2)} ms`)}` : `${ICONS.error} Erreur`),
          field(ICONS.time, 'Planificateur', schedulerOn ? `${ICONS.success} Actif` : `${ICONS.warning} Arrêté`),
          field(ICONS.duration, 'Disponibilité', formatDuration(client.uptime ?? 0) || '—'),
          field(ICONS.server, 'Serveurs', `**${client.guilds.cache.size}**`),
          field(ICONS.memory, 'Mémoire', `${mb(mem.rss)}\n${subtext(`tas : ${mb(mem.heapUsed)}`)}`),
          field(ICONS.bot, 'Commandes', `**${client.commands?.size ?? 0}** chargées\n${subtext(`${client.stats?.commandsRun ?? 0} exécutées`)}`),
          field(ICONS.error, 'Erreurs', `**${client.stats?.errors ?? 0}**\n${subtext('depuis le démarrage')}`),
          field(ICONS.heart, 'Processus', `PID \`${process.pid}\`\n${subtext(process.platform)}`),
        ],
      }),
    ],
    components: buttonRows(
      actionButton({ command: 'health', action: 'refresh', args: [ownerId], label: 'Actualiser', emoji: ICONS.refresh, style: ButtonStyle.Primary }),
    ),
  };
}

module.exports = {
  category: 'configuration',
  data: new SlashCommandBuilder().setName('health').setDescription('État de santé technique du bot (latence, DB, services).'),
  /** @param {import('discord.js').ChatInputCommandInteraction} interaction */
  async execute(interaction, client) {
    await interaction.reply({ ...render(client, interaction.user.id), ephemeral: true });
  },
  buttons: {
    /** cmd:health:refresh:<ownerId> */
    async refresh(interaction, client, [ownerId]) {
      assertInvoker(interaction, ownerId);
      await interaction.update(render(client, ownerId));
    },
  },
};
