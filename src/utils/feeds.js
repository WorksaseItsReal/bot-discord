'use strict';

/**
 * Flux RSS 2.0 / RSS 1.0 (RDF) / Atom : analyseur minimal SANS dépendance, et tout ce
 * qui est pur autour (adresses YouTube, texte des descriptions, extraits). Pur.
 *
 * Sécurité : aucune expression régulière à backtracking sur le document. Le découpage
 * XML est un balayage linéaire (indexOf) ; les seules regex appliquées au contenu ont
 * des quantificateurs bornés ou des classes simples (pas de quantificateurs imbriqués).
 * Aucune entité déclarée (DOCTYPE) n'est développée : pas de « milliard de rires ».
 */

/** Éléments analysés au plus (documents hostiles). */
const MAX_NODES = 60_000;
/** Profondeur d'imbrication suivie au plus (au-delà : éléments traités comme des feuilles). */
const MAX_DEPTH = 64;
/** Articles examinés au plus dans un document (les plus récents d'abord quand les dates le permettent). */
const MAX_ITEMS = 50;
/** Extrait publié (caractères). */
const EXCERPT_MAX = 300;
const MAX_URL = 2048;
const YT_CHANNEL_ID = /^UC[\w-]{22}$/;
const YT_PLAYLIST_ID = /^[\w-]{10,64}$/;

class FeedError extends Error {
  /** @param {string} message phrase en français, affichable telle quelle */
  constructor(message) {
    super(message);
    this.name = 'FeedError';
    this.isUserError = true;
  }
}

// ---------------------------------------------------------------- entités

const NAMED_ENTITIES = Object.freeze({
  amp: '&', lt: '<', gt: '>', quot: '"', apos: '\'', nbsp: ' ', ensp: ' ', emsp: ' ', thinsp: ' ',
  hellip: '…', mdash: '—', ndash: '–', lsquo: '‘', rsquo: '’', sbquo: '‚', ldquo: '“', rdquo: '”', bdquo: '„',
  laquo: '«', raquo: '»', middot: '·', bull: '•', copy: '©', reg: '®', trade: '™', deg: '°', euro: '€',
  pound: '£', yen: '¥', cent: '¢', sect: '§', para: '¶', times: '×', divide: '÷', plusmn: '±', iexcl: '¡', iquest: '¿',
  agrave: 'à', aacute: 'á', acirc: 'â', atilde: 'ã', auml: 'ä', aring: 'å', aelig: 'æ', ccedil: 'ç',
  egrave: 'è', eacute: 'é', ecirc: 'ê', euml: 'ë', igrave: 'ì', iacute: 'í', icirc: 'î', iuml: 'ï',
  ntilde: 'ñ', ograve: 'ò', oacute: 'ó', ocirc: 'ô', otilde: 'õ', ouml: 'ö', oslash: 'ø', oelig: 'œ',
  ugrave: 'ù', uacute: 'ú', ucirc: 'û', uuml: 'ü', yacute: 'ý', yuml: 'ÿ', szlig: 'ß',
  Agrave: 'À', Aacute: 'Á', Acirc: 'Â', Atilde: 'Ã', Auml: 'Ä', Aring: 'Å', AElig: 'Æ', Ccedil: 'Ç',
  Egrave: 'È', Eacute: 'É', Ecirc: 'Ê', Euml: 'Ë', Igrave: 'Ì', Iacute: 'Í', Icirc: 'Î', Iuml: 'Ï',
  Ntilde: 'Ñ', Ograve: 'Ò', Oacute: 'Ó', Ocirc: 'Ô', Otilde: 'Õ', Ouml: 'Ö', Oslash: 'Ø', OElig: 'Œ',
  Ugrave: 'Ù', Uacute: 'Ú', Ucirc: 'Û', Uuml: 'Ü', Yacute: 'Ý', Yuml: 'Ÿ',
});

/** Quantificateurs bornés, aucune imbrication : linéaire. */
const ENTITY_RE = /&(#[xX][0-9a-fA-F]{1,6}|#[0-9]{1,7}|[a-zA-Z][a-zA-Z0-9]{1,31});/g;

function codePointText(cp) {
  if (!Number.isInteger(cp) || cp <= 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return '\ufffd';
  return String.fromCodePoint(cp);
}

/** Décode les entités numériques et nommées (XML + sous-ensemble HTML courant). Pur. */
function decodeEntities(text) {
  const s = String(text ?? '');
  if (!s.includes('&')) return s;
  return s.replace(ENTITY_RE, (whole, body) => {
    if (body[0] === '#') return codePointText(body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10));
    return Object.hasOwn(NAMED_ENTITIES, body) ? NAMED_ENTITIES[body] : Object.hasOwn(NAMED_ENTITIES, body.toLowerCase()) ? NAMED_ENTITIES[body.toLowerCase()] : whole;
  });
}

// ---------------------------------------------------------------- XML

const isSpace = (c) => c === ' ' || c === '\n' || c === '\t' || c === '\r' || c === '\f';

/** Fin de balise (« > » hors guillemets) à partir de `from`, ou -1. Linéaire. */
function findTagEnd(text, from) {
  let quote = null;
  for (let j = from; j < text.length; j += 1) {
    const c = text[j];
    if (quote) {
      if (c === quote) quote = null;
    } else if (c === '"' || c === '\'') {
      quote = c;
    } else if (c === '>') {
      return j;
    }
  }
  return -1;
}

/** Nom et attributs d'une balise ouvrante (sans « < » ni « > »). Linéaire. */
function parseTag(body) {
  const len = body.length;
  let j = 0;
  while (j < len && !isSpace(body[j])) j += 1;
  const name = body.slice(0, j).toLowerCase().slice(0, 100);
  const attrs = Object.create(null);
  while (j < len) {
    while (j < len && isSpace(body[j])) j += 1;
    let k = j;
    while (k < len && body[k] !== '=' && !isSpace(body[k])) k += 1;
    const key = body.slice(j, k).toLowerCase().slice(0, 100);
    j = k;
    while (j < len && isSpace(body[j])) j += 1;
    if (body[j] !== '=') {
      if (key) attrs[key] = '';
      continue;
    }
    j += 1;
    while (j < len && isSpace(body[j])) j += 1;
    let value;
    const q = body[j];
    if (q === '"' || q === '\'') {
      const end = body.indexOf(q, j + 1);
      value = body.slice(j + 1, end === -1 ? len : end);
      j = end === -1 ? len : end + 1;
    } else {
      let e = j;
      while (e < len && !isSpace(body[e])) e += 1;
      value = body.slice(j, e);
      j = e;
    }
    if (key) attrs[key] = decodeEntities(value);
  }
  return { name, attrs };
}

/**
 * Arbre XML minimal : { name, attrs, children: (élément | texte)[] }. Tolérant (balises
 * non fermées, fermetures orphelines), linéaire, borné (MAX_NODES, MAX_DEPTH).
 * Les sections CDATA sont conservées telles quelles ; le reste du texte est décodé.
 */
function parseXml(input) {
  const text = String(input ?? '');
  const root = { name: '#document', attrs: Object.create(null), children: [] };
  const stack = [root];
  const top = () => stack[stack.length - 1];
  let nodes = 0;
  let i = 0;
  while (i < text.length) {
    const lt = text.indexOf('<', i);
    if (lt === -1) {
      top().children.push(decodeEntities(text.slice(i)));
      break;
    }
    if (lt > i) top().children.push(decodeEntities(text.slice(i, lt)));
    if (text.startsWith('<!--', lt)) {
      const end = text.indexOf('-->', lt + 4);
      if (end === -1) break;
      i = end + 3;
      continue;
    }
    if (text.startsWith('<![CDATA[', lt)) {
      const end = text.indexOf(']]>', lt + 9);
      top().children.push(text.slice(lt + 9, end === -1 ? text.length : end));
      if (end === -1) break;
      i = end + 3;
      continue;
    }
    if (text.startsWith('<?', lt)) {
      const end = text.indexOf('?>', lt + 2);
      if (end === -1) break;
      i = end + 2;
      continue;
    }
    if (text.startsWith('<!', lt)) {
      // DOCTYPE (sous-ensemble interne compris) : ignoré, aucune entité n'est déclarée.
      let gt = text.indexOf('>', lt + 2);
      const bracket = text.indexOf('[', lt + 2);
      if (bracket !== -1 && gt !== -1 && bracket < gt) {
        const close = text.indexOf(']', bracket);
        gt = close === -1 ? -1 : text.indexOf('>', close);
      }
      if (gt === -1) break;
      i = gt + 1;
      continue;
    }
    const next = text[lt + 1];
    // « < » littéral dans du texte (document mal formé) : conservé comme texte.
    if (!next || !(next === '/' || /[A-Za-z_:]/.test(next))) {
      top().children.push('<');
      i = lt + 1;
      continue;
    }
    const gt = findTagEnd(text, lt + 1);
    if (gt === -1) break;
    const inner = text.slice(lt + 1, gt);
    i = gt + 1;
    if (inner[0] === '/') {
      const name = inner.slice(1).trim().toLowerCase();
      for (let k = stack.length - 1; k > 0; k -= 1) {
        if (stack[k].name === name) {
          stack.length = k;
          break;
        }
      }
      continue;
    }
    const selfClosing = inner.endsWith('/');
    const { name, attrs } = parseTag(selfClosing ? inner.slice(0, -1) : inner);
    if (!name) continue;
    nodes += 1;
    if (nodes > MAX_NODES) break;
    const el = { name, attrs, children: [] };
    top().children.push(el);
    if (!selfClosing && stack.length < MAX_DEPTH) stack.push(el);
  }
  return root;
}

const localName = (name) => {
  const c = name.indexOf(':');
  return c === -1 ? name : name.slice(c + 1);
};
const isElement = (n) => n && typeof n === 'object';
const elements = (el) => (el?.children ?? []).filter(isElement);

/** Premier enfant direct portant l'un des noms (nom complet « media:thumbnail » ou local « thumbnail »). */
function child(el, ...names) {
  for (const n of elements(el)) if (names.includes(n.name)) return n;
  return null;
}

/** Premier descendant (parcours en largeur, profondeur bornée) qui satisfait `pred`. */
function find(el, pred, maxDepth = 4) {
  let level = elements(el);
  for (let d = 0; d < maxDepth && level.length; d += 1) {
    for (const n of level) if (pred(n)) return n;
    level = level.flatMap(elements);
  }
  return null;
}

/** Texte d'un élément (texte + CDATA des descendants). Borné à 100 000 caractères. */
function textOf(el, max = 100_000) {
  if (!el) return '';
  let out = '';
  const walk = (node) => {
    for (const c of node.children) {
      if (out.length >= max) return;
      if (typeof c === 'string') out += c;
      else walk(c);
    }
  };
  walk(el);
  return out.slice(0, max);
}

// ---------------------------------------------------------------- texte

const BLOCK_TAGS = new Set(['p', 'br', 'div', 'li', 'ul', 'ol', 'tr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'pre', 'hr', 'section', 'article', 'figure', 'table']);

/**
 * HTML → texte brut : balises retirées (blocs → saut de ligne), script/style supprimés,
 * entités décodées, espaces normalisés, caractères de contrôle retirés. Linéaire. Pur.
 */
function htmlToText(html) {
  const s = String(html ?? '');
  const lower = s.toLowerCase();
  let out = '';
  let i = 0;
  while (i < s.length) {
    const lt = s.indexOf('<', i);
    if (lt === -1) {
      out += s.slice(i);
      break;
    }
    out += s.slice(i, lt);
    const next = s[lt + 1];
    if (!next || !(next === '/' || next === '!' || /[A-Za-z]/.test(next))) {
      out += '<';
      i = lt + 1;
      continue;
    }
    const gt = s.indexOf('>', lt + 1);
    if (gt === -1) {
      // « < » sans fin de balise : texte.
      out += s.slice(lt);
      break;
    }
    let j = lt + 1;
    if (s[j] === '/') j += 1;
    let k = j;
    while (k < gt && /[A-Za-z0-9]/.test(s[k])) k += 1;
    const tag = lower.slice(j, k);
    i = gt + 1;
    if ((tag === 'script' || tag === 'style') && s[lt + 1] !== '/') {
      const close = lower.indexOf(`</${tag}`, i);
      if (close === -1) break;
      const end = s.indexOf('>', close);
      i = end === -1 ? s.length : end + 1;
      continue;
    }
    if (BLOCK_TAGS.has(tag)) out += '\n';
  }
  return decodeEntities(out)
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f\u200b\u2028\u2029]/g, '')
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Texte sur une seule ligne (titres). Pur. */
function oneLine(text, max = 256) {
  const t = htmlToText(text).replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
}

/** Extrait d'au plus `max` caractères, coupé sur un mot. Pur. */
function excerpt(text, max = EXCERPT_MAX) {
  const t = String(text ?? '').trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max - 1);
  const space = cut.lastIndexOf(' ');
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/** Adresse http(s) valide et raisonnable, normalisée, ou null. Pur. */
function safeHttpUrl(value, base) {
  const raw = String(value ?? '').trim();
  if (!raw || raw.length > MAX_URL || /\s/.test(raw)) return null;
  try {
    const url = base ? new URL(raw, base) : new URL(raw);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    if (url.username || url.password) return null;
    const out = url.toString();
    return out.length <= MAX_URL ? out : null;
  } catch {
    return null;
  }
}

/** Première image (`<img src>`) d'un fragment HTML, ou null. Linéaire. */
function firstImgSrc(html) {
  const s = String(html ?? '');
  const lower = s.toLowerCase();
  let from = 0;
  for (let n = 0; n < 20; n += 1) {
    const at = lower.indexOf('<img', from);
    if (at === -1) return null;
    const gt = findTagEnd(s, at + 4);
    if (gt === -1) return null;
    const { attrs } = parseTag(s.slice(at + 1, gt).replace(/\/$/, ''));
    if (attrs.src) return attrs.src;
    from = gt + 1;
  }
  return null;
}

// ---------------------------------------------------------------- flux

function parseDate(value) {
  const t = Date.parse(String(value ?? '').trim());
  return Number.isFinite(t) ? t : null;
}

const imageType = (t) => /^image\//i.test(String(t ?? ''));

/** Image d'un article : media:thumbnail, media:content (image), enclosure image, itunes:image, puis <img> de la description. */
function imageOf(entry, html, base) {
  const thumb = find(entry, (n) => (n.name === 'media:thumbnail' || localName(n.name) === 'thumbnail') && n.attrs.url, 3);
  const media = find(entry, (n) => (n.name === 'media:content' || localName(n.name) === 'content') && n.attrs.url && (n.attrs.medium === 'image' || imageType(n.attrs.type)), 3);
  const enclosure = elements(entry).find((n) => n.name === 'enclosure' && n.attrs.url && imageType(n.attrs.type));
  const itunes = child(entry, 'itunes:image');
  const candidates = [thumb?.attrs.url, media?.attrs.url, enclosure?.attrs.url, itunes?.attrs.href, firstImgSrc(html)];
  for (const c of candidates) {
    const url = safeHttpUrl(c, base);
    if (url) return url;
  }
  return null;
}

/** Lien d'une entrée Atom : rel="alternate" (ou sans rel) d'abord. */
function atomLink(el, base) {
  const links = elements(el).filter((n) => n.name === 'link' && n.attrs.href);
  const best = links.find((l) => !l.attrs.rel || l.attrs.rel === 'alternate') ?? links[0];
  return best ? safeHttpUrl(best.attrs.href, base) : null;
}

function rssItem(item, base) {
  const html = textOf(child(item, 'content:encoded')) || textOf(child(item, 'description')) || textOf(child(item, 'summary')) || textOf(find(item, (n) => n.name === 'media:description', 2));
  const guidEl = child(item, 'guid');
  const guid = textOf(guidEl).trim();
  let link = safeHttpUrl(textOf(child(item, 'link')).trim(), base);
  if (!link && guid && guidEl.attrs.ispermalink !== 'false') link = safeHttpUrl(guid, base);
  if (!link) link = atomLink(item, base);
  const title = oneLine(textOf(child(item, 'title')));
  const date = parseDate(textOf(child(item, 'pubdate', 'dc:date', 'published', 'updated')));
  return { id: guid || link || (title ? `${title}|${date ?? ''}` : null), title, link, date, summary: excerpt(htmlToText(html)), image: imageOf(item, html, base) };
}

function atomEntry(entry, base) {
  const group = child(entry, 'media:group');
  const html = textOf(child(entry, 'summary')) || textOf(child(entry, 'content')) || textOf(child(group, 'media:description')) || textOf(child(entry, 'media:description'));
  const link = atomLink(entry, base);
  const title = oneLine(textOf(child(entry, 'title')));
  const date = parseDate(textOf(child(entry, 'published')) || textOf(child(entry, 'updated')));
  const id = textOf(child(entry, 'id')).trim();
  return { id: id || link || (title ? `${title}|${date ?? ''}` : null), title, link, date, summary: excerpt(htmlToText(html)), image: imageOf(entry, html, base) };
}

/**
 * Analyse un document RSS 2.0, RSS 1.0 (RDF) ou Atom.
 * @param {string} xml
 * @param {{ baseUrl?: string }} [opts] adresse du flux (liens relatifs)
 * @returns {{ format: 'rss'|'atom', title: string, link: string|null, items: Array<{ id: string, title: string, link: string|null, date: number|null, summary: string, image: string|null }> }}
 */
function parseFeed(xml, { baseUrl } = {}) {
  const doc = parseXml(xml);
  const top = find(doc, (n) => n.name === 'rss' || n.name === 'rdf:rdf' || n.name === 'feed', 2);
  if (!top) throw new FeedError('ce document n\'est pas un flux RSS ou Atom');
  let format;
  let title;
  let link;
  let raw;
  if (top.name === 'feed') {
    format = 'atom';
    title = oneLine(textOf(child(top, 'title')));
    link = atomLink(top, baseUrl);
    raw = elements(top).filter((n) => n.name === 'entry').slice(0, 500).map((e) => atomEntry(e, baseUrl));
  } else {
    format = 'rss';
    const channel = child(top, 'channel');
    title = oneLine(textOf(child(channel, 'title')));
    link = safeHttpUrl(textOf(child(channel, 'link')).trim(), baseUrl) ?? atomLink(channel, baseUrl);
    // RSS 2.0 : channel > item ; RSS 1.0 : les items sont frères du channel.
    const list = [...elements(channel).filter((n) => n.name === 'item'), ...elements(top).filter((n) => n.name === 'item')];
    raw = list.slice(0, 500).map((e) => rssItem(e, baseUrl));
  }
  const seen = new Set();
  let items = raw.filter((it) => {
    if (!it.id) return false;
    it.id = it.id.slice(0, 500);
    if (seen.has(it.id)) return false;
    seen.add(it.id);
    return true;
  });
  // Plus récents d'abord quand les dates le permettent (certains flux sont du plus ancien au plus récent).
  if (items.length > 1 && items.filter((it) => it.date != null).length >= items.length / 2) {
    items = items.map((it, k) => ({ it, k })).sort((a, b) => (b.it.date ?? -Infinity) - (a.it.date ?? -Infinity) || a.k - b.k).map((x) => x.it);
  }
  return { format, title: title || 'Flux sans titre', link, items: items.slice(0, MAX_ITEMS) };
}

/** Correspondance d'un filtre (mot ou expression, sans accents ni casse) avec un article. Pur. */
function matchesFilter(item, filter) {
  const f = fold(filter);
  if (!f) return true;
  return fold(`${item.title ?? ''} ${item.summary ?? ''}`).includes(f);
}

function fold(text) {
  return String(text ?? '').normalize('NFD').replace(/\p{M}+/gu, '').toLowerCase().replace(/\s+/g, ' ').trim();
}

// ---------------------------------------------------------------- adresses

const ytChannelFeed = (id) => `https://www.youtube.com/feeds/videos.xml?channel_id=${id}`;

/**
 * Adresse saisie → adresse du flux. YouTube : youtube.com/channel/UC…, l'identifiant UC… seul,
 * ou feeds/videos.xml?channel_id= / playlist_id= (les @pseudos ne sont pas résolvables sans
 * requête supplémentaire). Lève une FeedError sinon. Pur.
 * @returns {{ url: string, youtube: boolean }}
 */
function normalizeFeedUrl(input) {
  let raw = String(input ?? '').trim();
  if (!raw) throw new FeedError('indiquez l\'adresse du flux');
  if (raw.length > 500 || /\s/.test(raw)) throw new FeedError('adresse invalide (500 caractères maximum, sans espace)');
  if (YT_CHANNEL_ID.test(raw)) return { url: ytChannelFeed(raw), youtube: true };
  if (!/^[a-z][a-z0-9+.-]{0,15}:\/\//i.test(raw)) raw = `https://${raw}`;
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new FeedError('adresse invalide');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new FeedError('seules les adresses `http://` et `https://` sont acceptées');
  if (url.username || url.password) throw new FeedError('une adresse avec identifiant ou mot de passe n\'est pas acceptée');
  const host = url.hostname.toLowerCase().replace(/^(www|m)\./, '');
  if (host === 'youtube.com' || host === 'youtu.be') {
    const channel = /^\/channel\/(UC[\w-]{22})(?:\/|$)/.exec(url.pathname);
    if (channel) return { url: ytChannelFeed(channel[1]), youtube: true };
    if (url.pathname === '/feeds/videos.xml') {
      const id = url.searchParams.get('channel_id');
      if (id && YT_CHANNEL_ID.test(id)) return { url: ytChannelFeed(id), youtube: true };
      const list = url.searchParams.get('playlist_id');
      if (list && YT_PLAYLIST_ID.test(list)) return { url: `https://www.youtube.com/feeds/videos.xml?playlist_id=${list}`, youtube: true };
    }
    if (/^\/(@|c\/|user\/)/.test(url.pathname)) {
      throw new FeedError('les adresses YouTube en @pseudo ne peuvent pas être suivies : indiquez l\'identifiant de la chaîne (`UC…`, YouTube → la chaîne → « À propos » → « Partager la chaîne » → « Copier l\'ID de la chaîne ») ou `youtube.com/channel/UC…`');
    }
    throw new FeedError('adresse YouTube non reconnue : utilisez `youtube.com/channel/UC…` ou l\'identifiant `UC…` de la chaîne');
  }
  url.hash = '';
  return { url: url.toString(), youtube: false };
}

/** Vrai pour un flux de vidéos YouTube. Pur. */
function isYoutubeFeed(url) {
  return /^https:\/\/www\.youtube\.com\/feeds\/videos\.xml\?/.test(String(url ?? ''));
}

/** Jeu de caractères d'un document : en-tête HTTP, BOM, puis déclaration XML. Pur. */
function decodeBody(buffer, contentType) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer ?? '');
  let charset = /charset\s*=\s*["']?([\w.:-]{1,40})/i.exec(String(contentType ?? ''))?.[1];
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) charset = 'utf-8';
  else if (buf[0] === 0xff && buf[1] === 0xfe) charset = 'utf-16le';
  else if (buf[0] === 0xfe && buf[1] === 0xff) charset = 'utf-16be';
  if (!charset) {
    const head = buf.subarray(0, 256).toString('latin1');
    charset = /<\?xml[^>]{0,200}encoding\s*=\s*["']([\w.:-]{1,40})["']/i.exec(head)?.[1];
  }
  try {
    return new TextDecoder(charset || 'utf-8').decode(buf);
  } catch {
    return new TextDecoder('utf-8').decode(buf);
  }
}

module.exports = {
  FeedError,
  MAX_ITEMS,
  EXCERPT_MAX,
  decodeEntities,
  parseXml,
  htmlToText,
  oneLine,
  excerpt,
  safeHttpUrl,
  parseFeed,
  matchesFilter,
  normalizeFeedUrl,
  isYoutubeFeed,
  decodeBody,
  fold,
};
