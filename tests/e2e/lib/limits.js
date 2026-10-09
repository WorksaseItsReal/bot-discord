'use strict';

/**
 * Validation des corps de requêtes envoyés à l'API Discord, d'après les limites
 * documentées (https://discord.com/developers/docs). Fonctions pures : chacune
 * renvoie la liste des violations (chaînes lisibles), vide si tout est conforme.
 */

const MAX = {
  content: 2000,
  embeds: 10,
  embedTitle: 256,
  embedDescription: 4096,
  embedFields: 25,
  fieldName: 256,
  fieldValue: 1024,
  footer: 2048,
  author: 256,
  embedTotal: 6000,
  rows: 5,
  rowButtons: 5,
  customId: 100,
  buttonLabel: 80,
  selectOptions: 25,
  optionLabel: 100,
  optionValue: 100,
  optionDescription: 100,
  placeholder: 150,
  modalTitle: 45,
  modalComponents: 5,
  inputLabel: 45,
  inputPlaceholder: 100,
  inputValue: 4000,
  labelDescription: 100,
  autocompleteChoices: 25,
  nick: 32,
  channelName: 100,
  topic: 1024,
  roleName: 100,
  auditReason: 512,
  threadName: 100,
  webhookName: 80,
};

const len = (s) => (typeof s === 'string' ? [...s].length : 0);
const isStr = (s) => typeof s === 'string';
const blank = (s) => !isStr(s) || !s.trim();
const URL_RE = /^(https?:\/\/|attachment:\/\/)\S+$/i;

/** Embeds d'un message (≤ 10, limites par élément, total 6000). */
function validateEmbeds(embeds, where = 'embeds') {
  const out = [];
  if (embeds == null) return out;
  if (!Array.isArray(embeds)) return [`${where} : doit être un tableau`];
  if (embeds.length > MAX.embeds) out.push(`${where} : ${embeds.length} embeds (> ${MAX.embeds})`);
  let total = 0;
  embeds.forEach((e, i) => {
    const at = `${where}[${i}]`;
    if (!e || typeof e !== 'object') return out.push(`${at} : embed invalide`);
    if (e.title != null) {
      if (len(e.title) > MAX.embedTitle) out.push(`${at}.title : ${len(e.title)} > ${MAX.embedTitle}`);
      total += len(e.title);
    }
    if (e.description != null) {
      if (!isStr(e.description)) out.push(`${at}.description : pas une chaîne`);
      if (len(e.description) > MAX.embedDescription) out.push(`${at}.description : ${len(e.description)} > ${MAX.embedDescription}`);
      total += len(e.description);
    }
    if (e.fields != null) {
      if (e.fields.length > MAX.embedFields) out.push(`${at}.fields : ${e.fields.length} > ${MAX.embedFields}`);
      e.fields.forEach((f, j) => {
        if (blank(f?.name)) out.push(`${at}.fields[${j}].name vide`);
        if (blank(f?.value)) out.push(`${at}.fields[${j}].value vide`);
        if (len(f?.name) > MAX.fieldName) out.push(`${at}.fields[${j}].name : ${len(f.name)} > ${MAX.fieldName}`);
        if (len(f?.value) > MAX.fieldValue) out.push(`${at}.fields[${j}].value : ${len(f.value)} > ${MAX.fieldValue}`);
        total += len(f?.name) + len(f?.value);
      });
    }
    if (e.footer != null) {
      if (blank(e.footer.text)) out.push(`${at}.footer.text vide`);
      if (len(e.footer.text) > MAX.footer) out.push(`${at}.footer.text : ${len(e.footer.text)} > ${MAX.footer}`);
      total += len(e.footer.text);
    }
    if (e.author != null) {
      if (blank(e.author.name)) out.push(`${at}.author.name vide`);
      if (len(e.author.name) > MAX.author) out.push(`${at}.author.name : ${len(e.author.name)} > ${MAX.author}`);
      total += len(e.author.name);
    }
    if (e.color != null && (!Number.isInteger(e.color) || e.color < 0 || e.color > 0xffffff)) out.push(`${at}.color invalide (${e.color})`);
    for (const [key, url] of [['url', e.url], ['image.url', e.image?.url], ['thumbnail.url', e.thumbnail?.url], ['author.url', e.author?.url], ['author.icon_url', e.author?.icon_url], ['footer.icon_url', e.footer?.icon_url]]) {
      if (url != null && !URL_RE.test(String(url))) out.push(`${at}.${key} : URL invalide (${String(url).slice(0, 60)})`);
    }
    if (e.timestamp != null && Number.isNaN(Date.parse(e.timestamp))) out.push(`${at}.timestamp invalide`);
  });
  if (total > MAX.embedTotal) out.push(`${where} : total ${total} caractères > ${MAX.embedTotal}`);
  return out;
}

const SELECT_TYPES = new Set([3, 5, 6, 7, 8]);

function validateButton(c, at) {
  const out = [];
  if (![1, 2, 3, 4, 5, 6].includes(c.style)) out.push(`${at} : style de bouton invalide (${c.style})`);
  if (c.style === 5) {
    if (!c.url || !URL_RE.test(c.url)) out.push(`${at} : bouton lien sans URL valide`);
    if (c.custom_id != null) out.push(`${at} : bouton lien avec custom_id`);
  } else if (c.style === 6) {
    if (!c.sku_id) out.push(`${at} : bouton premium sans sku_id`);
  } else {
    if (blank(c.custom_id)) out.push(`${at} : bouton sans custom_id`);
    if (c.url != null) out.push(`${at} : bouton non-lien avec url`);
  }
  if (c.style !== 6 && blank(c.label) && !c.emoji) out.push(`${at} : bouton sans libellé ni emoji`);
  if (len(c.label) > MAX.buttonLabel) out.push(`${at}.label : ${len(c.label)} > ${MAX.buttonLabel}`);
  return out;
}

function validateSelect(c, at) {
  const out = [];
  if (len(c.placeholder) > MAX.placeholder) out.push(`${at}.placeholder : ${len(c.placeholder)} > ${MAX.placeholder}`);
  const min = c.min_values ?? 1;
  const max = c.max_values ?? 1;
  if (min < 0 || min > 25) out.push(`${at}.min_values hors bornes (${min})`);
  if (max < 1 || max > 25) out.push(`${at}.max_values hors bornes (${max})`);
  if (min > max) out.push(`${at} : min_values ${min} > max_values ${max}`);
  if (c.type === 3) {
    const opts = c.options ?? [];
    if (!opts.length) out.push(`${at} : menu sans option`);
    if (opts.length > MAX.selectOptions) out.push(`${at}.options : ${opts.length} > ${MAX.selectOptions}`);
    if (max > opts.length && opts.length) out.push(`${at} : max_values ${max} > ${opts.length} options`);
    if (min > opts.length && opts.length) out.push(`${at} : min_values ${min} > ${opts.length} options`);
    const values = new Set();
    let defaults = 0;
    opts.forEach((o, j) => {
      if (blank(o?.label)) out.push(`${at}.options[${j}].label vide`);
      if (blank(o?.value)) out.push(`${at}.options[${j}].value vide`);
      if (len(o?.label) > MAX.optionLabel) out.push(`${at}.options[${j}].label : ${len(o.label)} > ${MAX.optionLabel}`);
      if (len(o?.value) > MAX.optionValue) out.push(`${at}.options[${j}].value : ${len(o.value)} > ${MAX.optionValue}`);
      if (len(o?.description) > MAX.optionDescription) out.push(`${at}.options[${j}].description : ${len(o.description)} > ${MAX.optionDescription}`);
      if (values.has(o?.value)) out.push(`${at}.options : valeur en double « ${o.value} »`);
      values.add(o?.value);
      if (o?.default) defaults += 1;
    });
    if (defaults > max) out.push(`${at} : ${defaults} options par défaut > max_values ${max}`);
  } else {
    const defs = c.default_values ?? [];
    if (defs.length > max) out.push(`${at}.default_values : ${defs.length} > max_values ${max}`);
    const allowed = { 5: ['user'], 6: ['role'], 7: ['user', 'role'], 8: ['channel'] }[c.type];
    defs.forEach((d, j) => {
      if (!allowed.includes(d?.type)) out.push(`${at}.default_values[${j}].type « ${d?.type} » invalide`);
      if (!/^\d{17,20}$/.test(String(d?.id ?? ''))) out.push(`${at}.default_values[${j}].id invalide`);
    });
  }
  return out;
}

/** Composants d'un message (rangées d'actions, hors Components V2). */
function validateComponents(components, where = 'components') {
  const out = [];
  if (components == null) return out;
  if (!Array.isArray(components)) return [`${where} : doit être un tableau`];
  if (components.length > MAX.rows) out.push(`${where} : ${components.length} rangées (> ${MAX.rows})`);
  const ids = new Set();
  components.forEach((row, i) => {
    const at = `${where}[${i}]`;
    if (row?.type !== 1) return out.push(`${at} : rangée de type ${row?.type} (attendu 1)`);
    const list = row.components ?? [];
    if (!list.length) out.push(`${at} : rangée vide`);
    if (list.length > MAX.rowButtons) out.push(`${at} : ${list.length} composants (> ${MAX.rowButtons})`);
    const hasSelect = list.some((c) => SELECT_TYPES.has(c?.type));
    if (hasSelect && list.length > 1) out.push(`${at} : un menu doit être seul dans sa rangée`);
    list.forEach((c, j) => {
      const cat = `${at}.components[${j}]`;
      if (c?.custom_id != null) {
        if (len(c.custom_id) > MAX.customId) out.push(`${cat}.custom_id : ${len(c.custom_id)} > ${MAX.customId}`);
        if (ids.has(c.custom_id)) out.push(`${cat} : custom_id en double « ${c.custom_id} »`);
        ids.add(c.custom_id);
      }
      if (c?.type === 2) out.push(...validateButton(c, cat));
      else if (SELECT_TYPES.has(c?.type)) {
        if (blank(c.custom_id)) out.push(`${cat} : menu sans custom_id`);
        out.push(...validateSelect(c, cat));
      } else out.push(`${cat} : type ${c?.type} interdit dans une rangée de message`);
    });
  });
  return out;
}

function validateTextInput(c, at, { inLabel }) {
  const out = [];
  if (blank(c.custom_id)) out.push(`${at} : champ sans custom_id`);
  if (len(c.custom_id) > MAX.customId) out.push(`${at}.custom_id : ${len(c.custom_id)} > ${MAX.customId}`);
  if (![1, 2].includes(c.style)) out.push(`${at}.style invalide (${c.style})`);
  if (inLabel) {
    if (c.label != null) out.push(`${at} : label interdit dans un composant Label`);
  } else {
    if (blank(c.label)) out.push(`${at} : champ sans label`);
    if (len(c.label) > MAX.inputLabel) out.push(`${at}.label : ${len(c.label)} > ${MAX.inputLabel}`);
  }
  if (len(c.placeholder) > MAX.inputPlaceholder) out.push(`${at}.placeholder : ${len(c.placeholder)} > ${MAX.inputPlaceholder}`);
  if (c.min_length != null && (c.min_length < 0 || c.min_length > 4000)) out.push(`${at}.min_length hors bornes`);
  if (c.max_length != null && (c.max_length < 1 || c.max_length > 4000)) out.push(`${at}.max_length hors bornes`);
  if (c.min_length != null && c.max_length != null && c.min_length > c.max_length) out.push(`${at} : min_length > max_length`);
  if (c.value != null) {
    if (len(c.value) > MAX.inputValue) out.push(`${at}.value : ${len(c.value)} > ${MAX.inputValue}`);
    if (c.max_length != null && len(c.value) > c.max_length) out.push(`${at}.value : ${len(c.value)} > max_length ${c.max_length}`);
  }
  return out;
}

/** Formulaire (réponse d'interaction de type 9). */
function validateModal(data, where = 'modal') {
  const out = [];
  if (!data || typeof data !== 'object') return [`${where} : données absentes`];
  if (blank(data.custom_id)) out.push(`${where} : custom_id absent`);
  if (len(data.custom_id) > MAX.customId) out.push(`${where}.custom_id : ${len(data.custom_id)} > ${MAX.customId}`);
  if (blank(data.title)) out.push(`${where} : titre absent`);
  if (len(data.title) > MAX.modalTitle) out.push(`${where}.title : ${len(data.title)} > ${MAX.modalTitle}`);
  const comps = data.components ?? [];
  if (!comps.length) out.push(`${where} : aucun champ`);
  if (comps.length > MAX.modalComponents) out.push(`${where} : ${comps.length} composants (> ${MAX.modalComponents})`);
  const ids = new Set();
  const seen = (id, at) => {
    if (id == null) return;
    if (ids.has(id)) out.push(`${at} : custom_id en double « ${id} »`);
    ids.add(id);
  };
  comps.forEach((row, i) => {
    const at = `${where}.components[${i}]`;
    if (row?.type === 1) {
      const list = row.components ?? [];
      if (list.length !== 1) out.push(`${at} : une rangée de formulaire contient exactement un champ (${list.length})`);
      list.forEach((c, j) => {
        if (c?.type !== 4) return out.push(`${at}.components[${j}] : type ${c?.type} interdit (attendu 4)`);
        seen(c.custom_id, `${at}.components[${j}]`);
        out.push(...validateTextInput(c, `${at}.components[${j}]`, { inLabel: false }));
      });
    } else if (row?.type === 18) {
      if (blank(row.label)) out.push(`${at} : Label sans texte`);
      if (len(row.label) > MAX.inputLabel) out.push(`${at}.label : ${len(row.label)} > ${MAX.inputLabel}`);
      if (len(row.description) > MAX.labelDescription) out.push(`${at}.description : ${len(row.description)} > ${MAX.labelDescription}`);
      const c = row.component;
      if (!c) return out.push(`${at} : Label sans composant`);
      seen(c.custom_id, `${at}.component`);
      if (c.type === 4) out.push(...validateTextInput(c, `${at}.component`, { inLabel: true }));
      else if (SELECT_TYPES.has(c.type)) out.push(...validateSelect(c, `${at}.component`));
      else if (c.type !== 19) out.push(`${at}.component : type ${c.type} non pris en charge`);
    } else if (row?.type !== 10) {
      out.push(`${at} : type ${row?.type} interdit dans un formulaire`);
    }
  });
  return out;
}

/** allowed_mentions cohérent (parse + listes explicites incompatibles). */
function validateAllowedMentions(am, where = 'allowed_mentions') {
  const out = [];
  if (am == null) return out;
  const parse = am.parse ?? [];
  for (const p of parse) if (!['users', 'roles', 'everyone'].includes(p)) out.push(`${where}.parse : valeur inconnue « ${p} »`);
  if (parse.includes('users') && am.users?.length) out.push(`${where} : parse « users » ET liste users (rejeté par Discord)`);
  if (parse.includes('roles') && am.roles?.length) out.push(`${where} : parse « roles » ET liste roles (rejeté par Discord)`);
  if ((am.users?.length ?? 0) > 100) out.push(`${where}.users : > 100`);
  if ((am.roles?.length ?? 0) > 100) out.push(`${where}.roles : > 100`);
  return out;
}

/**
 * Corps d'un message (création ou édition).
 * @param {object} body
 * @param {{ partial?: boolean, files?: any[], existing?: object }} [opts]
 */
function validateMessageBody(body, { partial = false, files = [], existing = null } = {}) {
  const out = [];
  if (!body || typeof body !== 'object') return partial ? out : ['message : corps absent'];
  if (body.content != null) {
    if (!isStr(body.content)) out.push('content : pas une chaîne');
    else if (len(body.content) > MAX.content) out.push(`content : ${len(body.content)} > ${MAX.content}`);
  }
  out.push(...validateEmbeds(body.embeds));
  if (!(Number(body.flags ?? 0) & (1 << 15))) out.push(...validateComponents(body.components));
  out.push(...validateAllowedMentions(body.allowed_mentions));
  if (body.poll) {
    if (len(body.poll.question?.text) > 300) out.push('poll.question.text > 300');
    if ((body.poll.answers?.length ?? 0) > 10) out.push('poll.answers > 10');
    (body.poll.answers ?? []).forEach((a, i) => {
      if (len(a?.poll_media?.text) > 55) out.push(`poll.answers[${i}].text > 55`);
    });
  }
  // Message vide (50006) : à la création, ou à l'édition si le résultat serait vide.
  const merged = partial && existing ? { ...existing, ...body } : body;
  const hasContent = isStr(merged.content) && merged.content.trim().length > 0;
  const hasEmbeds = Array.isArray(merged.embeds) && merged.embeds.length > 0;
  const hasComponents = Array.isArray(merged.components) && merged.components.length > 0;
  const hasFiles = files.length > 0 || (Array.isArray(merged.attachments) && merged.attachments.length > 0);
  if (!partial || existing) {
    if (!hasContent && !hasEmbeds && !hasComponents && !hasFiles && !merged.poll && !merged.sticker_ids?.length) {
      out.push('message vide (Cannot send an empty message, 50006)');
    }
  }
  return out;
}

/** Choix d'autocomplétion. */
function validateAutocomplete(data) {
  const out = [];
  const choices = data?.choices ?? [];
  if (choices.length > MAX.autocompleteChoices) out.push(`autocomplete : ${choices.length} choix > 25`);
  choices.forEach((c, i) => {
    if (blank(c?.name) || len(c.name) > 100) out.push(`autocomplete.choices[${i}].name invalide (${len(c?.name)})`);
    if (typeof c?.value === 'string' && len(c.value) > 100) out.push(`autocomplete.choices[${i}].value > 100`);
  });
  return out;
}

/** Textes trahissant une valeur mal lue (undefined, [object Object], NaN, mention vide…). */
const SUSPICIOUS_RE = /\bundefined\b|\[object \w+\]|\bNaN\b|<@!?>|<#>|<@&>|<t:(NaN|undefined|null|-?\d+\.\d+)(:\w)?>|Invalid Date|\bnull\b/;
const TEXT_KEYS = new Set(['content', 'title', 'description', 'name', 'value', 'text', 'label', 'placeholder', 'custom_id', 'url', 'icon_url']);

/** Chaînes suspectes d'un corps (récursif). @returns {string[]} */
function findSuspiciousText(body, path = '') {
  const out = [];
  if (body == null) return out;
  if (Array.isArray(body)) {
    body.forEach((v, i) => out.push(...findSuspiciousText(v, `${path}[${i}]`)));
    return out;
  }
  if (typeof body !== 'object') return out;
  for (const [k, v] of Object.entries(body)) {
    const at = path ? `${path}.${k}` : k;
    if (typeof v === 'string' && TEXT_KEYS.has(k)) {
      const m = SUSPICIOUS_RE.exec(v);
      if (m) out.push(`${at} contient « ${m[0]} » : ${v.slice(Math.max(0, m.index - 40), m.index + 40).replace(/\n/g, ' ')}`);
    } else if (v && typeof v === 'object') out.push(...findSuspiciousText(v, at));
  }
  return out;
}

/**
 * Mentions de masse EFFECTIVES d'un corps envoyé : un `content` contenant
 * @everyone/@here ou une mention de rôle que `allowed_mentions` laisserait notifier.
 * Sans `allowed_mentions`, Discord analyse tout le contenu (tout notifie).
 * Une liste explicite `roles` est un choix délibéré du bot ; elle n'est signalée
 * que pour un rôle de `forbiddenRoles` (rôle injecté dans une saisie utilisateur).
 * @param {object} body
 * @param {Set<string>} [forbiddenRoles]
 * @returns {string[]}
 */
function findMassMentions(body, forbiddenRoles = new Set(), path = '') {
  const out = [];
  if (body == null || typeof body !== 'object') return out;
  if (Array.isArray(body)) {
    body.forEach((v, i) => out.push(...findMassMentions(v, forbiddenRoles, `${path}[${i}]`)));
    return out;
  }
  if (typeof body.content === 'string' && body.content) {
    const am = body.allowed_mentions;
    const parse = am?.parse ?? [];
    const at = path ? `${path}.content` : 'content';
    const excerpt = body.content.slice(0, 80).replace(/\n/g, ' ');
    if (/@(everyone|here)/.test(body.content) && (am == null || parse.includes('everyone'))) {
      out.push(`${at} : @everyone/@here notifierait (allowed_mentions ${JSON.stringify(am ?? null)}) : ${excerpt}`);
    }
    for (const [, id] of body.content.matchAll(/<@&(\d{17,20})>/g)) {
      const pinged = am == null || parse.includes('roles') || (am.roles ?? []).includes(id);
      const deliberate = am != null && !parse.includes('roles') && (am.roles ?? []).includes(id) && !forbiddenRoles.has(id);
      if (pinged && !deliberate) out.push(`${at} : le rôle ${id} serait notifié (allowed_mentions ${JSON.stringify(am ?? null)}) : ${excerpt}`);
    }
  }
  for (const [k, v] of Object.entries(body)) {
    if (k !== 'allowed_mentions' && v && typeof v === 'object') out.push(...findMassMentions(v, forbiddenRoles, path ? `${path}.${k}` : k));
  }
  return out;
}

module.exports = {
  MAX,
  findMassMentions,
  findSuspiciousText,
  validateEmbeds,
  validateComponents,
  validateModal,
  validateAllowedMentions,
  validateMessageBody,
  validateAutocomplete,
};
