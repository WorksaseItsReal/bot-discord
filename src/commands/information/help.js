'use strict';

const { SlashCommandBuilder, ApplicationCommandOptionType: T, PermissionsBitField } = require('discord.js');
const { embeds, truncate, brandFooter } = require('../../utils/embeds');
const { row, selectMenu } = require('../../utils/components');
const { CATEGORIES, categoryMeta } = require('../../utils/categories');
const { permissionLabel } = require('../../utils/permissionNames');

/**
 * /help interactif : accueil avec toutes les catégories, menu déroulant pour
 * naviguer, et fiche détaillée de chaque commande (sous-commandes, options).
 */
module.exports = {
  guildOnly: false,
  category: 'information',
  data: new SlashCommandBuilder()
    .setName('help')
    .setDescription('Affiche le menu d\'aide interactif du bot.')
    .addStringOption((o) => o.setName('commande').setDescription('Détail d\'une commande précise').setAutocomplete(true).setMaxLength(32)),

  /** @param {import('discord.js').ChatInputCommandInteraction} interaction */
  async execute(interaction, client) {
    const specific = interaction.options.getString('commande');
    if (specific) {
      const cmd = client.commands.get(specific.replace(/^\//, '').toLowerCase());
      if (!cmd) return interaction.reply({ embeds: [embeds.error(`Commande inconnue : \`${truncate(specific, 32)}\`. Tapez \`/help\` pour la liste.`)], ephemeral: true });
      return interaction.reply({ embeds: [commandDetailEmbed(cmd)], ephemeral: true });
    }

    const grouped = groupByCategory(client.commands);
    const menuId = `help:${interaction.id}`;
    const menu = (selected) =>
      selectMenu({
        id: menuId,
        placeholder: 'Choisissez une catégorie…',
        options: [
          { label: 'Accueil', value: '__home', description: 'Vue d\'ensemble', emoji: '🏠', default: selected === '__home' },
          ...[...grouped.keys()].slice(0, 24).map((key) => ({
            label: categoryMeta(key).label,
            value: key,
            description: `${grouped.get(key).length} commande(s) — ${categoryMeta(key).description}`,
            emoji: categoryMeta(key).emoji,
            default: selected === key,
          })),
        ],
      });

    const message = await interaction.reply({
      embeds: [homeEmbed(client, grouped)],
      components: [row(menu('__home'))],
      ephemeral: true,
      fetchReply: true,
    });

    const collector = message.createMessageComponentCollector({
      filter: (i) => i.user.id === interaction.user.id && i.customId === menuId,
      time: 300_000,
    });
    collector.on('collect', async (i) => {
      const key = i.values[0];
      const embed = key === '__home' ? homeEmbed(client, grouped) : categoryEmbed(key, grouped.get(key) || []);
      await i.update({ embeds: [embed], components: [row(menu(key))] }).catch(() => {});
    });
    collector.on('end', () => interaction.editReply({ components: [] }).catch(() => {}));
  },

  /** @param {import('discord.js').AutocompleteInteraction} interaction */
  async autocomplete(interaction, client) {
    const focused = interaction.options.getFocused().toLowerCase().replace(/^\//, '');
    const choices = [...client.commands.values()]
      .filter((c) => c.data.name.includes(focused) || c.data.description.toLowerCase().includes(focused))
      .sort((a, b) => a.data.name.localeCompare(b.data.name))
      .slice(0, 25)
      .map((c) => ({ name: truncate(`/${c.data.name} — ${c.data.description}`, 100), value: c.data.name }));
    await interaction.respond(choices);
  },
};

function groupByCategory(commands) {
  const map = new Map();
  for (const key of Object.keys(CATEGORIES)) {
    const cmds = [...commands.values()].filter((c) => c.category === key);
    if (cmds.length) map.set(key, cmds.sort((a, b) => a.data.name.localeCompare(b.data.name)));
  }
  for (const cmd of commands.values()) {
    if (!map.has(cmd.category)) map.set(cmd.category, [...commands.values()].filter((c) => c.category === cmd.category));
  }
  return map;
}

/** Nombre total de commandes + sous-commandes (ce que l'utilisateur peut réellement taper). */
function countEntries(commands) {
  let n = 0;
  for (const c of commands.values()) {
    const subs = (c.data.toJSON().options || []).flatMap((o) =>
      o.type === T.Subcommand ? [o] : o.type === T.SubcommandGroup ? o.options || [] : [],
    );
    n += subs.length || 1;
  }
  return n;
}

function homeEmbed(client, grouped) {
  return embeds
    .neutral(`👋 Bienvenue dans l'aide de ${client.user.username}`)
    .setThumbnail(client.user.displayAvatarURL({ size: 256 }))
    .setDescription(
      `Un bot tout-en-un : **${client.commands.size} commandes** et **${countEntries(client.commands)} actions** au total.\n` +
        'Choisissez une catégorie dans le menu ci-dessous, ou tapez `/help commande:<nom>` pour le détail d\'une commande.\n​',
    )
    .addFields(
      [...grouped.entries()].slice(0, 24).map(([key, cmds]) => ({
        name: `${categoryMeta(key).emoji} ${categoryMeta(key).label}`,
        value: `\`${cmds.length}\` commande${cmds.length > 1 ? 's' : ''}`,
        inline: true,
      })),
    );
}

function categoryEmbed(key, cmds) {
  const meta = categoryMeta(key);
  const lines = cmds.map((c) => {
    const subs = (c.data.toJSON().options || []).filter((o) => o.type === T.Subcommand || o.type === T.SubcommandGroup);
    const suffix = subs.length ? ` *(${subs.length} sous-commandes)*` : '';
    return `**\`/${c.data.name}\`** — ${c.data.description}${suffix}`;
  });
  return embeds
    .neutral(`${meta.emoji} ${meta.label}`)
    .setDescription(truncate(`${meta.description}\n\n${lines.join('\n')}`, 4096))
    .setFooter(brandFooter(`${cmds.length} commande(s) • /help commande:<nom> pour le détail`));
}

function describeOption(o) {
  return `\`${o.name}\`${o.required ? '' : ' *(optionnel)*'} — ${o.description}`;
}

function commandDetailEmbed(cmd) {
  const data = cmd.data.toJSON();
  const options = data.options || [];
  const embed = embeds
    .neutral(`📖 /${data.name}`)
    .setDescription(data.description)
    .addFields(
      { name: 'Catégorie', value: `${categoryMeta(cmd.category).emoji} ${categoryMeta(cmd.category).label}`, inline: true },
      { name: 'Utilisable en MP', value: cmd.guildOnly === false ? 'Oui' : 'Non', inline: true },
    );
  if (cmd.cooldown) embed.addFields({ name: 'Délai', value: `${Math.round(cmd.cooldown / 1000)} s`, inline: true });
  if (data.default_member_permissions) {
    const perms = new PermissionsBitField(BigInt(data.default_member_permissions)).toArray().map(permissionLabel);
    if (perms.length) embed.addFields({ name: 'Permission requise', value: perms.join(', '), inline: true });
  }

  const subs = options.filter((o) => o.type === T.Subcommand || o.type === T.SubcommandGroup);
  if (subs.length) {
    const lines = subs.flatMap((s) =>
      s.type === T.SubcommandGroup
        ? (s.options || []).map((ss) => `**\`/${data.name} ${s.name} ${ss.name}\`** — ${ss.description}`)
        : [`**\`/${data.name} ${s.name}\`** — ${s.description}`],
    );
    // Les sous-commandes peuvent être nombreuses : on répartit sur plusieurs champs de 1024 caractères.
    let chunk = '';
    let part = 1;
    for (const line of lines) {
      if ((chunk + line).length > 1000) {
        embed.addFields({ name: part === 1 ? 'Sous-commandes' : '​', value: chunk });
        chunk = '';
        part += 1;
      }
      chunk += `${line}\n`;
    }
    if (chunk) embed.addFields({ name: part === 1 ? 'Sous-commandes' : '​', value: chunk });
  } else {
    embed.addFields({ name: 'Options', value: truncate(options.map(describeOption).join('\n') || 'Aucune', 1024) });
  }
  return embed;
}
