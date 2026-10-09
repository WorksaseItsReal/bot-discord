'use strict';

const { PermissionFlagsBits: P } = require('discord.js');
const { IDS } = require('./fixtures');
const { leavesOf, buildOptions, wrapPath, actionsOf, explore, runLeaf } = require('./explore');
const { OVERRIDES } = require('./overrides');
const { generateTextValue } = require('../harness');

/**
 * « Revue par le chaos » : valeurs hostiles pour chaque option de commande, clics
 * simultanés, marches aléatoires reproductibles. Tout est piloté par une graine :
 * même graine ⇒ mêmes actions (rejouer un échec = relancer avec CHAOS_SEED=<graine>).
 */

/* ---------------------------------------------------------------------- */
/* Aléa reproductible                                                       */
/* ---------------------------------------------------------------------- */

/** Générateur pseudo-aléatoire déterministe (mulberry32). */
class Rng {
  constructor(seed) {
    this.seed = Number(seed) >>> 0;
    this.state = this.seed || 0x9e3779b9;
  }

  next() {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  int(n) {
    return Math.floor(this.next() * n);
  }

  chance(p) {
    return this.next() < p;
  }

  pick(list) {
    return list[this.int(list.length)];
  }

  sample(list, k) {
    const copy = [...list];
    for (let i = copy.length - 1; i > 0; i -= 1) {
      const j = this.int(i + 1);
      [copy[i], copy[j]] = [copy[j], copy[i]];
    }
    return copy.slice(0, k);
  }

  /** Sous-générateur indépendant de l'ordre d'appel (graine dérivée d'un libellé). */
  fork(label) {
    let h = this.seed ^ 0x811c9dc5;
    for (const ch of String(label)) h = Math.imul(h ^ ch.codePointAt(0), 16777619) >>> 0;
    return new Rng(h);
  }
}

/* ---------------------------------------------------------------------- */
/* Valeurs hostiles                                                         */
/* ---------------------------------------------------------------------- */

const ZALGO = `Z${'\u0337\u0322\u031b\u0356'.repeat(6)}a${'\u0335\u0301'.repeat(6)}l${'\u0338\u0308'.repeat(6)}g${'\u0336\u0303'.repeat(6)}o`;
/** Snowflake valide mais inconnu de Discord. */
const UNKNOWN_ID = '123456789012345678';

/** Chaînes hostiles génériques (aucune ne contient de mot « suspect » : undefined, NaN, null…). */
function hostileStrings() {
  return [
    ' ',
    '\u200b',
    '\u3000\u3000',
    '\u200b\u200c\u200d\u2060\ufeff',
    '👨\u200d👩\u200d👧\u200d👦🏳\ufe0f\u200d🌈🧑🏽\u200d💻',
    '\u202egnp.exe\u202c',
    ZALGO,
    '**gras** __souligné__ ~~barré~~ ||spoiler|| `code` ```js\nfin``` > citation\n# Titre',
    '`',
    '```',
    '\\',
    '*_~|>',
    '@everyone @here',
    `<@&${IDS.roles.admin}> <@&${IDS.roles.mod}>`,
    `<@&${IDS.guild}>`,
    `<#${IDS.channels.staff}>`,
    `<@${IDS.users.owner}>`,
    `<@!${IDS.users.bot}>`,
    `https://example.com/${'a'.repeat(1990)}`,
    'javascript:alert(1)',
    'discord.gg/abcdef',
    "'; DROP TABLE sanctions; --",
    '%s %d %n ${process.exit()} {user} {{server}}',
    '__proto__',
    'constructor',
    '(a+)+$[',
    '\u0000\u0007',
    'a\n'.repeat(300),
    'x'.repeat(6000),
    '-1',
    '0',
    '1e309',
    '9'.repeat(40),
    UNKNOWN_ID,
    IDS.users.owner,
    IDS.users.bot,
  ];
}

const DURATIONS = ['0s', '0', '999y', '-5m', '1e9h', '1.5h', 'h', '5', '10x', '99999999999999999999d', '1 d', '1w2d', '28d', '29d', '2147483648s', 'Infinity', '1h-1m', '00:00'];
const DATES = ['31/02/2025', '2025-02-31', '29/02/2023', '00/00/0000', '2030-13-01', '1969-12-31', '9999-12-31', '31/12/275760', 'demain', '2025-02-30T25:61', '2000-01-01'];
const COLORS = ['#GGGGGG', '#fff', 'fff', '#12345', '#1234567', 'rouge', '0x', '#-00001', '#FFFFFFFF', '#000000'];
const URLS = [`https://example.com/${'a'.repeat(2000)}`, 'javascript:alert(1)', 'http://', 'ftp://example.com', 'https://exa mple.com', 'attachment://x.png', `https://${'é'.repeat(300)}.fr`, 'example.com'];
const EMOJIS = ['<:x:1>', '<a:bad:99999999999999999999>', `<:gadget:${IDS.emoji}>`, ':smile:', '🏳\ufe0f\u200d🌈', '1', '<:x:>'];
const ID_STRINGS = ['0', '-1', '1.5', '9'.repeat(30), UNKNOWN_ID, IDS.users.owner, IDS.users.bot, 'abc'];
const EXPRESSIONS = ['1/0', '0/0', '9^9^9', '('.repeat(150), '2^1024', 'sqrt(-1)', '1e308*10', 'constructor.constructor', ')', '-0', '1%0'];
const TIMES = ['31/02/2025 25:61', 'hier', '-1', '9999999999999', '2025-02-30', '24:00', '1969-01-01 00:00'];
const ZONES = ['Mars/Olympus', '../../etc/passwd', 'UTC+99', 'Europe/Paris\u0000', 'utc', 'Etc/GMT+14'];
const DICE = ['0d0', '1000d1000', 'd', '-1d6', '1d-6', '99999999d9', '2d6+', '1d6+1d6', '1d6+99999999999'];
const LISTS = ['|||', '| |', 'a', ',,,,', 'a|'.repeat(300), ' | ', '\u200b|\u200b'];
const PALIERS = ['0=ban', '-1=mute 1h', '3=mute 999y', '3=nuke', '=,=,=', '1000000=kick', '3=mute 0s', '3=ban, 3=kick'];

/** Valeurs propres au rôle de l'option (devinées d'après son nom). */
function specificStrings(name) {
  const rules = [
    [/dur[ée]e|intervalle/, DURATIONS],
    [/date|echeance/, DATES],
    [/couleur|hex/, COLORS],
    [/url|lien|image|thumbnail/, URLS],
    [/emoji/, EMOJIS],
    [/^id$|user_id/, ID_STRINGS],
    [/expression/, EXPRESSIONS],
    [/quand/, TIMES],
    [/fuseau/, ZONES],
    [/lancer/, DICE],
    [/options|choix|tags|details/, LISTS],
    [/paliers/, PALIERS],
  ];
  return rules.filter(([re]) => re.test(name)).flatMap(([, list]) => list);
}

/** Ajuste une chaîne aux bornes que Discord impose avant l'envoi (min/max_length). */
function fitString(value, opt) {
  let v = String(value);
  const max = opt.max_length ?? 6000;
  if ([...v].length > max) v = [...v].slice(0, max).join('');
  if (opt.min_length && [...v].length < opt.min_length) v = v.padEnd(opt.min_length, 'x');
  return v;
}

/** Salons proposés par Discord pour une option (types autorisés), de tout type sinon. */
function channelCandidates(h, opt) {
  const all = [...h.fake.channels.values()].filter((c) => !opt.channel_types?.length || opt.channel_types.includes(c.type));
  const byType = new Map();
  for (const c of all) if (!byType.has(c.type)) byType.set(c.type, c.id);
  // Un salon de chaque type + quelques salons sensibles (logs, staff).
  const out = new Set(byType.values());
  for (const key of ['logs', 'staff', 'general', 'thread']) {
    const c = h.fake.channels.get(IDS.channels[key]);
    if (c && (!opt.channel_types?.length || opt.channel_types.includes(c.type))) out.add(c.id);
  }
  return [...out];
}

/** Utilisateur qui n'est pas (ou plus) membre du serveur. */
function outsider(h) {
  const existing = [...h.fake.users.values()].find((u) => u.global_name === 'Étranger');
  if (existing) return existing.id;
  const u = h.addUser('Étranger', { ageDays: 50 });
  return u.id;
}

const userCandidates = (h) => [IDS.users.target, IDS.users.owner, IDS.users.bot, IDS.users.otherBot, IDS.users.admin, IDS.users.botOwner, IDS.users.mod, outsider(h)];
/** Rôles sensibles encore existants (Discord ne propose pas un rôle supprimé). */
const roleCandidates = (h) => [IDS.roles.everyone, IDS.roles.bot, IDS.roles.admin, IDS.roles.mod, IDS.roles.muted, IDS.roles.notif, IDS.roles.temp].filter((id) => h.fake.roles.has(id));

/**
 * Valeurs hostiles pour une option (format API). Les bornes que Discord fait respecter
 * (choix, min/max, types de salons) sont respectées : seul ce qu'un client peut
 * réellement envoyer est testé.
 * @returns {Array<{ value: any, mentionableType?: string }>}
 */
function hostileValues(h, opt) {
  switch (opt.type) {
    case 3: {
      if (opt.choices?.length) return opt.choices.map((c) => ({ value: c.value }));
      const raw = [...specificStrings(opt.name), ...hostileStrings()];
      return [...new Set(raw.map((v) => fitString(v, opt)))].map((value) => ({ value }));
    }
    case 4:
    case 10: {
      if (opt.choices?.length) return opt.choices.map((c) => ({ value: c.value }));
      const lo = opt.min_value ?? -(2 ** 53) + 1;
      const hi = opt.max_value ?? 2 ** 53 - 1;
      const raw = [lo, hi, 0, -1, 1, 2, 1000, 2 ** 31, -(2 ** 31)];
      if (opt.type === 10) raw.push(0.5, 1e-7, -0.0001, 1e15, 3.14159);
      return [...new Set(raw.filter((v) => v >= lo && v <= hi))].map((value) => ({ value }));
    }
    case 5:
      return [{ value: true }, { value: false }];
    case 6:
      return userCandidates(h).map((value) => ({ value }));
    case 7:
      return channelCandidates(h, opt).map((value) => ({ value }));
    case 8:
      return roleCandidates(h).map((value) => ({ value }));
    case 9:
      return [...userCandidates(h).map((value) => ({ value, mentionableType: 'user' })), ...roleCandidates(h).map((value) => ({ value, mentionableType: 'role' }))];
    case 11:
      return [{ value: String(BigInt(IDS.guild) + 999n) }];
    default:
      return [];
  }
}

/**
 * Remplace les références à un rôle ou un salon supprimé entre-temps (surcharges
 * fixes, marche aléatoire) : Discord ne propose jamais un objet qui n'existe plus.
 * @returns {object[]|null} options corrigées, ou null si une option obligatoire n'a plus de valeur possible
 */
function dropDeletedRefs(h, defs, options) {
  const out = [];
  for (const o of options) {
    const def = defs.find((d) => d.name === o.name);
    const gone = o.type === 8 ? !h.fake.roles.has(o.value)
      : o.type === 9 ? !h.fake.roles.has(o.value) && !h.fake.users.has(o.value)
        : o.type === 7 ? !h.fake.channels.has(o.value) : false;
    if (!gone) {
      out.push(o);
      continue;
    }
    const replacement = o.type === 7 ? channelCandidates(h, def ?? {})[0] : roleCandidates(h).find((id) => id !== IDS.roles.everyone);
    if (replacement) out.push({ ...o, value: replacement });
    else if (def?.required) return null;
  }
  return out;
}

/** Valeur hostile au hasard pour un champ de formulaire (respecte min/max). */
function hostileText(rng, input, label) {
  const hint = `${input.custom_id} ${label ?? ''}`;
  const pool = [...specificStrings(hint.toLowerCase()), ...hostileStrings()];
  let v = rng.chance(0.25) ? generateTextValue(input, label) : rng.pick(pool);
  const max = input.max_length ?? 4000;
  if ([...v].length > max) v = [...v].slice(0, max).join('');
  const min = input.min_length ?? 0;
  if ([...v].length < min) v = v.padEnd(min, 'x');
  return v;
}

/* ---------------------------------------------------------------------- */
/* Bilan d'un pas                                                            */
/* ---------------------------------------------------------------------- */

/**
 * Exécute `fn`, puis relève les problèmes apparus (consignés avec `context` et
 * remis à zéro). Renvoie le résultat de `fn`.
 */
async function step(h, failures, context, fn) {
  let result;
  try {
    result = await fn();
  } catch (err) {
    // Erreur du harnais lui-même (ou du test) : consignée comme un échec.
    failures.push({ ...context, problems: `exception dans le scénario : ${err?.stack ?? err}` });
    return null;
  }
  if (h.problemCount()) {
    failures.push({ ...context, problems: h.formatProblems() });
    h.resetProblems();
  } else {
    h.sent = h.sent.slice(-50); // garde la mémoire bornée sur de longues marches
  }
  return result;
}

function formatFailures(failures, max = 15) {
  const shown = failures.slice(0, max).map((f) => {
    const { problems, ...ctx } = f;
    return `• ${JSON.stringify(ctx, (k, v) => (typeof v === 'string' && v.length > 120 ? `${v.slice(0, 120)}…(${v.length})` : v))}\n  ${String(problems).split('\n').slice(0, 12).join('\n  ')}`;
  });
  return `${failures.length} échec(s)${failures.length > max ? ` (${max} premiers)` : ''} :\n${shown.join('\n')}`;
}

/* ---------------------------------------------------------------------- */
/* Fuzz des options                                                          */
/* ---------------------------------------------------------------------- */

/** Clique « Confirmer » si l'interaction a ouvert une confirmation. */
async function confirmIfAsked(h, rec) {
  const confirmed = await h.confirm(rec);
  if (confirmed) await h.settle();
  return confirmed;
}

/** Première suggestion d'autocomplétion réelle (ou null). */
function autocompleteFor(h, name, path, as) {
  return async (opt, filled) => {
    const focused = [...filled, { name: opt.name, type: 3, value: '', focused: true }];
    const rec = await h.autocomplete(name, wrapPath(path, focused), { as, label: `autocomplete /${name} ${path.join(' ')} ${opt.name}` });
    return rec.autocomplete?.[0]?.value ?? null;
  };
}

/**
 * Fuzz d'une commande : pour chaque feuille, chaque option reçoit tour à tour des
 * valeurs hostiles (les autres gardant une valeur plausible), puis quelques
 * combinaisons entièrement hostiles.
 * @param {{ rng: Rng, perOption?: number, combos?: number, as?: string, failures: object[], seed: number }} opts
 *   perOption : nombre de valeurs essayées par option (Infinity = toutes).
 * @returns {Promise<number>} nombre d'interactions envoyées
 */
async function fuzzCommand(h, name, command, { rng, perOption = Infinity, combos = 2, as = 'admin', failures, seed, exploreBudget = 0, channel = 'general' }) {
  let actions = 0;
  for (const leaf of leavesOf(command.data.toJSON())) {
    const key = [name, ...leaf.path].join(' ');
    let overrides = OVERRIDES[key] ?? {};
    if (name === 'massrole') overrides = { ...overrides, cible: 'bots' }; // lots espacés d'1 s sinon
    h.client.cooldowns.expiries.clear();
    const baseline = dropDeletedRefs(h, leaf.options, await buildOptions(h, key, leaf.options, overrides, { autocomplete: autocompleteFor(h, name, leaf.path, as) }));
    if (!baseline) continue;
    const run = async (options, label) => {
      actions += 1;
      const context = { seed, command: `/${key}`, as, input: label };
      await step(h, failures, context, async () => {
        const rec = await h.slash(name, wrapPath(leaf.path, options), { as, channel, label: `/${key} ${label}` });
        if (rec.ackType == null) throw new Error('interaction non acquittée');
        if (await confirmIfAsked(h, rec)) actions += 1;
        // Données hostiles enregistrées : affichées ensuite par les boutons de la réponse.
        if (exploreBudget) actions += (await explore(h, rec, { as, budget: exploreBudget, maxDepth: 2 })).actions;
        return rec;
      });
    };
    const withValue = (opt, v) => {
      const entry = { name: opt.name, type: opt.type, value: v.value, ...(v.mentionableType ? { mentionableType: v.mentionableType } : {}) };
      const out = baseline.filter((o) => o.name !== opt.name);
      out.push(entry);
      return out;
    };
    // Options obligatoires seules.
    await run(baseline.filter((o) => leaf.options.find((d) => d.name === o.name)?.required), 'obligatoires seules');
    for (const opt of leaf.options) {
      const values = hostileValues(h, opt);
      const chosen = perOption >= values.length ? values : rng.sample(values, perOption);
      for (const v of chosen) {
        if (opt.type === 8 || (opt.type === 9 && v.mentionableType === 'role')) h.fake.forbiddenPings.add(v.value);
        await run(withValue(opt, v), `${opt.name}=${JSON.stringify(v.value).slice(0, 60)}`);
      }
    }
    for (let i = 0; i < combos && leaf.options.length; i += 1) {
      const options = [];
      for (const opt of leaf.options) {
        if (!opt.required && rng.chance(0.3)) continue;
        const values = hostileValues(h, opt);
        if (!values.length) continue;
        const v = rng.pick(values);
        options.push({ name: opt.name, type: opt.type, value: v.value, ...(v.mentionableType ? { mentionableType: v.mentionableType } : {}) });
      }
      await run(options, `combinaison ${options.map((o) => `${o.name}=${JSON.stringify(o.value).slice(0, 25)}`).join(' ')}`);
    }
  }
  return actions;
}

/**
 * Fuzz des formulaires : explore les composants d'une réponse, retient chaque
 * formulaire rencontré, puis le soumet à nouveau avec des valeurs hostiles, champ
 * par champ (`perField` valeurs par champ) puis tous champs hostiles à la fois.
 * @returns {Promise<{ actions: number, modals: number }>}
 */
async function fuzzModals(h, rootRec, { rng, failures, seed, perField = 4, as = 'admin', budget = 150, label = '' }) {
  const captured = new Map();
  const original = h.submitModal;
  h.submitModal = function capture(rec, values, ctx) {
    const modal = rec.modals[rec.modals.length - 1];
    const key = modal.custom_id.split(':').slice(0, 3).join(':');
    if (!captured.has(key)) captured.set(key, rec);
    return original.call(this, rec, values, ctx);
  };
  let actions = 0;
  try {
    actions += (await explore(h, rootRec, { as, budget })).actions;
  } finally {
    h.submitModal = original;
  }
  for (const [key, rec] of captured) {
    const modal = rec.modals[rec.modals.length - 1];
    const inputs = modal.components
      .map((row) => (row.type === 1 ? { c: row.components[0], label: row.components[0].label } : { c: row.component, label: row.label }))
      .filter((x) => x.c?.type === 4);
    const pool = (input, lbl) => [...new Set([...specificStrings(`${input.custom_id} ${lbl ?? ''}`.toLowerCase()), ...hostileStrings()])]
      .map((v) => fitString(v, { max_length: input.max_length ?? 4000, min_length: input.min_length }));
    const submit = async (values, desc) => {
      actions += 1;
      await step(h, failures, { seed, source: label, modal: key, as, input: desc }, async () => {
        const sub = await h.submitModal(rec, values, { as, label: `formulaire ${key} ${desc}` });
        if (sub.ackType == null) throw new Error('formulaire non acquitté');
        await confirmIfAsked(h, sub);
        return sub;
      });
    };
    for (const { c, label: lbl } of inputs) {
      const values = pool(c, lbl);
      for (const v of perField >= values.length ? values : rng.sample(values, perField)) await submit({ [c.custom_id]: v }, `${c.custom_id}=${JSON.stringify(v).slice(0, 60)}`);
    }
    if (inputs.length > 1) {
      const all = Object.fromEntries(inputs.map(({ c, label: lbl }) => [c.custom_id, rng.pick(pool(c, lbl))]));
      await submit(all, `tous=${JSON.stringify(all).slice(0, 120)}`);
    }
  }
  return { actions, modals: captured.size };
}

/** Rôles injectés dans les chaînes hostiles : ne doivent jamais être notifiés. */
function forbidHostilePings(h) {
  for (const id of [IDS.roles.admin, IDS.roles.mod, IDS.guild]) h.fake.forbiddenPings.add(id);
}

/* ---------------------------------------------------------------------- */
/* État observable (comparaison clic simple / clics simultanés)             */
/* ---------------------------------------------------------------------- */

/** Nombre de lignes par table (hors tables techniques). */
function tableCounts(h) {
  const db = h.client.database.db;
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT IN ('schema_migrations', 'migrations')").all().map((r) => r.name);
  return Object.fromEntries(tables.map((t) => [t, db.prepare(`SELECT COUNT(*) AS n FROM "${t}"`).get().n]));
}

/** Empreinte de l'état : base, salons, rôles, bannissements, rôles des membres, messages publiés. */
function digest(h, since = 0) {
  const posts = h.fake.calls.slice(since).filter((c) => c.method === 'POST' && /^\/channels\/\d+\/messages$/.test(c.route) && c.status === 200);
  // Identifiants des membres créés pendant le scénario : différents d'un harnais à l'autre.
  const known = new Set([...Object.values(IDS.users), ...Object.values(IDS.roles)]);
  const who = (id) => (known.has(id) ? id : 'nouveau');
  return {
    tables: tableCounts(h),
    channels: h.fake.channels.size,
    roles: h.fake.roles.size,
    bans: h.fake.bans.size,
    members: h.fake.members.size,
    memberRoles: [...h.fake.members.values()].map((m) => `${who(m.user.id)}:${m.roles.map(who).sort().join(',')}:${m.communication_disabled_until ? 'to' : ''}`).sort().join('|'),
    posted: posts.length,
    dms: posts.filter((c) => h.fake.dms.has(c.route.split('/')[2])).length,
    /** Titres des messages publiés (aide au diagnostic, non comparés). */
    postedTitles: posts.map((c) => c.body?.embeds?.[0]?.title ?? c.body?.content ?? '?').join(' | '),
  };
}

/** Différences entre deux empreintes : [« clé : a → b »]. */
function diffDigest(a, b) {
  const out = [];
  for (const k of Object.keys(a)) {
    if (k === 'postedTitles') continue;
    if (k === 'tables') {
      for (const t of new Set([...Object.keys(a.tables), ...Object.keys(b.tables)])) if (a.tables[t] !== b.tables[t]) out.push(`table ${t} : ${a.tables[t]} → ${b.tables[t]}`);
    } else if (a[k] !== b[k]) out.push(`${k} : ${String(a[k]).slice(0, 300)} → ${String(b[k]).slice(0, 300)}`);
  }
  return out;
}

/* ---------------------------------------------------------------------- */
/* Clics simultanés                                                          */
/* ---------------------------------------------------------------------- */

/** Actions qui publient légitimement un message à chaque clic (essais d'envoi). */
const PER_CLICK = /:(test|alerttest)(:|$)/;

/** Forme d'une action, sans ses identifiants (stable d'un harnais à l'autre). */
const shapeOf = (key) => key.replace(/\d{5,}/g, '#');

/** Messages à composants publiés par le bot pendant une interaction (réponse, suivis, salons). */
function producedMessages(h, rec) {
  const ids = new Set([...(rec.messages ?? []), ...(rec.followUps ?? [])]);
  for (const id of h.fake.messageLog.slice(rec.msgMark)) if (h.message(id)?.author.id === h.client.user.id) ids.add(id);
  return [...ids].map((id) => h.message(id)).filter((m) => m?.components?.length);
}

function findAction(h, rec, shape) {
  for (const msg of producedMessages(h, rec)) for (const a of actionsOf(msg)) if (shapeOf(a.key) === shape) return { msg, a };
  return null;
}

/** Termine le travail différé du bot (éditions de cartes groupées, suppressions). */
async function flushServices(h) {
  for (const name of ['tickets', 'giveaways', 'projects']) await h.client.services[name]?.flush?.();
  await h.settle();
}

/**
 * Cibles de clics simultanés d'une commande : chaque action des messages qu'elle
 * produit et, pour les tableaux de bord, chaque action de chaque vue du menu de
 * navigation. @returns {Promise<Array<{ name: string, leaf: object, steps: string[] }>>}
 */
async function raceTargets(h, name, leaf, { as = 'admin' } = {}) {
  const key = [name, ...leaf.path].join(' ');
  const rec = await runLeaf(h, name, leaf, { overrides: OVERRIDES[key] ?? {}, as });
  const out = [];
  const seen = new Set();
  const add = (steps) => {
    const k = steps.join(' > ');
    if (seen.has(k)) return;
    seen.add(k);
    out.push({ name, leaf, key, steps });
  };
  for (const msg of producedMessages(h, rec)) {
    for (const a of actionsOf(msg)) {
      add([shapeOf(a.key)]);
      if (a.type === 3 && /:nav$/.test(a.customId)) {
        h.client.cooldowns.expiries.clear();
        const view = await h.click(msg, a.customId, { as, values: a.values });
        for (const vm of producedMessages(h, view)) for (const b of actionsOf(vm)) if (!/:nav$/.test(b.customId)) add([shapeOf(a.key), shapeOf(b.key)]);
      }
    }
  }
  return out;
}

/**
 * Rejoue une cible dans un harnais neuf puis envoie la dernière action `clicks` fois
 * en même temps, pour chaque acteur (chacun avec sa propre réponse / son tableau de bord).
 * @returns {Promise<{ skipped?: string, problems: string, digest: object, acks: number[] }>}
 */
async function raceOnce(createH, target, { actors = ['admin'], clicks = 1, latency = 0 } = {}) {
  const h = await createH();
  try {
    const finals = [];
    for (const as of actors) {
      h.client.cooldowns.expiries.clear();
      let cur = await runLeaf(h, target.name, target.leaf, { overrides: OVERRIDES[target.key] ?? {}, as });
      for (const shape of target.steps.slice(0, -1)) {
        const f = findAction(h, cur, shape);
        if (!f) return { skipped: `étape introuvable : ${shape}` };
        cur = await h.click(f.msg, f.a.customId, { as, values: f.a.values });
      }
      const f = findAction(h, cur, target.steps[target.steps.length - 1]);
      if (!f) return { skipped: `action introuvable pour ${as}` };
      finals.push({ as, ...f });
    }
    await flushServices(h);
    h.resetProblems();
    const mark = h.fake.calls.length;
    h.fake.latency = latency;
    h.client.cooldowns.expiries.clear();
    const recs = await Promise.all(finals.flatMap(({ as, msg, a }) => Array.from({ length: clicks }, () => h.click(msg, a.customId, { as, values: a.values, label: `${clicks > 1 ? `${clicks} clics simultanés` : 'clic'} ${a.key} (${as})` }))));
    h.fake.latency = 0;
    await flushServices(h);
    return { problems: h.problemCount() ? h.formatProblems() : '', digest: digest(h, mark), acks: recs.map((r) => r.ackType) };
  } finally {
    await h.close();
  }
}

/**
 * Compare un clic simple et des clics simultanés sur une cible : aucun problème
 * relevé, et le même état final (pas de doublon en base, de double envoi…).
 * @returns {Promise<{ skipped?: string, problems: string[], diff: string[] }>}
 */
async function checkRace(createH, target, { actors = ['admin'], clicks = 3, latency = 2 } = {}) {
  const single = await raceOnce(createH, target, { actors: [actors[0]], clicks: 1 });
  if (single.skipped) return { skipped: single.skipped, problems: [], diff: [] };
  const multi = await raceOnce(createH, target, { actors, clicks, latency });
  if (multi.skipped) return { skipped: multi.skipped, problems: [], diff: [] };
  const problems = [single.problems && `clic simple : ${single.problems}`, multi.problems && `clics simultanés : ${multi.problems}`].filter(Boolean);
  // Boutons « tester » : un message d'essai par clic, c'est leur rôle.
  const perClick = PER_CLICK.test(target.steps[target.steps.length - 1]);
  const diff = diffDigest(single.digest, multi.digest).filter((d) => !(perClick && d.startsWith('posted')));
  if (diff.length) diff.push(`publiés (simple) : ${single.digest.postedTitles}`, `publiés (simultanés) : ${multi.digest.postedTitles}`);
  return { problems, diff };
}

/**
 * Deux administrateurs ouvrent le même formulaire (chacun depuis son tableau de bord)
 * et le soumettent en même temps : l'un avec des valeurs plausibles, l'autre avec des
 * valeurs hostiles. @returns {Promise<{ skipped?: string, problems: string }>}
 */
async function checkModalRace(createH, target, { rng, actors = ['admin', 'owner'] } = {}) {
  const h = await createH();
  try {
    const opened = [];
    for (const as of actors) {
      h.client.cooldowns.expiries.clear();
      let cur = await runLeaf(h, target.name, target.leaf, { overrides: OVERRIDES[target.key] ?? {}, as });
      for (const shape of target.steps) {
        const f = findAction(h, cur, shape);
        if (!f) return { skipped: `étape introuvable : ${shape}` };
        cur = await h.click(f.msg, f.a.customId, { as, values: f.a.values });
      }
      if (!cur.modals?.length) return { skipped: 'pas de formulaire' };
      opened.push({ as, rec: cur });
    }
    h.resetProblems();
    await Promise.all(opened.map(({ as, rec }, i) => {
      const modal = rec.modals[rec.modals.length - 1];
      const values = {};
      if (i > 0) {
        for (const row of modal.components) {
          const c = row.type === 1 ? row.components[0] : row.component;
          if (c?.type === 4) values[c.custom_id] = hostileText(rng, c, row.label ?? c.label);
        }
      }
      return h.submitModal(rec, values, { as, label: `formulaire simultané ${modal.custom_id} (${as})` });
    }));
    await flushServices(h);
    return { problems: h.problemCount() ? h.formatProblems() : '' };
  } finally {
    await h.close();
  }
}

/* ---------------------------------------------------------------------- */
/* Marche aléatoire                                                         */
/* ---------------------------------------------------------------------- */

/** Pseudos affichés hostiles (32 caractères au plus, comme Discord). */
const HOSTILE_NAMES = ['@everyone', '@here', `<@&${IDS.roles.admin}>`, '**gras**`code`', '\u202Eevil', ZALGO, '👨\u200d👩\u200d👧\u200d👦'.repeat(4), '||spoiler||', '\u200b', '${user}', '{server}', '# Titre', '> citation'];
const USERS = ['admin', 'admin', 'admin', 'owner', 'mod', 'member', 'target'];
/** Commandes exclues de la marche : effets globaux longs (lots espacés d'1 s). */
const WALK_SKIP = new Set(['massrole']);
const SPAM = ['salut', 'interdit !!!', 'https://discord.gg/abcdef', 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', '@everyone regardez', `<@${IDS.users.target}> <@${IDS.users.mod}> <@${IDS.users.admin}> <@${IDS.users.owner}> <@${IDS.users.member}>`, 'free nitro https://dlscord-gift.com/x', '😀'.repeat(40), '', 'texte normal pour gagner de l\'xp'];

/**
 * Marche aléatoire : commandes (plausibles ou hostiles), clics, formulaires et
 * événements (arrivées, départs, messages, suppressions de salons/rôles configurés,
 * perte de permissions du bot) mêlés au hasard.
 * `trace` (tableau) reçoit chaque action exécutée, `onStep(i, contexte)` est appelé
 * après chaque pas ; CHAOS_SLOW=<ms> affiche les pas plus lents que ce seuil.
 * @param {{ rng: Rng, steps: number, failures: object[], seed: number, trace?: string[]|null,
 *   onStep?: Function|null, collectorRate?: number }} opts collectorRate : probabilité de
 *   garder un bouton de collector (confirmation, pages) parmi les clics possibles
 * @returns {Promise<{ actions: number, kinds: Record<string, number> }>}
 */
async function randomWalk(h, { rng, steps, failures, seed, trace = null, onStep = null, collectorRate = 0.25 }) {
  const commands = [...h.client.commands.entries()].filter(([n]) => !WALK_SKIP.has(n)).flatMap(([n, c]) => leavesOf(c.data.toJSON()).map((leaf) => ({ name: n, leaf })));
  const kinds = {};
  /** Formulaires ouverts et pas encore soumis (un membre peut en soumettre un tard). */
  const openModals = [];
  /** Membres arrivés pendant la marche (pseudos parfois hostiles). */
  const arrivals = [];
  const remember = (rec) => {
    if (rec?.modals?.length) openModals.push(rec);
    if (openModals.length > 20) openModals.shift();
  };
  const submitHostile = async (rec) => {
    const modal = rec.modals[rec.modals.length - 1];
    const values = {};
    for (const row of modal.components) {
      const c = row.type === 1 ? row.components[0] : row.component;
      if (c?.type === 4) values[c.custom_id] = hostileText(rng, c, row.label ?? c.label);
    }
    remember(await h.submitModal(rec, values));
    return `formulaire ${modal.custom_id} ${JSON.stringify(values).slice(0, 200)}`;
  };
  let actions = 0;
  const textChannel = () => {
    const list = [...h.fake.channels.values()].filter((c) => c.type === 0 && h.client.channels.cache.has(c.id));
    return list.find((c) => c.id === IDS.channels.general)?.id ?? list[0]?.id;
  };
  const botMessages = () => h.fake.messageLog.slice(-60).map((id) => h.message(id)).filter((m) => m && m.author.id === h.client.user.id && m.components?.length && h.fake.channels.has(m.channel_id));
  const protectedChannels = new Set([IDS.channels.general]);
  /** Utilisateur qui agit : seulement un membre encore présent (Discord n'envoie rien sinon). */
  const actor = () => {
    const present = USERS.filter((u) => h.fake.members.has(IDS.users[u]));
    return rng.pick(present.length ? present : ['owner']);
  };

  const ACTIONS = [
    ['commande', 30, async () => {
      const { name, leaf } = rng.pick(commands);
      const key = [name, ...leaf.path].join(' ');
      const as = actor();
      const overrides = { ...(OVERRIDES[key] ?? {}) };
      // Une option sur deux reçoit, une fois sur trois, une valeur hostile.
      for (const opt of leaf.options) {
        if (rng.chance(0.15)) {
          const values = hostileValues(h, opt);
          if (values.length) overrides[opt.name] = rng.pick(values).value;
        }
      }
      h.client.cooldowns.expiries.clear();
      const options = dropDeletedRefs(h, leaf.options, await buildOptions(h, key, leaf.options, overrides, { requiredOnly: rng.chance(0.3) }));
      if (!options) return null;
      const channel = textChannel();
      const rec = await h.slash(name, wrapPath(leaf.path, options), { as, channel, label: `/${key} (${as})` });
      if (rng.chance(0.8)) remember(await confirmIfAsked(h, rec));
      remember(rec);
      return `/${key} ${as} ${JSON.stringify(options).slice(0, 200)}`;
    }],
    ['clic', 30, async () => {
      const msgs = botMessages();
      if (!msgs.length) return null;
      const msg = rng.pick(msgs);
      // Boutons de collectors (confirmation, pages) : un clic hors de leur auteur ou après
      // expiration attend la réponse « bouton expiré » du routeur (2,5 s) ; tirés plus rarement.
      const acts = actionsOf(msg).filter((a) => (a.customId.startsWith('cmd:_:delete') ? rng.chance(0.1)
        : h.client.componentHandler.resolve(a.customId) ? true : rng.chance(collectorRate)));
      if (!acts.length) return null;
      const a = rng.pick(acts);
      const as = actor();
      h.client.cooldowns.expiries.clear();
      const count = rng.chance(0.15) ? 2 + rng.int(2) : 1;
      const recs = await Promise.all(Array.from({ length: count }, () => h.click(msg, a.customId, { as, values: a.values })));
      for (const rec of recs) remember(rec);
      // Le plus souvent, le formulaire ouvert est rempli tout de suite.
      const opened = recs.find((rec) => rec.modals?.length);
      const submitted = opened && rng.chance(0.7) ? ` puis ${await submitHostile(opened)}` : '';
      return `clic ×${count} ${a.customId} ${a.values?.join(',') ?? ''} (${as})${submitted}`;
    }],
    ['formulaire', 5, async () => {
      if (!openModals.length) return null;
      return submitHostile(rng.pick(openModals));
    }],
    ['arrivée', 5, async () => {
      const young = rng.chance(0.3);
      // Pseudo affiché hostile une fois sur trois (repris par l'accueil, les niveaux, les logs).
      const display = rng.chance(0.35) ? [...rng.pick(HOSTILE_NAMES)].slice(0, 32).join('') : `Arrivant${rng.int(1e6)}`;
      const user = h.addUser(display, { ageDays: young ? 1 : 400, bot: rng.chance(0.1) });
      await h.memberJoin(user);
      arrivals.push(user.id);
      return `arrivée ${user.id}${young ? ' (compte récent)' : ''}`;
    }],
    ['retour', 2, async () => {
      const gone = ['mod', 'target'].filter((u) => !h.fake.members.has(IDS.users[u]));
      if (!gone.length) return null;
      const who = rng.pick(gone);
      await h.memberJoin(h.fake.users.get(IDS.users[who]));
      return `retour ${who}`;
    }],
    ['départ', 3, async () => {
      // « member » reste : les préparations des surcharges (lib/overrides.js) agissent en son nom.
      const candidates = [...h.fake.members.keys()].filter((id) => ![IDS.users.bot, IDS.users.owner, IDS.users.admin, IDS.users.member].includes(id));
      if (!candidates.length) return null;
      const id = rng.pick(candidates);
      await h.memberLeave(id);
      return `départ ${id}`;
    }],
    ['message', 12, async () => {
      const recent = arrivals.filter((id) => h.fake.members.has(id));
      const as = recent.length && rng.chance(0.3) ? rng.pick(recent) : rng.pick(['member', 'target', 'mod', 'member']);
      if (!h.fake.members.has(IDS.users[as] ?? as)) return null;
      const channel = textChannel();
      const content = rng.chance(0.2) ? rng.pick(hostileStrings()).slice(0, 2000) : rng.pick(SPAM);
      if (!content) return null;
      await h.userMessage({ as, channel, content });
      return `message ${as} ${JSON.stringify(content.slice(0, 40))}`;
    }],
    ['suppression message', 2, async () => {
      const ids = h.fake.messageLog.slice(-40).filter((id) => h.message(id) && h.message(id).author.id !== h.client.user.id && h.fake.channels.has(h.message(id).channel_id));
      if (!ids.length) return null;
      const id = rng.pick(ids);
      await h.deleteUserMessage(id);
      return `suppression message ${id}`;
    }],
    ['vocal', 4, async () => {
      const as = rng.pick(['member', 'target', 'mod']);
      if (!h.fake.members.has(IDS.users[as])) return null;
      const voices = [...h.fake.channels.values()].filter((c) => c.type === 2).map((c) => c.id);
      const channel = rng.chance(0.3) || !voices.length ? null : rng.pick(voices);
      await h.voice(as, channel);
      return `vocal ${as} → ${channel}`;
    }],
    ['suppression salon', 2, async () => {
      const cfgIds = new Set(JSON.stringify(h.client.services.config.get(h.guild.id)).match(/\d{17,20}/g) ?? []);
      const list = [...h.fake.channels.values()].filter((c) => !protectedChannels.has(c.id) && c.type !== 11);
      const preferred = list.filter((c) => cfgIds.has(c.id));
      const ch = rng.chance(0.7) && preferred.length ? rng.pick(preferred) : rng.pick(list);
      if (!ch) return null;
      h.fake.label = `suppression salon ${ch.name}`;
      h.fake.deleteChannel(ch.id);
      await h.settle();
      return `suppression salon ${ch.id} (${ch.name})`;
    }],
    ['suppression rôle', 2, async () => {
      const cfgIds = new Set(JSON.stringify(h.client.services.config.get(h.guild.id)).match(/\d{17,20}/g) ?? []);
      const list = [...h.fake.roles.values()].filter((r) => r.id !== IDS.guild && !r.managed && r.id !== IDS.roles.admin);
      const preferred = list.filter((r) => cfgIds.has(r.id));
      const role = rng.chance(0.7) && preferred.length ? rng.pick(preferred) : rng.pick(list);
      if (!role) return null;
      h.fake.label = `suppression rôle ${role.name}`;
      h.fake.deleteRole(role.id);
      await h.settle();
      return `suppression rôle ${role.id} (${role.name})`;
    }],
    ['permissions du bot', 2, async () => {
      const role = h.fake.roles.get(IDS.roles.bot);
      const sets = {
        aucune: [P.ViewChannel, P.SendMessages],
        moderation: [P.ViewChannel, P.SendMessages, P.EmbedLinks, P.KickMembers, P.BanMembers, P.ModerateMembers, P.ManageMessages, P.ReadMessageHistory],
        'sans rôles ni salons': [P.ViewChannel, P.SendMessages, P.EmbedLinks, P.ReadMessageHistory, P.KickMembers, P.BanMembers, P.ModerateMembers, P.ManageMessages, P.ViewAuditLog],
        administrateur: [P.Administrator],
      };
      const choice = rng.pick(Object.keys(sets));
      role.permissions = sets[choice].reduce((a, f) => a | f, 0n).toString();
      h.fake.label = `permissions du bot : ${choice}`;
      h.fake.dispatchNow('GUILD_ROLE_UPDATE', { guild_id: h.guild.id, role });
      await h.settle();
      return `permissions du bot : ${choice}`;
    }],
    ['planificateur', 2, async () => {
      await h.client.services.scheduler.tick();
      await h.settle();
      return 'tick du planificateur';
    }],
  ];
  const total = ACTIONS.reduce((n, [, w]) => n + w, 0);
  const choose = () => {
    let r = rng.int(total);
    for (const a of ACTIONS) {
      r -= a[1];
      if (r < 0) return a;
    }
    return ACTIONS[0];
  };

  for (let i = 0; i < steps; i += 1) {
    const [kind, , fn] = choose();
    const context = { seed, step: i, kind };
    const started = Date.now();
    const what = await step(h, failures, context, async () => {
      const label = await fn();
      if (label) context.action = label;
      return label;
    });
    if (process.env.CHAOS_SLOW && Date.now() - started > Number(process.env.CHAOS_SLOW)) process.stderr.write(`lent (${Date.now() - started} ms) : ${what}\n`);
    if (what) {
      actions += 1;
      kinds[kind] = (kinds[kind] ?? 0) + 1;
      trace?.push(`${i} ${what}`);
    }
    if (onStep) await onStep(i, context);
  }
  return { actions, kinds };
}

/**
 * Références de la configuration vers un salon ou un rôle qui n'existe plus :
 * [{ path: 'logChannels.messages', id }]. Les identifiants d'utilisateurs (listes
 * blanches…) et les valeurs non-snowflake sont ignorés.
 */
function danglingRefs(h) {
  const out = [];
  const walk = (value, path) => {
    if (Array.isArray(value)) value.forEach((v, i) => walk(v, `${path}[${i}]`));
    else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) walk(v, path ? `${path}.${k}` : k);
    else if (typeof value === 'string' && /^\d{17,20}$/.test(value) && value !== h.guild.id) {
      if (!h.fake.channels.has(value) && !h.fake.roles.has(value) && !h.fake.users.has(value)) out.push({ path, id: value });
    }
  };
  walk(h.client.services.config.get(h.guild.id), '');
  return out;
}

/** Graine : CHAOS_SEED, sinon valeur par défaut fixe. */
function seedFromEnv(fallback) {
  const raw = process.env.CHAOS_SEED;
  if (raw == null || raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n >>> 0 : [...raw].reduce((a, c) => (Math.imul(a, 31) + c.codePointAt(0)) >>> 0, 7);
}

module.exports = {
  Rng,
  hostileStrings,
  hostileValues,
  hostileText,
  dropDeletedRefs,
  fuzzCommand,
  fuzzModals,
  forbidHostilePings,
  randomWalk,
  danglingRefs,
  digest,
  diffDigest,
  raceTargets,
  raceOnce,
  checkRace,
  checkModalRace,
  shapeOf,
  step,
  formatFailures,
  confirmIfAsked,
  seedFromEnv,
  UNKNOWN_ID,
};
