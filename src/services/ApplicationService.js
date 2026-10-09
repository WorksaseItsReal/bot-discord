'use strict';

const { ChannelType, PermissionFlagsBits, ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder } = require('discord.js');
const { truncate } = require('../utils/embeds');
const { discordTimestamp, formatDuration, parseDuration } = require('../utils/time');
const { card, field, wide, ICONS, subtext, code, actionButton, linkButton, buttonRows, ButtonStyle, fitEmbeds } = require('../utils/ui');
const { applyRoles } = require('../utils/memberRoles');
const { hasForbiddenPermissions } = require('../commands/roles/rolemenu');
const { logCard, REQUIRED_PERMISSIONS } = require('./LoggingService');
const { historyButton } = require('./ModerationService');
const { supportRoles } = require('./TicketService');
const { MAX_FORMS } = require('../database/repositories/ApplicationRepository');
const { UserError } = require('../core/errors');
const { createLogger } = require('../core/logger');

const logger = createLogger('applications');

/** En-tête des cartes de candidature. */
const SECTION = Object.freeze({ emoji: '📝', label: 'Candidatures' });
const APP_ICON = '📝';
const INTERVIEW_ICON = '🎙️';
const MAX_QUESTIONS = 5;
/** Libellé d'un champ de formulaire Discord (TextInput) : 45 caractères au plus. */
const MAX_LABEL = 45;
/** Titre d'un formulaire Discord : 45 caractères au plus (le nom du formulaire en est le titre). */
const MAX_NAME = 45;
const MAX_DESCRIPTION = 1000;
const MAX_ROLES = 5;
const SHORT_ANSWER_MAX = 300;
const LONG_ANSWER_MAX = 1000;
const MAX_REASON = 500;
const TEXT_TYPES = [ChannelType.GuildText, ChannelType.GuildAnnouncement];

/** Présentation des statuts d'une candidature. */
const STATUS = Object.freeze({
  pending: { emoji: '🟡', label: 'En attente', tone: 'warning' },
  accepted: { emoji: ICONS.success, label: 'Acceptée', tone: 'success' },
  rejected: { emoji: '🚫', label: 'Refusée', tone: 'danger' },
  withdrawn: { emoji: '↩️', label: 'Retirée', tone: 'neutral' },
});

// ---------------------------------------------------------------- helpers purs

/** Lien vers un message. Pur. */
function messageLink(guildId, channelId, messageId) {
  return `https://discord.com/channels/${guildId}/${channelId}/${messageId}`;
}

/** Texte saisi sans caractères de contrôle (hors retours à la ligne si `multiline`). Pur. */
function clean(text, { multiline = false } = {}) {
  // eslint-disable-next-line no-control-regex
  const re = multiline ? /[\u0000-\u0009\u000b-\u001f\u007f]/g : /[\u0000-\u001f\u007f]/g;
  return String(text ?? '').replace(re, multiline ? '' : ' ').trim();
}

/** Nom de formulaire (1 à 45 caractères). Pur. */
function parseName(raw) {
  const name = clean(raw).replace(/\s+/g, ' ');
  if (!name) throw new UserError('Le nom du formulaire est obligatoire.');
  if (name.length > MAX_NAME) throw new UserError(`Nom trop long (${MAX_NAME} caractères maximum).`);
  return name;
}

/** Description facultative (≤ 1000 caractères). Pur. */
function parseDescription(raw) {
  const text = clean(raw, { multiline: true });
  if (!text) return null;
  if (text.length > MAX_DESCRIPTION) throw new UserError(`Description trop longue (${MAX_DESCRIPTION} caractères maximum).`);
  return text;
}

/**
 * Questions saisies, une par ligne ; « + » en tête de ligne = réponse longue. Pur.
 * @returns {Array<{ label: string, long: boolean }>}
 */
function parseQuestions(text) {
  const out = [];
  for (const raw of String(text ?? '').split('\n')) {
    let line = clean(raw).replace(/\s+/g, ' ');
    if (!line) continue;
    const long = line.startsWith('+');
    if (long) line = line.slice(1).trim();
    if (!line) continue;
    if (line.length > MAX_LABEL) throw new UserError(`Question trop longue (${MAX_LABEL} caractères maximum, limite des formulaires Discord) : « ${truncate(line, 40)} ».`);
    out.push({ label: line, long });
  }
  if (!out.length) throw new UserError('Indiquez au moins une question (une par ligne).');
  if (out.length > MAX_QUESTIONS) throw new UserError(`${MAX_QUESTIONS} questions maximum (limite des formulaires Discord).`);
  const seen = new Set();
  for (const q of out) {
    const key = q.label.toLowerCase();
    if (seen.has(key)) throw new UserError(`Question en double : « ${truncate(q.label, 40)} ».`);
    seen.add(key);
  }
  return out;
}

/** Inverse de parseQuestions (préremplissage). Pur. */
function questionsToText(questions = []) {
  return questions.map((q) => `${q.long ? '+ ' : ''}${q.label}`).join('\n');
}

/** Délai entre deux candidatures (« 7d », « 12h », vide ou « 0 » = aucun), en ms. Pur. */
function parseCooldown(raw) {
  const text = clean(raw).toLowerCase();
  if (!text || text === '0' || text === 'aucun') return 0;
  const ms = parseDuration(text);
  if (!ms) throw new UserError('Délai invalide : utilisez par exemple `12h`, `7d` ou `2w` (1 an maximum), ou `0` pour aucun délai.');
  return ms;
}

/** Délai lisible. Pur. */
function formatCooldown(ms) {
  return ms > 0 ? formatDuration(ms) : 'Aucun';
}

/** Délai au format de saisie (« 7d », « 1d12h », « 0 »), relu par parseCooldown. Pur. */
function cooldownToInput(ms) {
  if (!(ms > 0)) return '0';
  return formatDuration(ms).replace(/j/g, 'd').replace(/\s+/g, '');
}

/** Ligne d'une question (« 1. 📄 Pourquoi … »). Pur. */
const questionLine = (q, i) => `**${i + 1}.** ${q.long ? '📄' : '✏️'} ${q.label}`;

/**
 * Problème d'un rôle à donner automatiquement : null s'il est attribuable. Pur.
 * @param {{ id: string, ownerId: string, members?: { me?: object } }} guild
 * @param {object} role
 * @param {object|null} [actor] membre qui configure ou accepte (hiérarchie, sauf propriétaire)
 */
function roleProblem(guild, role, actor = null) {
  if (!role) return 'il n\'existe plus';
  if (role.id === guild.id) return 'c\'est @everyone';
  if (role.managed) return 'il est géré par une intégration';
  if (role.permissions?.any && hasForbiddenPermissions(role)) return 'il confère des permissions de modération ou d\'administration';
  const me = guild.members?.me;
  if (me && role.position >= (me.roles?.highest?.position ?? 0)) return 'il est au-dessus de mon rôle le plus haut';
  if (actor && actor.id !== guild.ownerId && role.position >= (actor.roles?.highest?.position ?? 0)) return 'il est au-dessus de (ou égal à) votre rôle le plus haut';
  return null;
}

/** Le membre peut-il traiter les candidatures ? (« Gérer le serveur » ou « Gérer les rôles ») */
function canReview(permissions) {
  return Boolean(permissions?.has?.(PermissionFlagsBits.ManageGuild) || permissions?.has?.(PermissionFlagsBits.ManageRoles));
}

/** UserError pour une candidature déjà traitée. Pur. */
function alreadyDecided(app) {
  const st = STATUS[app?.status];
  if (!st || app.status === 'pending') return new UserError('Cette candidature est en cours de traitement.');
  const by = app.reviewer_id ? ` par <@${app.reviewer_id}>` : '';
  return new UserError(`Cette candidature a déjà été traitée : ${st.emoji} **${st.label.toLowerCase()}**${app.status === 'withdrawn' ? ' par son auteur' : by}.`);
}

// ---------------------------------------------------------------- service

/**
 * Candidatures : formulaires (5 par serveur), panneau public « Postuler », formulaire
 * Discord rempli par le membre, carte dans le salon de réception (réponses en embed) avec
 * les actions du staff (accepter → rôles + MP, refuser → motif + MP, entretien → ticket
 * ou fil privé), retrait par le membre, journal (Modération · Candidatures).
 */
class ApplicationService {
  /**
   * @param {{ client: import('discord.js').Client, applications: import('../database/repositories/ApplicationRepository').ApplicationRepository,
   *   config: import('./ConfigService').ConfigService, logging: import('./LoggingService').LoggingService,
   *   tickets?: import('./TicketService').TicketService }} deps
   */
  constructor({ client, applications, config, logging, tickets = null }) {
    this.client = client;
    this.applications = applications;
    this.config = config;
    this.logging = logging;
    this.tickets = tickets;
    /** Entretiens en cours d'ouverture (`guildId:id`) : anti double clic. */
    this.opening = new Set();
  }

  // ------------------------------------------------------------ formulaires

  forms(guildId) {
    return this.applications.listForms(guildId);
  }

  /** Formulaire du serveur, sinon UserError. */
  form(guildId, id) {
    const formId = Number(id);
    const form = Number.isInteger(formId) && formId > 0 ? this.applications.getForm(guildId, formId) : null;
    if (!form) throw new UserError('Ce formulaire n\'existe plus.');
    return form;
  }

  /** Crée un formulaire fermé. @returns {object} formulaire */
  createForm(guildId, { name, description = null, questions, cooldownMs = 0 }) {
    const id = this.applications.createForm({ guildId, name, description, questions, cooldownMs });
    if (!id) throw new UserError(`${MAX_FORMS} formulaires maximum : supprimez-en un d'abord.`);
    return this.applications.getForm(guildId, id);
  }

  /** Modifie un formulaire. @returns {object} formulaire à jour */
  updateForm(guildId, id, patch) {
    const form = this.applications.updateForm(guildId, Number(id), patch);
    if (!form) throw new UserError('Ce formulaire n\'existe plus.');
    return form;
  }

  /** Formulaire supprimable (aucune candidature en attente), sinon UserError. Synchrone. */
  assertDeletable(guildId, id) {
    const form = this.form(guildId, id);
    const pending = this.applications.pendingPerForm(guildId).get(form.id) ?? 0;
    if (pending) throw new UserError(`Ce formulaire a **${pending}** candidature(s) en attente : acceptez-les ou refusez-les avant de le supprimer (fermez-le pour ne plus en recevoir).`);
    return form;
  }

  /**
   * Supprime un formulaire sans candidature en attente (retire aussi son panneau publié).
   * @returns {Promise<object>} formulaire supprimé
   */
  async deleteForm(guild, id) {
    const form = this.assertDeletable(guild.id, id);
    if (form.panel_channel_id && form.panel_message_id) {
      const channel = guild.channels?.cache?.get(form.panel_channel_id);
      await channel?.messages?.delete?.(form.panel_message_id).catch(() => {});
    }
    this.applications.deleteForm(guild.id, form.id);
    return form;
  }

  /**
   * Rôles à donner : 5 au plus, chacun attribuable par le bot et par `actor`
   * (hiérarchie, sauf propriétaire), sans permission de modération. UserError sinon.
   */
  assertGrantableRoles(guild, roleIds, actor = null) {
    if (roleIds.length > MAX_ROLES) throw new UserError(`${MAX_ROLES} rôles maximum.`);
    for (const id of roleIds) {
      const role = guild.roles?.cache?.get(id);
      const problem = roleProblem(guild, role, actor);
      if (problem) throw new UserError(`Le rôle ${role ? `**${truncate(role.name, 80)}**` : code(id)} ne peut pas être donné automatiquement : ${problem}.`);
    }
  }

  /**
   * Salon de réception d'un formulaire : null s'il est utilisable, sinon le problème.
   * @returns {string|null}
   */
  reviewProblem(guild, form) {
    if (!form.review_channel_id) return 'aucun salon de réception n\'est choisi';
    const channel = guild.channels?.cache?.get(form.review_channel_id);
    if (!channel || !TEXT_TYPES.includes(channel.type)) return 'le salon de réception n\'existe plus';
    const me = guild.members?.me;
    const perms = me && typeof channel.permissionsFor === 'function' ? channel.permissionsFor(me) : null;
    if (perms && !perms.has(REQUIRED_PERMISSIONS)) return `je ne peux pas écrire dans <#${channel.id}> (Voir, Envoyer, Intégrer des liens)`;
    return null;
  }

  // ------------------------------------------------------------ panneau public

  /** Panneau public (embed + bouton « Postuler » persistant). */
  panelPayload(guild, form) {
    const lines = form.questions.map(questionLine);
    return {
      embeds: [
        card({
          tone: form.open ? 'brand' : 'neutral',
          section: SECTION,
          icon: APP_ICON,
          title: form.name,
          description: [
            form.description ?? `Vous souhaitez rejoindre l'équipe de **${truncate(guild?.name ?? 'ce serveur', 100)}** ? Postulez en quelques questions.`,
            '',
            form.open ? `Cliquez sur **${APP_ICON} Postuler** : un formulaire s'ouvre, vos réponses sont transmises à l'équipe.` : '🔴 **Les candidatures sont fermées pour le moment.**',
            subtext('Vous recevrez la réponse en message privé. Suivi : /candidature statut.'),
          ],
          fields: [
            wide(ICONS.list, `Questions (${form.questions.length})`, lines.length ? lines.join('\n') : '—'),
            field(ICONS.status, 'Statut', form.open ? '🟢 Ouvertes' : '🔴 Fermées'),
            field(ICONS.duration, 'Délai entre deux candidatures', formatCooldown(form.cooldown_ms)),
          ],
          footer: `Formulaire #${form.id}`,
          timestamp: false,
        }),
      ],
      components: buttonRows(
        actionButton({ command: 'candidature', action: 'apply', args: [form.id], label: form.open ? 'Postuler' : 'Candidatures fermées', emoji: APP_ICON, style: ButtonStyle.Primary, disabled: !form.open }),
      ),
    };
  }

  /**
   * Publie (ou met à jour) le panneau dans son salon.
   * @returns {Promise<{ form: object, updated: boolean, url: string }>}
   */
  async publishPanel(guild, form) {
    if (!form.panel_channel_id) throw new UserError('Choisissez d\'abord le salon du panneau.');
    const channel = guild.channels?.cache?.get(form.panel_channel_id) ?? (await guild.channels?.fetch?.(form.panel_channel_id).catch(() => null));
    if (!channel?.send || !TEXT_TYPES.includes(channel.type)) throw new UserError('Le salon du panneau est introuvable : choisissez-en un autre.');
    const payload = this.panelPayload(guild, form);
    const body = { ...payload, embeds: fitEmbeds(payload.embeds) };
    let message = null;
    let updated = false;
    if (form.panel_message_id) {
      const existing = await channel.messages?.fetch?.(form.panel_message_id).catch(() => null);
      if (existing?.edit) {
        message = await existing.edit(body).catch(() => null);
        updated = Boolean(message);
      }
    }
    if (!message) {
      message = await channel.send(body).catch((err) => {
        logger.debug(`Panneau du formulaire #${form.id} non publié :`, err?.message);
        return null;
      });
    }
    if (!message?.id) throw new UserError(`Je ne peux pas publier dans <#${channel.id}> : il me faut **Voir le salon**, **Envoyer des messages** et **Intégrer des liens**.`);
    const saved = this.updateForm(guild.id, form.id, { panelMessageId: message.id });
    return { form: saved, updated, url: messageLink(guild.id, channel.id, message.id) };
  }

  /** Met à jour le panneau publié (ouverture / fermeture, questions). Best effort. */
  async refreshPanel(guild, form) {
    if (!form.panel_channel_id || !form.panel_message_id) return false;
    const channel = guild.channels?.cache?.get(form.panel_channel_id);
    const message = await channel?.messages?.fetch?.(form.panel_message_id).catch(() => null);
    if (!message?.edit) return false;
    const payload = this.panelPayload(guild, form);
    return message.edit({ ...payload, embeds: fitEmbeds(payload.embeds) }).then(() => true, () => false);
  }

  // ------------------------------------------------------------ dépôt d'une candidature

  /**
   * Le membre peut-il postuler ? (synchrone : avant d'ouvrir le formulaire Discord)
   * Formulaire ouvert et prêt, pas de candidature en attente, délai respecté.
   */
  assertCanApply(guild, userId, form, now = Date.now()) {
    if (!form.open) throw new UserError(`Les candidatures **${form.name}** sont fermées pour le moment.`);
    if (!form.questions.length || this.reviewProblem(guild, form)) {
      throw new UserError('Ce formulaire n\'est pas prêt à recevoir des candidatures. Prévenez un administrateur (`/candidatures`).');
    }
    const pending = this.applications.pendingByMember(form.id, userId);
    if (pending) throw new UserError(`Vous avez déjà une candidature **${form.name}** en attente (${code(`#${pending.id}`)}). Retirez-la avec /candidature retirer pour en envoyer une nouvelle.`);
    const last = this.applications.lastByMember(form.id, userId);
    if (last && form.cooldown_ms > 0 && now - last.created_at < form.cooldown_ms) {
      throw new UserError(`Vous avez déjà postulé récemment. Vous pourrez renvoyer une candidature **${form.name}** ${discordTimestamp(last.created_at + form.cooldown_ms, 'R')}.`);
    }
  }

  /** Formulaire Discord d'une candidature (une zone de texte par question). */
  applyModal(form) {
    return new ModalBuilder()
      .setCustomId(`cmd:candidature:submit:${form.id}`)
      .setTitle(truncate(form.name, MAX_NAME))
      .addComponents(
        form.questions.slice(0, MAX_QUESTIONS).map((q, i) =>
          new ActionRowBuilder().addComponents(
            new TextInputBuilder()
              .setCustomId(`q${i}`)
              .setLabel(truncate(q.label, MAX_LABEL))
              .setStyle(q.long ? TextInputStyle.Paragraph : TextInputStyle.Short)
              .setRequired(true)
              .setMaxLength(q.long ? LONG_ANSWER_MAX : SHORT_ANSWER_MAX),
          )),
      );
  }

  /**
   * Réponses validées (une par question, non vides, longueur bornée). Pur.
   * @param {string[]} raw réponses dans l'ordre des questions
   * @returns {Array<{ q: string, a: string }>}
   */
  static answers(form, raw) {
    return form.questions.map((q, i) => {
      const a = clean(raw[i], { multiline: q.long });
      if (!a) throw new UserError(`Répondez à la question « ${truncate(q.label, 40)} ».`);
      const max = q.long ? LONG_ANSWER_MAX : SHORT_ANSWER_MAX;
      if (a.length > max) throw new UserError(`Réponse trop longue pour « ${truncate(q.label, 40)} » (${max} caractères maximum).`);
      return { q: q.label, a };
    });
  }

  /**
   * Enregistre la candidature et publie sa carte dans le salon de réception (ping du rôle
   * choisi, réponses en embed). Carte impossible à publier : candidature supprimée, UserError.
   * @returns {Promise<object>} candidature enregistrée
   */
  async submit(guild, user, form, rawAnswers) {
    this.assertCanApply(guild, user.id, form);
    const answers = ApplicationService.answers(form, rawAnswers);
    const id = this.applications.createApplication({ guildId: guild.id, formId: form.id, formName: form.name, userId: user.id, answers });
    if (!id) throw new UserError(`Vous avez déjà une candidature **${form.name}** en attente.`);
    const app = this.applications.getApplication(guild.id, id);
    const channel = guild.channels.cache.get(form.review_channel_id);
    const role = form.ping_role_id && form.ping_role_id !== guild.id && guild.roles?.cache?.has(form.ping_role_id) ? form.ping_role_id : null;
    try {
      const sent = await channel.send({
        ...(role ? { content: `<@&${role}>` } : {}),
        ...this.cardPayload(guild, app, { fit: true }),
        allowedMentions: role ? { parse: [], roles: [role] } : { parse: [] },
      });
      this.applications.setCard(guild.id, id, sent.channelId ?? channel.id, sent.id);
    } catch (err) {
      logger.debug(`Carte de candidature non publiée (${guild.id}) :`, err?.message);
      this.applications.deleteApplication(guild.id, id);
      throw new UserError('Je n\'ai pas pu transmettre votre candidature à l\'équipe. Prévenez un administrateur (`/candidatures`).');
    }
    return this.applications.getApplication(guild.id, id);
  }

  // ------------------------------------------------------------ carte du staff

  /**
   * Carte d'une candidature (salon de réception) : statut, candidat, réponses, remarques,
   * actions du staff tant qu'elle est en attente.
   * @param {{ fit?: boolean }} [opts] fit : embeds prêts pour un envoi direct (channel.send / edit)
   */
  cardPayload(guild, app, { fit = false } = {}) {
    const st = STATUS[app.status] ?? STATUS.pending;
    const decided = app.status !== 'pending' && app.decided_at;
    const by = app.status === 'withdrawn' ? ' par le candidat' : app.reviewer_id ? ` par <@${app.reviewer_id}>` : '';
    const embed = card({
      tone: st.tone,
      section: SECTION,
      icon: APP_ICON,
      title: `Candidature #${app.id} · ${truncate(app.form_name, 100)}`,
      description: [
        `${st.emoji} **${st.label}**${decided ? `${by} ${discordTimestamp(app.decided_at, 'R')}` : ''}`,
        app.interview_channel_id ? `${INTERVIEW_ICON} Entretien : <#${app.interview_channel_id}>` : null,
      ],
      fields: [
        field(ICONS.user, 'Candidat', `<@${app.user_id}>\n${code(app.user_id)}`),
        field(ICONS.date, 'Envoyée', `${discordTimestamp(app.created_at, 'f')}\n${discordTimestamp(app.created_at, 'R')}`),
        field(APP_ICON, 'Formulaire', truncate(app.form_name, 100)),
        ...app.answers.map((a, i) => wide(`${i + 1}.`, a.q, truncate(a.a, 1024))),
        app.reason ? wide(ICONS.reason, 'Motif du refus', truncate(app.reason, 1000)) : null,
        app.note ? wide(ICONS.warning, 'Remarques', truncate(app.note, 1000)) : null,
      ],
      footer: `Candidature #${app.id}`,
      timestamp: app.created_at,
    });
    const pending = app.status === 'pending';
    const act = (action, label, emoji, style) => actionButton({ command: 'candidatures', action, args: [app.id], label, emoji, style });
    const interview = app.interview_channel_id ? linkButton('Entretien', `https://discord.com/channels/${guild.id}/${app.interview_channel_id}`, INTERVIEW_ICON) : null;
    const components = buttonRows(
      pending ? act('accept', 'Accepter', ICONS.success, ButtonStyle.Success) : null,
      pending ? act('reject', 'Refuser', ICONS.error, ButtonStyle.Danger) : null,
      pending && !interview ? act('interview', 'Entretien', INTERVIEW_ICON, ButtonStyle.Secondary) : null,
      interview,
      historyButton(app.user_id),
    );
    return { embeds: fit ? fitEmbeds([embed]) : [embed], components };
  }

  /** Réédite la carte publiée d'une candidature. Best effort. */
  async refreshCard(guild, app) {
    if (!app.card_channel_id || !app.card_message_id) return false;
    const channel = guild.channels?.cache?.get(app.card_channel_id);
    if (!channel?.messages) return false;
    return channel.messages.edit(app.card_message_id, this.cardPayload(guild, app, { fit: true })).then(() => true, () => false);
  }

  // ------------------------------------------------------------ décisions

  /** Candidature du serveur, sinon UserError. */
  application(guildId, id) {
    const appId = Number(id);
    const app = Number.isInteger(appId) && appId > 0 ? this.applications.getApplication(guildId, appId) : null;
    if (!app) throw new UserError(`La candidature ${code(`#${id}`)} est introuvable.`);
    return app;
  }

  assertPending(app) {
    if (app.status !== 'pending') throw alreadyDecided(app);
  }

  /**
   * Rôles qu'une acceptation donnera, vérifiés pour le relecteur (avant toute réservation).
   * @returns {string[]} rôles existants à donner
   */
  rolesToGrant(guild, app, reviewer) {
    const form = this.applications.getForm(guild.id, app.form_id);
    const ids = (form?.role_ids ?? []).filter((id) => guild.roles?.cache?.has(id));
    this.assertGrantableRoles(guild, ids, reviewer);
    return ids;
  }

  /**
   * Réserve la décision (synchrone, atomique) : un double clic ou deux relecteurs
   * simultanés ne produisent qu'une seule décision.
   * @param {'accepted'|'rejected'} status
   * @returns {object} candidature décidée
   */
  decide(guild, app, { status, reviewer, reason = null }) {
    this.assertPending(app);
    if (!this.applications.decide(guild.id, app.id, { status, reviewerId: reviewer.id, reason })) {
      throw alreadyDecided(this.applications.getApplication(guild.id, app.id) ?? app);
    }
    return this.applications.getApplication(guild.id, app.id);
  }

  /**
   * Suite d'une décision réservée : rôles (acceptée), MP au candidat, remarques.
   * @param {string[]} [roleIds] rôles à donner (acceptée)
   * @returns {Promise<{ app: object, added: string[], failed: string[], dm: boolean, left: boolean }>}
   */
  async complete(guild, app, reviewer, roleIds = []) {
    const notes = [];
    let added = [];
    let failed = [];
    const member = guild.members?.cache?.get(app.user_id) ?? (await guild.members?.fetch?.(app.user_id).catch(() => null));
    if (app.status === 'accepted' && roleIds.length) {
      if (!member) notes.push('Le membre a quitté le serveur : aucun rôle donné.');
      else {
        ({ added, failed } = await applyRoles(member, { add: roleIds }, `Candidature #${app.id} acceptée par ${reviewer.user?.tag ?? reviewer.tag ?? reviewer.id}`));
        if (failed.length) notes.push(`Rôle(s) non donné(s) (permissions ou hiérarchie) : ${failed.map((id) => `<@&${id}>`).join(' ')}.`);
      }
    }
    const user = member?.user ?? (await this.client.users?.fetch?.(app.user_id).catch(() => null));
    const dm = user ? await user.send(this.decisionDm(guild, app, added)).then(() => true, () => false) : false;
    if (!dm) notes.push('MP impossible : le candidat n\'accepte pas les messages privés du serveur.');
    if (notes.length) this.applications.setNote(guild.id, app.id, notes.join('\n'));
    return { app: this.applications.getApplication(guild.id, app.id), added, failed, dm, left: !member };
  }

  /** MP envoyé au candidat après la décision (noms des rôles : une mention de rôle ne s'affiche pas en MP). */
  decisionDm(guild, app, added = []) {
    const accepted = app.status === 'accepted';
    const roleNames = added.map((id) => guild.roles?.cache?.get(id)?.name).filter(Boolean).map((n) => `**${truncate(n, 80)}**`);
    const embed = card({
      tone: accepted ? 'success' : 'neutral',
      section: SECTION,
      icon: accepted ? '🎉' : APP_ICON,
      title: accepted ? 'Candidature acceptée' : 'Candidature refusée',
      description: accepted
        ? [`Bonne nouvelle : votre candidature **${truncate(app.form_name, 100)}** sur **${truncate(guild.name, 100)}** a été acceptée ! 🎉`, roleNames.length ? `Vous avez reçu : ${roleNames.join(', ')}.` : null]
        : [`Votre candidature **${truncate(app.form_name, 100)}** sur **${truncate(guild.name, 100)}** n'a pas été retenue.`, subtext('Merci pour votre intérêt : vous pourrez postuler de nouveau plus tard.')],
      fields: [!accepted && app.reason ? wide(ICONS.reason, 'Motif', truncate(app.reason, 1000)) : null],
      footer: `Candidature #${app.id}`,
    });
    return { embeds: fitEmbeds([embed]) };
  }

  // ------------------------------------------------------------ entretien

  /** Les tickets sont-ils configurés (rôle staff ou catégorie) ? */
  ticketsConfigured(guild) {
    const cfg = this.config.get(guild.id).tickets ?? {};
    return Boolean(this.tickets) && (supportRoles(cfg).some((id) => guild.roles?.cache?.has(id)) || Boolean(cfg.categoryId && guild.channels?.cache?.has(cfg.categoryId)));
  }

  /**
   * Ouvre un entretien : ticket (si les tickets sont configurés), sinon fil privé dans le
   * salon du panneau du formulaire, avec le candidat et le relecteur.
   * @returns {Promise<{ app: object, channel: object, kind: 'ticket'|'thread' }>}
   */
  async openInterview(guild, current, reviewer) {
    // Relue : un autre clic a pu ouvrir l'entretien ou décider entre-temps.
    const app = this.applications.getApplication(guild.id, current.id) ?? current;
    this.assertPending(app);
    const key = `${guild.id}:${app.id}`;
    if (this.opening.has(key)) throw new UserError('Un entretien est déjà en cours d\'ouverture pour cette candidature.');
    if (app.interview_channel_id && guild.channels?.cache?.has(app.interview_channel_id)) {
      throw new UserError(`Un entretien est déjà ouvert : <#${app.interview_channel_id}>.`);
    }
    this.opening.add(key);
    try {
      const member = guild.members?.cache?.get(app.user_id) ?? (await guild.members?.fetch?.(app.user_id).catch(() => null));
      if (!member) throw new UserError('Le candidat a quitté le serveur : impossible d\'ouvrir un entretien.');
      let channel = null;
      let kind = 'ticket';
      if (this.ticketsConfigured(guild)) {
        channel = await this.tickets.create(guild, member.user, { reason: truncate(`Entretien · candidature #${app.id} (${app.form_name})`, 100) }).catch((err) => {
          if (err instanceof UserError || err?.isUserError) return null; // ticket déjà ouvert, délai… : repli sur un fil
          throw err;
        });
        if (channel && !this.tickets.isStaff(reviewer)) {
          await channel.permissionOverwrites?.edit?.(reviewer.id, { ViewChannel: true, SendMessages: true }).catch(() => {});
        }
      }
      if (!channel) {
        kind = 'thread';
        channel = await this.#interviewThread(guild, app, member, reviewer);
      }
      const intro = this.interviewCard(app, reviewer);
      await channel.send({
        content: `<@${app.user_id}> <@${reviewer.id}>`,
        embeds: fitEmbeds([intro]),
        allowedMentions: { parse: [], users: [app.user_id, reviewer.id] },
      }).catch(() => {});
      this.applications.setInterview(guild.id, app.id, channel.id);
      return { app: this.applications.getApplication(guild.id, app.id), channel, kind };
    } finally {
      this.opening.delete(key);
    }
  }

  /** Fil privé d'entretien dans le salon du panneau (visible du candidat). */
  async #interviewThread(guild, app, member, reviewer) {
    const form = this.applications.getForm(guild.id, app.form_id);
    const parent = form?.panel_channel_id ? guild.channels?.cache?.get(form.panel_channel_id) : null;
    if (!parent || parent.type !== ChannelType.GuildText || !parent.threads?.create) {
      throw new UserError('Impossible d\'ouvrir un entretien : configurez les tickets (/tickets) ou publiez le panneau du formulaire dans un salon textuel (l\'entretien a lieu dans un fil privé de ce salon).');
    }
    const thread = await parent.threads.create({
      name: truncate(`entretien-${member.user?.username ?? app.user_id}`, 100),
      type: ChannelType.PrivateThread,
      invitable: false,
      autoArchiveDuration: 10080,
      reason: `Entretien · candidature #${app.id}`,
    }).catch((err) => {
      logger.debug(`Fil d'entretien non créé (${guild.id}) :`, err?.message);
      throw new UserError(`Je ne peux pas créer de fil privé dans <#${parent.id}> : il me faut **Créer des fils privés** et **Envoyer des messages dans les fils**.`);
    });
    for (const id of [app.user_id, reviewer.id]) await thread.members?.add?.(id).catch(() => {});
    return thread;
  }

  /** Carte d'accueil de l'entretien. */
  interviewCard(app, reviewer) {
    return card({
      tone: 'info',
      section: SECTION,
      icon: INTERVIEW_ICON,
      title: `Entretien · ${truncate(app.form_name, 100)}`,
      description: [
        `Bonjour <@${app.user_id}> ! <@${reviewer.id}> souhaite échanger avec vous au sujet de votre candidature **${truncate(app.form_name, 100)}**.`,
        subtext('Seuls vous et l\'équipe voyez cette discussion.'),
      ],
      fields: [field(APP_ICON, 'Candidature', code(`#${app.id}`)), field(ICONS.date, 'Envoyée', discordTimestamp(app.created_at, 'R')), field(ICONS.moderator, 'Avec', `<@${reviewer.id}>`)],
      footer: `Candidature #${app.id}`,
    });
  }

  // ------------------------------------------------------------ retrait

  /**
   * Retrait par son auteur d'une candidature en attente (atomique), puis carte mise à jour.
   * @returns {object} candidature retirée
   */
  withdraw(guild, userId, id) {
    const app = this.application(guild.id, id);
    if (app.user_id !== userId) throw new UserError('Vous ne pouvez retirer que vos propres candidatures.');
    this.assertPending(app);
    if (!this.applications.withdraw(guild.id, app.id, userId)) throw alreadyDecided(this.applications.getApplication(guild.id, app.id) ?? app);
    return this.applications.getApplication(guild.id, app.id);
  }

  // ------------------------------------------------------------ membres et journal

  /** Candidatures d'un membre (récentes d'abord). */
  ofMember(guildId, userId, limit = 10) {
    return this.applications.listByMember(guildId, userId, limit);
  }

  /** Journal (Modération · Candidatures). Ne lève jamais. */
  async log(guild, app, { title, description, tone }) {
    try {
      const st = STATUS[app.status] ?? STATUS.pending;
      const link = app.card_channel_id && app.card_message_id ? messageLink(guild.id, app.card_channel_id, app.card_message_id) : null;
      await this.logging.send(
        guild.id,
        'moderation',
        logCard({
          category: 'moderation',
          tone: tone ?? st.tone,
          icon: APP_ICON,
          title: `${title} · #${app.id}`,
          description,
          fields: [
            field(ICONS.user, 'Candidat', `<@${app.user_id}>`),
            field(APP_ICON, 'Formulaire', truncate(app.form_name, 100)),
            field(ICONS.status, 'Statut', `${st.emoji} ${st.label}`),
            app.reason ? wide(ICONS.reason, 'Motif', truncate(app.reason, 500)) : null,
            app.note ? wide(ICONS.warning, 'Remarques', truncate(app.note, 500)) : null,
            link ? wide(ICONS.link, 'Carte', link) : null,
          ],
          id: app.user_id,
        }),
        undefined,
        { event: 'application' },
      );
    } catch (err) {
      logger.debug('Journal des candidatures :', err?.message ?? err);
    }
  }

  /** Lignes de suivi d'un membre (« 🟡 #3 · Modération · il y a 2 jours »). Pur. */
  static memberLines(apps) {
    return apps.map((a) => {
      const st = STATUS[a.status] ?? STATUS.pending;
      return `${st.emoji} ${code(`#${a.id}`)} · **${truncate(a.form_name, 60)}** · ${st.label} · ${discordTimestamp(a.decided_at ?? a.created_at, 'R')}`;
    });
  }

}

module.exports = {
  ApplicationService,
  SECTION,
  APP_ICON,
  INTERVIEW_ICON,
  STATUS,
  MAX_FORMS,
  MAX_QUESTIONS,
  MAX_LABEL,
  MAX_NAME,
  MAX_DESCRIPTION,
  MAX_ROLES,
  MAX_REASON,
  SHORT_ANSWER_MAX,
  LONG_ANSWER_MAX,
  TEXT_TYPES,
  parseName,
  parseDescription,
  parseQuestions,
  questionsToText,
  parseCooldown,
  formatCooldown,
  cooldownToInput,
  roleProblem,
  canReview,
  alreadyDecided,
  messageLink,
  questionLine,
};
