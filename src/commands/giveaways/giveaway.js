'use strict';

const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const { truncate, listOrMore } = require('../../utils/embeds');
const { parseDuration, discordTimestamp, formatDuration } = require('../../utils/time');
const { card, field, wide, ICONS, status, subtext, linkButton, buttonRows } = require('../../utils/ui');
const { paginate } = require('../../utils/pagination');
const { giveawayUrl, conditions, MAX_REROLL_WINNERS } = require('../../services/GiveawayService');
const { UserError } = require('../../core/errors');

const PER_PAGE = 6;

function assertCanManage(interaction) {
  if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageEvents)) {
    throw new UserError('Il faut la permission **Gérer les événements** pour gérer les giveaways.');
  }
}

/** Conditions de rôles satisfiables par au moins un membre. Pur. */
function assertRoleConditions(guildId, requiredRole, forbiddenRole) {
  if (forbiddenRole && forbiddenRole === guildId) {
    throw new UserError('Le rôle @everyone ne peut pas être le rôle interdit : personne ne pourrait participer.');
  }
  if (requiredRole && forbiddenRole && requiredRole === forbiddenRole) {
    throw new UserError('Le rôle requis et le rôle interdit doivent être différents : personne ne pourrait participer.');
  }
}

function winnersReply(winners, id) {
  const list = winners.map((w) => `<@${w}>`);
  return status.ok(
    winners.length ? `Nouveau tirage : ${listOrMore(list, 20)}. L'annonce est publiée dans le salon du giveaway.` : 'Aucun participant à retirer.',
    `Giveaway #${id} relancé`,
  );
}

module.exports = {
  category: 'giveaways',
  assertRoleConditions,
  data: new SlashCommandBuilder()
    .setName('giveaway')
    .setDescription('Système de giveaways.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageEvents)
    .addSubcommand((s) =>
      s.setName('create').setDescription('Crée un giveaway.')
        .addStringOption((o) => o.setName('recompense').setDescription('Récompense').setRequired(true).setMaxLength(200))
        .addStringOption((o) => o.setName('duree').setDescription('Durée (ex: 1h, 2d)').setRequired(true))
        .addIntegerOption((o) => o.setName('gagnants').setDescription('Nombre de gagnants').setMinValue(1).setMaxValue(20))
        .addRoleOption((o) => o.setName('role_requis').setDescription('Rôle requis pour participer'))
        .addRoleOption((o) => o.setName('role_interdit').setDescription('Rôle interdit')))
    .addSubcommand((s) => s.setName('end').setDescription('Termine un giveaway immédiatement (ou retente une annonce échouée).').addIntegerOption((o) => o.setName('id').setDescription('ID du giveaway').setRequired(true)))
    .addSubcommand((s) =>
      s.setName('reroll').setDescription('Retire de nouveaux gagnants.')
        .addIntegerOption((o) => o.setName('id').setDescription('ID du giveaway').setRequired(true))
        .addIntegerOption((o) => o.setName('gagnants').setDescription('Nombre de gagnants à tirer (défaut : celui du giveaway)').setMinValue(1).setMaxValue(MAX_REROLL_WINNERS)))
    .addSubcommand((s) => s.setName('list').setDescription('Liste les giveaways en cours.')),

  async execute(interaction, client) {
    const sub = interaction.options.getSubcommand();
    const { giveaways } = client.services;
    // Mêmes droits que le bouton Relancer (la permission par défaut peut être modifiée par serveur).
    if (sub === 'create' || sub === 'end' || sub === 'reroll') assertCanManage(interaction);

    if (sub === 'create') {
      const prize = interaction.options.getString('recompense');
      const durationMs = parseDuration(interaction.options.getString('duree'));
      if (!durationMs) throw new UserError('Durée invalide : utilisez par exemple `30m`, `1h` ou `2d`.');
      const winners = interaction.options.getInteger('gagnants') || 1;
      const requiredRole = interaction.options.getRole('role_requis')?.id ?? null;
      const forbiddenRole = interaction.options.getRole('role_interdit')?.id ?? null;
      assertRoleConditions(interaction.guild.id, requiredRole, forbiddenRole);
      const { id, message } = await giveaways.create(interaction.channel, interaction.user, { prize, winners, durationMs, requiredRole, forbiddenRole });
      return interaction.reply({
        embeds: [
          card({
            tone: 'celebrate',
            section: 'giveaways',
            icon: ICONS.success,
            title: `Giveaway #${id} lancé`,
            description: [`**${truncate(prize, 200)}** est en jeu dans ${interaction.channel}.`, subtext(`Terminez-le plus tôt avec /giveaway end id:${id}.`)],
            fields: [
              field('🏆', 'Gagnants', `**${winners}**`),
              field(ICONS.duration, 'Durée', formatDuration(durationMs)),
              field(ICONS.expires, 'Fin', discordTimestamp(Date.now() + durationMs, 'R')),
            ],
          }),
        ],
        components: message?.url ? buttonRows(linkButton('Voir le giveaway', message.url, ICONS.link)) : [],
        ephemeral: true,
      });
    }

    if (sub === 'end') {
      const id = interaction.options.getInteger('id');
      await interaction.deferReply({ ephemeral: true });
      const winners = await giveaways.end(id, { guildId: interaction.guild.id });
      const url = giveawayUrl(giveaways.get(id));
      return interaction.editReply({
        embeds: [
          status.ok(
            winners.length ? `Gagnant(s) : ${listOrMore(winners.map((w) => `<@${w}>`), 20)}.` : 'Aucun participant éligible : pas de gagnant.',
            `Giveaway #${id} terminé`,
          ),
        ],
        components: url ? buttonRows(linkButton('Voir le giveaway', url, ICONS.link)) : [],
      });
    }
    if (sub === 'reroll') {
      const id = interaction.options.getInteger('id');
      await interaction.deferReply({ ephemeral: true });
      const count = interaction.options.getInteger('gagnants');
      const winners = await giveaways.end(id, { reroll: true, guildId: interaction.guild.id, count });
      return interaction.editReply({ embeds: [winnersReply(winners, id)] });
    }
    if (sub === 'list') {
      const active = giveaways.listActive(interaction.guild.id);
      if (!active.length) {
        return interaction.reply({ embeds: [status.note('Aucun giveaway en cours. Lancez-en un avec /giveaway create.', 'Giveaways')], ephemeral: true });
      }
      const pages = [];
      for (let i = 0; i < active.length; i += PER_PAGE) {
        const slice = active.slice(i, i + PER_PAGE);
        pages.push(
          card({
            tone: 'celebrate',
            section: 'giveaways',
            icon: ICONS.gift,
            title: `Giveaways en cours (${active.length})`,
            fields: slice.map((g) => {
              const url = giveawayUrl(g);
              return wide(
                ICONS.gift,
                `#${g.id} · ${truncate(g.prize, 120)}`,
                [
                  `${ICONS.expires} Fin ${discordTimestamp(g.ends_at, 'R')} · 🏆 ${g.winners} gagnant(s) · ${ICONS.members} ${g.entry_count ?? 0} participant(s)`,
                  `${ICONS.owner} <@${g.host_id}> · <#${g.channel_id}>${url ? ` · [Voir](${url})` : ''}`,
                  g.required_role || g.forbidden_role ? conditions(g) : null,
                ].filter(Boolean).join('\n'),
              );
            }),
          }),
        );
      }
      if (pages.length === 1) {
        const links = active.map((g) => [g, giveawayUrl(g)]).filter(([, url]) => url).slice(0, 5);
        return interaction.reply({
          embeds: pages,
          components: buttonRows(links.map(([g, url]) => linkButton(`#${g.id}`, url, ICONS.link))),
          ephemeral: true,
        });
      }
      return paginate(interaction, pages, { ephemeral: true });
    }
  },

  buttons: {
    /** cmd:giveaway:reroll:<id> — nouveau tirage depuis le message du giveaway terminé. */
    async reroll(interaction, client, [idStr]) {
      assertCanManage(interaction);
      const id = Number(idStr);
      await interaction.deferReply({ ephemeral: true });
      const winners = await client.services.giveaways.end(id, { reroll: true, guildId: interaction.guildId });
      return interaction.editReply({ embeds: [winnersReply(winners, id)] });
    },
  },
};
