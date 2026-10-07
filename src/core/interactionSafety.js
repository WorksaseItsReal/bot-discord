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
/**
 * État de la couche : acquittement en cours (`inflight`) et nature du premier
 * acquittement (`kind` : reply | deferReply | update | deferUpdate, `ephemeral`).
 */
const STATE = Symbol('gadget.ackState');

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
  // Règle de design : toute réponse est un embed. Un texte brut est mis en forme.
  if (typeof options === 'string') options = { content: options };
  if (options == null || typeof options !== 'object' || Array.isArray(options) || options instanceof MessagePayload) {
    return { options, fetch: false };
  }
  const out = { ...options };
  if (typeof out.content === 'string' && out.content.trim() && !out.embeds?.length && !out.poll && !out.files?.length) {
    out.embeds = [require('../utils/ui').card({ tone: 'neutral', description: out.content })];
    delete out.content;
  }
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

  const state = { inflight: null, kind: null, ephemeral: false };
  interaction[STATE] = state;

  const acknowledged = () => interaction.deferred || interaction.replied;
  /**
   * Vrai si l'interaction (bouton, menu) a été acquittée par update()/deferUpdate() :
   * discord.js lève alors aussi `deferred`, mais « la réponse » EST le message du
   * bouton. Une nouvelle réponse (ex : carte d'erreur) doit partir en followUp,
   * jamais écraser ce message public.
   */
  const updateAcked = () => state.kind === 'update' || state.kind === 'deferUpdate';

  /**
   * Premier acquittement : `inflight` est posé de façon SYNCHRONE avant l'appel
   * réseau. discord.js ne lève `deferred`/`replied` qu'après la réponse de l'API ;
   * sans ce drapeau, un répondant concurrent (minuteur de bouton orphelin, carte
   * d'erreur…) croirait l'interaction libre et provoquerait « already acknowledged ».
   */
  const ack = async (kind, ephemeral, fn) => {
    const p = (async () => fn())();
    state.inflight = p;
    try {
      const result = await p;
      state.kind = kind;
      state.ephemeral = Boolean(ephemeral);
      return result;
    } finally {
      if (state.inflight === p) state.inflight = null;
    }
  };
  /** Attend la fin d'un acquittement en cours (aucune attente s'il n'y en a pas). */
  const settle = async () => {
    while (state.inflight) await state.inflight.catch(() => {});
  };

  /** Hook optionnel (posé par le routeur de commandes) : ajoute le bouton 🗑️, etc. */
  const decorate = (options, ephemeral, kind) =>
    typeof interaction.gadgetDecorate === 'function' ? interaction.gadgetDecorate(options, { ephemeral, kind }) : options;
  const isEphemeral = (options) =>
    Boolean(options && typeof options === 'object' && new MessageFlagsBitField(options.flags ?? 0).has(MessageFlags.Ephemeral));
  /** Première réponse renvoyant le Message créé. */
  const replyFetched = async (options) => {
    const response = await original.reply(withResponseOption(options));
    return response?.resource?.message ?? original.fetchReply();
  };
  /** Première réponse (acquittement), avec ou sans récupération du message. */
  const firstReply = (options, fetch) =>
    ack('reply', isEphemeral(options), () => (fetch ? replyFetched(options) : original.reply(options)));

  interaction.reply = async (raw) => {
    const { options, fetch } = normalizeOptions(raw);
    if (state.inflight) await settle();
    if (interaction.replied || updateAcked()) return original.followUp(decorate(options, isEphemeral(options), 'followUp'));
    if (interaction.deferred) return original.editReply(stripForEdit(decorate(options, state.ephemeral || Boolean(interaction.ephemeral), 'edit')));
    return firstReply(decorate(options, isEphemeral(options), 'reply'), fetch);
  };

  interaction.deferReply = async (raw) => {
    const { options, fetch } = normalizeOptions(raw ?? {});
    if (state.inflight) await settle();
    if (acknowledged()) return fetch ? original.fetchReply().catch(() => null) : undefined;
    return ack('deferReply', isEphemeral(options), async () => {
      if (!fetch) return original.deferReply(options);
      const response = await original.deferReply(withResponseOption(options));
      return response?.resource?.message ?? original.fetchReply();
    });
  };

  interaction.editReply = async (raw) => {
    if (state.inflight) await settle();
    // Sans réponse préalable, l'édition devient une réponse : on garde alors `ephemeral`.
    if (!acknowledged()) {
      const { options } = normalizeOptions(raw);
      return firstReply(decorate(options, isEphemeral(options), 'reply'), true);
    }
    let { options } = normalizeOptions(raw, { allowEphemeral: false });
    // Une édition ciblant un autre message (option `message`) n'est pas décorée.
    const targetsOther = Boolean(options && typeof options === 'object' && options.message && options.message !== '@original');
    if (!targetsOther && !updateAcked()) options = decorate(options, state.ephemeral || Boolean(interaction.ephemeral), 'edit');
    return original.editReply(stripForEdit(options));
  };

  interaction.followUp = async (raw) => {
    const { options } = normalizeOptions(raw);
    if (state.inflight) await settle();
    if (!acknowledged()) return firstReply(decorate(options, isEphemeral(options), 'reply'), true);
    return original.followUp(decorate(options, isEphemeral(options), 'followUp'));
  };

  if (original.update) {
    interaction.update = async (raw) => {
      const { options, fetch } = normalizeOptions(raw, { allowEphemeral: false });
      if (state.inflight) await settle();
      if (acknowledged()) return original.editReply(stripForEdit(options));
      const response = await ack('update', false, () => original.update(fetch ? withResponseOption(options) : options));
      return fetch ? response?.resource?.message ?? interaction.message : response;
    };
  }

  if (original.deferUpdate) {
    interaction.deferUpdate = async (raw) => {
      const { options, fetch } = normalizeOptions(raw ?? {}, { allowEphemeral: false });
      if (state.inflight) await settle();
      if (acknowledged()) return fetch ? interaction.message : undefined;
      const response = await ack('deferUpdate', false, () => original.deferUpdate(fetch ? withResponseOption(options) : options));
      return fetch ? response?.resource?.message ?? interaction.message : response;
    };
  }

  return interaction;
}

/**
 * Vrai si l'interaction est acquittée OU en cours d'acquittement (appel réseau
 * pas encore terminé). À utiliser par tout répondant concurrent.
 */
function isAcknowledged(interaction) {
  return Boolean(interaction?.deferred || interaction?.replied || interaction?.[STATE]?.inflight);
}

/** Attend la fin d'un acquittement en cours, s'il y en a un. */
async function waitForAcknowledgement(interaction) {
  const state = interaction?.[STATE];
  while (state?.inflight) await state.inflight.catch(() => {});
}

/**
 * Vrai si la réponse actuelle est un `deferReply()` PUBLIC encore vide
 * (« Gadget réfléchit… » visible de tous, pas encore édité).
 */
function isPendingPublicDeferral(interaction) {
  const state = interaction?.[STATE];
  return Boolean(state && state.kind === 'deferReply' && !state.ephemeral && interaction.deferred && !interaction.replied);
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

/**
 * Comme safeRespond, pour un message destiné au seul utilisateur (erreur
 * « attendue ») : après un `deferReply()` public encore vide, la réponse différée
 * est supprimée et le message part en followUp éphémère, au lieu d'afficher
 * l'erreur publiquement à la place de « réfléchit… ».
 * @returns {Promise<boolean>}
 */
async function safeRespondPrivately(interaction, payload) {
  if (!interaction?.isRepliable?.()) return false;
  try {
    hardenInteraction(interaction);
    await waitForAcknowledgement(interaction);
    if (isPendingPublicDeferral(interaction)) {
      if (typeof interaction.deleteReply === 'function') await interaction.deleteReply().catch(() => {});
      const options = typeof payload === 'object' && payload && !(payload instanceof MessagePayload) ? { ...payload, ephemeral: true } : payload;
      await interaction.followUp(options);
      return true;
    }
    await interaction.reply(payload);
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  hardenInteraction,
  normalizeOptions,
  safeRespond,
  safeRespondPrivately,
  isAcknowledged,
  isPendingPublicDeferral,
  waitForAcknowledgement,
  HARDENED,
};
