'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const { assertAdmin } = require('../../services/ModerationService');
const { UserError } = require('../../core/errors');
const { own } = require('../../utils/secur');

/** Dossier des sections, chargées automatiquement (ordre alphabétique). */
const SECTIONS_DIR = path.join(__dirname, '..', '..', 'services', 'secur', 'sections');
/** Discord : 25 options de premier niveau (sous-commandes et groupes) au plus. */
const MAX_TOP_LEVEL = 25;
/** Actions réservées à la coquille. */
const SHELL_ACTIONS = ['open'];

/**
 * Charge les sections de /secur : un fichier par section, `{ name, type: 'subcommand'|'group',
 * build(builder), execute(interaction, client, path), buttons?, views? }`. SEC1 livre « statut » ;
 * SEC2 et SEC3 ajoutent leurs sections sans toucher à ce fichier.
 */
function loadSections(dir = SECTIONS_DIR) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith('.js')).sort().flatMap((f) => [].concat(require(path.join(dir, f))));
}

/**
 * Assemble la commande à partir des sections. Lève une Error au chargement : nom ou action en
 * double, plus de 25 options de premier niveau, section invalide.
 * @returns {{ data: SlashCommandBuilder, sections: Map<string, object>, buttons: Record<string, Function>, views: Record<string, Function> }}
 */
function buildShell(sections) {
  const data = new SlashCommandBuilder()
    .setName('secur')
    .setDescription('Anti-nuke Secur : statut, modules, owners et bots de confiance.')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator);
  const byName = new Map();
  const buttons = {};
  const views = {};
  if (sections.length > MAX_TOP_LEVEL) throw new Error(`/secur : ${sections.length} sections, ${MAX_TOP_LEVEL} au plus.`);
  for (const section of sections) {
    const { name, type } = section ?? {};
    if (typeof name !== 'string' || !/^[-_\p{Ll}\p{N}]{1,32}$/u.test(name)) throw new Error(`/secur : section au nom invalide (« ${name} »).`);
    if (byName.has(name)) throw new Error(`/secur : section « ${name} » en double.`);
    if (type !== 'subcommand' && type !== 'group') throw new Error(`/secur ${name} : type « ${type} » inconnu (subcommand ou group).`);
    if (typeof section.build !== 'function' || typeof section.execute !== 'function') throw new Error(`/secur ${name} : build et execute requis.`);
    let built = null;
    if (type === 'group') data.addSubcommandGroup((g) => (built = section.build(g) ?? g));
    else data.addSubcommand((s) => (built = section.build(s) ?? s));
    if (built?.name !== name) throw new Error(`/secur : la section « ${name} » a déclaré le nom « ${built?.name} ».`);
    byName.set(name, section);
    for (const [action, handler] of Object.entries(section.buttons ?? {})) {
      if (typeof handler !== 'function') throw new Error(`/secur ${name} : bouton « ${action} » invalide.`);
      if (SHELL_ACTIONS.includes(action) || own(buttons, action)) throw new Error(`/secur : action « ${action} » en double (section ${name}).`);
      buttons[action] = handler;
    }
    for (const [view, render] of Object.entries(section.views ?? {})) {
      if (typeof render !== 'function') throw new Error(`/secur ${name} : vue « ${view} » invalide.`);
      if (own(views, view)) throw new Error(`/secur : vue « ${view} » en double (section ${name}).`);
      views[view] = render;
    }
  }
  if ((data.options?.length ?? 0) > MAX_TOP_LEVEL) throw new Error(`/secur : plus de ${MAX_TOP_LEVEL} options de premier niveau.`);
  return { data, sections: byName, buttons, views };
}

const shell = buildShell(loadSections());

/**
 * /secur : coquille à sections (Administrateur, réponses éphémères). Le routage des boutons
 * cmd:secur:<action> passe par les `buttons` fusionnés des sections ; `open:<vue>` RÉPOND
 * toujours en éphémère (jamais update) : la carte d'incident publique n'est jamais remplacée.
 */
module.exports = {
  category: 'security',
  cooldown: 3_000,
  loadSections,
  buildShell,
  sections: shell.sections,
  views: shell.views,
  data: shell.data,

  async execute(interaction, client) {
    assertAdmin(interaction);
    const group = interaction.options.getSubcommandGroup(false);
    const sub = interaction.options.getSubcommand(false);
    const section = shell.sections.get(group ?? sub);
    if (!section) throw new UserError('Cette sous-commande n\'est plus disponible. Un administrateur doit redéployer les commandes.');
    return section.execute(interaction, client, [group, sub].filter(Boolean));
  },

  buttons: {
    ...shell.buttons,
    /** cmd:secur:open:<vue> — depuis une carte publique : réponse ÉPHÉMÈRE, carte intacte. */
    async open(interaction, client, [view]) {
      assertAdmin(interaction);
      const render = own(shell.views, view) ? shell.views[view] : shell.views.statut;
      if (!render) throw new UserError('Secur est indisponible pour le moment.');
      await interaction.reply({ ...(await render(client, interaction)), ephemeral: true });
    },
  },
};
