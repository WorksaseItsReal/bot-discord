'use strict';

const { createLogger } = require('../core/logger');
const { UserError } = require('../core/errors');
const { describeApiError } = require('../core/apiErrors');
const { hardenInteraction, safeRespond } = require('../core/interactionSafety');
const { errorReply, embeds } = require('../utils/embeds');
const { missingPermissions, permissionLabel } = require('../utils/permissionNames');
const { discordTimestamp } = require('../utils/time');

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
        embeds: [embeds.warning(`Doucement ! Vous pourrez réutiliser \`/${command.data.name}\` ${discordTimestamp(Date.now() + remaining, 'R')}.`)],
        ephemeral: true,
      });
      return;
    }

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

async function handleComponent(client, interaction) {
  const handler = client.componentHandler?.resolve(interaction.customId);
  if (!handler) return; // laissé aux collectors locaux (confirmation, pagination, help…)
  try {
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

/** Identifiant court pour retrouver une erreur dans les logs. */
function errorRef() {
  return Date.now().toString(36).slice(-4).toUpperCase() + Math.random().toString(36).slice(2, 5).toUpperCase();
}

async function reportError(client, interaction, err, source) {
  const isUserError = err instanceof UserError || err?.isUserError;
  if (isUserError) {
    await safeRespond(interaction, errorReply(err.message));
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
    await safeRespond(interaction, errorReply(api.friendly, { footer: `Réf. ${ref}` }));
    return;
  }

  logger.error(`${source} [${ref}] erreur inattendue :`, err);
  await safeRespond(
    interaction,
    errorReply(`Une erreur inattendue est survenue. Réessayez dans un instant.\nSi le problème persiste, communiquez la référence \`${ref}\` à un administrateur.`, {
      footer: `Réf. ${ref}`,
    }),
  );
}

module.exports.reportError = reportError;
