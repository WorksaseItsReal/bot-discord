'use strict';

const { AsyncLocalStorage } = require('node:async_hooks');
const { DiscordAPIError, PermissionFlagsBits: P } = require('discord.js');
const { nextId, DAY } = require('./ids');
const L = require('./limits');

/**
 * « Faux Discord » : remplace `client.rest.request` (toutes les requêtes REST de
 * discord.js passent par là) et simule l'API — état du serveur, réponses JSON
 * plausibles, erreurs Discord réelles (DiscordAPIError) — puis renvoie, comme la
 * vraie passerelle, les événements qui suivent une modification (MESSAGE_CREATE,
 * GUILD_MEMBER_UPDATE, GUILD_AUDIT_LOG_ENTRY_CREATE…).
 *
 * Chaque requête est enregistrée (`calls`) ; tout corps hors limites Discord est
 * consigné dans `violations` puis rejeté avec l'erreur que Discord renverrait.
 */

const INTERACTION_CALLBACK = {
  4: 'ChannelMessageWithSource',
  5: 'DeferredChannelMessageWithSource',
  6: 'DeferredMessageUpdate',
  7: 'UpdateMessage',
  8: 'ApplicationCommandAutocompleteResult',
  9: 'Modal',
};
/** Scénario à l'origine d'une requête (suit les continuations asynchrones du bot). */
const scenario = new AsyncLocalStorage();
const EPHEMERAL = 1 << 6;
const LOADING = 1 << 7;
const MAX_TIMEOUT_MS = 28 * DAY;

/** Copie JSON (applique les toJSON des builders, comme l'envoi réel). */
function json(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function compileRoute(pattern) {
  const keys = [];
  const re = new RegExp(`^${pattern.replace(/:(\w+)/g, (_, k) => (keys.push(k), '([^/]+)'))}$`);
  return { re, keys };
}

class FakeDiscord {
  /**
   * @param {{ client: import('discord.js').Client, guild: object, users: Record<string, object>, botUser: object }} opts
   */
  constructor({ client, guild, users, botUser }) {
    this.client = client;
    this.botUser = botUser;
    this.guildId = guild.id;
    /** Requêtes reçues : { method, route, body, files, query, reason, label, status } */
    this.calls = [];
    /** Corps hors limites / appels interdits : { method, route, problems, label } */
    this.violations = [];
    /** Textes suspects envoyés (« undefined », « [object Object] », mention vide…). */
    this.suspicious = [];
    /** Routes non simulées (réponse par défaut) : à compléter dans le harnais. */
    this.unmocked = [];
    /** Erreurs injectées : { match(call) → bool, status, code, message, times } */
    this.injections = [];
    /** Étiquette du scénario en cours (pour attribuer les violations). */
    this.label = '';
    /** Événements de passerelle en attente d'émission (setImmediate). */
    this.pendingDispatch = 0;
    /** Requêtes REST en cours (latence simulée). */
    this.inflight = 0;
    this.echo = true;
    /** Vérifie les permissions du bot (calculées par discord.js) avant chaque requête. */
    this.enforcePermissions = true;
    /** Latence simulée de chaque requête (ms) : révèle courses et acquittements trop tardifs. */
    this.latency = 0;

    const { members, channels, roles, threads: _threads, ...guildRest } = json(guild);
    this.guild = guildRest;
    this.users = new Map(Object.values(users).map((u) => [u.id, json(u)]));
    this.channels = new Map([...channels, ...(guild.threads ?? [])].map((c) => [c.id, { ...c, guild_id: guild.id }]));
    this.roles = new Map(roles.map((r) => [r.id, r]));
    this.members = new Map(members.map((m) => [m.user.id, m]));
    this.messages = new Map();
    /** Identifiants des messages dans l'ordre de création. */
    this.messageLog = [];
    this.bans = new Map();
    this.dms = new Map();
    this.webhooks = new Map();
    this.autoModRules = new Map();
    this.auditLog = [];
    this.voiceStates = new Map();
    this.interactions = new Map();
    this.commands = [];
    this.routes = [];
    this.#defineRoutes();
  }

  /* ------------------------------------------------------------------ */
  /* Infrastructure                                                       */
  /* ------------------------------------------------------------------ */

  /** Installé à la place de `client.rest.request`. */
  async request(options) {
    this.inflight += 1;
    try {
      return await this.#request(options);
    } finally {
      this.inflight -= 1;
    }
  }

  async #request(options) {
    const method = String(options.method).toUpperCase();
    const route = options.fullRoute;
    const call = {
      method,
      route,
      body: json(options.body),
      files: (options.files ?? []).map((f) => ({ name: f.name, size: f.data?.length ?? 0, contentType: f.contentType })),
      query: options.query ? Object.fromEntries(new URLSearchParams(options.query.toString())) : {},
      reason: options.reason ?? null,
      label: scenario.getStore() ?? this.label,
      status: 200,
    };
    this.calls.push(call);

    if (call.reason && [...call.reason].length > L.MAX.auditReason) {
      this.#violate(call, [`X-Audit-Log-Reason : ${[...call.reason].length} > ${L.MAX.auditReason}`]);
    }

    if (this.latency) await new Promise((r) => setTimeout(r, this.latency));
    if (this.enforcePermissions) this.#checkPermissions(call);

    if (call.body && method !== 'GET') {
      const found = L.findSuspiciousText(call.body);
      if (found.length) this.suspicious.push({ method, route, problems: found, label: call.label });
    }

    const injected = this.injections.find((inj) => inj.times > 0 && inj.match(call));
    if (injected) {
      injected.times -= 1;
      if (injected.status === 429) {
        // Comme @discordjs/rest : attente de retry_after puis nouvel essai (invisible du bot).
        await new Promise((r) => setTimeout(r, injected.retryAfter ?? 5));
      } else {
        call.status = injected.status;
        throw this.#error(call, injected.status, injected.code, injected.message ?? `Erreur injectée ${injected.code}`);
      }
    }

    for (const r of this.routes) {
      if (r.method !== method) continue;
      const m = r.re.exec(route);
      if (!m) continue;
      const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
      try {
        const out = await r.handler(params, call);
        return json(out);
      } catch (err) {
        if (err instanceof DiscordAPIError) call.status = err.status;
        throw err;
      }
    }
    this.unmocked.push(`${method} ${route}`);
    return method === 'GET' ? [] : undefined;
  }

  /**
   * Injecte une erreur Discord pour les prochaines requêtes correspondantes.
   * @param {{ method?: string, route?: RegExp|string, match?: (call) => boolean }} matcher
   * @param {{ status?: number, code?: number, message?: string, times?: number, retryAfter?: number }} error
   */
  inject(matcher, { status = 403, code = 50013, message, times = 1, retryAfter } = {}) {
    const match = matcher.match
      ?? ((c) => (!matcher.method || c.method === matcher.method.toUpperCase())
        && (!matcher.route || (matcher.route instanceof RegExp ? matcher.route.test(c.route) : c.route === matcher.route)));
    this.injections.push({ match, status, code, message, times, retryAfter });
  }

  #route(method, pattern, handler) {
    this.routes.push({ method, ...compileRoute(pattern), handler: handler.bind(this) });
  }

  #error(call, status, code, message, errors) {
    const raw = { code, message, ...(errors ? { errors } : {}) };
    return new DiscordAPIError(raw, code, status, call.method, `https://discord.com/api/v10${call.route}`, { body: call.body, files: call.files });
  }

  #violate(call, problems, { code = 50035, status = 400, message = 'Invalid Form Body', throwError = true } = {}) {
    if (!problems.length) return;
    this.violations.push({ method: call.method, route: call.route, problems, label: call.label });
    if (throwError) throw this.#error(call, status, code, `${message}\n${problems.join('\n')}`);
  }

  /** Émet un événement de passerelle, de façon asynchrone comme la vraie connexion. */
  dispatch(t, d) {
    if (!this.echo) return;
    this.pendingDispatch += 1;
    const label = scenario.getStore() ?? this.label;
    setImmediate(() => {
      this.pendingDispatch -= 1;
      this.dispatchNow(t, d, label);
    });
  }

  dispatchNow(t, d, label = scenario.getStore() ?? this.label) {
    const ws = this.client.ws;
    scenario.run(label, () => ws.handlePacket({ op: 0, t, d: json(d), s: null }, ws.shards.get(0)));
  }

  #audit(actionType, targetId, call, changes = [], options = undefined) {
    const entry = {
      id: nextId(),
      action_type: actionType,
      target_id: targetId ?? null,
      user_id: this.botUser.id,
      reason: call?.reason ?? undefined,
      changes,
      ...(options ? { options } : {}),
    };
    this.auditLog.unshift(entry);
    this.dispatch('GUILD_AUDIT_LOG_ENTRY_CREATE', { ...entry, guild_id: this.guildId });
    return entry;
  }

  /* ------------------------------------------------------------------ */
  /* Construction d'objets bruts                                         */
  /* ------------------------------------------------------------------ */

  channel(id, call) {
    const ch = this.channels.get(id) ?? this.dms.get(id);
    if (!ch) throw this.#error(call, 404, 10003, 'Unknown Channel');
    return ch;
  }

  member(userId, call) {
    const m = this.members.get(userId);
    if (!m) throw this.#error(call, 404, 10007, 'Unknown Member');
    return m;
  }

  memberWithGuild(m) {
    return { ...m, guild_id: this.guildId };
  }

  /** Normalise un objet message comme l'API (embeds « rich », composants tels quels). */
  buildMessage({ channelId, body = {}, files = [], author = this.botUser, flags = 0, type = 0, extra = {} }) {
    const ch = this.channels.get(channelId) ?? this.dms.get(channelId);
    const id = nextId();
    const attachments = files.map((f, i) => ({
      id: nextId(),
      filename: f.name ?? `file${i}`,
      size: f.size ?? 0,
      url: `https://cdn.discordapp.com/attachments/${channelId}/${id}/${f.name ?? `file${i}`}`,
      proxy_url: `https://media.discordapp.net/attachments/${channelId}/${id}/${f.name ?? `file${i}`}`,
      content_type: f.contentType ?? 'application/octet-stream',
    }));
    const msg = {
      id,
      type,
      channel_id: channelId,
      ...(ch?.guild_id ? { guild_id: ch.guild_id } : {}),
      author,
      content: body.content ?? '',
      timestamp: new Date().toISOString(),
      edited_timestamp: null,
      tts: false,
      mention_everyone: false,
      mentions: [],
      mention_roles: [],
      attachments,
      embeds: (body.embeds ?? []).map((e) => ({ type: 'rich', ...e })),
      components: body.components ?? [],
      reactions: [],
      pinned: false,
      flags: (body.flags ?? 0) | flags,
      ...(body.poll ? { poll: { ...body.poll, results: { is_finalized: false, answer_counts: [] }, expiry: new Date(Date.now() + 86400000).toISOString() } } : {}),
      ...(body.message_reference ? { message_reference: body.message_reference } : {}),
      ...extra,
    };
    this.messages.set(id, msg);
    this.messageLog.push(id);
    if (ch) ch.last_message_id = id;
    return msg;
  }

  applyMessageEdit(msg, body = {}, files = []) {
    for (const key of ['content', 'components', 'flags', 'allowed_mentions']) if (key in body) msg[key] = body[key] ?? (key === 'content' ? '' : key === 'flags' ? 0 : []);
    if ('embeds' in body) msg.embeds = (body.embeds ?? []).map((e) => ({ type: 'rich', ...e }));
    if ('attachments' in body || files.length) {
      const kept = (body.attachments ?? []).filter((a) => msg.attachments.some((x) => x.id === a.id));
      msg.attachments = [...msg.attachments.filter((a) => kept.some((k) => k.id === a.id)), ...files.map((f) => ({ id: nextId(), filename: f.name, size: f.size ?? 0, url: `https://cdn.discordapp.com/attachments/${msg.channel_id}/${msg.id}/${f.name}`, proxy_url: '', content_type: f.contentType ?? 'application/octet-stream' }))];
    }
    msg.flags &= ~LOADING;
    msg.edited_timestamp = new Date().toISOString();
    delete msg.allowed_mentions;
    return msg;
  }

  #echoMessage(msg, kind) {
    if (msg.flags & EPHEMERAL) return;
    const member = msg.guild_id && this.members.get(msg.author.id);
    const channelType = (this.channels.get(msg.channel_id) ?? this.dms.get(msg.channel_id))?.type;
    this.dispatch(kind, { ...msg, channel_type: channelType, ...(member ? { member: { ...member, user: undefined } } : {}) });
  }

  #validateMessage(call, body, opts) {
    this.#violate(call, L.validateMessageBody(body, { files: call.files, ...opts }), { code: opts?.empty ? 50006 : 50035 });
  }

  /* ------------------------------------------------------------------ */
  /* Interactions                                                         */
  /* ------------------------------------------------------------------ */

  registerInteraction(raw, extra = {}) {
    const rec = {
      id: raw.id,
      token: raw.token,
      type: raw.type,
      raw,
      channelId: raw.channel_id,
      componentMessageId: raw.message?.id ?? null,
      ackType: null,
      original: null,
      modals: [],
      followUps: [],
      messages: [],
      autocomplete: null,
      createdAt: Date.now(),
      /** Position dans messageLog au moment de l'interaction (messages créés depuis). */
      msgMark: this.messageLog.length,
      ...extra,
    };
    this.interactions.set(raw.token, rec);
    return rec;
  }

  #interaction(call, token) {
    const rec = this.interactions.get(token);
    if (!rec) throw this.#error(call, 404, 10015, 'Unknown Webhook');
    return rec;
  }

  #interactionMeta(rec) {
    return {
      interaction_metadata: {
        id: rec.id,
        type: rec.type,
        user: rec.raw.member?.user ?? rec.raw.user,
        authorizing_integration_owners: { 0: this.guildId },
      },
      application_id: this.botUser.id,
      webhook_id: this.botUser.id,
    };
  }

  #callback({ id, token }, call) {
    const rec = this.interactions.get(token);
    if (!rec || rec.id !== id) throw this.#error(call, 404, 10062, 'Unknown interaction');
    const { type, data = {} } = call.body ?? {};
    if (rec.ackType != null) {
      this.#violate(call, [`interaction déjà acquittée (${INTERACTION_CALLBACK[rec.ackType]}) puis ${INTERACTION_CALLBACK[type]}`], { status: 400, code: 40060, message: 'Interaction has already been acknowledged.' });
    }
    const isComponent = rec.type === 3 || (rec.type === 5 && rec.componentMessageId);
    let message = null;
    switch (type) {
      case 4: {
        if (rec.type === 4) this.#violate(call, ['réponse message à une autocomplétion']);
        this.#validateMessage(call, data, {});
        message = this.buildMessage({ channelId: rec.channelId, body: data, files: call.files, type: rec.type === 2 ? 20 : 0, extra: this.#interactionMeta(rec) });
        rec.original = message.id;
        this.#echoMessage(message, 'MESSAGE_CREATE');
        break;
      }
      case 5: {
        if (rec.type === 4) this.#violate(call, ['réponse différée à une autocomplétion']);
        message = this.buildMessage({ channelId: rec.channelId, body: {}, flags: LOADING | ((data.flags ?? 0) & EPHEMERAL), type: rec.type === 2 ? 20 : 0, extra: this.#interactionMeta(rec) });
        rec.original = message.id;
        break;
      }
      case 6:
      case 7: {
        if (!isComponent) this.#violate(call, [`${INTERACTION_CALLBACK[type]} impossible : interaction sans message de composant`]);
        const msg = this.messages.get(rec.componentMessageId);
        if (!msg) throw this.#error(call, 404, 10008, 'Unknown Message');
        if (type === 7) {
          this.#validateMessage(call, data, { partial: true, existing: msg });
          this.applyMessageEdit(msg, data, call.files);
          this.#echoMessage(msg, 'MESSAGE_UPDATE');
        }
        rec.original = msg.id;
        message = msg;
        break;
      }
      case 8: {
        if (rec.type !== 4) this.#violate(call, ['résultat d\'autocomplétion hors autocomplétion']);
        this.#violate(call, L.validateAutocomplete(data));
        rec.autocomplete = data.choices ?? [];
        break;
      }
      case 9: {
        if (rec.type === 5 || rec.type === 4) this.#violate(call, ['formulaire en réponse à un formulaire ou une autocomplétion']);
        this.#violate(call, L.validateModal(data));
        rec.modals.push(data);
        break;
      }
      default:
        this.#violate(call, [`type de réponse inconnu ${type}`]);
    }
    rec.ackType = type;
    rec.ackedAt = Date.now();
    if (message) rec.messages.push(message.id);
    if (call.query.with_response !== 'true') return undefined;
    return {
      interaction: {
        id: rec.id,
        type: rec.type,
        response_message_id: message?.id,
        response_message_loading: Boolean(message && message.flags & LOADING),
        response_message_ephemeral: Boolean(message && message.flags & EPHEMERAL),
      },
      resource: message ? { type, message } : { type },
    };
  }

  #webhookMessageId(rec, messageId, call) {
    const id = messageId === '@original' ? rec.original : messageId;
    const msg = id && this.messages.get(id);
    if (!msg) throw this.#error(call, 404, 10008, 'Unknown Message');
    // Par jeton d'interaction : seuls les messages de l'application, et un message
    // éphémère uniquement via l'interaction qui l'a créé (ou son composant).
    const own = id === rec.original || id === rec.componentMessageId || rec.messages.includes(id) || rec.followUps.includes(id);
    if (!own && (!msg.interaction_metadata || (msg.flags & EPHEMERAL && !this.#sameEphemeralChain(rec, msg)))) {
      throw this.#error(call, 404, 10008, 'Unknown Message');
    }
    return msg;
  }

  /** Un message éphémère reste modifiable par les interactions de ses propres composants. */
  #sameEphemeralChain(rec, msg) {
    return msg.interaction_metadata?.user?.id === (rec.raw.member?.user?.id ?? rec.raw.user?.id) && rec.componentMessageId === msg.id;
  }

  /* ------------------------------------------------------------------ */
  /* Routes                                                               */
  /* ------------------------------------------------------------------ */

  #defineRoutes() {
    const r = this.#route.bind(this);
    const gid = () => this.guildId;

    // --- Interactions --------------------------------------------------
    r('POST', '/interactions/:id/:token/callback', (p, call) => this.#callback(p, call));
    r('POST', '/webhooks/:app/:token', (p, call) => {
      if (this.webhooks.has(p.app)) return this.#executeWebhook(p, call);
      const rec = this.#interaction(call, p.token);
      if (rec.ackType == null || rec.ackType === 8 || rec.ackType === 9) {
        this.#violate(call, ['suivi (followUp) envoyé avant tout acquittement de l\'interaction'], { status: 404, code: 10015, message: 'Unknown Webhook' });
      }
      this.#validateMessage(call, call.body, {});
      const original = rec.original && this.messages.get(rec.original);
      // Premier suivi après un deferReply : Discord remplace le message « réfléchit… ».
      if (original && original.flags & LOADING && rec.ackType === 5) {
        // Le drapeau Ephemeral du suivi est alors ignoré : la visibilité est celle du deferReply.
        const wanted = Boolean((call.body?.flags ?? 0) & EPHEMERAL);
        if (wanted !== Boolean(original.flags & EPHEMERAL)) {
          this.#violate(call, [wanted ? 'suivi éphémère rendu PUBLIC (il remplace le « réfléchit… » d\'un deferReply public)' : 'suivi public rendu éphémère (il remplace le « réfléchit… » d\'un deferReply éphémère)'], { throwError: false });
        }
        this.applyMessageEdit(original, { ...call.body, flags: (original.flags & EPHEMERAL) | (call.body.flags ?? 0) & ~EPHEMERAL }, call.files);
        this.#echoMessage(original, 'MESSAGE_CREATE');
        rec.followUps.push(original.id);
        return original;
      }
      const msg = this.buildMessage({ channelId: rec.channelId, body: call.body, files: call.files, extra: this.#interactionMeta(rec) });
      rec.followUps.push(msg.id);
      rec.messages.push(msg.id);
      this.#echoMessage(msg, 'MESSAGE_CREATE');
      return msg;
    });
    r('GET', '/webhooks/:app/:token/messages/:message', (p, call) => {
      const rec = this.#interaction(call, p.token);
      return this.#webhookMessageId(rec, p.message, call);
    });
    r('PATCH', '/webhooks/:app/:token/messages/:message', (p, call) => {
      const rec = this.#interaction(call, p.token);
      if (rec.ackType == null || rec.ackType === 8 || rec.ackType === 9) this.#violate(call, ['édition de la réponse avant tout acquittement'], { status: 404, code: 10015, message: 'Unknown Webhook' });
      const msg = this.#webhookMessageId(rec, p.message, call);
      this.#validateMessage(call, call.body, { partial: true, existing: msg.flags & LOADING ? null : msg });
      if (msg.flags & LOADING) {
        // Édition d'une réponse différée : le résultat ne doit pas être vide.
        this.#violate(call, L.validateMessageBody({ ...call.body }, { files: call.files }).filter((x) => x.startsWith('message vide')), { code: 50006 });
      }
      this.applyMessageEdit(msg, call.body, call.files);
      this.#echoMessage(msg, 'MESSAGE_UPDATE');
      return msg;
    });
    r('DELETE', '/webhooks/:app/:token/messages/:message', (p, call) => {
      const rec = this.#interaction(call, p.token);
      const msg = this.#webhookMessageId(rec, p.message, call);
      this.#deleteMessage(msg);
    });

    // --- Salons et messages --------------------------------------------
    r('GET', '/channels/:channel', (p, call) => this.channel(p.channel, call));
    r('PATCH', '/channels/:channel', (p, call) => {
      const ch = this.channel(p.channel, call);
      const b = call.body ?? {};
      const problems = [];
      if (b.name != null && ([...b.name].length < 1 || [...b.name].length > L.MAX.channelName)) problems.push(`name : ${[...b.name].length} caractères`);
      if (b.topic != null && [...b.topic].length > L.MAX.topic) problems.push(`topic : ${[...b.topic].length} > 1024`);
      if (b.rate_limit_per_user != null && (b.rate_limit_per_user < 0 || b.rate_limit_per_user > 21600)) problems.push(`rate_limit_per_user hors bornes (${b.rate_limit_per_user})`);
      if (b.user_limit != null && (b.user_limit < 0 || b.user_limit > 99)) problems.push(`user_limit hors bornes (${b.user_limit})`);
      if (b.bitrate != null && (b.bitrate < 8000 || b.bitrate > 384000)) problems.push(`bitrate hors bornes (${b.bitrate})`);
      problems.push(...this.#checkOverwrites(b.permission_overwrites));
      this.#violate(call, problems);
      Object.assign(ch, b);
      if (b.permission_overwrites) ch.permission_overwrites = b.permission_overwrites.map((o) => ({ ...o, allow: String(o.allow ?? '0'), deny: String(o.deny ?? '0') }));
      this.dispatch('CHANNEL_UPDATE', ch);
      this.#audit(11, ch.id, call);
      return ch;
    });
    r('DELETE', '/channels/:channel', (p, call) => {
      const ch = this.channel(p.channel, call);
      this.channels.delete(ch.id);
      this.dispatch('CHANNEL_DELETE', ch);
      this.#audit(12, ch.id, call);
      return ch;
    });
    r('PUT', '/channels/:channel/permissions/:overwrite', (p, call) => {
      const ch = this.channel(p.channel, call);
      const b = call.body ?? {};
      this.#violate(call, this.#checkOverwrites([{ id: p.overwrite, ...b }]));
      ch.permission_overwrites = ch.permission_overwrites.filter((o) => o.id !== p.overwrite);
      ch.permission_overwrites.push({ id: p.overwrite, type: b.type ?? 0, allow: String(b.allow ?? '0'), deny: String(b.deny ?? '0') });
      this.dispatch('CHANNEL_UPDATE', ch);
    });
    r('DELETE', '/channels/:channel/permissions/:overwrite', (p, call) => {
      const ch = this.channel(p.channel, call);
      ch.permission_overwrites = ch.permission_overwrites.filter((o) => o.id !== p.overwrite);
      this.dispatch('CHANNEL_UPDATE', ch);
    });
    r('GET', '/channels/:channel/messages', (p, call) => {
      this.channel(p.channel, call);
      const limit = Math.min(Number(call.query.limit ?? 50), 100);
      if (limit < 1) this.#violate(call, ['limit < 1']);
      let list = [...this.messages.values()].filter((m) => m.channel_id === p.channel && !(m.flags & EPHEMERAL)).sort((a, b) => (BigInt(b.id) > BigInt(a.id) ? 1 : -1));
      if (call.query.before) list = list.filter((m) => BigInt(m.id) < BigInt(call.query.before));
      if (call.query.after) list = list.filter((m) => BigInt(m.id) > BigInt(call.query.after));
      return list.slice(0, limit);
    });
    r('GET', '/channels/:channel/messages/:message', (p, call) => {
      this.channel(p.channel, call);
      const msg = this.messages.get(p.message);
      if (!msg || msg.channel_id !== p.channel || msg.flags & EPHEMERAL) throw this.#error(call, 404, 10008, 'Unknown Message');
      return msg;
    });
    r('POST', '/channels/:channel/messages', (p, call) => {
      const ch = this.channel(p.channel, call);
      if (ch.type === 4 || ch.type === 15) this.#violate(call, [`envoi de message dans un salon de type ${ch.type}`], { code: 50008, message: 'Cannot send messages in a non-text channel' });
      if ((call.body?.flags ?? 0) & EPHEMERAL) this.#violate(call, ['flag Ephemeral sur un message de salon']);
      this.#validateMessage(call, call.body, {});
      const msg = this.buildMessage({ channelId: ch.id, body: call.body, files: call.files, type: call.body?.message_reference ? 19 : 0 });
      this.#echoMessage(msg, 'MESSAGE_CREATE');
      return msg;
    });
    r('PATCH', '/channels/:channel/messages/:message', (p, call) => {
      this.channel(p.channel, call);
      const msg = this.messages.get(p.message);
      if (!msg || msg.channel_id !== p.channel || msg.flags & EPHEMERAL) throw this.#error(call, 404, 10008, 'Unknown Message');
      if (msg.author.id !== this.botUser.id) {
        const onlyFlags = Object.keys(call.body ?? {}).every((k) => k === 'flags');
        if (!onlyFlags) this.#violate(call, ['édition du message d\'un autre utilisateur'], { status: 403, code: 50005, message: 'Cannot edit a message authored by another user' });
      }
      this.#validateMessage(call, call.body, { partial: true, existing: msg });
      this.applyMessageEdit(msg, call.body, call.files);
      this.#echoMessage(msg, 'MESSAGE_UPDATE');
      return msg;
    });
    r('DELETE', '/channels/:channel/messages/:message', (p, call) => {
      this.channel(p.channel, call);
      const msg = this.messages.get(p.message);
      if (!msg || msg.channel_id !== p.channel || msg.flags & EPHEMERAL) throw this.#error(call, 404, 10008, 'Unknown Message');
      if (msg.author.id !== this.botUser.id) this.#audit(72, msg.author.id, call, [], { channel_id: msg.channel_id, count: '1' });
      this.#deleteMessage(msg);
    });
    r('POST', '/channels/:channel/messages/bulk-delete', (p, call) => {
      this.channel(p.channel, call);
      const ids = call.body?.messages ?? [];
      const problems = [];
      if (ids.length < 2 || ids.length > 100) problems.push(`bulk-delete : ${ids.length} messages (2 à 100)`);
      if (new Set(ids).size !== ids.length) problems.push('bulk-delete : identifiants en double');
      const old = ids.filter((id) => Number((BigInt(id) >> 22n) + 1420070400000n) < Date.now() - 14 * DAY);
      if (old.length) problems.push(`bulk-delete : ${old.length} message(s) de plus de 14 jours`);
      this.#violate(call, problems, { code: problems.some((x) => x.includes('14 jours')) ? 50034 : 50035 });
      for (const id of ids) this.messages.delete(id);
      this.dispatch('MESSAGE_DELETE_BULK', { ids, channel_id: p.channel, guild_id: this.guildId });
    });
    r('PUT', '/channels/:channel/messages/:message/reactions/:emoji/@me', (p, call) => {
      const msg = this.messages.get(p.message);
      if (!msg) throw this.#error(call, 404, 10008, 'Unknown Message');
    });
    r('DELETE', '/channels/:channel/messages/:message/reactions/:emoji/@me', () => undefined);
    r('DELETE', '/channels/:channel/messages/:message/reactions', () => undefined);
    r('DELETE', '/channels/:channel/messages/:message/reactions/:emoji', () => undefined);
    r('GET', '/channels/:channel/messages/:message/reactions/:emoji', () => []);
    r('PUT', '/channels/:channel/pins/:message', () => undefined);
    r('DELETE', '/channels/:channel/pins/:message', () => undefined);
    r('PUT', '/channels/:channel/messages/pins/:message', () => undefined);
    r('DELETE', '/channels/:channel/messages/pins/:message', () => undefined);
    r('GET', '/channels/:channel/pins', () => []);
    r('GET', '/channels/:channel/messages/pins', () => ({ items: [], has_more: false }));
    r('POST', '/channels/:channel/typing', () => undefined);
    r('GET', '/channels/:channel/webhooks', (p) => [...this.webhooks.values()].filter((w) => w.channel_id === p.channel));
    r('POST', '/channels/:channel/webhooks', (p, call) => {
      const name = call.body?.name ?? '';
      if (!name || [...name].length > L.MAX.webhookName || /clyde|discord/i.test(name)) this.#violate(call, [`nom de webhook invalide « ${name} »`]);
      const hook = { id: nextId(), type: 1, token: `wh-${nextId()}`, name, avatar: null, channel_id: p.channel, guild_id: this.guildId, application_id: null, user: this.botUser };
      this.webhooks.set(hook.id, hook);
      return hook;
    });
    r('GET', '/channels/:channel/invites', () => []);
    r('POST', '/channels/:channel/invites', (p) => ({ code: `test${Date.now().toString(36)}`, type: 0, channel: this.channels.get(p.channel), guild: { id: this.guildId, name: this.guild.name }, inviter: this.botUser, max_age: 0, max_uses: 0, uses: 0, temporary: false, created_at: new Date().toISOString() }));
    r('POST', '/channels/:channel/threads', (p, call) => this.#createThread(p.channel, null, call));
    r('POST', '/channels/:channel/messages/:message/threads', (p, call) => this.#createThread(p.channel, p.message, call));
    r('PUT', '/channels/:channel/thread-members/:user', () => undefined);
    r('DELETE', '/channels/:channel/thread-members/:user', () => undefined);
    r('GET', '/channels/:channel/thread-members', () => []);
    r('GET', '/channels/:channel/threads/archived/public', () => ({ threads: [], members: [], has_more: false }));
    r('GET', '/channels/:channel/threads/archived/private', () => ({ threads: [], members: [], has_more: false }));

    // --- Serveur -------------------------------------------------------
    r('GET', '/guilds/:guild', (p, call) => {
      this.#guild(p, call);
      return { ...this.guild, roles: [...this.roles.values()], approximate_member_count: this.members.size, approximate_presence_count: 2 };
    });
    r('PATCH', '/guilds/:guild', (p, call) => {
      this.#guild(p, call);
      Object.assign(this.guild, call.body ?? {});
      const out = { ...this.guild, roles: [...this.roles.values()] };
      this.dispatch('GUILD_UPDATE', out);
      return out;
    });
    r('GET', '/guilds/:guild/preview', (p, call) => ({ ...this.#guild(p, call), approximate_member_count: this.members.size, approximate_presence_count: 2 }));
    r('GET', '/guilds/:guild/channels', (p, call) => (this.#guild(p, call), [...this.channels.values()]));
    r('PATCH', '/guilds/:guild/channels', (p, call) => {
      for (const { id, position, parent_id: parentId } of call.body ?? []) {
        const ch = this.channels.get(id);
        if (!ch) continue;
        if (position != null) ch.position = position;
        if (parentId !== undefined) ch.parent_id = parentId;
      }
    });
    r('POST', '/guilds/:guild/channels', (p, call) => {
      this.#guild(p, call);
      const b = call.body ?? {};
      const problems = [];
      if (!b.name || [...b.name].length > L.MAX.channelName) problems.push(`name invalide (${b.name})`);
      if (b.type != null && ![0, 2, 4, 5, 13, 15, 16].includes(b.type)) problems.push(`type de salon invalide (${b.type})`);
      if (b.topic != null && [...b.topic].length > L.MAX.topic) problems.push('topic > 1024');
      if (b.user_limit != null && (b.user_limit < 0 || b.user_limit > 99)) problems.push(`user_limit hors bornes (${b.user_limit})`);
      if (b.parent_id && this.channels.get(b.parent_id)?.type !== 4) problems.push(`parent_id ${b.parent_id} n'est pas une catégorie`);
      if (b.type === 4 && b.parent_id) problems.push('une catégorie ne peut pas avoir de parent');
      problems.push(...this.#checkOverwrites(b.permission_overwrites));
      this.#violate(call, problems);
      const ch = {
        id: nextId(),
        type: b.type ?? 0,
        guild_id: this.guildId,
        name: b.name,
        position: b.position ?? this.channels.size,
        parent_id: b.parent_id ?? null,
        // Sans permission_overwrites, Discord synchronise le salon sur sa catégorie.
        permission_overwrites: (b.permission_overwrites ?? (b.parent_id ? json(this.channels.get(b.parent_id)?.permission_overwrites ?? []) : [])).map((o) => ({ id: o.id, type: o.type ?? 0, allow: String(o.allow ?? '0'), deny: String(o.deny ?? '0') })),
        topic: b.topic ?? null,
        nsfw: Boolean(b.nsfw),
        rate_limit_per_user: b.rate_limit_per_user ?? 0,
        flags: 0,
        ...((b.type === 2 || b.type === 13) ? { bitrate: b.bitrate ?? 64000, user_limit: b.user_limit ?? 0, rtc_region: null } : {}),
        ...(b.type === 15 ? { available_tags: b.available_tags ?? [], default_reaction_emoji: null } : {}),
        last_message_id: null,
      };
      this.channels.set(ch.id, ch);
      this.dispatch('CHANNEL_CREATE', ch);
      this.#audit(10, ch.id, call);
      return ch;
    });
    r('GET', '/guilds/:guild/members', (p, call) => {
      this.#guild(p, call);
      const limit = Number(call.query.limit ?? 1);
      if (limit < 1 || limit > 1000) this.#violate(call, [`limit hors bornes (${limit})`]);
      let list = [...this.members.values()].sort((a, b) => (BigInt(a.user.id) > BigInt(b.user.id) ? 1 : -1));
      if (call.query.after) list = list.filter((m) => BigInt(m.user.id) > BigInt(call.query.after));
      return list.slice(0, limit);
    });
    r('GET', '/guilds/:guild/members/search', (p, call) => {
      this.#guild(p, call);
      const q = String(call.query.query ?? '').toLowerCase();
      return [...this.members.values()].filter((m) => m.user.username.toLowerCase().startsWith(q) || (m.nick ?? '').toLowerCase().startsWith(q) || (m.user.global_name ?? '').toLowerCase().startsWith(q)).slice(0, Number(call.query.limit ?? 1));
    });
    r('GET', '/guilds/:guild/members/:user', (p, call) => (this.#guild(p, call), this.member(p.user, call)));
    r('PATCH', '/guilds/:guild/members/:user', (p, call) => this.#editMember(p.user === '@me' ? this.botUser.id : p.user, call));
    r('PUT', '/guilds/:guild/members/:user/roles/:role', (p, call) => this.#memberRole(p.user, p.role, true, call));
    r('DELETE', '/guilds/:guild/members/:user/roles/:role', (p, call) => this.#memberRole(p.user, p.role, false, call));
    r('DELETE', '/guilds/:guild/members/:user', (p, call) => {
      const m = this.member(p.user, call);
      this.#assertManageable(p.user, call);
      this.#removeMember(m);
      this.#audit(20, p.user, call);
    });
    r('GET', '/guilds/:guild/bans', (p, call) => {
      this.#guild(p, call);
      return [...this.bans.values()].slice(0, Number(call.query.limit ?? 1000));
    });
    r('GET', '/guilds/:guild/bans/:user', (p, call) => {
      const ban = this.bans.get(p.user);
      if (!ban) throw this.#error(call, 404, 10026, 'Unknown Ban');
      return ban;
    });
    r('PUT', '/guilds/:guild/bans/:user', (p, call) => {
      const secs = call.body?.delete_message_seconds;
      if (secs != null && (secs < 0 || secs > 604800)) this.#violate(call, [`delete_message_seconds hors bornes (${secs})`]);
      if (call.body?.delete_message_days != null) this.#violate(call, ['delete_message_days est obsolète (utiliser delete_message_seconds)'], { throwError: false });
      const user = this.users.get(p.user);
      if (!user) throw this.#error(call, 404, 10013, 'Unknown User');
      if (this.members.has(p.user)) this.#assertManageable(p.user, call);
      this.bans.set(p.user, { user, reason: call.reason ?? null });
      this.dispatch('GUILD_BAN_ADD', { guild_id: this.guildId, user });
      const m = this.members.get(p.user);
      if (m) this.#removeMember(m);
      this.#audit(22, p.user, call);
    });
    r('DELETE', '/guilds/:guild/bans/:user', (p, call) => {
      const ban = this.bans.get(p.user);
      if (!ban) throw this.#error(call, 404, 10026, 'Unknown Ban');
      this.bans.delete(p.user);
      this.dispatch('GUILD_BAN_REMOVE', { guild_id: this.guildId, user: ban.user });
      this.#audit(23, p.user, call);
    });
    r('POST', '/guilds/:guild/bulk-ban', (p, call) => {
      const ids = call.body?.user_ids ?? [];
      if (!ids.length || ids.length > 200) this.#violate(call, [`bulk-ban : ${ids.length} utilisateurs (1 à 200)`]);
      return { banned_users: ids, failed_users: [] };
    });
    r('GET', '/guilds/:guild/roles', (p, call) => (this.#guild(p, call), [...this.roles.values()]));
    r('GET', '/guilds/:guild/roles/:role', (p, call) => this.#role(p.role, call));
    r('POST', '/guilds/:guild/roles', (p, call) => {
      const b = call.body ?? {};
      const problems = [];
      if (b.name != null && [...b.name].length > L.MAX.roleName) problems.push(`name > ${L.MAX.roleName}`);
      if (b.color != null && (b.color < 0 || b.color > 0xffffff)) problems.push(`color invalide (${b.color})`);
      if (b.permissions != null && !/^\d+$/.test(String(b.permissions))) problems.push(`permissions invalides (${b.permissions})`);
      this.#violate(call, problems);
      const role = { id: nextId(), name: b.name ?? 'new role', color: b.color ?? 0, colors: { primary_color: b.color ?? 0, secondary_color: null, tertiary_color: null }, hoist: Boolean(b.hoist), icon: null, unicode_emoji: b.unicode_emoji ?? null, position: 1, permissions: String(b.permissions ?? this.roles.get(this.guildId).permissions), managed: false, mentionable: Boolean(b.mentionable), flags: 0 };
      for (const other of this.roles.values()) if (other.position >= 1 && other.id !== this.guildId) other.position += 1;
      this.roles.set(role.id, role);
      this.dispatch('GUILD_ROLE_CREATE', { guild_id: this.guildId, role });
      this.#audit(30, role.id, call);
      return role;
    });
    r('PATCH', '/guilds/:guild/roles', (p, call) => {
      for (const { id, position } of call.body ?? []) {
        const role = this.roles.get(id);
        if (role && position != null) role.position = position;
      }
      return [...this.roles.values()];
    });
    r('PATCH', '/guilds/:guild/roles/:role', (p, call) => {
      const role = this.#role(p.role, call);
      const b = call.body ?? {};
      if (b.name != null && [...b.name].length > L.MAX.roleName) this.#violate(call, [`name > ${L.MAX.roleName}`]);
      this.#assertRoleBelowBot(role, call);
      Object.assign(role, b, b.permissions != null ? { permissions: String(b.permissions) } : {});
      this.dispatch('GUILD_ROLE_UPDATE', { guild_id: this.guildId, role });
      this.#audit(31, role.id, call);
      return role;
    });
    r('DELETE', '/guilds/:guild/roles/:role', (p, call) => {
      const role = this.#role(p.role, call);
      this.#assertRoleBelowBot(role, call);
      this.roles.delete(role.id);
      for (const m of this.members.values()) m.roles = m.roles.filter((x) => x !== role.id);
      // Discord retire aussi les surcharges de permissions de ce rôle.
      for (const ch of this.channels.values()) {
        if (!ch.permission_overwrites?.some((o) => o.id === role.id)) continue;
        ch.permission_overwrites = ch.permission_overwrites.filter((o) => o.id !== role.id);
        this.dispatch('CHANNEL_UPDATE', ch);
      }
      this.dispatch('GUILD_ROLE_DELETE', { guild_id: this.guildId, role_id: role.id });
      this.#audit(32, role.id, call);
    });
    r('GET', '/guilds/:guild/audit-logs', (p, call) => {
      const type = call.query.action_type != null ? Number(call.query.action_type) : null;
      const limit = Number(call.query.limit ?? 50);
      if (limit < 1 || limit > 100) this.#violate(call, [`audit-logs limit hors bornes (${limit})`]);
      const entries = this.auditLog.filter((e) => type == null || e.action_type === type).slice(0, limit);
      return { audit_log_entries: entries, users: [...this.users.values()], integrations: [], webhooks: [], guild_scheduled_events: [], threads: [], application_commands: [], auto_moderation_rules: [] };
    });
    r('GET', '/guilds/:guild/auto-moderation/rules', () => [...this.autoModRules.values()]);
    r('GET', '/guilds/:guild/auto-moderation/rules/:rule', (p, call) => {
      const rule = this.autoModRules.get(p.rule);
      if (!rule) throw this.#error(call, 404, 10066, 'Unknown auto moderation rule');
      return rule;
    });
    r('POST', '/guilds/:guild/auto-moderation/rules', (p, call) => {
      const b = call.body ?? {};
      const problems = [];
      if (!b.name || [...b.name].length > 100) problems.push('name de règle invalide');
      if (![1, 3, 4, 5, 6].includes(b.trigger_type)) problems.push(`trigger_type invalide (${b.trigger_type})`);
      if (!b.actions?.length) problems.push('règle sans action');
      for (const a of b.actions ?? []) {
        if (a.type === 1 && a.metadata?.custom_message && [...a.metadata.custom_message].length > 150) problems.push('custom_message > 150');
        if (a.type === 3 && (a.metadata?.duration_seconds ?? 0) > 2419200) problems.push('duration_seconds > 28 jours');
      }
      const kw = b.trigger_metadata?.keyword_filter ?? [];
      if (kw.length > 1000) problems.push('keyword_filter > 1000');
      if (kw.some((k) => [...k].length > 60)) problems.push('mot-clé > 60 caractères');
      if ((b.trigger_metadata?.regex_patterns ?? []).length > 10) problems.push('regex_patterns > 10');
      if ((b.exempt_roles ?? []).length > 20) problems.push('exempt_roles > 20');
      if ((b.exempt_channels ?? []).length > 50) problems.push('exempt_channels > 50');
      this.#violate(call, problems);
      const rule = { id: nextId(), guild_id: this.guildId, creator_id: this.botUser.id, enabled: b.enabled ?? false, exempt_roles: [], exempt_channels: [], trigger_metadata: {}, ...b };
      this.autoModRules.set(rule.id, rule);
      return rule;
    });
    r('PATCH', '/guilds/:guild/auto-moderation/rules/:rule', (p, call) => {
      const rule = this.autoModRules.get(p.rule);
      if (!rule) throw this.#error(call, 404, 10066, 'Unknown auto moderation rule');
      return Object.assign(rule, call.body ?? {});
    });
    r('DELETE', '/guilds/:guild/auto-moderation/rules/:rule', (p) => void this.autoModRules.delete(p.rule));
    r('GET', '/guilds/:guild/invites', () => []);
    r('GET', '/guilds/:guild/webhooks', () => [...this.webhooks.values()]);
    r('GET', '/guilds/:guild/integrations', () => []);
    r('GET', '/guilds/:guild/emojis', () => this.guild.emojis);
    r('GET', '/guilds/:guild/stickers', () => []);
    r('GET', '/guilds/:guild/scheduled-events', () => []);
    r('GET', '/guilds/:guild/prune', () => ({ pruned: 0 }));
    r('GET', '/guilds/:guild/vanity-url', (p, call) => {
      throw this.#error(call, 403, 50020, 'Invalid invite code');
    });
    r('GET', '/guilds/:guild/voice-states/:user', (p, call) => {
      const vs = this.voiceStates.get(p.user === '@me' ? this.botUser.id : p.user);
      if (!vs) throw this.#error(call, 404, 10065, 'Unknown Voice State');
      return vs;
    });
    r('GET', '/guilds/:guild/onboarding', () => ({ guild_id: gid(), prompts: [], default_channel_ids: [], enabled: false, mode: 0 }));
    r('GET', '/guilds/:guild/welcome-screen', () => ({ description: null, welcome_channels: [] }));

    // --- Application, utilisateurs --------------------------------------
    const app = () => ({ id: this.botUser.id, name: this.botUser.username, icon: null, description: '', bot_public: true, bot_require_code_grant: false, flags: 0, owner: this.users.get(this.client.config?.ownerIds?.[0]) ?? this.botUser, team: null, verify_key: 'x', approximate_guild_count: 1 });
    r('GET', '/applications/@me', app);
    r('GET', '/oauth2/applications/@me', app);
    r('GET', '/applications/:app/commands', () => this.commands);
    r('PUT', '/applications/:app/commands', (p, call) => (this.commands = (call.body ?? []).map((c) => ({ ...c, id: nextId(), application_id: p.app, version: '1' }))));
    r('GET', '/applications/:app/guilds/:guild/commands', () => this.commands);
    r('PUT', '/applications/:app/guilds/:guild/commands', (p, call) => (this.commands = (call.body ?? []).map((c) => ({ ...c, id: nextId(), application_id: p.app, guild_id: p.guild, version: '1' }))));
    r('GET', '/applications/:app/emojis', () => ({ items: [] }));
    r('GET', '/users/@me', () => this.botUser);
    r('PATCH', '/users/@me', (p, call) => Object.assign(this.botUser, call.body ?? {}));
    r('GET', '/users/:user', (p, call) => {
      const u = this.users.get(p.user);
      if (!u) throw this.#error(call, 404, 10013, 'Unknown User');
      return u;
    });
    r('POST', '/users/@me/channels', (p, call) => {
      const user = this.users.get(call.body?.recipient_id);
      if (!user) throw this.#error(call, 404, 10013, 'Unknown User');
      if (user.bot) throw this.#error(call, 400, 50007, 'Cannot send messages to this user');
      let dm = [...this.dms.values()].find((d) => d.recipients[0].id === user.id);
      if (!dm) {
        dm = { id: nextId(), type: 1, recipients: [user], last_message_id: null, flags: 0 };
        this.dms.set(dm.id, dm);
      }
      return dm;
    });
    r('DELETE', '/users/@me/guilds/:guild', () => undefined);
    r('GET', '/invites/:code', (p, call) => {
      throw this.#error(call, 404, 10006, 'Unknown Invite');
    });
    r('GET', '/stickers/:sticker', (p, call) => {
      throw this.#error(call, 404, 10060, 'Unknown Sticker');
    });
  }

  /* ------------------------------------------------------------------ */
  /* Aides des routes                                                     */
  /* ------------------------------------------------------------------ */

  /**
   * Permissions requises par Discord pour une requête (sous-ensemble courant) ;
   * 50001 (Missing Access) sans « Voir le salon », 50013 sinon.
   */
  #checkPermissions(call) {
    const guild = this.client.guilds.cache.get(this.guildId);
    const me = guild?.members.me;
    if (!me) return;
    const { method, route, body } = call;
    const inChannel = (id, ...flags) => {
      const ch = this.client.channels.cache.get(id);
      if (!ch?.guild) return; // MP, salon inconnu : 10003 plus loin
      const perms = ch.permissionsFor(me);
      if (!perms) return;
      const view = ch.isThread?.() ? ch.parent?.permissionsFor(me)?.has(P.ViewChannel) : perms.has(P.ViewChannel);
      if (!view) throw this.#error(call, 403, 50001, 'Missing Access');
      const missing = flags.filter((f) => !perms.has(f));
      if (missing.length) throw this.#error(call, 403, 50013, 'Missing Permissions');
    };
    const inGuild = (...flags) => {
      if (flags.some((f) => !me.permissions.has(f))) throw this.#error(call, 403, 50013, 'Missing Permissions');
    };
    let m;
    if ((m = /^\/channels\/(\d+)\/messages$/.exec(route)) && method === 'POST') {
      const ch = this.client.channels.cache.get(m[1]);
      const flags = [ch?.isThread?.() ? P.SendMessagesInThreads : P.SendMessages];
      if (body?.embeds?.length) flags.push(P.EmbedLinks);
      if (call.files.length) flags.push(P.AttachFiles);
      if (body?.message_reference) flags.push(P.ReadMessageHistory);
      inChannel(m[1], ...flags);
    } else if ((m = /^\/channels\/(\d+)\/messages$/.exec(route)) && method === 'GET') inChannel(m[1], P.ReadMessageHistory);
    else if ((m = /^\/channels\/(\d+)\/messages\/bulk-delete$/.exec(route))) inChannel(m[1], P.ManageMessages, P.ReadMessageHistory);
    else if ((m = /^\/channels\/(\d+)\/messages\/(\d+)$/.exec(route)) && method === 'DELETE') {
      const msg = this.messages.get(m[2]);
      if (msg && msg.author.id !== this.botUser.id) inChannel(m[1], P.ManageMessages);
      else inChannel(m[1]);
    } else if ((m = /^\/channels\/(\d+)\/messages\/(\d+)$/.exec(route))) inChannel(m[1], ...(method === 'GET' ? [P.ReadMessageHistory] : []));
    else if ((m = /^\/channels\/(\d+)\/messages\/\d+\/reactions\/[^/]+\/@me$/.exec(route)) && method === 'PUT') inChannel(m[1], P.AddReactions, P.ReadMessageHistory);
    else if ((m = /^\/channels\/(\d+)\/(messages\/)?pins/.exec(route)) && method !== 'GET') inChannel(m[1], P.ManageMessages);
    else if ((m = /^\/channels\/(\d+)\/permissions\//.exec(route))) inChannel(m[1], P.ManageRoles);
    else if ((m = /^\/channels\/(\d+)$/.exec(route)) && method !== 'GET') {
      const ch = this.client.channels.cache.get(m[1]);
      inChannel(m[1], ch?.isThread?.() ? P.ManageThreads : P.ManageChannels);
      if (body?.permission_overwrites) inChannel(m[1], P.ManageRoles);
    } else if ((m = /^\/channels\/(\d+)\/webhooks$/.exec(route))) inChannel(m[1], P.ManageWebhooks);
    else if ((m = /^\/channels\/(\d+)\/invites$/.exec(route)) && method === 'POST') inChannel(m[1], P.CreateInstantInvite);
    else if ((m = /^\/channels\/(\d+)\/(messages\/\d+\/)?threads$/.exec(route))) inChannel(m[1], body?.type === 12 ? P.CreatePrivateThreads : P.CreatePublicThreads);
    else if (/^\/guilds\/\d+\/channels$/.test(route) && method !== 'GET') {
      inGuild(P.ManageChannels);
      if (body?.permission_overwrites?.length) inGuild(P.ManageRoles);
    } else if (/^\/guilds\/\d+\/members\/[^/]+$/.test(route) && method === 'PATCH') {
      const target = route.split('/').pop();
      if (body && 'nick' in body) inGuild(target === '@me' || target === this.botUser.id ? P.ChangeNickname : P.ManageNicknames);
      if (body && 'roles' in body) inGuild(P.ManageRoles);
      if (body && 'communication_disabled_until' in body) inGuild(P.ModerateMembers);
      if (body && 'channel_id' in body) inGuild(P.MoveMembers);
      if (body && 'mute' in body) inGuild(P.MuteMembers);
      if (body && 'deaf' in body) inGuild(P.DeafenMembers);
    } else if (/^\/guilds\/\d+\/members\/\d+\/roles\//.test(route)) inGuild(P.ManageRoles);
    else if (/^\/guilds\/\d+\/members\/\d+$/.test(route) && method === 'DELETE') inGuild(P.KickMembers);
    else if (/^\/guilds\/\d+\/(bans|bulk-ban)/.test(route)) inGuild(P.BanMembers);
    else if (/^\/guilds\/\d+\/roles/.test(route) && method !== 'GET') inGuild(P.ManageRoles);
    else if (/^\/guilds\/\d+\/audit-logs$/.test(route)) inGuild(P.ViewAuditLog);
    else if (/^\/guilds\/\d+\/auto-moderation\//.test(route)) inGuild(P.ManageGuild);
    else if (/^\/guilds\/\d+$/.test(route) && method === 'PATCH') inGuild(P.ManageGuild);
    else if (/^\/guilds\/\d+\/(invites|webhooks|integrations)$/.test(route)) inGuild(route.endsWith('webhooks') ? P.ManageWebhooks : P.ManageGuild);
  }

  #guild(p, call) {
    if (p.guild !== this.guildId) throw this.#error(call, 404, 10004, 'Unknown Guild');
    return this.guild;
  }

  #role(id, call) {
    const role = this.roles.get(id);
    if (!role) throw this.#error(call, 404, 10011, 'Unknown Role');
    return role;
  }

  #checkOverwrites(list) {
    const out = [];
    for (const o of list ?? []) {
      if (![0, 1].includes(o.type)) out.push(`permission_overwrites : type ${o.type} invalide pour ${o.id}`);
      for (const k of ['allow', 'deny']) if (o[k] != null && !/^\d+$/.test(String(o[k]))) out.push(`permission_overwrites.${k} invalide (${o[k]})`);
      if (o.type === 0 && !this.roles.has(o.id)) out.push(`permission_overwrites : rôle inconnu ${o.id}`);
      if (o.type === 1 && !this.users.has(o.id)) out.push(`permission_overwrites : membre inconnu ${o.id}`);
    }
    if ((list?.length ?? 0) > 100) out.push('permission_overwrites > 100');
    return out;
  }

  /** Hiérarchie : le rôle le plus haut du bot doit dépasser celui de la cible (50013 sinon). */
  #highest(userId) {
    const m = this.members.get(userId);
    if (!m) return -1;
    return Math.max(0, ...m.roles.map((r) => this.roles.get(r)?.position ?? 0));
  }

  #assertManageable(userId, call) {
    if (userId === this.guild.owner_id || this.#highest(userId) >= this.#highest(this.botUser.id)) {
      throw this.#error(call, 403, 50013, 'Missing Permissions');
    }
  }

  #assertRoleBelowBot(role, call) {
    if (role.managed && call.method === 'DELETE') throw this.#error(call, 400, 50028, 'Invalid Role');
    if (role.position >= this.#highest(this.botUser.id)) throw this.#error(call, 403, 50013, 'Missing Permissions');
  }

  #editMember(userId, call) {
    const m = this.member(userId, call);
    const b = call.body ?? {};
    const problems = [];
    if (b.nick != null && [...b.nick].length > L.MAX.nick) problems.push(`nick : ${[...b.nick].length} > ${L.MAX.nick}`);
    if (b.communication_disabled_until) {
      const until = Date.parse(b.communication_disabled_until);
      if (Number.isNaN(until)) problems.push('communication_disabled_until invalide');
      else if (until - Date.now() > MAX_TIMEOUT_MS + 60_000) problems.push('communication_disabled_until > 28 jours');
    }
    if (b.roles && b.roles.some((r) => !this.roles.has(r))) problems.push('roles : rôle inconnu');
    this.#violate(call, problems);
    if (userId !== this.botUser.id && ('nick' in b || 'communication_disabled_until' in b || 'roles' in b)) {
      if (userId === this.guild.owner_id && 'nick' in b) throw this.#error(call, 403, 50013, 'Missing Permissions');
      this.#assertManageable(userId, call);
    }
    const changes = [];
    if ('nick' in b) {
      changes.push({ key: 'nick', old_value: m.nick ?? undefined, new_value: b.nick ?? undefined });
      m.nick = b.nick || null;
    }
    if ('communication_disabled_until' in b) {
      changes.push({ key: 'communication_disabled_until', old_value: m.communication_disabled_until ?? undefined, new_value: b.communication_disabled_until ?? undefined });
      m.communication_disabled_until = b.communication_disabled_until;
    }
    // @everyone (implicite) est ignoré par Discord ; discord.js l'envoie via roles.remove([...]).
    if ('roles' in b) m.roles = [...new Set(b.roles)].filter((r) => r !== this.guildId);
    if ('mute' in b) m.mute = Boolean(b.mute);
    if ('deaf' in b) m.deaf = Boolean(b.deaf);
    if ('channel_id' in b) this.setVoice(userId, b.channel_id);
    this.dispatch('GUILD_MEMBER_UPDATE', this.memberWithGuild(m));
    if (changes.length) this.#audit(24, userId, call, changes);
    if ('roles' in b) this.#audit(25, userId, call);
    return m;
  }

  #memberRole(userId, roleId, add, call) {
    const m = this.member(userId, call);
    const role = this.#role(roleId, call);
    if (role.managed || roleId === this.guildId) throw this.#error(call, 400, 50028, 'Invalid Role');
    this.#assertRoleBelowBot(role, call);
    m.roles = add ? [...new Set([...m.roles, roleId])] : m.roles.filter((r) => r !== roleId);
    this.dispatch('GUILD_MEMBER_UPDATE', this.memberWithGuild(m));
    this.#audit(25, userId, call, [{ key: add ? '$add' : '$remove', new_value: [{ id: role.id, name: role.name }] }]);
  }

  #removeMember(m) {
    this.members.delete(m.user.id);
    this.voiceStates.delete(m.user.id);
    this.dispatch('GUILD_MEMBER_REMOVE', { guild_id: this.guildId, user: m.user });
  }

  #deleteMessage(msg) {
    this.messages.delete(msg.id);
    if (!(msg.flags & EPHEMERAL)) this.dispatch('MESSAGE_DELETE', { id: msg.id, channel_id: msg.channel_id, ...(msg.guild_id ? { guild_id: msg.guild_id } : {}) });
  }

  #createThread(channelId, messageId, call) {
    const parent = this.channel(channelId, call);
    const b = call.body ?? {};
    const problems = [];
    if (!b.name || [...b.name].length > L.MAX.threadName) problems.push(`nom de fil invalide (${[...(b.name ?? '')].length})`);
    if (parent.type === 15) {
      if (!b.message) problems.push('fil de forum sans message');
      else problems.push(...L.validateMessageBody(b.message, { files: call.files }).map((x) => `message.${x}`));
    }
    if (b.auto_archive_duration != null && ![60, 1440, 4320, 10080].includes(b.auto_archive_duration)) problems.push(`auto_archive_duration invalide (${b.auto_archive_duration})`);
    this.#violate(call, problems);
    const thread = {
      id: messageId ?? nextId(),
      type: b.type ?? (parent.type === 15 ? 11 : 11),
      guild_id: this.guildId,
      parent_id: channelId,
      name: b.name,
      owner_id: this.botUser.id,
      rate_limit_per_user: b.rate_limit_per_user ?? 0,
      message_count: 0,
      member_count: 1,
      thread_metadata: { archived: false, auto_archive_duration: b.auto_archive_duration ?? 1440, archive_timestamp: new Date().toISOString(), locked: false, invitable: true },
      applied_tags: b.applied_tags ?? [],
      flags: 0,
      last_message_id: null,
      member: { id: messageId ?? undefined, user_id: this.botUser.id, join_timestamp: new Date().toISOString(), flags: 0 },
    };
    this.channels.set(thread.id, thread);
    if (parent.type === 15 && b.message) {
      const first = this.buildMessage({ channelId: thread.id, body: b.message, files: call.files });
      first.id = thread.id;
      this.messages.delete(first.id);
      this.messages.set(thread.id, first);
      thread.message = first;
      thread.last_message_id = first.id;
    }
    this.dispatch('THREAD_CREATE', { ...thread, newly_created: true });
    return thread;
  }

  #executeWebhook(p, call) {
    const hook = this.webhooks.get(p.app);
    if (!hook || hook.token !== p.token) throw this.#error(call, 404, 10015, 'Unknown Webhook');
    this.#validateMessage(call, call.body, {});
    const author = { id: hook.id, username: call.body?.username ?? hook.name, avatar: null, discriminator: '0000', bot: true };
    const msg = this.buildMessage({ channelId: hook.channel_id, body: call.body, files: call.files, author, extra: { webhook_id: hook.id } });
    this.#echoMessage(msg, 'MESSAGE_CREATE');
    return call.query.wait === 'true' ? msg : undefined;
  }

  /** Déplace un membre en vocal (ou le déconnecte) et émet VOICE_STATE_UPDATE. */
  setVoice(userId, channelId) {
    const m = this.members.get(userId);
    const state = {
      guild_id: this.guildId,
      channel_id: channelId ?? null,
      user_id: userId,
      member: m,
      session_id: `s-${userId}`,
      deaf: false,
      mute: false,
      self_deaf: false,
      self_mute: false,
      self_video: false,
      suppress: false,
      request_to_speak_timestamp: null,
    };
    if (channelId) this.voiceStates.set(userId, state);
    else this.voiceStates.delete(userId);
    this.dispatch('VOICE_STATE_UPDATE', state);
    return state;
  }

  /** Membres pour une requête de passerelle REQUEST_GUILD_MEMBERS (op 8). */
  membersForRequest({ user_ids: userIds, query, limit }) {
    let list = [...this.members.values()];
    if (userIds) {
      const ids = new Set([].concat(userIds));
      list = list.filter((m) => ids.has(m.user.id));
    } else if (query) {
      const q = query.toLowerCase();
      list = list.filter((m) => m.user.username.toLowerCase().startsWith(q) || (m.nick ?? '').toLowerCase().startsWith(q));
    }
    return limit ? list.slice(0, limit) : list;
  }
}

module.exports = { FakeDiscord, EPHEMERAL, LOADING, INTERACTION_CALLBACK, scenario };
