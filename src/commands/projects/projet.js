'use strict';

const {
  SlashCommandBuilder,
  ChannelType,
  PermissionFlagsBits,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ActionRowBuilder,
} = require('discord.js');
const { UserError } = require('../../core/errors');
const { progressBar, truncate } = require('../../utils/embeds');
const { confirm } = require('../../utils/confirmation');
const { assertInvoker, snowflake } = require('../../utils/buttonGuard');
const { discordTimestamp } = require('../../utils/time');
const {
  card,
  field,
  status: statusCard,
  subtext,
  ICONS,
  actionButton,
  linkButton,
  labelButton,
  deleteButton,
  buttonRows,
  ButtonStyle,
} = require('../../utils/ui');
const {
  LIMITS,
  STATUSES,
  statusMeta,
  statusChoices,
  parseColor,
  formatColor,
  parseTags,
  parseDeadline,
  normalizeUrl,
  projectSection,
  buildProjectEmbed,
  buildProjectComponents,
  buildProjectListPages,
  buildProjectStatsEmbed,
  buildProjectSettingsEmbed,
} = require('../../utils/projectFormat');

const projectOption = (o) =>
  o.setName('projet').setDescription('Le projet (numéro ou nom)').setRequired(true).setAutocomplete(true).setMaxLength(100);

const data = new SlashCommandBuilder()
  .setName('projet')
  .setDescription('Gérez et présentez les projets du serveur.')
  .addSubcommand((s) =>
    s
      .setName('creer')
      .setDescription('Crée un nouveau projet.')
      .addStringOption((o) => o.setName('nom').setDescription('Nom du projet').setRequired(true).setMaxLength(LIMITS.name))
      .addStringOption((o) => o.setName('description').setDescription('Description (modifiable ensuite avec /projet modifier)').setMaxLength(LIMITS.description))
      .addStringOption((o) => o.setName('statut').setDescription('Statut initial').addChoices(...statusChoices()))
      .addStringOption((o) => o.setName('tags').setDescription('Tags séparés par des virgules (ex: web, bot)').setMaxLength(250))
      .addStringOption((o) => o.setName('echeance').setDescription('Échéance : JJ/MM/AAAA, AAAA-MM-JJ ou durée (2w, 10d)').setMaxLength(20))
      .addStringOption((o) => o.setName('lien').setDescription('Lien principal (https://…)').setMaxLength(LIMITS.url))
      .addStringOption((o) => o.setName('image').setDescription('Image de bannière (https://…)').setMaxLength(LIMITS.url))
      .addStringOption((o) => o.setName('couleur').setDescription('Couleur de l\'embed (#5865F2)').setMaxLength(9)),
  )
  .addSubcommand((s) => s.setName('voir').setDescription('Affiche la fiche d\'un projet.').addStringOption(projectOption))
  .addSubcommand((s) =>
    s
      .setName('liste')
      .setDescription('Liste les projets du serveur.')
      .addStringOption((o) => o.setName('statut').setDescription('Filtrer par statut').addChoices(...statusChoices()))
      .addUserOption((o) => o.setName('membre').setDescription('Projets d\'un membre (responsable ou équipe)')),
  )
  .addSubcommand((s) => s.setName('modifier').setDescription('Modifie nom, description, tags, image et couleur (formulaire).').addStringOption(projectOption))
  .addSubcommand((s) =>
    s
      .setName('statut')
      .setDescription('Change le statut d\'un projet.')
      .addStringOption(projectOption)
      .addStringOption((o) => o.setName('statut').setDescription('Nouveau statut').setRequired(true).addChoices(...statusChoices())),
  )
  .addSubcommand((s) =>
    s
      .setName('progression')
      .setDescription('Définit la progression (projets sans tâches).')
      .addStringOption(projectOption)
      .addIntegerOption((o) => o.setName('pourcentage').setDescription('Avancement du projet, de 0 à 100 %').setRequired(true).setMinValue(0).setMaxValue(100)),
  )
  .addSubcommand((s) =>
    s
      .setName('echeance')
      .setDescription('Définit ou retire l\'échéance.')
      .addStringOption(projectOption)
      .addStringOption((o) => o.setName('date').setDescription('JJ/MM/AAAA, AAAA-MM-JJ, durée (2w) ou « aucune »').setRequired(true).setMaxLength(20)),
  )
  .addSubcommand((s) =>
    s
      .setName('membre-ajouter')
      .setDescription('Ajoute un membre à l\'équipe.')
      .addStringOption(projectOption)
      .addUserOption((o) => o.setName('membre').setDescription('Membre à ajouter').setRequired(true))
      .addStringOption((o) => o.setName('role').setDescription('Rôle dans le projet (ex: Développeur)').setMaxLength(LIMITS.memberRole)),
  )
  .addSubcommand((s) =>
    s
      .setName('membre-retirer')
      .setDescription('Retire un membre de l\'équipe.')
      .addStringOption(projectOption)
      .addUserOption((o) => o.setName('membre').setDescription('Membre à retirer').setRequired(true)),
  )
  .addSubcommand((s) =>
    s
      .setName('tache-ajouter')
      .setDescription('Ajoute une tâche au projet.')
      .addStringOption(projectOption)
      .addStringOption((o) => o.setName('titre').setDescription('Intitulé de la tâche').setRequired(true).setMaxLength(LIMITS.taskTitle)),
  )
  .addSubcommand((s) =>
    s
      .setName('tache-cocher')
      .setDescription('Coche ou décoche une tâche.')
      .addStringOption(projectOption)
      .addStringOption((o) => o.setName('tache').setDescription('La tâche').setRequired(true).setAutocomplete(true).setMaxLength(100)),
  )
  .addSubcommand((s) =>
    s
      .setName('tache-supprimer')
      .setDescription('Supprime une tâche.')
      .addStringOption(projectOption)
      .addStringOption((o) => o.setName('tache').setDescription('La tâche').setRequired(true).setAutocomplete(true).setMaxLength(100)),
  )
  .addSubcommand((s) =>
    s
      .setName('lien-ajouter')
      .setDescription('Ajoute un lien (bouton) au projet.')
      .addStringOption(projectOption)
      .addStringOption((o) => o.setName('nom').setDescription('Texte du bouton (ex: GitHub)').setRequired(true).setMaxLength(LIMITS.linkLabel))
      .addStringOption((o) => o.setName('url').setDescription('Adresse https://…').setRequired(true).setMaxLength(LIMITS.url)),
  )
  .addSubcommand((s) =>
    s
      .setName('lien-retirer')
      .setDescription('Retire un lien du projet.')
      .addStringOption(projectOption)
      .addStringOption((o) => o.setName('nom').setDescription('Lien à retirer').setRequired(true).setAutocomplete(true).setMaxLength(LIMITS.linkLabel)),
  )
  .addSubcommand((s) =>
    s
      .setName('publier')
      .setDescription('Publie la fiche dans un salon (mise à jour automatique).')
      .addStringOption(projectOption)
      .addChannelOption((o) =>
        o.setName('salon').setDescription('Salon de publication').addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement),
      ),
  )
  .addSubcommand((s) =>
    s
      .setName('transferer')
      .setDescription('Transfère la responsabilité du projet.')
      .addStringOption(projectOption)
      .addUserOption((o) => o.setName('membre').setDescription('Nouveau responsable').setRequired(true)),
  )
  .addSubcommand((s) => s.setName('supprimer').setDescription('Supprime définitivement un projet.').addStringOption(projectOption))
  .addSubcommand((s) => s.setName('stats').setDescription('Statistiques des projets du serveur.'))
  .addSubcommand((s) =>
    s
      .setName('config')
      .setDescription('Réglages des projets (Gérer le serveur).')
      .addRoleOption((o) => o.setName('role_gestionnaire').setDescription('Rôle pouvant gérer tous les projets'))
      .addChannelOption((o) =>
        o.setName('salon').setDescription('Salon de publication par défaut').addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement),
      )
      .addBooleanOption((o) => o.setName('creation_ouverte').setDescription('Tout le monde peut créer des projets'))
      .addIntegerOption((o) => o.setName('max_par_membre').setDescription('Projets actifs max par membre').setMinValue(1).setMaxValue(50))
      .addBooleanOption((o) => o.setName('reinitialiser').setDescription('Retirer le rôle et le salon configurés')),
  );

/** Projets affichés par page dans /projet liste. */
const PER_PAGE = 6;

/**
 * Formulaire d'édition d'un projet (soumis vers `project:edit:<id>`,
 * traité par src/components/project.js). Utilisé par /projet modifier et le bouton « Modifier ».
 */
function buildEditModal(project) {
  const input = (id, label, style, { value, max, required = false, placeholder } = {}) => {
    const text = new TextInputBuilder().setCustomId(id).setLabel(label).setStyle(style).setRequired(required).setMaxLength(max);
    if (value) text.setValue(String(value).slice(0, max));
    if (placeholder) text.setPlaceholder(placeholder);
    return new ActionRowBuilder().addComponents(text);
  };
  return new ModalBuilder()
    .setCustomId(`project:edit:${project.id}`)
    .setTitle(truncate(`Modifier le projet #${project.number}`, 45))
    .addComponents(
      input('name', 'Nom', TextInputStyle.Short, { value: project.name, max: LIMITS.name, required: true }),
      input('description', 'Description', TextInputStyle.Paragraph, { value: project.description, max: LIMITS.description }),
      input('tags', 'Tags (séparés par des virgules)', TextInputStyle.Short, { value: (project.tags || []).join(', '), max: 250 }),
      input('image', 'Image de bannière (https://…)', TextInputStyle.Short, { value: project.imageUrl, max: LIMITS.url }),
      input('color', 'Couleur (#RRGGBB, vide = couleur du statut)', TextInputStyle.Short, {
        value: project.color != null ? formatColor(project.color) : '',
        max: 9,
        placeholder: '#5865F2',
      }),
    );
}

/** Projet visé par un bouton (identifiant interne encodé dans le customId). */
function projectFromButton(service, interaction, idStr) {
  const project = service.repo.get(Number(idStr));
  if (!project || project.guildId !== interaction.guildId) {
    throw new UserError('Ce projet n\'existe plus. Il a peut-être été supprimé.');
  }
  return project;
}

/** Réponse éphémère : retour d'action + aperçu à jour du projet. */
function updatedReply(service, project, guild, message) {
  const { tasks, members } = service.details(project);
  return {
    embeds: [statusCard.ok(message), buildProjectEmbed(project, { tasks, members, guild })],
    // Mêmes boutons que la fiche (modifier, publier, liens) : l'action suivante est à un clic.
    components: buildProjectComponents(project, { hasTasks: tasks.length > 0 }),
    ephemeral: true,
  };
}

function publishedHint(project) {
  return project.messageId ? ' La fiche publiée sera mise à jour automatiquement.' : '';
}

/** Publie une fiche dans `channel` après vérification des droits de la personne. */
async function publishTo(interaction, service, project, channel) {
  service.assertCanEdit(project, interaction.member);
  if (!channel?.isTextBased?.()) throw new UserError('Choisissez un salon textuel.');
  // La personne doit elle-même pouvoir écrire dans le salon visé.
  if (!channel.permissionsFor?.(interaction.member)?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages])) {
    throw new UserError(`Vous ne pouvez pas envoyer de messages dans ${channel}.`);
  }
  await interaction.deferReply({ ephemeral: true });
  const updated = await service.publish(project, channel);
  const link = `https://discord.com/channels/${interaction.guildId}/${updated.channelId}/${updated.messageId}`;
  await interaction.editReply({
    embeds: [
      card({
        tone: 'success',
        section: projectSection(updated, interaction.guild),
        icon: '📢',
        title: 'Fiche publiée',
        description: [
          `La fiche de **${updated.name}** est en ligne dans ${channel}.`,
          subtext('Elle se met à jour automatiquement à chaque modification du projet.'),
        ],
        fields: [field(ICONS.channel, 'Salon', `${channel}`), field(ICONS.refresh, 'Mise à jour', 'Automatique')],
      }),
    ],
    components: buttonRows(linkButton('Voir la fiche', link, ICONS.link)),
  });
  return updated;
}

/**
 * Liste paginée SANS état serveur : page, filtre et auteur sont encodés dans le bouton.
 *   cmd:projet:list:<ownerId>:<page>:<statut|->:<membreId|->:<p|r|n>
 */
async function renderList(client, service, guild, { ownerId, page = 0, status = null, memberId = null, entries = service.list(guild.id, { status, memberId }) }) {
  const why = status ? ` avec le statut **${statusMeta(status).label}**` : memberId ? ` pour <@${memberId}>` : '';
  if (!entries.length) {
    return {
      embeds: [statusCard.note(`Aucun projet${why}. Créez-en un avec \`/projet creer\`.`, `${ICONS.project} Projets`)],
      components: buttonRows(deleteButton(ownerId)),
    };
  }
  let filterLabel = null;
  if (status) filterLabel = `${statusMeta(status).emoji} ${statusMeta(status).label}`;
  else if (memberId) {
    const user = client.users.cache.get(memberId) ?? (await client.users.fetch(memberId).catch(() => null));
    filterLabel = user?.username ?? 'membre';
  }
  const pages = buildProjectListPages(entries, { guildName: guild.name, filterLabel, perPage: PER_PAGE });
  const index = Math.min(Math.max(0, Number(page) || 0), pages.length - 1);
  const embed = pages[index];
  if (pages.length > 1) embed.setFooter({ ...embed.data.footer, text: `${embed.data.footer.text} • Page ${index + 1}/${pages.length}` });

  const args = (target, tag) => [ownerId, target, status ?? '-', memberId ?? '-', tag];
  const nav = pages.length > 1
    ? [
      actionButton({ command: 'projet', action: 'list', args: args(index - 1, 'p'), emoji: ICONS.back, disabled: index === 0 }),
      labelButton(`${index + 1} / ${pages.length}`),
      actionButton({ command: 'projet', action: 'list', args: args(index + 1, 'n'), emoji: ICONS.next, disabled: index === pages.length - 1 }),
    ]
    : [];
  return {
    embeds: [embed],
    components: buttonRows(
      ...nav,
      actionButton({ command: 'projet', action: 'list', args: args(index, 'r'), label: 'Actualiser', emoji: ICONS.refresh, style: ButtonStyle.Primary }),
      deleteButton(ownerId),
    ),
  };
}

function renderStats(service, guild, ownerId) {
  const s = service.stats(guild.id);
  if (!s.total) return null;
  return {
    embeds: [buildProjectStatsEmbed(s, { guildName: guild.name, thumbnail: guild.iconURL?.({ size: 128 }) ?? null })],
    components: buttonRows(
      actionButton({ command: 'projet', action: 'stats', args: [ownerId], label: 'Actualiser', emoji: ICONS.refresh, style: ButtonStyle.Primary }),
      deleteButton(ownerId),
    ),
  };
}

const EMPTY_STATS = 'Aucun projet pour le moment. Lancez-vous avec `/projet creer` !';

module.exports = {
  category: 'projects',
  cooldown: 2_000,
  data,
  buildEditModal,

  /** @param {import('discord.js').ChatInputCommandInteraction} interaction */
  async execute(interaction, client) {
    const service = client.services.projects;
    const sub = interaction.options.getSubcommand();
    const guild = interaction.guild;
    const member = interaction.member;
    const handler = HANDLERS[sub];
    if (!handler) throw new UserError('Sous-commande inconnue.');
    return handler({ interaction, client, service, guild, member });
  },

  /** @param {import('discord.js').AutocompleteInteraction} interaction */
  async autocomplete(interaction, client) {
    const service = client.services.projects;
    const focused = interaction.options.getFocused(true);
    if (!interaction.guildId) return interaction.respond([]);

    if (focused.name === 'projet') {
      return interaction.respond(service.autocomplete(interaction.guildId, focused.value));
    }

    let project = null;
    try {
      project = service.resolve(interaction.guildId, interaction.options.getString('projet'));
    } catch {
      return interaction.respond([]);
    }
    const q = String(focused.value || '').toLowerCase();

    if (focused.name === 'tache') {
      const choices = service.repo
        .tasks(project.id)
        .filter((t) => !q || t.title.toLowerCase().includes(q))
        .slice(0, 25)
        .map((t) => ({ name: `${t.done ? '✅' : '⬜'} ${t.title}`.slice(0, 100), value: String(t.id) }));
      return interaction.respond(choices);
    }
    if (focused.name === 'nom' && interaction.options.getSubcommand() === 'lien-retirer') {
      const choices = (project.links || [])
        .filter((l) => !q || l.label.toLowerCase().includes(q))
        .slice(0, 25)
        .map((l) => ({ name: l.label.slice(0, 100), value: l.label.slice(0, 100) }));
      return interaction.respond(choices);
    }
    return interaction.respond([]);
  },

  buttons: {
    /** cmd:projet:publish:<projectId> — publie la fiche dans le salon courant. */
    async publish(interaction, client, [projectId]) {
      const service = client.services.projects;
      const project = projectFromButton(service, interaction, projectId);
      await publishTo(interaction, service, project, interaction.channel);
    },

    /** cmd:projet:edit:<projectId> — ouvre le formulaire de modification. */
    async edit(interaction, client, [projectId]) {
      const service = client.services.projects;
      const project = projectFromButton(service, interaction, projectId);
      service.assertCanEdit(project, interaction.member);
      await interaction.showModal(buildEditModal(project));
    },

    /** cmd:projet:list:<ownerId>:<page>:<statut|->:<membreId|->:<tag> — navigation / actualisation. */
    async list(interaction, client, [ownerId, page, status, memberId]) {
      assertInvoker(interaction, ownerId);
      // Arguments contrôlés par le client : statut connu et identifiant Discord uniquement.
      if (status && status !== '-' && !Object.hasOwn(STATUSES, status)) throw new UserError('Bouton invalide (statut).');
      const view = await renderList(client, client.services.projects, interaction.guild, {
        ownerId,
        page: Number(page) || 0,
        status: status && status !== '-' ? status : null,
        memberId: memberId && memberId !== '-' ? snowflake(memberId, 'membre') : null,
      });
      await interaction.update(view);
    },

    /** cmd:projet:stats:<ownerId> — actualise les statistiques. */
    async stats(interaction, client, [ownerId]) {
      assertInvoker(interaction, ownerId);
      const view = renderStats(client.services.projects, interaction.guild, ownerId);
      await interaction.update(view ?? { embeds: [statusCard.note(EMPTY_STATS, `${ICONS.stats} Statistiques des projets`)], components: buttonRows(deleteButton(ownerId)) });
    },
  },
};

const HANDLERS = {
  async creer({ interaction, service, guild, member }) {
    const o = interaction.options;
    const colorInput = o.getString('couleur');
    const color = colorInput ? parseColor(colorInput) : null;
    if (colorInput && color == null) throw new UserError('Couleur invalide. Exemple : `#5865F2`.');
    const deadlineInput = o.getString('echeance');
    let deadline = null;
    if (deadlineInput) {
      const parsed = parseDeadline(deadlineInput);
      if (parsed.error) throw new UserError(parsed.error);
      deadline = parsed.value;
    }
    const project = service.create(member, {
      name: o.getString('nom'),
      description: o.getString('description'),
      status: o.getString('statut'),
      tags: parseTags(o.getString('tags')),
      deadline,
      link: o.getString('lien'),
      imageUrl: o.getString('image'),
      color,
    });
    const { tasks, members } = service.details(project);
    const links = (project.links || []).filter((l) => normalizeUrl(l.url)).slice(0, LIMITS.links);
    await interaction.reply({
      embeds: [
        statusCard.ok(
          [
            `Projet **#${project.number} · ${project.name}** créé !`,
            subtext('Ajoutez des tâches avec /projet tache-ajouter, puis publiez la fiche pour la partager.'),
          ].join('\n'),
        ),
        buildProjectEmbed(project, { tasks, members, guild }),
      ],
      components: [
        ...buttonRows(links.map((l) => linkButton(truncate(l.label, 80), l.url, ICONS.link))),
        ...buttonRows(
          actionButton({ command: 'projet', action: 'publish', args: [project.id], label: 'Publier ici', emoji: '📢', style: ButtonStyle.Primary }),
          actionButton({ command: 'projet', action: 'edit', args: [project.id], label: 'Modifier', emoji: '✏️' }),
        ),
      ],
    });
  },

  async voir({ interaction, service, guild }) {
    const project = service.resolve(guild.id, interaction.options.getString('projet'));
    await interaction.reply(service.render(project, guild));
  },

  async liste({ interaction, client, service, guild }) {
    const status = interaction.options.getString('statut');
    const user = interaction.options.getUser('membre');
    const entries = service.list(guild.id, { status, memberId: user?.id });
    if (!entries.length) {
      const why = status ? ` avec le statut **${statusMeta(status).label}**` : user ? ` pour ${user}` : '';
      return interaction.reply({
        embeds: [statusCard.note(`Aucun projet${why}. Créez-en un avec \`/projet creer\`.`, `${ICONS.project} Projets`)],
        ephemeral: true,
      });
    }
    await interaction.reply(await renderList(client, service, guild, { ownerId: interaction.user.id, status, memberId: user?.id ?? null, entries }));
  },

  async modifier({ interaction, service, guild, member }) {
    const project = service.resolve(guild.id, interaction.options.getString('projet'));
    service.assertCanEdit(project, member);
    await interaction.showModal(buildEditModal(project));
  },

  async statut({ interaction, service, guild, member }) {
    const project = service.resolve(guild.id, interaction.options.getString('projet'));
    service.assertCanEdit(project, member);
    const status = interaction.options.getString('statut');
    const updated = service.update(project, { status });
    const meta = statusMeta(status);
    await interaction.reply(updatedReply(service, updated, guild, `Statut de **${updated.name}** : ${meta.emoji} **${meta.label}**.${publishedHint(updated)}`));
  },

  async progression({ interaction, service, guild, member }) {
    const project = service.resolve(guild.id, interaction.options.getString('projet'));
    service.assertCanEdit(project, member);
    const value = interaction.options.getInteger('pourcentage');
    const updated = service.setProgress(project, value);
    await interaction.reply(updatedReply(service, updated, guild, `Progression de **${updated.name}** : \`${progressBar(value / 100, 10)}\` **${value} %**.${publishedHint(updated)}`));
  },

  async echeance({ interaction, service, guild, member }) {
    const project = service.resolve(guild.id, interaction.options.getString('projet'));
    service.assertCanEdit(project, member);
    const parsed = parseDeadline(interaction.options.getString('date'));
    if (parsed.error) throw new UserError(parsed.error);
    const updated = service.update(project, { deadline: parsed.value });
    const msg = parsed.clear ? `Échéance de **${updated.name}** retirée.` : `Échéance de **${updated.name}** : ${discordTimestamp(parsed.value, 'D')}.`;
    await interaction.reply(updatedReply(service, updated, guild, msg + publishedHint(updated)));
  },

  async 'membre-ajouter'({ interaction, service, guild, member }) {
    const project = service.resolve(guild.id, interaction.options.getString('projet'));
    service.assertCanManage(project, member);
    const user = interaction.options.getUser('membre');
    if (user.bot) throw new UserError('Un bot ne peut pas faire partie d\'une équipe.');
    const target = await guild.members.fetch(user.id).catch(() => null);
    if (!target) throw new UserError('Ce membre n\'est pas sur le serveur.');
    const role = interaction.options.getString('role');
    const added = service.addMember(project, user.id, role);
    const updated = service.repo.get(project.id);
    await interaction.reply(updatedReply(service, updated, guild, `${user} ${added ? 'a rejoint' : 'est déjà dans'} l'équipe de **${updated.name}**${role ? ` (*${role}*)` : ''}.`));
  },

  async 'membre-retirer'({ interaction, service, guild, member }) {
    const project = service.resolve(guild.id, interaction.options.getString('projet'));
    const user = interaction.options.getUser('membre');
    // Un membre peut se retirer lui-même ; sinon il faut gérer le projet.
    if (user.id !== member.id) service.assertCanManage(project, member);
    service.removeMember(project, user.id);
    const updated = service.repo.get(project.id);
    await interaction.reply(updatedReply(service, updated, guild, `${user} a quitté l'équipe de **${updated.name}**.`));
  },

  async 'tache-ajouter'({ interaction, service, guild, member }) {
    const project = service.resolve(guild.id, interaction.options.getString('projet'));
    service.assertCanEdit(project, member);
    const updated = service.addTask(project, interaction.options.getString('titre'));
    await interaction.reply(updatedReply(service, updated, guild, `Tâche ajoutée à **${updated.name}**.${publishedHint(updated)}`));
  },

  async 'tache-cocher'({ interaction, service, guild, member }) {
    const project = service.resolve(guild.id, interaction.options.getString('projet'));
    service.assertCanEdit(project, member);
    const { task, project: updated, counts } = service.toggleTask(project, interaction.options.getString('tache'), member.id);
    const done = counts.total > 0 && counts.done === counts.total;
    const msg = `${task.done ? 'Tâche terminée' : 'Tâche rouverte'} : **${truncate(task.title, 100)}** (${counts.done}/${counts.total}).${done ? ' 🎉 Toutes les tâches sont terminées !' : ''}`;
    await interaction.reply(updatedReply(service, updated, guild, msg));
  },

  async 'tache-supprimer'({ interaction, service, guild, member }) {
    const project = service.resolve(guild.id, interaction.options.getString('projet'));
    service.assertCanEdit(project, member);
    const { task, project: updated } = service.removeTask(project, interaction.options.getString('tache'));
    await interaction.reply(updatedReply(service, updated, guild, `Tâche supprimée : **${truncate(task.title, 100)}**.`));
  },

  async 'lien-ajouter'({ interaction, service, guild, member }) {
    const project = service.resolve(guild.id, interaction.options.getString('projet'));
    service.assertCanEdit(project, member);
    const updated = service.addLink(project, interaction.options.getString('nom'), interaction.options.getString('url'));
    await interaction.reply(updatedReply(service, updated, guild, `Lien ajouté à **${updated.name}**.${publishedHint(updated)}`));
  },

  async 'lien-retirer'({ interaction, service, guild, member }) {
    const project = service.resolve(guild.id, interaction.options.getString('projet'));
    service.assertCanEdit(project, member);
    const updated = service.removeLink(project, interaction.options.getString('nom'));
    await interaction.reply(updatedReply(service, updated, guild, `Lien retiré de **${updated.name}**.`));
  },

  async publier({ interaction, client, service, guild }) {
    const project = service.resolve(guild.id, interaction.options.getString('projet'));
    const settings = service.settings(guild.id);
    const channel =
      interaction.options.getChannel('salon') ||
      (settings.channelId && guild.channels.cache.get(settings.channelId)) ||
      interaction.channel;
    const updated = await publishTo(interaction, service, project, channel);
    client.logger.debug(`Projet ${updated.id} publié dans ${channel.id}`);
  },

  async transferer({ interaction, service, guild, member }) {
    const project = service.resolve(guild.id, interaction.options.getString('projet'));
    service.assertCanManage(project, member);
    const user = interaction.options.getUser('membre');
    if (user.bot) throw new UserError('Un bot ne peut pas être responsable d\'un projet.');
    const target = await guild.members.fetch(user.id).catch(() => null);
    if (!target) throw new UserError('Ce membre n\'est pas sur le serveur.');
    const updated = service.transfer(project, user.id);
    await interaction.reply(updatedReply(service, updated, guild, `${user} est désormais responsable de **${updated.name}**.`));
  },

  async supprimer({ interaction, service, guild, member }) {
    const project = service.resolve(guild.id, interaction.options.getString('projet'));
    service.assertCanManage(project, member);
    const ok = await confirm(interaction, {
      description: `Supprimer définitivement le projet **#${project.number} · ${project.name}** ainsi que ses tâches et sa fiche publiée ?`,
      confirmLabel: 'Supprimer',
    });
    if (!ok) return;
    await service.delete(project);
    await interaction.followUp({
      embeds: [
        card({
          tone: 'danger',
          section: projectSection(project, guild),
          icon: ICONS.delete,
          title: 'Projet supprimé',
          description: [`**${project.name}** a été supprimé, avec ses tâches et sa fiche publiée.`, subtext('Cette action est définitive.')],
        }),
      ],
      ephemeral: true,
    });
  },

  async stats({ interaction, service, guild }) {
    const view = renderStats(service, guild, interaction.user.id);
    if (!view) {
      return interaction.reply({ embeds: [statusCard.note(EMPTY_STATS, `${ICONS.stats} Statistiques des projets`)], ephemeral: true });
    }
    await interaction.reply(view);
  },

  async config({ interaction, client, service, guild, member }) {
    if (!member.permissions.has(PermissionFlagsBits.ManageGuild)) {
      throw new UserError('Il faut la permission **Gérer le serveur** pour configurer les projets.');
    }
    const o = interaction.options;
    const patch = {};
    const role = o.getRole('role_gestionnaire');
    const channel = o.getChannel('salon');
    const open = o.getBoolean('creation_ouverte');
    const max = o.getInteger('max_par_membre');
    if (o.getBoolean('reinitialiser')) {
      patch.managerRoleId = null;
      patch.channelId = null;
    }
    if (role) {
      if (role.id === guild.id || role.managed) throw new UserError('Choisissez un rôle classique (ni @everyone, ni rôle de bot).');
      patch.managerRoleId = role.id;
    }
    if (channel) patch.channelId = channel.id;
    if (open !== null) patch.openCreation = open;
    if (max !== null) patch.maxPerUser = max;
    const changed = Object.keys(patch).length > 0;
    const settings = changed ? client.services.config.update(guild.id, { projects: patch }).projects : service.settings(guild.id);
    await interaction.reply({ embeds: [buildProjectSettingsEmbed(settings, { changed })], ephemeral: true });
  },
};
