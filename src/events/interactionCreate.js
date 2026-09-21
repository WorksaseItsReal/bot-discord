'use strict';

const { createLogger } = require('../core/logger');
const { UserError } = require('../core/errors');
const { errorReply } = require('../utils/embeds');

const logger = createLogger('interaction');

module.exports = {
  name: 'interactionCreate',
  /**
   * @param {import('../core/GadgetClient').GadgetClient} client
   * @param {import('discord.js').Interaction} interaction
   */
  async execute(client, interaction) {
    if (interaction.isAutocomplete()) return handleAutocomplete(client, interaction);
    if (interaction.isChatInputCommand()) return handleCommand(client, interaction);
  },
};

async function handleCommand(client, interaction) {
  const command = client.commands.get(interaction.commandName);
  if (!command) return;
  try {
    await command.execute(interaction, client);
  } catch (err) {
    await reportError(interaction, err);
  }
}

async function handleAutocomplete(client, interaction) {
  const command = client.commands.get(interaction.commandName);
  if (!command?.autocomplete) return;
  try {
    await command.autocomplete(interaction, client);
  } catch (err) {
    logger.debug('Erreur autocomplete :', err?.message);
  }
}

async function reportError(interaction, err) {
  const isUserError = err instanceof UserError || err?.isUserError;
  if (!isUserError) {
    logger.error(`Erreur commande /${interaction.commandName} :`, err);
  }
  const message = isUserError ? err.message : 'Une erreur inattendue est survenue. Réessayez plus tard.';
  const payload = errorReply(message);
  try {
    if (interaction.deferred || interaction.replied) await interaction.followUp(payload);
    else await interaction.reply(payload);
  } catch {
    /* interaction expirée / déjà répondue : on ignore */
  }
}
