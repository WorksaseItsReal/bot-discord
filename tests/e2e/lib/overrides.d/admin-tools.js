'use strict';

/**
 * Outils d'administration (ADM2) : /channel renouveler, /voice rassembler, /membres liste.
 * Chemin « succès » des explorations automatiques :
 *  - renouveler vise un salon jetable (jamais #général, partagé par les autres scénarios) ;
 *  - rassembler ramène un membre d'un vocal jetable vers #Salon vocal ;
 *  - /membres affiche la liste des administrateurs (/membres nu est couvert par member-lists.e2e).
 */
const { IDS } = require('../fixtures');
const { nextId } = require('../ids');

// Chargé PENDANT l'évaluation de ../overrides.js (dépendance circulaire) : lecture paresseuse.
const throwawayChannel = (h, name) => require('../overrides').throwawayChannel(h, name);

/** Vocal jetable où un membre est connecté (source de /voice rassembler). */
async function throwawayVoice(h, name = 'vocal-jetable', as = 'member') {
  const id = nextId();
  const raw = { id, type: 2, guild_id: h.guild.id, name, position: 60, permission_overwrites: [], parent_id: IDS.channels.catVoice, flags: 0, bitrate: 64000, user_limit: 0, rtc_region: null, video_quality_mode: 1, nsfw: false, rate_limit_per_user: 0, last_message_id: null };
  h.fake.channels.set(id, raw);
  h.fake.dispatchNow('CHANNEL_CREATE', raw, `préparation : vocal ${name}`);
  await h.settle();
  await h.voice(as, id, { label: 'préparation : vocal jetable' });
  return id;
}

module.exports = {
  'channel renouveler': { salon: (h) => throwawayChannel(h, 'a-renouveler') },
  'voice rassembler': {
    vers: async (h) => {
      await throwawayVoice(h);
      return IDS.channels.voice;
    },
    depuis: null,
    bots: null,
  },
  membres: { liste: 'admins', role: null },
};

// Aide partagée avec les tests ADM2, non énumérable : jamais prise pour une clé de commande.
Object.defineProperty(module.exports, 'throwawayVoice', { value: throwawayVoice, enumerable: false });
