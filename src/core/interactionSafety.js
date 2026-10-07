'use strict';

const { MessageFlags, MessageFlagsBitField, MessagePayload } = require('discord.js');
const { sanitizeEmbeds } = require('../utils/embeds');

/**
 * Couche de sûreté pour les interactions Discord.
 *
 * Problèmes résolus (pour TOUTES les commandes, sans les modifier une à une) :
 *  - « Interaction has already been acknowledged » : `reply()` après un `deferReply()`
 *    devient automatiquement un `editReply()`, un second `reply()` devient un `followUp()`.
 *  - « The reply to this interaction has not been sent or deferred » : `editReply()` /
 *    `followUp()` sans réponse préalable deviennent un `reply()`.
 *  - Options dépréciées de discord.js 14.17+ : `ephemeral` est converti en
 *    `flags: Ephemeral` et `fetchReply` en `withResponse`, sans avertissement.
 *  - `deferReply()` / `deferUpdate()` appelés deux fois deviennent des no-ops.
 *  - Embeds trop longs (description > 4096, champ > 1024, total > 6000…) : tronqués
 *    au lieu de faire échouer la réponse avec « Invalid Form Body ».
 *
 * Le patch est appliqué sur l'instance (pas sur le prototype) et de façon
 * synchrone dès la réception de l'interaction, donc AVANT que les collectors
 * ne la reçoivent : les interactions collectées (boutons, menus) sont aussi protégées.
 */

const HARDENED = Symbol('gadget.hardened');

/** Combine des flags existants (nombre, tableau, BitField) avec Ephemeral. */
function withEphemeral(flags) {
  return new MessageFlagsBitField(flags ?? 0).add(MessageFlags.Ephemeral).bitfield;
}

/**
 * Normalise des options de réponse. Fonction pure (testée).
 * @param {unknown} options
 * @param {{ allowEphemeral?: boolean }} [opts]
 * @returns {{ options: any, fetch: boolean }}
 */
function normalizeOptions(options, { allowEphemeral = true } = {}) {
  if (options == null || typeof options !== 'object' || Array.isArray(options) || options instanceof MessagePayload) {
    return { options, fetch: false };
  }
  const out = { ...options };
  let fetch = false;
  if ('fetchReply' in out) {
    fetch = Boolean(out.fetchReply);
    delete out.fetchReply;
  }
  if ('withResponse' in out) {
    // Géré par la couche : on renvoie toujours un Message quand une réponse est demandée.
    fetch = fetch || Boolean(out.withResponse);
    delete out.withResponse;
  }
  if ('ephemeral' in out) {
    const ephemeral = Boolean(out.ephemeral);
    delete out.ephemeral;
    if (ephemeral && allowEphemeral) out.flags = withEphemeral(out.flags);
  }
  if (Array.isArray(out.embeds)) out.embeds = sanitizeEmbeds(out.embeds);
  return { options: out, fetch };
}

/** Retire les flags qu'on ne peut pas changer lors d'une édition. */
function stripForEdit(options) {
  if (options && typeof options === 'object' && !(options instanceof MessagePayload) && 'flags' in options) {
    const flags = new MessageFlagsBitField(options.flags ?? 0).remove(MessageFlags.Ephemeral).bitfield;
    const out = { ...options };
    if (flags) out.flags = flags;
    else delete out.flags;
    return out;
  }
  return options;
}

/**
 * Applique la couche de sûreté sur une interaction (idempotent).
 * @template {import('discord.js').BaseInteraction} T
 * @param {T} interaction
 * @returns {T}
 */
function hardenInteraction(interaction) {
  if (!interaction || interaction[HARDENED]) return interaction;
  if (typeof interaction.isRepliable !== 'function' || !interaction.isRepliable()) return interaction;
  interaction[HARDENED] = true;

  const original = {
    reply: interaction.reply.bind(interaction),
    deferReply: interaction.deferReply.bind(interaction),
    editReply: interaction.editReply.bind(interaction),
    followUp: interaction.followUp.bind(interaction),
    fetchReply: interaction.fetchReply.bind(interaction),
    update: typeof interaction.update === 'function' ? interaction.update.bind(interaction) : null,
    deferUpdate: typeof interaction.deferUpdate === 'function' ? interaction.deferUpdate.bind(interaction) : null,
  };

  const acknowledged = () => interaction.deferred || interaction.replied;

  interaction.reply = async (raw) => {
    const { options, fetch } = normalizeOptions(raw);
    if (interaction.replied) return original.followUp(options);
    if (interaction.deferred) return original.editReply(stripForEdit(options));
    if (!fetch) return original.reply(options);
    const response = await original.reply(withResponseOption(options));
    return response?.resource?.message ?? original.fetchReply();
  };

  interaction.deferReply = async (raw) => {
    const { options, fetch } = normalizeOptions(raw ?? {});
    if (acknowledged()) return fetch ? original.fetchReply().catch(() => null) : undefined;
    if (!fetch) return original.deferReply(options);
    const response = await original.deferReply(withResponseOption(options));
    return response?.resource?.message ?? original.fetchReply();
  };

  interaction.editReply = async (raw) => {
    const { options } = normalizeOptions(raw, { allowEphemeral: false });
    if (!acknowledged()) {
      const response = await original.reply(withResponseOption(options));
      return response?.resource?.message ?? original.fetchReply();
    }
    return original.editReply(stripForEdit(options));
  };

  interaction.followUp = async (raw) => {
    const { options } = normalizeOptions(raw);
    if (!acknowledged()) {
      const response = await original.reply(withResponseOption(options));
      return response?.resource?.message ?? original.fetchReply();
    }
    return original.followUp(options);
  };

  if (original.update) {
    interaction.update = async (raw) => {
      const { options, fetch } = normalizeOptions(raw, { allowEphemeral: false });
      if (acknowledged()) return original.editReply(stripForEdit(options));
      if (!fetch) return original.update(options);
      const response = await original.update(withResponseOption(options));
      return response?.resource?.message ?? interaction.message;
    };
  }

  if (original.deferUpdate) {
    interaction.deferUpdate = async (raw) => {
      const { options, fetch } = normalizeOptions(raw ?? {}, { allowEphemeral: false });
      if (acknowledged()) return fetch ? interaction.message : undefined;
      if (!fetch) return original.deferUpdate(options);
      const response = await original.deferUpdate(withResponseOption(options));
      return response?.resource?.message ?? interaction.message;
    };
  }

  return interaction;
}

function withResponseOption(options) {
  if (options == null) return { withResponse: true };
  if (typeof options === 'string') return { content: options, withResponse: true };
  if (options instanceof MessagePayload) return options;
  return { ...options, withResponse: true };
}

/**
 * Répond « au mieux » à une interaction sans jamais lever d'exception
 * (interaction expirée, déjà répondue, salon supprimé…).
 * @returns {Promise<boolean>} true si la réponse a pu être envoyée
 */
async function safeRespond(interaction, payload) {
  if (!interaction?.isRepliable?.()) return false;
  try {
    hardenInteraction(interaction);
    // reply() « durci » choisit seul : reply, editReply (si différé) ou followUp.
    await interaction.reply(payload);
    return true;
  } catch {
    return false;
  }
}

module.exports = { hardenInteraction, normalizeOptions, safeRespond, HARDENED };
