'use strict';

const { IDS } = require('./fixtures');
const { defaultSelectValues, channelForTypes } = require('../harness');

/**
 * Génération d'options de commandes slash à partir de `data.toJSON()` et
 * exploration automatique des composants (boutons, menus, formulaires).
 */

/** Feuilles exécutables d'une commande : [{ path: ['sous-groupe', 'sous-commande'], options }] */
function leavesOf(json) {
  const out = [];
  const walk = (opts, path) => {
    const subs = (opts ?? []).filter((o) => o.type === 1 || o.type === 2);
    if (!subs.length) return out.push({ path, options: opts ?? [] });
    for (const s of subs) {
      if (s.type === 1) out.push({ path: [...path, s.name], options: s.options ?? [] });
      else walk(s.options, [...path, s.name]);
    }
  };
  walk(json.options, []);
  return out;
}

const STRING_HINTS = [
  [/^(raison|reason|motif)$/, 'Test de bout en bout'],
  [/dur[ée]e|duration|intervalle/, '1h'],
  [/couleur|color|hex/, '#ff8800'],
  [/^(url|lien|image|thumbnail)$/, 'https://example.com/image.png'],
  [/echeance|date/, '2030-12-31'],
  [/emoji/, '😀'],
  [/expression/, '2*(3+4)'],
  [/question/, 'Est-ce que ça marche ?'],
  [/pseudo|nick/, 'Nouveau pseudo'],
  [/^(nom|name|titre|title)$/, 'Test e2e'],
  [/^tags$/, 'test, e2e'],
  [/contenu|texte|message|description|details|footer/, 'Contenu de test'],
  [/user_id/, () => IDS.users.target],
  [/^id$/, '1'],
];

function stringValue(opt, key, ctx) {
  if (opt.choices?.length) return opt.choices[0].value;
  for (const [re, v] of STRING_HINTS) if (re.test(opt.name)) return typeof v === 'function' ? v(ctx) : v;
  return 'test';
}

function channelFor(opt) {
  return channelForTypes(opt.channel_types);
}

/**
 * Valeurs d'options représentatives pour une feuille.
 * @param {object} h harnais
 * @param {string} key « commande sous-commande » (pour les surcharges)
 * @param {object[]} options définitions (toJSON)
 * @param {Record<string, any>} overrides valeurs par nom d'option (fonctions acceptées, async)
 * @param {{ requiredOnly?: boolean }} [opts]
 */
async function buildOptions(h, key, options, overrides = {}, { requiredOnly = false, autocomplete = null } = {}) {
  const out = [];
  for (const opt of options) {
    if (requiredOnly && !opt.required && !(opt.name in overrides)) continue;
    let value = overrides[opt.name];
    if (typeof value === 'function') value = await value(h, out);
    if (value === null) continue; // surcharge « ne pas fournir »
    if (value === undefined) {
      switch (opt.type) {
        case 3:
          if (opt.autocomplete && autocomplete) value = await autocomplete(opt, out);
          value ??= stringValue(opt, key, h);
          if (opt.min_length && String(value).length < opt.min_length) value = String(value).padEnd(opt.min_length, 'x');
          if (opt.max_length && String(value).length > opt.max_length) value = String(value).slice(0, opt.max_length);
          break;
        case 4:
        case 10: {
          if (opt.choices?.length) value = opt.choices[0].value;
          else {
            let v = opt.min_value ?? 1;
            if (opt.max_value != null && v > opt.max_value) v = opt.max_value;
            value = opt.type === 10 && opt.min_value == null ? 1.5 : v;
          }
          break;
        }
        case 5:
          value = true;
          break;
        case 6:
          value = IDS.users.target;
          break;
        case 7:
          value = channelFor(opt);
          break;
        case 8:
          value = IDS.roles.gamer;
          break;
        case 9:
          value = IDS.users.target;
          break;
        case 11:
          value = String(BigInt(IDS.guild) + 999n);
          break;
        default:
          continue;
      }
    }
    out.push({ name: opt.name, type: opt.type, value });
  }
  return out;
}

/** Enveloppe les options dans la (les) sous-commande(s). */
function wrapPath(path, options) {
  let wrapped = options;
  for (let i = path.length - 1; i >= 0; i -= 1) wrapped = [{ name: path[i], type: i === path.length - 1 ? 1 : 2, options: wrapped }];
  return wrapped;
}

/** Autocomplétion réelle (première suggestion), ou null. */
function makeAutocomplete(h, name, path, ctx) {
  return async (opt, filled) => {
    const focused = [...filled, { name: opt.name, type: 3, value: '', focused: true }];
    const rec = await h.autocomplete(name, wrapPath(path, focused), { ...ctx, label: `autocomplete /${name} ${path.join(' ')} ${opt.name}` });
    return rec.autocomplete?.[0]?.value ?? null;
  };
}

/** Exécute une feuille de commande avec des options générées. */
async function runLeaf(h, name, leaf, { overrides = {}, as = 'admin', channel = 'general', requiredOnly = false } = {}) {
  h.client.cooldowns.expiries.clear();
  const key = [name, ...leaf.path].join(' ');
  const ctx = { as, channel };
  const options = await buildOptions(h, key, leaf.options, overrides, { requiredOnly, autocomplete: makeAutocomplete(h, name, leaf.path, ctx) });
  h.client.cooldowns.expiries.clear();
  return h.slash(name, wrapPath(leaf.path, options), ctx);
}

/* ---------------------------------------------------------------------- */
/* Exploration des composants                                              */
/* ---------------------------------------------------------------------- */

/** Actions possibles sur un message (boutons, options de menus). */
function actionsOf(message) {
  const out = [];
  for (const row of message?.components ?? []) {
    for (const c of row.components ?? []) {
      if (!c.custom_id || c.disabled) continue;
      if (c.type === 2) {
        if (c.style === 5 || c.style === 6) continue;
        out.push({ customId: c.custom_id, type: 2, key: c.custom_id, priority: c.custom_id.startsWith('cmd:_:delete') ? 3 : 0 });
      } else if (c.type === 3) {
        const min = c.min_values ?? 1;
        for (const o of c.options ?? []) {
          if (min <= 1) out.push({ customId: c.custom_id, type: 3, values: [o.value], key: `${c.custom_id}=${o.value}`, priority: 2 });
        }
        if (min > 1) out.push({ customId: c.custom_id, type: 3, values: (c.options ?? []).slice(0, min).map((o) => o.value), key: `${c.custom_id}=min`, priority: 2 });
        if (min === 0) out.push({ customId: c.custom_id, type: 3, values: [], key: `${c.custom_id}=∅`, priority: 2 });
      } else {
        const values = defaultSelectValues(c);
        out.push({ customId: c.custom_id, type: c.type, values, key: `${c.custom_id}=${values.join(',')}`, priority: 1 });
        if ((c.min_values ?? 1) === 0) out.push({ customId: c.custom_id, type: c.type, values: [], key: `${c.custom_id}=∅`, priority: 1 });
      }
    }
  }
  return out.sort((a, b) => a.priority - b.priority);
}

/**
 * Explore les messages et formulaires produits par une interaction : clique chaque
 * bouton, choisit chaque option, soumet chaque formulaire, en profondeur bornée.
 * @returns {Promise<{ actions: number, buttons: number, selects: number, modals: number, labels: string[] }>}
 */
async function explore(h, rootRec, { as = 'admin', maxDepth = 3, budget = 120, maxRepeat = 2, navRepeat = 12, stallLimit = 6, skip = () => false, stats = null } = {}) {
  const s = stats ?? newStats();
  s.navOptions ??= new Map();
  s.navChosen ??= new Set();
  let spent = 0;
  const queue = [];
  const queued = new Set();
  const enqueue = (rec, depth) => {
    const ids = new Set([...(rec.messages ?? []), ...(rec.followUps ?? [])]);
    // Messages publiés par le bot dans des salons pendant l'action (panneaux, cartes…).
    for (const id of h.fake.messageLog.slice(rec.msgMark)) if (h.message(id)?.author.id === h.client.user.id) ids.add(id);
    for (const id of ids) {
      if (queued.has(id) || !h.message(id)) continue;
      queued.add(id);
      queue.push({ id, depth });
    }
  };
  const handleModals = async (rec, depth) => {
    if (!rec.modals?.length || spent >= budget) return;
    const sub = await h.submitModal(rec, {}, { as });
    s.modals += 1;
    s.actions += 1;
    spent += 1;
    s.keys.add(`modal:${rec.modals[rec.modals.length - 1].custom_id.split(':').slice(0, 3).join(':')}`);
    if (depth + 1 <= maxDepth) enqueue(sub, depth + 1);
  };

  await handleModals(rootRec, 0);
  enqueue(rootRec, 1);

  // Parcours d'un graphe d'états : chaque (état du message, action) au plus une fois.
  // Les actions jamais essayées passent d'abord ; une action déjà vue (retour, menu de
  // navigation) ne sert qu'à rejoindre une vue qui en contient encore, et l'exploration
  // d'un message s'arrête après `stallLimit` actions sans nouveauté.
  // Clés normalisées (chiffres → #) : un bouton « encore » à compteur ou une page
  // suivante n'est rejoué que `maxRepeat` fois comme nouveauté.
  const uses = new Map();
  const shape = (key) => key.replace(/\d+/g, '#');
  const isNew = (a) => (uses.get(shape(a.key)) ?? 0) < maxRepeat;
  while (queue.length && spent < budget) {
    const { id, depth } = queue.shift();
    const taken = new Set();
    let stall = 0;
    while (spent < budget && stall < stallLimit) {
      const msg = h.message(id);
      if (!msg) break;
      const actions = actionsOf(msg).filter((a) => !skip(a));
      // Menus de navigation des tableaux de bord : toutes les vues proposées.
      for (const row of msg.components ?? []) {
        for (const c of row.components ?? []) {
          if (c.type !== 3 || !/:nav$/.test(c.custom_id ?? '')) continue;
          const set = s.navOptions.get(c.custom_id) ?? new Set();
          for (const o of c.options ?? []) set.add(o.value);
          s.navOptions.set(c.custom_id, set);
        }
      }
      const state = `${msg.embeds?.[0]?.title ?? ''}|${actions.map((a) => a.key).join(',')}`;
      const candidates = actions.filter((a) => !taken.has(`${state}#${a.key}`) && (uses.get(shape(a.key)) ?? 0) < navRepeat);
      const fresh = candidates.filter(isNew);
      const next = fresh[0] ?? candidates.sort((a, b) => (uses.get(shape(a.key)) ?? 0) - (uses.get(shape(b.key)) ?? 0))[0];
      if (!next) break;
      stall = fresh.length ? 0 : stall + 1;
      taken.add(`${state}#${next.key}`);
      uses.set(shape(next.key), (uses.get(shape(next.key)) ?? 0) + 1);
      h.client.cooldowns.expiries.clear();
      const rec = await h.click(msg, next.customId, { as, values: next.values });
      spent += 1;
      s.actions += 1;
      if (next.type === 2) s.buttons += 1;
      else s.selects += 1;
      if (next.type === 3 && next.values?.length === 1) s.navChosen.add(`${next.customId}=${next.values[0]}`);
      s.keys.add(next.customId.split(':').slice(0, 3).join(':'));
      await handleModals(rec, depth);
      if (depth + 1 <= maxDepth) enqueue(rec, depth + 1);
    }
  }
  return s;
}

/** Compteurs d'exploration (partageables entre plusieurs appels à `explore`). */
function newStats() {
  return { actions: 0, buttons: 0, selects: 0, modals: 0, keys: new Set(), navOptions: new Map(), navChosen: new Set() };
}

/** Vues de navigation jamais ouvertes : [« customId=valeur »]. */
function missingNavViews(stats) {
  const out = [];
  for (const [id, values] of stats.navOptions) for (const v of values) if (!stats.navChosen.has(`${id}=${v}`)) out.push(`${id}=${v}`);
  return out;
}

/** Vrai si le message (brut) est une carte d'erreur du bot. */
function isErrorCard(message) {
  const d = message?.embeds?.[0]?.description ?? '';
  return d.startsWith('❌');
}

module.exports = { leavesOf, buildOptions, wrapPath, runLeaf, explore, actionsOf, isErrorCard, newStats, missingNavViews };
