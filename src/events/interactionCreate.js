'use strict';

const { createLogger } = require('../core/logger');
const { UserError } = require('../core/errors');
const { describeApiError } = require('../core/apiErrors');
const { hardenInteraction, safeRespond, safeRespondPrivately, isAcknowledged } = require('../core/interactionSafety');
const { errorReply } = require('../utils/embeds');
const { missingPermissions, permissionLabel } = require('../utils/permissionNames');
const { discordTimestamp } = require('../utils/time');
const { deleteButton, status } = require('../utils/ui');
const { MessagePayload, PermissionsBitField } = require('discord.js');
const { commandLabel } = require('../core/CommandHandler');

const logger = createLogger('interaction');

/** Cooldown par défaut entre deux utilisations d'une même commande (par utilisateur). */
const DEFAULT_COOLDOWN_MS = 2_000;
/** Au-delà, Discord a déjà invalidé l'interaction si elle n'a pas été différée. */
const SLOW_COMMAND_MS = 2_500;

module.exports = {
  name: 'interactionCreate',
  /**
   * @param {import('../core/GadgetClient').GadgetClient} client
   * @param {import('discord.js').Interaction} interaction
   */
  async execute(client, interaction) {
    // Synchrone et en premier : protège aussi les interactions reçues par les collectors.
    hardenInteraction(interaction);

    if (interaction.isAutocomplete()) return handleAutocomplete(client, interaction);
    if (interaction.isChatInputCommand() || interaction.isContextMenuCommand()) return handleCommand(client, interaction);
    if (interaction.isButton() || interaction.isAnySelectMenu() || interaction.isModalSubmit()) {
      return handleComponent(client, interaction);
    }
  },
};

/**
 * Vérifications communes avant exécution. Lève une UserError si la commande
 * ne peut pas s'exécuter dans ce contexte.
 */
/**
 * Permission Discord déclarée par la commande (`setDefaultMemberPermissions`), revérifiée
 * côté bot : Discord ne l'applique qu'à l'AFFICHAGE, et un administrateur peut ouvrir une
 * commande à n'importe quel rôle dans Paramètres du serveur → Intégrations. Sans ce contrôle,
 * un rôle sans « Bannir des membres » pourrait bannir via /ban avec les droits du bot.
 * « 0 » (commande masquée à tous) est réservé aux administrateurs.
 */
function assertMemberPermissions(interaction, command) {
  if (!interaction.inGuild()) return;
  const declared = command.data?.default_member_permissions ?? command.data?.toJSON?.().default_member_permissions;
  if (declared == null) return;
  const required = BigInt(declared) === 0n ? PermissionsBitField.Flags.Administrator : BigInt(declared);
  const have = interaction.memberPermissions;
  if (have?.has?.(required)) return;
  const missing = have ? missingPermissions(have, [required]) : new PermissionsBitField(required).toArray();
  const names = (missing.length ? missing : new PermissionsBitField(required).toArray()).map((p) => `**${permissionLabel(p)}**`).join(', ');
  throw new UserError(`Il vous faut la permission ${names} pour utiliser **${commandLabel(command)}**.`);
}

function preflight(client, interaction, command) {
  if (command.guildOnly !== false && !interaction.inGuild()) {
    throw new UserError('Cette commande ne peut être utilisée que sur un serveur.');
  }
  if (interaction.inGuild() && !interaction.guild) {
    throw new UserError('Je dois être membre de ce serveur pour exécuter cette commande. Invitez-moi avec `/invite`.');
  }
  if (command.ownerOnly && !client.config.ownerIds.includes(interaction.user.id)) {
    throw new UserError('Cette commande est réservée aux propriétaires du bot.');
  }
  assertMemberPermissions(interaction, command);
  if (interaction.inGuild() && command.botPermissions?.length) {
    const missing = missingPermissions(interaction.appPermissions, command.botPermissions);
    if (missing.length) {
      throw new UserError(
        `Il me manque des permissions dans ce salon : ${missing.map((p) => `**${permissionLabel(p)}**`).join(', ')}.`,
      );
    }
  }
}

async function handleCommand(client, interaction) {
  const command = client.commands.get(interaction.commandName);
  if (!command) {
    await safeRespond(interaction, errorReply('Cette commande n\'existe plus. Un administrateur doit redéployer les commandes (`npm run deploy`).'));
    return;
  }

  const cooldownKey = `${command.data.name}:${interaction.user.id}`;
  const started = Date.now();
  try {
    preflight(client, interaction, command);

    const remaining = client.cooldowns.hit(cooldownKey, command.cooldown ?? DEFAULT_COOLDOWN_MS);
    if (remaining > 0) {
      await interaction.reply({
        embeds: [status.warn(`Doucement ! Vous pourrez réutiliser **${commandLabel(command)}** ${discordTimestamp(Date.now() + remaining, 'R')}.`)],
        ephemeral: true,
      });
      return;
    }

    interaction.gadgetDecorate = autoDecorate(interaction, command);
    await command.execute(interaction, client);
    client.stats.commandsRun += 1;
  } catch (err) {
    client.cooldowns.release(cooldownKey);
    await reportError(client, interaction, err, `/${interaction.commandName}`);
  } finally {
    const elapsed = Date.now() - started;
    if (elapsed > SLOW_COMMAND_MS && !interaction.deferred && !interaction.replied) {
      logger.warn(`/${interaction.commandName} a mis ${elapsed}ms sans répondre ni différer (pensez à deferReply).`);
    }
    logger.debug(`/${interaction.commandName} par ${interaction.user.tag} en ${elapsed}ms`);
  }
}

/** Le bouton/menu cliqué figure-t-il vraiment sur le message ? (customId forgé sinon) */
function componentExistsOnMessage(interaction) {
  if (!interaction.isMessageComponent?.() || !interaction.message) return true;
  const rows = interaction.message.components ?? [];
  const walk = (list) => list.some((c) => c?.customId === interaction.customId || (c?.components && walk(c.components)));
  return walk(rows);
}

/** Délai laissé aux collectors locaux avant de signaler un bouton expiré. */
const ORPHAN_COMPONENT_MS = 2_500;

async function handleComponent(client, interaction) {
  const handler = client.componentHandler?.resolve(interaction.customId);
  if (!handler) {
    // Laissé aux collectors locaux (confirmation, pagination, help…). Si personne ne
    // répond (bouton expiré, redémarrage, clic d'un autre membre), on l'explique.
    setTimeout(() => {
      // isAcknowledged couvre aussi un acquittement en cours (requête pas encore revenue).
      if (!isAcknowledged(interaction)) {
        safeRespond(interaction, errorReply('Ce bouton a expiré ou ne vous est pas destiné. Relancez la commande.'));
      }
    }, ORPHAN_COMPONENT_MS).unref?.();
    return;
  }
  try {
    if (!componentExistsOnMessage(interaction)) throw new UserError('Ce bouton est invalide.');
    if (handler.guildOnly !== false && !interaction.inGuild()) {
      throw new UserError('Cette action n\'est disponible que sur un serveur.');
    }
    await handler.execute(interaction, client);
  } catch (err) {
    await reportError(client, interaction, err, `composant ${handler.id}`);
  }
}

async function handleAutocomplete(client, interaction) {
  const command = client.commands.get(interaction.commandName);
  if (!command?.autocomplete) return interaction.respond([]).catch(() => {});
  try {
    await command.autocomplete(interaction, client);
  } catch (err) {
    logger.debug(`Erreur autocomplete /${interaction.commandName} :`, err?.message);
    if (!interaction.responded) await interaction.respond([]).catch(() => {});
  }
}

/**
 * Ajoute le bouton 🗑️ « Supprimer » à la première réponse PUBLIQUE d'une commande
 * (les réponses éphémères ont déjà « Ignorer le message » de Discord).
 * Une commande peut s'en passer avec `autoDelete: false`.
 */
function autoDecorate(interaction, command) {
  let decorated = false;
  return (options, { ephemeral, kind }) => {
    if (ephemeral || command.autoDelete === false) return options;
    if (!options || typeof options !== 'object' || options instanceof MessagePayload || options.poll) return options;
    // Réponse d'origine déjà décorée : une édition qui remplace ses composants garde 🗑️.
    if (decorated) return kind === 'edit' && options.components ? withDeleteButton(options, interaction.user.id) : options;
    if (!options.embeds?.length || kind === 'followUp') return options;
    decorated = true;
    return withDeleteButton(options, interaction.user.id);
  };
}

/** Insère 🗑️ dans la dernière rangée de boutons (ou une nouvelle rangée). Pur. */
function withDeleteButton(options, ownerId) {
  const rows = (options.components || []).map((r) => (typeof r?.toJSON === 'function' ? r.toJSON() : r));
  const hasDelete = rows.some((r) => r?.components?.some((c) => String(c.custom_id ?? c.customId ?? '').startsWith('cmd:_:delete')));
  if (hasDelete) return options;
  const del = deleteButton(ownerId).toJSON();
  const last = rows[rows.length - 1];
  if (last && last.type === 1 && last.components?.length < 5 && last.components.every((c) => c.type === 2)) {
    rows[rows.length - 1] = { ...last, components: [...last.components, del] };
  } else if (rows.length < 5) {
    rows.push({ type: 1, components: [del] });
  } else {
    return options;
  }
  return { ...options, components: rows };
}

/** Identifiant court pour retrouver une erreur dans les logs. */
function errorRef() {
  return Date.now().toString(36).slice(-4).toUpperCase() + Math.random().toString(36).slice(2, 5).toUpperCase();
}

/**
 * Envoie la carte d'erreur. Après une confirmation (« exécution en cours… »),
 * remplace ce message plutôt que d'en ajouter un second.
 * `privately` (erreurs attendues : UserError, erreurs Discord traduites) : après un
 * deferReply public encore vide, la réponse différée est supprimée et l'erreur
 * part en éphémère, au lieu de s'afficher publiquement.
 */
async function respondError(interaction, payload, { privately = false } = {}) {
  const pending = interaction.pendingConfirmation;
  if (pending?.message) {
    interaction.pendingConfirmation = null;
    try {
      await interaction.editReply({ embeds: payload.embeds, components: [], message: pending.message.id });
      return;
    } catch {
      /* message supprimé ou interaction expirée : on retombe sur une réponse classique */
    }
  }
  if (privately) await safeRespondPrivately(interaction, payload);
  else await safeRespond(interaction, payload);
}

async function reportError(client, interaction, err, source) {
  const isUserError = err instanceof UserError || err?.isUserError;
  if (isUserError) {
    await respondError(interaction, errorReply(err.message), { privately: true });
    return;
  }

  const api = describeApiError(err);
  if (api.deadInteraction) {
    logger.debug(`${source} : interaction expirée ou déjà traitée (${api.code}).`);
    return;
  }

  client.stats.errors += 1;
  const ref = errorRef();
  if (api.friendly) {
    logger.warn(`${source} [${ref}] : ${err?.message ?? err}`);
    await respondError(interaction, errorReply(api.friendly, { footer: `Réf. ${ref}` }), { privately: true });
    return;
  }

  logger.error(`${source} [${ref}] erreur inattendue :`, err);
  await respondError(
    interaction,
    errorReply(`Une erreur inattendue est survenue. Réessayez dans un instant.\nSi le problème persiste, communiquez la référence \`${ref}\` à un administrateur.`, {
      footer: `Réf. ${ref}`,
    }),
  );
}

module.exports.reportError = reportError;
module.exports.withDeleteButton = withDeleteButton;
module.exports.componentExistsOnMessage = componentExistsOnMessage;
module.exports.DEFAULT_COOLDOWN_MS = DEFAULT_COOLDOWN_MS;
module.exports.assertMemberPermissions = assertMemberPermissions;
