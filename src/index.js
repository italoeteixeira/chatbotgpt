import { config } from './config.js';
import { logger } from './logger.js';
import { askAI } from './aiBridge.js';
import { appendConversationEntry, listRecentConversationEntries } from './conversationStore.js';
import { tryHandleLocalAction, startFullAutoJobDirect } from './localActions.js';
import { createWhatsappClient } from './whatsappBot.js';
import { startWebPanel } from './webPanel.js';
import { GroupQueue } from './messageQueue.js';
import { updateRuntimeState, getRuntimeState } from './runtimeState.js';
import { ModerationEngine } from './moderationEngine.js';
import { accessControl } from './accessControl.js';
import { settingsStore } from './settingsStore.js';
import { mediaStore } from './mediaStore.js';
import { scheduledMessagesStore } from './scheduledMessagesStore.js';
import { reminderStore } from './reminderStore.js';
import { runWebSearch } from './searchService.js';
import { botDatabase } from './botDatabase.js';
import { groupStore } from './groupStore.js';
import { transcribeMediaEntry, truncateTranscriptionText } from './audioTranscriptionService.js';
import { resolveRelevantImageAttachments } from './imageContextService.js';
import { analyzeImageWithVision } from './visionService.js';
import { loadJobsFromDb } from './fullAutoJobStore.js';
import { relayChatStore } from './relayChatStore.js';
import pkg from 'whatsapp-web.js';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import * as selfHealingService from './selfHealingService.js';
import { startBackupScheduler } from './backupService.js';

const { MessageMedia } = pkg;

// Recupera e loga o resultado da ultima validacao apos restart controlado
(async () => {
  try {
    const lastValidationPath = join(process.cwd(), 'logs', 'last-validation.json');
    const raw = await readFile(lastValidationPath, 'utf8');
    const data = JSON.parse(raw);
    logger.info('Recuperacao pos-restart: ultimo resultado de validacao', {
      ts: data.ts,
      ok: data.ok,
      status: data.status,
      willRestart: data.willRestart,
      summary: data.summary ? String(data.summary).slice(0, 200) : '(sem resumo)'
    });
    if (!data.ok) {
      logger.warn('Atencao: ultima validacao falhou antes do restart', {
        status: data.status,
        output: String(data.output || '').slice(0, 400)
      });
    }
  } catch {
    // arquivo nao existe ou erro de parse: primeiro start ou validacao nao executada
  }
})();

// Restaura historico de jobs FULL dos ultimos 30 dias ao iniciar
// Jobs que ficaram como 'running' de instancias anteriores são marcados como error pelo próprio loadJobsFromDb
loadJobsFromDb().catch(() => {});

if (!config.groupJid && !config.groupInviteLink) {
  logger.error('Defina GROUP_JID_AUTORIZADO ou GROUP_INVITE_LINK no .env. Encerrando.');
  process.exit(1);
}

let activeGroupJid = config.groupJid || '';
let activeNotificationGroupJid = config.notificationGroupJid || '';
let storeResponseGroupJids = [];
let resolvingGroup = false;
let resolvingNotificationGroup = false;

function extractInviteCode(inviteLink) {
  if (!inviteLink) return '';
  const match = String(inviteLink).match(/chat\.whatsapp\.com\/([A-Za-z0-9]+)/i);
  return match?.[1] || '';
}

function normalizePhoneNumber(value) {
  return String(value || '').replace(/\D/g, '');
}

function foldLookupText(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

function senderDigitsFromContext(context = {}) {
  const byNumber = normalizePhoneNumber(context.senderNumber || '');
  if (byNumber) return byNumber;
  const byJid = normalizePhoneNumber(String(context.senderJid || '').split('@')[0]);
  return byJid;
}

function mentionFromContext(context = {}) {
  const digits = senderDigitsFromContext(context);
  return digits ? `@${digits}` : '@usuario';
}

function buildAudioTranscriptionReply(context = {}, text = '') {
  const mention = mentionFromContext(context);
  const cleaned = truncateTranscriptionText(text, config.audioTranscriptionMaxChars);
  if (!cleaned) return '';
  return `Transcricao do audio ${mention}:\n${cleaned}`;
}

// Pending image action: key = `${groupId}::${senderNumber}`, value = { mediaEntry, expiresAt }
const pendingImageActions = new Map();
const PENDING_IMAGE_TTL_MS = 5 * 60 * 1000; // 5 minutos

// Pending audio transcript: key = `${groupId}::${senderNumber}`, value = { text, expiresAt }
const pendingAudioSummaries = new Map();
const PENDING_AUDIO_SUMMARY_TTL_MS = 5 * 60 * 1000; // 5 minutos

// Pending txt file action: key = `${groupId}::${senderNumber}`, value = { mediaEntry, expiresAt }
const pendingTxtActions = new Map();
const PENDING_TXT_TTL_MS = 10 * 60 * 1000; // 10 minutos

// Wizard de envio de mensagem relay: key = `${groupId}::${senderNumber}`
const pendingRelayWizards = new Map();
const PENDING_RELAY_WIZARD_TTL_MS = 3 * 60 * 1000; // 3 minutos
function buildRelayHeader(senderName) {
  const name = (senderName || '').trim();
  if (name) {
    return `_🤖 Conversa com apoio de IA, comigo no comando._\n> *${name}*:\n\n`;
  }
  return '_🤖 Conversa com apoio de IA, comigo no comando._\n\n';
}

async function resolveSenderName(messageObj, fallbackNumber) {
  // Se relaySenderName estiver configurado, usa sempre esse nome
  const configuredName = String(settingsStore.get().relaySenderName || '').trim();
  if (configuredName) return configuredName;

  // notifyName is embedded in the raw message and is the most reliable source
  const notifyName = String(messageObj?._data?.notifyName || '').trim();
  if (notifyName && /\p{L}/u.test(notifyName)) return notifyName;

  try {
    const contact = await messageObj?.getContact?.();
    const name = String(contact?.pushname || contact?.name || '').trim();
    // Reject emoji-only strings (no letter characters) from contact resolution
    if (name && /\p{L}/u.test(name)) return name;
  } catch {}

  // Accept notifyName even if emoji-only before falling back to phone number
  if (notifyName) return notifyName;

  return String(fallbackNumber || '').replace(/\D/g, '');
}

function setPendingRelayWizard(groupId, senderNumber, state) {
  const key = `${groupId}::${senderNumber}`;
  pendingRelayWizards.set(key, { ...state, expiresAt: Date.now() + PENDING_RELAY_WIZARD_TTL_MS });
}

function popPendingRelayWizard(groupId, senderNumber) {
  const key = `${groupId}::${senderNumber}`;
  const w = pendingRelayWizards.get(key);
  if (!w) return null;
  pendingRelayWizards.delete(key);
  if (Date.now() > w.expiresAt) return null;
  return w;
}

function hasPendingRelayWizard(groupId, senderNumber) {
  const key = `${groupId}::${senderNumber}`;
  const w = pendingRelayWizards.get(key);
  if (!w) return false;
  if (Date.now() > w.expiresAt) { pendingRelayWizards.delete(key); return false; }
  return true;
}

function setPendingAudioSummary(groupId, senderNumber, transcriptText) {
  const key = `${groupId}::${senderNumber}`;
  pendingAudioSummaries.set(key, { text: transcriptText, expiresAt: Date.now() + PENDING_AUDIO_SUMMARY_TTL_MS });
}

function popPendingAudioSummary(groupId, senderNumber) {
  const key = `${groupId}::${senderNumber}`;
  const pending = pendingAudioSummaries.get(key);
  if (!pending) return null;
  pendingAudioSummaries.delete(key);
  if (Date.now() > pending.expiresAt) return null;
  return pending.text;
}

function hasPendingAudioSummary(groupId, senderNumber) {
  const key = `${groupId}::${senderNumber}`;
  const pending = pendingAudioSummaries.get(key);
  if (!pending) return false;
  if (Date.now() > pending.expiresAt) {
    pendingAudioSummaries.delete(key);
    return false;
  }
  return true;
}

// ─── Inbox: mensagens de remetentes não autorizados ───────────────────────────
const unauthorizedInbox = new Map(); // id -> entrada
const INBOX_MAX_SIZE = 500;

function inboxPush(entry) {
  if (unauthorizedInbox.size >= INBOX_MAX_SIZE) {
    const oldestKey = unauthorizedInbox.keys().next().value;
    unauthorizedInbox.delete(oldestKey);
  }
  unauthorizedInbox.set(entry.id, entry);
}

function inboxGetAll() {
  return Array.from(unauthorizedInbox.values()).sort((a, b) => a.ts - b.ts);
}

function inboxMarkRead(id) {
  const entry = unauthorizedInbox.get(id);
  if (entry) entry.read = true;
}
// ──────────────────────────────────────────────────────────────────────────────

function setPendingTxtAction(groupId, senderNumber, mediaEntry) {
  const key = `${groupId}::${senderNumber}`;
  pendingTxtActions.set(key, { mediaEntry, expiresAt: Date.now() + PENDING_TXT_TTL_MS });
}

function popPendingTxtAction(groupId, senderNumber) {
  const key = `${groupId}::${senderNumber}`;
  const pending = pendingTxtActions.get(key);
  if (!pending) return null;
  pendingTxtActions.delete(key);
  if (Date.now() > pending.expiresAt) return null;
  return pending.mediaEntry;
}

function hasPendingTxtAction(groupId, senderNumber) {
  const key = `${groupId}::${senderNumber}`;
  const pending = pendingTxtActions.get(key);
  if (!pending) return false;
  if (Date.now() > pending.expiresAt) {
    pendingTxtActions.delete(key);
    return false;
  }
  return true;
}

function setPendingImageAction(groupId, senderNumber, mediaEntry) {
  const key = `${groupId}::${senderNumber}`;
  pendingImageActions.set(key, { mediaEntry, expiresAt: Date.now() + PENDING_IMAGE_TTL_MS });
}

function popPendingImageAction(groupId, senderNumber) {
  const key = `${groupId}::${senderNumber}`;
  const pending = pendingImageActions.get(key);
  if (!pending) return null;
  pendingImageActions.delete(key);
  if (Date.now() > pending.expiresAt) return null;
  return pending.mediaEntry;
}

function hasPendingImageAction(groupId, senderNumber) {
  const key = `${groupId}::${senderNumber}`;
  const pending = pendingImageActions.get(key);
  if (!pending) return false;
  if (Date.now() > pending.expiresAt) {
    pendingImageActions.delete(key);
    return false;
  }
  return true;
}

function isAdminSenderContext(context = {}){
  return accessControl.isAdmin(senderDigitsFromContext(context));
}

function isFullSenderContext(context = {}) {
  return accessControl.isFull(senderDigitsFromContext(context));
}

function buildRemovalCandidates(context = {}) {
  const list = new Set();
  if (context.senderJid) list.add(String(context.senderJid));
  const digits = senderDigitsFromContext(context);
  if (digits) {
    list.add(`${digits}@c.us`);
    list.add(`${digits}@lid`);
  }
  return Array.from(list).filter(Boolean);
}

function senderMatchesAllowed(senderNumber, allowed) {
  if (!senderNumber || !allowed) return false;
  return senderNumber === allowed || senderNumber.endsWith(allowed) || allowed.endsWith(senderNumber);
}

function extractLocalActionDirective(text) {
  const normalized = String(text || '').trim();
  if (!normalized) return '';
  const match = normalized.match(/(?:^|\n)\s*LOCAL_ACTION:\s*(.+)$/im);
  if (!match) return '';
  return String(match[1] || '').trim();
}

function stripLocalActionDirectives(text) {
  const normalized = String(text || '');
  if (!normalized) return '';
  return normalized
    .split('\n')
    .filter((line) => !/^\s*LOCAL_ACTION\s*:/i.test(line))
    .join('\n')
    .trim();
}

function sanitizeNonFullResponse(text) {
  const normalized = String(text || '').trim();
  if (!normalized) return '';

  const withoutServerPreamble = normalized
    .split('\n')
    .filter((line) => !/^\s*executando no servidor\s*:/i.test(line))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return withoutServerPreamble || normalized;
}

function isOperationalRequestText(folded) {
  return /(configur|program|agend|agenda|adicion|remove|apaga|limpa|reinicia|restart|status|processo|servico|servidor|arquivo|midia|permiss|admin|full|codigo|valida|testa|edita|altera)/.test(
    folded
  );
}

function shouldUseWebFallback(text) {
  const normalized = String(text || '').trim();
  if (!normalized) return false;

  const folded = foldLookupText(normalized);

  const looksLikeQuestion =
    /\?$/.test(normalized) ||
    /^(quem|qual|quais|quanto|quanta|onde|quando|como|por que|porque|o que)\b/.test(folded);
  if (!looksLikeQuestion) return false;

  return !isOperationalRequestText(folded);
}

function extractWebContextQuery(text) {
  const normalized = String(text || '').trim();
  if (!normalized) return '';

  const folded = foldLookupText(normalized);
  if (isOperationalRequestText(folded)) return '';

  const explicitSearch = normalized.match(
    /^(?:buscar|busca|busque|pesquisar|pesquisa|pesquise|procura|procurar|procure|search)(?:\s+(?:na|no|pela|via))?\s*(?:internet|web|google)?(?:\s+sobre)?(?:\s*[:\-])?\s*(.*)$/i
  );
  if (explicitSearch) {
    return String(explicitSearch[1] || '').trim();
  }

  const explicitInternetLookup = normalized.match(
    /^(?:veja|verifica|verifique|confira|consulta|consulte|olha|olhe|acha|ache|encontra|encontre)\s+(?:na|no)\s+(?:internet|web|google)(?:\s+sobre)?\s*(.*)$/i
  );
  if (explicitInternetLookup) {
    return String(explicitInternetLookup[1] || '').trim();
  }

  const looksLikeQuestion =
    /\?$/.test(normalized) ||
    /^(quem|qual|quais|quanto|quanta|onde|quando|como|por que|porque|o que)\b/.test(folded);
  if (!looksLikeQuestion) return '';

  const mentionsInternet = /(na internet|no google|na web|online|site oficial)/.test(folded);
  const looksTimeSensitive =
    /(hoje|agora|atualmente|ultim[ao]s?|recente|recentes|cotacao|preco|valor|clima|temperatura|tempo|resultado|placar|noticia|noticias|lancamento|estreia|acao|acoes|dolar|euro|bitcoin|hora|horas|horario|fuso)\b/.test(
      folded
    );

  return mentionsInternet || looksTimeSensitive ? normalized : '';
}

function buildRecentContextText(entries = []) {
  if (!Array.isArray(entries) || !entries.length) return '';
  const lines = entries.slice(-30).map((entry) => {
    const side = entry.direction === 'outbound' ? 'bot' : 'usuario';
    const ts = String(entry.ts || '').slice(11, 19) || '--:--:--';
    const text = String(entry.text || '').replace(/\s+/g, ' ').trim();
    return `- [${ts}] ${side}: ${text}`;
  });
  return lines.join('\n');
}

function formatUptimeShort() {
  const total = Math.max(0, Math.floor(process.uptime()));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return `${h}h ${m}m ${s}s`;
}

function buildReadyNotificationText(source) {
  const lines = [
    config.notifyOnReadyText || 'Servico de volta: online e pronto para responder.',
    `Uptime: ${formatUptimeShort()}.`,
    `Grupo autorizado: ${activeGroupJid || 'nao definido'}.`,
    `Grupo de notificacoes: ${getNotificationGroupJid() || 'nao definido'}.`
  ];
  if (source) {
    lines.push(`Origem: ${source}.`);
  }
  return lines.join('\n');
}

function extractGroupNameFromChat(chat) {
  const nameCandidates = [chat?.name, chat?.subject, chat?.groupMetadata?.subject];

  for (const value of nameCandidates) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }

  return '';
}

function groupNameMatchesNotificationTarget(groupName) {
  const target = foldLookupText(config.notificationGroupName);
  if (!target) return false;
  return foldLookupText(groupName) === target;
}

function textContainsNotificationMarker(text) {
  const marker = foldLookupText(config.notificationGroupMarkerText);
  if (!marker) return false;
  return foldLookupText(text).includes(marker);
}

function getNotificationGroupJid() {
  return String(activeNotificationGroupJid || activeGroupJid || '').trim();
}

function getEffectiveResponseGroupJids() {
  const fromAccessControl = accessControl.allResponseGroupIds(activeGroupJid);
  const merged = new Set(
    [...fromAccessControl, ...storeResponseGroupJids]
      .map((item) => String(item || '').trim())
      .filter((item) => item.endsWith('@g.us'))
  );

  if (activeNotificationGroupJid && activeNotificationGroupJid !== activeGroupJid) {
    merged.delete(activeNotificationGroupJid);
  }

  return Array.from(merged);
}

function refreshResponseGroupsFromStore() {
  const fromStore = groupStore
    .responseGroupIds()
    .map((item) => String(item || '').trim())
    .filter((item) => item.endsWith('@g.us'));
  storeResponseGroupJids = fromStore.filter((item) => item !== activeNotificationGroupJid);
}

function setNotificationGroupJid(groupJid, source, details = {}) {
  if (!groupJid) return;
  activeNotificationGroupJid = groupJid;
  logger.info('Grupo de notificacoes definido', {
    groupJid,
    source,
    ...details
  });
  updateRuntimeState({ notificationGroupJid: groupJid, lastError: null });
}

async function notifyServiceReady(client, source = 'on_ready') {
  if (!config.notifyOnReady) return false;
  const groupId = getNotificationGroupJid();
  if (!groupId) return false;

  try {
    await client.sendMessage(groupId, buildReadyNotificationText(source));
    logger.info('Notificacao de servico online enviada', { groupId, source });
    return true;
  } catch (error) {
    logger.warn('Falha ao enviar notificacao de servico online', {
      groupId,
      source,
      error: error instanceof Error ? error.message : String(error)
    });
    return false;
  }
}

let dailySchedulerTimer = null;
let dailySchedulerRunning = false;

function startDailyScheduler(client) {
  if (dailySchedulerTimer) return;

  const tick = async () => {
    if (dailySchedulerRunning) return;
    if (getRuntimeState().whatsappStatus !== 'pronto') return;
    dailySchedulerRunning = true;

    try {
      await scheduledMessagesStore.ensureReady();
      await reminderStore.ensureReady();
      const dueItems = scheduledMessagesStore.getDueItems(new Date());

      for (const item of dueItems) {
        const groupId = String(item.groupId || '').trim();
        const message = String(item.message || '').trim();
        if (!groupId || !message) continue;

        try {
          await client.sendMessage(groupId, message);
          await scheduledMessagesStore.markSent(item.id, new Date());
          logger.info('Mensagem diaria enviada com sucesso', {
            scheduleId: item.id,
            groupId,
            hour: item.hour,
            minute: item.minute
          });
        } catch (error) {
          logger.error('Falha ao enviar mensagem diaria agendada', {
            scheduleId: item.id,
            groupId,
            error: error instanceof Error ? error.message : String(error)
          });
        }
      }

      const dueReminders = reminderStore.getDueItems(new Date());
      for (const item of dueReminders) {
        const groupId = String(item.groupId || '').trim();
        const message = String(item.text || '').trim();
        if (!groupId || !message) continue;

        const senderTag = item.senderNumber ? `@${item.senderNumber} ` : '';
        const reminderText = `Lembrete ${senderTag}: ${message}`;

        try {
          await client.sendMessage(groupId, reminderText);
          await reminderStore.markSent(item.id, new Date());
          logger.info('Lembrete enviado com sucesso', {
            reminderId: item.id,
            groupId,
            dueAt: item.dueAt
          });
        } catch (error) {
          logger.error('Falha ao enviar lembrete', {
            reminderId: item.id,
            groupId,
            error: error instanceof Error ? error.message : String(error)
          });
        }
      }

    } catch (error) {
      logger.error('Falha no scheduler de mensagens diarias', {
        error: error instanceof Error ? error.message : String(error)
      });
    } finally {
      dailySchedulerRunning = false;
    }
  };

  void tick();
  dailySchedulerTimer = setInterval(() => {
    void tick();
  }, 5000);
  dailySchedulerTimer.unref?.();
  logger.info('Scheduler de mensagens diarias ativo', { intervalMs: 5000 });
}

async function extractQuotedContext(message) {
  if (!message?.hasQuotedMsg || typeof message.getQuotedMessage !== 'function') {
    return {
      quotedMessageId: null,
      quotedSenderJid: null
    };
  }

  try {
    const quoted = await message.getQuotedMessage();
    return {
      quotedMessageId: quoted?.id?._serialized || null,
      quotedSenderJid: quoted?.author || quoted?.from || quoted?.id?.participant || null
    };
  } catch {
    return {
      quotedMessageId: null,
      quotedSenderJid: null
    };
  }
}

function extractSerializedWid(value) {
  if (!value) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'object') {
    if (typeof value._serialized === 'string') return value._serialized;
    if (typeof value.user === 'string' && typeof value.server === 'string') return `${value.user}@${value.server}`;
    if (value.id) return extractSerializedWid(value.id);
  }
  return '';
}

function extractGroupJidFromAny(value, visited = new WeakSet()) {
  if (!value) return '';

  if (typeof value === 'string') {
    return value.endsWith('@g.us') ? value : '';
  }

  if (typeof value !== 'object') return '';
  if (visited.has(value)) return '';
  visited.add(value);

  const serialized = extractSerializedWid(value);
  if (serialized.endsWith('@g.us')) return serialized;

  for (const key of Object.keys(value)) {
    const nested = extractGroupJidFromAny(value[key], visited);
    if (nested) return nested;
  }

  return '';
}

function extractGroupNameFromInviteInfo(inviteInfo) {
  if (!inviteInfo || typeof inviteInfo !== 'object') return '';

  const nameCandidates = [
    inviteInfo.subject,
    inviteInfo.groupName,
    inviteInfo.name,
    inviteInfo.title,
    inviteInfo.formattedTitle
  ];

  for (const value of nameCandidates) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }

  return '';
}

function isGroupParticipantAuthorized(groupChat) {
  if (config.allowAllSenders) return true;
  if (!Array.isArray(groupChat?.participants)) return false;

  return groupChat.participants.some((participant) => {
    const participantWid = extractSerializedWid(participant?.id || participant);
    const participantNumber = normalizePhoneNumber(participantWid.split('@')[0]);
    if (!participantNumber) return false;

    return config.authorizedSenderNumbers.some((allowed) => senderMatchesAllowed(participantNumber, allowed));
  });
}

function pickBestGroupCandidate(candidates) {
  if (!candidates.length) return null;
  if (candidates.length === 1) return candidates[0];

  const sorted = [...candidates].sort((a, b) => {
    const ta = Number(a.timestamp || 0);
    const tb = Number(b.timestamp || 0);
    return tb - ta;
  });

  return sorted[0];
}

function setAuthorizedGroupJid(groupJid, source) {
  if (!groupJid) return;
  activeGroupJid = groupJid;
  refreshResponseGroupsFromStore();
  logger.info('Grupo autorizado definido', { groupJid, source });
  updateRuntimeState({
    authorizedGroupJid: groupJid,
    responseGroupJids: getEffectiveResponseGroupJids(),
    lastError: null
  });
}

async function chatContainsNotificationMarker(chat) {
  const marker = foldLookupText(config.notificationGroupMarkerText);
  if (!marker) return false;

  const recentCandidates = [
    chat?.lastMessage?.body,
    chat?.lastMessage?.caption,
    chat?.lastMessage?._data?.body
  ];

  if (recentCandidates.some((item) => textContainsNotificationMarker(item))) {
    return true;
  }

  if (typeof chat?.fetchMessages !== 'function') return false;

  try {
    const messages = await chat.fetchMessages({ limit: 12 });
    return messages.some((item) => textContainsNotificationMarker(item?.body || item?.caption || ''));
  } catch (error) {
    logger.debug('Falha ao ler mensagens recentes para descoberta do grupo de notificacoes', {
      error: error instanceof Error ? error.message : String(error)
    });
    return false;
  }
}

async function discoverNotificationGroupFromChats(client) {
  if (activeNotificationGroupJid || resolvingNotificationGroup) {
    return activeNotificationGroupJid;
  }

  const shouldDiscover = Boolean(config.notificationGroupName || config.notificationGroupMarkerText);
  if (!shouldDiscover) return '';

  resolvingNotificationGroup = true;
  try {
    const chats = await client.getChats();
    const groups = chats.filter((chat) => chat.isGroup);
    const candidates = [];

    for (const group of groups) {
      const groupJid = extractSerializedWid(group.id);
      if (!groupJid || groupJid === activeGroupJid) continue;

      const groupName = extractGroupNameFromChat(group);
      const matchesName = groupNameMatchesNotificationTarget(groupName);
      const matchesMarker = await chatContainsNotificationMarker(group);
      if (!matchesName && !matchesMarker) continue;

      candidates.push({
        groupJid,
        groupName,
        matchesName,
        matchesMarker,
        timestamp: Number(group.timestamp || group.lastMessage?.timestamp || 0)
      });
    }

    if (!candidates.length) {
      logger.warn('Nenhum grupo de notificacoes encontrado por varredura de chats', {
        notificationGroupNameConfigured: Boolean(config.notificationGroupName),
        notificationMarkerConfigured: Boolean(config.notificationGroupMarkerText)
      });
      return '';
    }

    candidates.sort((left, right) => {
      const byMarker = Number(right.matchesMarker) - Number(left.matchesMarker);
      if (byMarker) return byMarker;
      const byName = Number(right.matchesName) - Number(left.matchesName);
      if (byName) return byName;
      return right.timestamp - left.timestamp;
    });

    const picked = candidates[0];
    setNotificationGroupJid(picked.groupJid, 'chat_discovery', {
      groupName: picked.groupName || null,
      matchesName: picked.matchesName,
      matchesMarker: picked.matchesMarker,
      candidates: candidates.length
    });
    return picked.groupJid;
  } finally {
    resolvingNotificationGroup = false;
  }
}

async function maybeCaptureNotificationGroupFromForeignMessage(message) {
  if (activeNotificationGroupJid) return false;

  const groupId = String(message?.from || '').trim();
  if (!groupId || groupId === activeGroupJid || !groupId.endsWith('@g.us')) return false;

  let groupName = '';
  let matchesName = false;
  try {
    const chat = await message.getChat();
    groupName = extractGroupNameFromChat(chat);
    matchesName = groupNameMatchesNotificationTarget(groupName);
  } catch {
    // segue com deteccao por marcador.
  }

  const matchesMarker = textContainsNotificationMarker(message?.body || '');
  if (!matchesName && !matchesMarker) return false;

  setNotificationGroupJid(groupId, 'foreign_group_message', {
    groupName: groupName || null,
    matchesName,
    matchesMarker
  });
  return true;
}

async function discoverGroupFromChats(client, inviteGroupName) {
  const chats = await client.getChats();
  const groups = chats.filter((chat) => chat.isGroup);

  if (!groups.length) {
    logger.warn('Nenhum grupo encontrado na sessao para descoberta automatica.');
    return '';
  }

  const participantFiltered = groups.filter((group) => isGroupParticipantAuthorized(group));
  let candidates = participantFiltered.length ? participantFiltered : groups;

  if (inviteGroupName) {
    const byName = candidates.filter((group) => String(group.name || '').trim() === inviteGroupName);
    if (byName.length) {
      candidates = byName;
    }
  }

  const picked = pickBestGroupCandidate(candidates);
  if (!picked) return '';

  const jid = extractSerializedWid(picked.id);
  if (!jid) return '';

  logger.info('Grupo descoberto por varredura de chats', {
    groupJid: jid,
    groupName: picked.name || null,
    candidates: candidates.length,
    usedInviteGroupName: Boolean(inviteGroupName)
  });

  return jid;
}

async function resolveGroupFromInvite(client) {
  if (activeGroupJid || !config.groupInviteLink || resolvingGroup) return;
  resolvingGroup = true;

  try {
    const inviteCode = extractInviteCode(config.groupInviteLink);
    if (!inviteCode) {
      const reason = 'GROUP_INVITE_LINK invalido. Nao foi possivel extrair codigo do convite.';
      logger.error(reason);
      updateRuntimeState({ lastError: reason, whatsappStatus: 'erro_convite' });
      return;
    }

    let inviteInfo = null;
    let inviteGroupName = '';
    try {
      inviteInfo = await client.getInviteInfo(inviteCode);
      inviteGroupName = extractGroupNameFromInviteInfo(inviteInfo);

      const jidFromInviteInfo = extractGroupJidFromAny(inviteInfo);
      if (jidFromInviteInfo) {
        setAuthorizedGroupJid(jidFromInviteInfo, 'invite_info');
        return;
      }
    } catch (error) {
      logger.warn('Nao foi possivel ler metadados do convite. Seguindo com fallback.', {
        error: error instanceof Error ? error.message : String(error)
      });
    }

    logger.info('Tentando resolver grupo via convite...');

    try {
      const joinedGroupJid = await client.acceptInvite(inviteCode);
      if (joinedGroupJid) {
        setAuthorizedGroupJid(joinedGroupJid, 'accept_invite');
        return;
      }
    } catch (error) {
      // Se ja estiver no grupo, esse passo pode falhar. Tentamos descoberta por chats.
      logger.warn('acceptInvite falhou, tentando descoberta por chats', {
        error: error instanceof Error ? error.message : String(error)
      });
    }

    const discoveredJid = await discoverGroupFromChats(client, inviteGroupName);
    if (discoveredJid) {
      setAuthorizedGroupJid(discoveredJid, 'chat_discovery');
      return;
    }

    const reason = 'Nao foi possivel resolver o grupo autorizado automaticamente.';
    logger.error(reason);
    updateRuntimeState({ lastError: reason, whatsappStatus: 'erro_convite' });
  } finally {
    resolvingGroup = false;
  }
}

await accessControl.ensureReady();
await botDatabase.ensureReady();
await settingsStore.ensureReady();
await mediaStore.ensureReady();
await scheduledMessagesStore.ensureReady();
await reminderStore.ensureReady();
await groupStore.ensureReady();

if (!activeGroupJid) {
  const selectedFromStore = String(groupStore.getSelectedGroupId() || '').trim();
  const primaryFromStore = String(groupStore.getPrimaryGroupId() || '').trim();
  activeGroupJid = selectedFromStore || primaryFromStore || activeGroupJid;
}
refreshResponseGroupsFromStore();
const runtimeSettings = settingsStore.get();

if (config.panelBootstrapUsername || config.panelBootstrapPassword) {
  if (!config.panelBootstrapUsername || !config.panelBootstrapPassword) {
    logger.warn('Bootstrap do painel ignorado: defina usuario e senha juntos.', {
      usernameConfigured: Boolean(config.panelBootstrapUsername),
      passwordConfigured: Boolean(config.panelBootstrapPassword)
    });
  } else {
    const bootstrapResult = await botDatabase.ensurePanelBootstrapUser(
      config.panelBootstrapUsername,
      config.panelBootstrapPassword,
      { allowWeakPassword: true }
    );

    if (bootstrapResult.ok && bootstrapResult.user) {
      logger.info('Usuario bootstrap do painel garantido', {
        username: bootstrapResult.user.username,
        created: Boolean(bootstrapResult.created),
        updated: Boolean(bootstrapResult.updated)
      });

      if (config.panelBootstrapPassword.length < 8) {
        logger.warn('Senha bootstrap do painel abaixo da politica padrao de 8 caracteres', {
          username: bootstrapResult.user.username,
          length: config.panelBootstrapPassword.length
        });
      }
    } else {
      logger.warn('Falha ao garantir usuario bootstrap do painel', {
        username: config.panelBootstrapUsername,
        message: bootstrapResult.message || 'erro desconhecido'
      });
    }
  }
}

logger.info('Iniciando bot com filtro de grupo', {
  group: activeGroupJid || null,
  responseGroups: getEffectiveResponseGroupJids(),
  privateAllowedNumbers: accessControl.allPrivateNumbers(),
  notificationGroup: activeNotificationGroupJid || null,
  codexBin: config.codexBin,
  inviteLinkConfigured: Boolean(config.groupInviteLink),
  requireMention: runtimeSettings.requireMention,
  allowAllSenders: config.allowAllSenders,
  authorizedSenderNumbers: config.authorizedSenderNumbers,
  effectiveAuthorizedNumbers: accessControl.allAuthorizedNumbers(),
  allowAllAdmins: config.allowAllAdmins,
  adminSenderNumbers: config.adminSenderNumbers,
  effectiveAdminNumbers: accessControl.allAdminNumbers(),
  allowAllFulls: config.allowAllFulls,
  fullSenderNumbers: config.fullSenderNumbers,
  effectiveFullNumbers: accessControl.allFullNumbers(),
  moderationEnabled: config.moderationEnabled,
  moderationMaxWarnings: config.moderationMaxWarnings,
  moderationDeleteMessage: config.moderationDeleteMessage,
  timeoutMs: runtimeSettings.codexTimeoutMs,
  maxInputChars: runtimeSettings.maxInputChars,
  maxOutputChars: runtimeSettings.maxOutputChars,
  cooldownMs: config.responseCooldownMs
});

updateRuntimeState({
  whatsappStatus: 'iniciando',
  lastError: null,
  authorizedGroupJid: activeGroupJid || null,
  responseGroupJids: getEffectiveResponseGroupJids(),
  privateAllowedNumbers: accessControl.allPrivateNumbers(),
  notificationGroupJid: activeNotificationGroupJid || null
});

const moderation = new ModerationEngine(config.moderationFile);
let client = null;
const panel = startWebPanel({
  moderation,
  groupControl: {
    getClient: () => client,
    getGroupId: () => String(activeGroupJid || '').trim()
  },
  inbox: {
    getMessages: () => inboxGetAll(),
    markRead: (id) => inboxMarkRead(id),
    sendReply: async (chatId, text) => {
      if (!client) throw new Error('WhatsApp client nao disponivel');
      return client.sendMessage(String(chatId), String(text));
    }
  }
});
const queue = new GroupQueue(config.responseCooldownMs);

client = createWhatsappClient({
  getAuthorizedGroupJid: () => activeGroupJid,
  getResponseGroupJids: () => getEffectiveResponseGroupJids(),
  onQr: (qrDataUrl) => {
    updateRuntimeState({ whatsappStatus: 'aguardando_qr', qrDataUrl, lastError: null });
  },
  onReady: () => {
    updateRuntimeState({
      whatsappStatus: 'pronto',
      qrDataUrl: null,
      lastError: null,
      authorizedGroupJid: activeGroupJid || null,
      responseGroupJids: getEffectiveResponseGroupJids(),
      privateAllowedNumbers: accessControl.allPrivateNumbers(),
      notificationGroupJid: activeNotificationGroupJid || null
    });
    startDailyScheduler(client);
    void (async () => {
      await resolveGroupFromInvite(client);
      await discoverNotificationGroupFromChats(client);
      await notifyServiceReady(client, 'on_ready');
      selfHealingService.startWatchdog(client, askAI, getNotificationGroupJid);
      startBackupScheduler(config.backupSchedulerIntervalHours, config.backupSchedulerMode);
    })();
  },
  onAuthenticated: () => {
    updateRuntimeState({ whatsappStatus: 'autenticado', qrDataUrl: null, lastError: null });
  },
  onAuthFailure: (message) => {
    updateRuntimeState({ whatsappStatus: 'erro_auth', lastError: message || 'Falha de autenticacao' });
    void selfHealingService.notifyAuthFailure(message);
  },
  onDisconnected: (reason) => {
    updateRuntimeState({ whatsappStatus: 'desconectado', lastError: String(reason || 'Desconectado') });
    void selfHealingService.notifyDisconnect(reason);
  },
  onStateChange: (state) => {
    const normalizedState = String(state || '').toLowerCase();
    const nextState = { whatsappStatus: `estado_${normalizedState}` };
    if (normalizedState === 'connected') {
      nextState.qrDataUrl = null;
    }
    updateRuntimeState(nextState);
  },
  onForeignGroupMessage: (message) => {
    void maybeCaptureNotificationGroupFromForeignMessage(message);
  },
  onGroupMessage: (message, context) => {
    const groupId = message.from;
    const text = message.body?.trim() || '';
    if (!text) return;

    void (async () => {
      try {
        const isAdminSender = isAdminSenderContext(context);

        if (config.moderationIgnoreAdmins && isAdminSender) {
          return;
        }

        const violation = await moderation.registerViolation({
          groupId,
          senderJid: context?.senderJid || '',
          senderNumber: context?.senderNumber || '',
          rawText: text
        });

        if (!violation.matched) return;

        if (config.moderationDeleteMessage) {
          try {
            await message.delete(true);
          } catch (error) {
            logger.warn('Falha ao apagar mensagem moderada', {
              error: error instanceof Error ? error.message : String(error)
            });
          }
        }

        const who = mentionFromContext(context);
        if (!violation.shouldRemove) {
          await client.sendMessage(
            groupId,
            `${who} aviso ${violation.warningCount}/${violation.maxWarnings}. Palavra bloqueada detectada (${violation.matches.join(', ')}).`
          );
          return;
        }

        await client.sendMessage(
          groupId,
          `${who} atingiu ${violation.maxWarnings} avisos por linguagem inapropriada e sera removido do grupo.`
        );

        try {
          const chat = await client.getChatById(groupId);
          const candidates = buildRemovalCandidates(context);
          let removed = false;

          if (chat?.isGroup && typeof chat.removeParticipants === 'function') {
            for (const candidate of candidates) {
              try {
                await chat.removeParticipants([candidate]);
                removed = true;
                break;
              } catch {
                // tenta proximo candidato.
              }
            }
          }

          if (removed) {
            await client.sendMessage(groupId, `${who} removido do grupo.`);
          } else {
            await client.sendMessage(
              groupId,
              `Nao consegui remover ${who}. Verifique se o bot tem permissao de admin.`
            );
          }
        } catch (error) {
          await client.sendMessage(
            groupId,
            `Erro ao tentar remover participante: ${error instanceof Error ? error.message : String(error)}`
          );
        }
      } catch (error) {
        logger.error('Falha no fluxo de moderacao', {
          error: error instanceof Error ? error.message : String(error)
        });
      }
    })();
  },
  onUnauthorizedMessage: async (message, context) => {
    try {
      const text = String(message.body || '').trim();

      // Relay: encaminhar mensagens de contatos monitorados para o grupo
      try {
        const senderNum = String(context.senderNumber || '').replace(/\D/g, '');
        if (senderNum && client) {
          await relayChatStore.ensureReady();
          const relay = await relayChatStore.findActiveByTarget(senderNum);
          if (relay) {
            // Resolve contact display name
            let displayName = senderNum;
            try {
              const contact = await message.getContact();
              const name = contact?.pushname || contact?.name || '';
              if (name) displayName = `${name} (${senderNum})`;
            } catch {}

            let sent = null;
            try {
              const _relayTimeStr = new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
              if (message.hasMedia) {
                // Forward media (image, video, audio, document, sticker)
                const media = await message.downloadMedia();
                if (media) {
                  const caption = text
                    ? `📲 *${displayName}* ⏰ ${_relayTimeStr}:\n${text}\n\n_↩️ Cite para responder ou: !resp ${senderNum} <msg>_`
                    : `📲 *${displayName}* enviou uma mídia ⏰ ${_relayTimeStr}\n\n_↩️ !resp ${senderNum} <msg>_`;
                  sent = await client.sendMessage(relay.groupId, media, { caption });
                }
              }
              if (!sent) {
                if (!text) {
                  logger.debug('Relay: mensagem sem texto e sem midia, ignorando', { senderNum });
                  return;
                }
                const fwdMsg = `📲 *${displayName}* ⏰ ${_relayTimeStr}:\n${text}\n\n_↩️ Cite para responder ou: !resp ${senderNum} <msg>_`;
                sent = await client.sendMessage(relay.groupId, fwdMsg);
              }
              const sentId = sent?.id?._serialized || '';
              if (sentId) {
                await relayChatStore.addForwardedMessageId(relay.id, sentId);
              }
              logger.info('Mensagem relay encaminhada ao grupo', {
                senderNum,
                groupId: relay.groupId
              });
            } catch (fwdErr) {
              logger.warn('Falha ao encaminhar mensagem relay ao grupo', {
                error: fwdErr instanceof Error ? fwdErr.message : String(fwdErr)
              });
            }
            return;
          }
        }
      } catch (relayErr) {
        logger.warn('Erro ao verificar relay para mensagem privada', {
          error: relayErr instanceof Error ? relayErr.message : String(relayErr)
        });
      }

      if (!text) return;

      const ts = Date.now();
      const id = `${ts}-${Math.random().toString(36).slice(2, 8)}`;
      const entry = {
        id,
        ts,
        chatId: String(context.chatId || message.from || ''),
        chatType: String(context.chatType || 'unknown'),
        senderJid: String(context.senderJid || ''),
        senderNumber: String(context.senderNumber || ''),
        text,
        read: false
      };
      inboxPush(entry);
      panel.emitInboxMessage(entry);
    } catch (error) {
      logger.warn('Falha ao capturar mensagem de nao autorizado para inbox', {
        error: error instanceof Error ? error.message : String(error)
      });
    }
  },
  onGroupMedia: (message, context) => {
    const groupId = message.from;

    void (async () => {
      try {
        const result = await mediaStore.ingestMessageMedia({
          message,
          groupId,
          senderJid: context?.senderJid || '',
          senderNumber: context?.senderNumber || ''
        });

        if (!result.saved) {
          logger.debug('Midia recebida nao indexada', {
            groupId,
            reason: result.reason || 'desconhecido',
            messageType: message.type || 'unknown',
            message: result.message || null
          });
          return;
        }

        logger.info('Midia recebida salva com sucesso', {
          groupId,
          mediaId: result.entry?.id || null,
          mediaType: result.entry?.mediaType || null,
          mimeType: result.entry?.mimeType || null,
          sizeBytes: result.entry?.sizeBytes || null
        });

        await appendConversationEntry({
          groupId,
          direction: 'inbound',
          text: `[midia recebida] ${result.entry?.mediaType || 'arquivo'} ${result.entry?.fileName || ''}`.trim(),
          senderJid: context?.senderJid || null,
          senderNumber: context?.senderNumber || null,
          mentionedIds: Array.isArray(context?.mentionedIds) ? context.mentionedIds : []
        });

        const isAudio = String(result.entry?.mediaType || '').toLowerCase() === 'audio';
        const isImage = String(result.entry?.mediaType || '').toLowerCase() === 'image';
        const isText = String(result.entry?.mediaType || '').toLowerCase() === 'text' ||
          String(result.entry?.mimeType || '').toLowerCase().startsWith('text/plain');

        if (isText) {
          const senderNumber = context?.senderNumber || '';
          const mention = mentionFromContext(context);
          const fileName = result.entry?.fileName || result.entry?.id || 'arquivo.txt';
          setPendingTxtAction(groupId, senderNumber, result.entry);
          const choiceMsg = `${mention} ✅ O que deseja fazer com *${fileName}*?\n\n1️⃣ *ler* — exibir o conteudo na conversa\n2️⃣ *executar* — validar e executar como tarefa FULL`;
          await client.sendMessage(groupId, choiceMsg);
          await appendConversationEntry({
            groupId,
            direction: 'outbound',
            text: choiceMsg,
            senderJid: null,
            senderNumber: null
          });
          return;
        }

        if (isImage) {
          const senderNumber = context?.senderNumber || '';
          const mention = mentionFromContext(context);
          setPendingImageAction(groupId, senderNumber, result.entry);
          const choiceMsg = `${mention} imagem recebida! O que deseja fazer?\n\n1️⃣ *salvar* — salvar a imagem\n2️⃣ *extrair* — extrair texto da imagem (OCR)\n3️⃣ *analisar* — análise visual com IA\n\n💡 _Ou envie diretamente uma pergunta sobre a imagem._`;
          await client.sendMessage(groupId, choiceMsg);
          await appendConversationEntry({
            groupId,
            direction: 'outbound',
            text: choiceMsg,
            senderJid: null,
            senderNumber: null
          });
          return;
        }

        if (!isAudio) return;

        const waitReply = `${mentionFromContext(context)} audio identificado. Aguarde enquanto faco a transcricao.`;
        await client.sendMessage(groupId, waitReply);
        await appendConversationEntry({
          groupId,
          direction: 'outbound',
          text: waitReply,
          senderJid: null,
          senderNumber: null
        });

        const transcript = await transcribeMediaEntry(result.entry);
        if (!transcript.ok) {
          logger.warn('Falha na transcricao automatica de audio', {
            groupId,
            mediaId: result.entry?.id || null,
            reason: transcript.reason || 'desconhecido',
            skipped: Boolean(transcript.skipped)
          });

          if (config.audioTranscriptionNotifyErrors && !transcript.skipped) {
            await client.sendMessage(groupId, 'Nao consegui transcrever este audio agora. Tente novamente em instantes.');
          }
          return;
        }

        const transcriptReply = buildAudioTranscriptionReply(context, transcript.text || '');
        if (!transcriptReply) return;

        // Armazena transcricao pendente para oferecer resumo
        const senderNumber = context?.senderNumber || '';
        const rawTranscriptText = transcript.text || '';
        if (rawTranscriptText.length > 80) {
          setPendingAudioSummary(groupId, senderNumber, rawTranscriptText);
          const summaryHint = '\n\n💡 _Responda *resumir* para obter um resumo do audio._';
          await client.sendMessage(groupId, transcriptReply + summaryHint);
        } else {
          await client.sendMessage(groupId, transcriptReply);
        }
        await appendConversationEntry({
          groupId,
          direction: 'outbound',
          text: transcriptReply,
          senderJid: null,
          senderNumber: null
        });

        logger.info('Audio transcrito com sucesso', {
          groupId,
          mediaId: result.entry?.id || null,
          provider: transcript.provider || 'desconhecido',
          chars: transcriptReply.length
        });
      } catch (error) {
        logger.error('Falha ao salvar midia recebida', {
          error: error instanceof Error ? error.message : String(error)
        });
      }
    })();
  },
  onEligibleMessage: (message, context) => {
    const groupId = message.from;

    void queue
      .enqueue(groupId, async () => {
        const startedAt = Date.now();
        const text = message.body.trim();
        const preview =
          config.logMessagePreviewChars > 0
            ? text.slice(0, config.logMessagePreviewChars)
            : undefined;
        logger.info('Mensagem elegivel recebida', {
          groupId,
          from: context?.senderJid || message.author || message.id?.participant || 'desconhecido',
          senderNumber: context?.senderNumber || 'desconhecido',
          chars: text.length,
          ...(preview ? { preview } : {})
        });

        const moderationMatches = moderation.findKeywordMatches(text);
        if (moderation.isEnabled() && moderationMatches.length && !isAdminSenderContext(context)) {
          logger.warn('Mensagem bloqueada por moderacao antes da resposta', {
            groupId,
            sender: context?.senderJid || null,
            moderationMatches
          });
          return;
        }

        let _quotedMessageId = null;
        try {
          const quotedContext = await extractQuotedContext(message);
          _quotedMessageId = quotedContext.quotedMessageId || null;
          await appendConversationEntry({
            groupId,
            direction: 'inbound',
            text,
            senderJid: context?.senderJid || null,
            senderNumber: context?.senderNumber || null,
            mentionedIds: Array.isArray(context?.mentionedIds) ? context.mentionedIds : [],
            quotedMessageId: quotedContext.quotedMessageId,
            quotedSenderJid: quotedContext.quotedSenderJid
          });
        } catch (error) {
          logger.warn('Falha ao salvar historico de entrada', {
            error: error instanceof Error ? error.message : String(error)
          });
        }

        // Relay reply: se o usuário citou (quote) uma mensagem encaminhada pelo relay,
        // reencaminha a resposta de volta para o contato original.
        if (_quotedMessageId && client) {
          try {
            await relayChatStore.ensureReady();
            const relayForReply = await relayChatStore.findRelayByForwardedMessageId(_quotedMessageId, groupId);
            if (relayForReply) {
              const targetJid = relayForReply.targetJid || `${relayForReply.targetNumber}@c.us`;
              try {
                const _relaySenderName = await resolveSenderName(message, context?.senderNumber);
                await client.sendMessage(targetJid, buildRelayHeader(_relaySenderName) + text);
                const confirmMsg = `✅ Resposta enviada para *${relayForReply.targetNumber}*.`;
                await client.sendMessage(groupId, confirmMsg);
                await appendConversationEntry({
                  groupId,
                  direction: 'outbound',
                  text: confirmMsg,
                  senderJid: null,
                  senderNumber: null
                });
                logger.info('Resposta relay enviada ao contato', {
                  targetNumber: relayForReply.targetNumber,
                  groupId
                });
              } catch (sendErr) {
                const errMsg = `❌ Falha ao enviar resposta para ${relayForReply.targetNumber}: ${sendErr instanceof Error ? sendErr.message : String(sendErr)}`;
                await client.sendMessage(groupId, errMsg);
                logger.warn('Falha ao enviar resposta relay', {
                  error: sendErr instanceof Error ? sendErr.message : String(sendErr)
                });
              }
              return;
            }
          } catch (relayReplyErr) {
            logger.warn('Erro ao verificar relay reply por quote', {
              error: relayReplyErr instanceof Error ? relayReplyErr.message : String(relayReplyErr)
            });
          }
        }

        const localActionContext = {
          groupId,
          authorizedGroupId: activeGroupJid || '',
          notificationGroupId: getNotificationGroupJid(),
          getNotificationGroupId: () => getNotificationGroupJid(),
          senderJid: context?.senderJid || null,
          senderNumber: context?.senderNumber || null,
          authorizationMode: context?.authorizationMode || 'authorized',
          isGroupAdminSender: Boolean(context?.isGroupAdminSender),
          chatType: context?.chatType || (String(groupId).endsWith('@g.us') ? 'group' : 'private'),
          mentionedIds: Array.isArray(context?.mentionedIds) ? context.mentionedIds : [],
          message,
          client,
          moderation
        };

        // Verificar se há arquivo txt pendente aguardando resposta do usuário
        const senderNum = context?.senderNumber || '';
        if (hasPendingTxtAction(groupId, senderNum)) {
          const normalized = text.toLowerCase().trim().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
          const wantsRead = /^(1|ler|leia|exibir|mostrar|ver|read|show)$/.test(normalized);
          const wantsExecute = /^(2|executar|execute|exec|rodar|run|valida|validar|tarefa|task|full)$/.test(normalized);

          if (wantsRead || wantsExecute) {
            const pendingEntry = popPendingTxtAction(groupId, senderNum);
            const mention = mentionFromContext(context);

            if (pendingEntry) {
              if (wantsRead) {
                // Lê o conteúdo do arquivo e exibe
                const waitReply = `${mention} lendo arquivo, aguarde...`;
                await client.sendMessage(groupId, waitReply);
                try {
                  const { readFileSync } = await import('node:fs');
                  const fileContent = readFileSync(pendingEntry.absolutePath, 'utf8');
                  const fileName = pendingEntry.fileName || pendingEntry.id || 'arquivo.txt';
                  const preview = fileContent.length > 8000 ? fileContent.slice(0, 8000) + `\n\n...(${fileContent.length - 8000} chars restantes)` : fileContent;
                  const readReply = `${mention} 📄 *${fileName}*:\n\n${preview}`;
                  await client.sendMessage(groupId, readReply);
                  await appendConversationEntry({ groupId, direction: 'outbound', text: readReply, senderJid: null, senderNumber: null });
                } catch (readErr) {
                  const errReply = `${mention} não consegui ler o arquivo agora. Ele ainda está salvo na mídia (ID: ${pendingEntry.id}).`;
                  await client.sendMessage(groupId, errReply);
                  await appendConversationEntry({ groupId, direction: 'outbound', text: errReply, senderJid: null, senderNumber: null });
                  logger.error('Falha ao ler arquivo txt pendente', { error: readErr instanceof Error ? readErr.message : String(readErr) });
                }
              } else {
                // Executa como job FULL completo — sem truncamento, sem sanitização de linhas
                try {
                  const { readFileSync } = await import('node:fs');
                  const fileContent = readFileSync(pendingEntry.absolutePath, 'utf8');
                  const fileName = pendingEntry.fileName || pendingEntry.id || 'arquivo.txt';
                  const requestText = `Arquivo recebido via WhatsApp: **${fileName}**\n\nConteudo completo do arquivo:\n\`\`\`\n${fileContent}\n\`\`\`\n\nAnalise este arquivo, execute todas as instrucoes e tarefas descritas nele. Crie, edite, modifique, teste e valide o que for necessario. Nao ha restricao alguma. Ao concluir, retorne o resultado completo e detalhado de tudo que foi feito.`;

                  const fullContext = {
                    ...localActionContext,
                    isFullSender: true,
                    senderNumber: senderNum
                  };
                  const fullResult = await startFullAutoJobDirect(requestText, fullContext);

                  if (fullResult?.handled) {
                    if (fullResult.response) {
                      await client.sendMessage(groupId, fullResult.response);
                      await appendConversationEntry({ groupId, direction: 'outbound', text: fullResult.response, senderJid: null, senderNumber: null });
                    }
                    if (typeof fullResult.afterSend === 'function') {
                      if (fullResult.runAfterSendInBackground) {
                        Promise.resolve()
                          .then(() => fullResult.afterSend())
                          .catch((bgErr) => {
                            logger.error('Falha em job FULL de arquivo txt (background)', {
                              error: bgErr instanceof Error ? bgErr.message : String(bgErr)
                            });
                          });
                      } else {
                        await fullResult.afterSend();
                      }
                    }
                  } else {
                    const errReply = `${mention} ❌ Nao foi possivel iniciar o job FULL para este arquivo.`;
                    await client.sendMessage(groupId, errReply);
                    await appendConversationEntry({ groupId, direction: 'outbound', text: errReply, senderJid: null, senderNumber: null });
                  }
                } catch (execErr) {
                  const errReply = `${mention} ❌ Erro ao iniciar execucao do arquivo (${execErr instanceof Error ? execErr.message : 'erro desconhecido'}). O arquivo esta salvo (ID: ${pendingEntry.id}).`;
                  await client.sendMessage(groupId, errReply);
                  await appendConversationEntry({ groupId, direction: 'outbound', text: errReply, senderJid: null, senderNumber: null });
                  logger.error('Falha ao executar configuracao de arquivo txt pendente', { error: execErr instanceof Error ? execErr.message : String(execErr) });
                }
              }
            }
            return;
          }
          // Resposta não reconhecida: cancela pendência
          popPendingTxtAction(groupId, senderNum);
          const cancelReply = `${mentionFromContext(context)} resposta não reconhecida. O arquivo foi salvo na mídia. Envie novamente e responda *ler* ou *executar*.`;
          await client.sendMessage(groupId, cancelReply);
          await appendConversationEntry({ groupId, direction: 'outbound', text: cancelReply, senderJid: null, senderNumber: null });
          return;
        }

        // Verificar se há ação pendente de imagem aguardando resposta do usuário
        if (hasPendingImageAction(groupId, senderNum)) {
          const normalized = text.toLowerCase().trim().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
          const wantsSave = /^(1|salvar|salva|guardar|guarda|save)$/.test(normalized);
          const wantsExtract = /^(2|extrair|extrai|extrair texto|ocr|ler|leia|texto|extract)$/.test(normalized);
          const wantsAnalyze = /^(3|analisar|analisa|analise|ver|descrever|descreve|descricao|visao|visual|ia|analise visual)$/.test(normalized);

          if (wantsSave || wantsExtract || wantsAnalyze) {
            const pendingEntry = popPendingImageAction(groupId, senderNum);
            const mention = mentionFromContext(context);

            if (pendingEntry) {
              if (wantsSave) {
                const saveReply = `${mention} imagem salva com sucesso! 📁 (ID: ${pendingEntry.id})`;
                await client.sendMessage(groupId, saveReply);
                await appendConversationEntry({ groupId, direction: 'outbound', text: saveReply, senderJid: null, senderNumber: null });
              } else if (wantsExtract) {
                const waitReply = `${mention} extraindo texto da imagem, aguarde...`;
                await client.sendMessage(groupId, waitReply);
                try {
                  const ocrResponse = await askAI(
                    'Extraia todo o texto visível nesta imagem. Retorne apenas o texto extraído, sem explicações.',
                    {
                      groupId,
                      senderNumber: senderNum,
                      imageAttachments: [{ path: pendingEntry.absolutePath, source: 'ocr_request' }]
                    }
                  );
                  const ocrReply = `${mention} texto extraído da imagem:\n\n${ocrResponse}`;
                  await client.sendMessage(groupId, ocrReply);
                  await appendConversationEntry({ groupId, direction: 'outbound', text: ocrReply, senderJid: null, senderNumber: null });
                } catch (ocrErr) {
                  const errReply = `${mention} não consegui extrair o texto da imagem agora. Tente novamente.`;
                  await client.sendMessage(groupId, errReply);
                  await appendConversationEntry({ groupId, direction: 'outbound', text: errReply, senderJid: null, senderNumber: null });
                  logger.error('Falha ao extrair texto de imagem pendente', { error: ocrErr instanceof Error ? ocrErr.message : String(ocrErr) });
                }
              } else {
                // wantsAnalyze: análise visual com IA
                const waitReply = `${mention} analisando imagem com IA, aguarde...`;
                await client.sendMessage(groupId, waitReply);
                try {
                  const visionResult = await analyzeImageWithVision(
                    [pendingEntry.absolutePath],
                    '',
                    { groupId, senderNumber: senderNum }
                  );
                  const visionReply = visionResult.ok
                    ? `${mention} 🔍 *Análise visual da imagem:*\n\n${visionResult.description}\n\n📁 _Imagem salva (ID: ${pendingEntry.id})_`
                    : `${mention} não consegui analisar a imagem agora. A imagem foi salva (ID: ${pendingEntry.id}).`;
                  await client.sendMessage(groupId, visionReply);
                  await appendConversationEntry({ groupId, direction: 'outbound', text: visionReply, senderJid: null, senderNumber: null });
                } catch (visionErr) {
                  const errReply = `${mention} não consegui analisar a imagem agora. A imagem foi salva (ID: ${pendingEntry.id}).`;
                  await client.sendMessage(groupId, errReply);
                  await appendConversationEntry({ groupId, direction: 'outbound', text: errReply, senderJid: null, senderNumber: null });
                  logger.error('Falha na análise visual de imagem pendente', { error: visionErr instanceof Error ? visionErr.message : String(visionErr) });
                }
              }
            }
            return;
          }
          // Se resposta não reconhecida, avisar e manter pendência
          popPendingImageAction(groupId, senderNum);
          const cancelReply = `${mentionFromContext(context)} resposta não reconhecida. A imagem foi salva. Para analisar, envie a imagem novamente e responda *analisar*.`;
          await client.sendMessage(groupId, cancelReply);
          await appendConversationEntry({ groupId, direction: 'outbound', text: cancelReply, senderJid: null, senderNumber: null });
          return;
        }

        // Verificar se há transcrição pendente aguardando pedido de resumo
        if (hasPendingAudioSummary(groupId, senderNum)) {
          const normalizedAudio = text.toLowerCase().trim().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
          const wantsSummary = /^(resumir|resumo|resuma|resume|sintetizar|sintetize|sumarizar|sumarize)$/.test(normalizedAudio);

          if (wantsSummary) {
            const pendingText = popPendingAudioSummary(groupId, senderNum);
            const mention = mentionFromContext(context);

            if (pendingText) {
              const waitMsg = `${mention} gerando resumo do audio, aguarde...`;
              await client.sendMessage(groupId, waitMsg);
              try {
                const summaryResponse = await askAI(
                  `Resuma de forma clara e objetiva o seguinte texto transcrito de um audio. Destaque os pontos principais, decisoes e acoes mencionadas. Responda em portugues.\n\nTexto do audio:\n${pendingText}`,
                  { groupId, senderNumber: senderNum }
                );
                const summaryReply = `${mention} *Resumo do audio:*\n\n${summaryResponse}`;
                await client.sendMessage(groupId, summaryReply);
                await appendConversationEntry({ groupId, direction: 'outbound', text: summaryReply, senderJid: null, senderNumber: null });
              } catch (summaryErr) {
                const errReply = `${mention} nao consegui gerar o resumo do audio agora. Tente novamente.`;
                await client.sendMessage(groupId, errReply);
                await appendConversationEntry({ groupId, direction: 'outbound', text: errReply, senderJid: null, senderNumber: null });
                logger.error('Falha ao gerar resumo de audio', { error: summaryErr instanceof Error ? summaryErr.message : String(summaryErr) });
              }
            }
            return;
          }
          // Resposta diferente de resumir: descarta pendencia silenciosamente e continua fluxo normal
          popPendingAudioSummary(groupId, senderNum);
        }

        // Wizard de envio de mensagem relay (fluxo conversacional)
        if (hasPendingRelayWizard(groupId, senderNum)) {
          const wizard = pendingRelayWizards.get(`${groupId}::${senderNum}`);
          const mention = mentionFromContext(context);
          const reply = text.trim();
          if (wizard && !wizard.expiresAt || Date.now() <= (wizard?.expiresAt || 0)) {
            if (wizard.step === 'waiting_number') {
              const digits = reply.replace(/\D/g, '');
              if (digits.length < 8 || digits.length > 15) {
                await client.sendMessage(groupId, `${mention} Número inválido. Informe apenas os dígitos (ex: 5521999998888):`);
                await appendConversationEntry({ groupId, direction: 'outbound', text: `${mention} Número inválido.`, senderJid: null, senderNumber: null });
              } else {
                setPendingRelayWizard(groupId, senderNum, { step: 'waiting_message', targetNumber: digits });
                const askMsg = `${mention} Qual a mensagem você quer enviar para *${digits}*?`;
                await client.sendMessage(groupId, askMsg);
                await appendConversationEntry({ groupId, direction: 'outbound', text: askMsg, senderJid: null, senderNumber: null });
              }
              return;
            }
            if (wizard.step === 'waiting_message') {
              popPendingRelayWizard(groupId, senderNum);
              const targetNumber = wizard.targetNumber;
              const targetJid = `${targetNumber}@c.us`;
              let sendOk = false;
              let sendErr = '';
              try {
                const _relaySenderName = await resolveSenderName(message, senderNum);
                await client.sendMessage(targetJid, buildRelayHeader(_relaySenderName) + reply);
                sendOk = true;
              } catch (err) {
                sendErr = err instanceof Error ? err.message : String(err);
              }
              await relayChatStore.ensureReady();
              await relayChatStore.addRelay({ targetNumber, targetJid, groupId, requestedBy: senderNum });
              let resp;
              if (sendOk) {
                resp = `${mention} ✅ Mensagem enviada para *${targetNumber}*.\n📡 *Relay ativo* — toda resposta será encaminhada aqui.\n\n💡 *Para responder:* cite (quote) a mensagem encaminhada.\n🛑 *Encerrar:* @ encerrar mensagem ${targetNumber}`;
              } else {
                resp = `${mention} ⚠️ Relay registrado, mas erro ao enviar: ${sendErr}\n\n🛑 *Encerrar:* @ encerrar mensagem ${targetNumber}`;
              }
              await client.sendMessage(groupId, resp);
              await appendConversationEntry({ groupId, direction: 'outbound', text: resp, senderJid: null, senderNumber: null });
              return;
            }
          }
          popPendingRelayWizard(groupId, senderNum);
        }

        const localAction = await tryHandleLocalAction(text, localActionContext);
        let resolvedLocalAction = localAction?.handled ? localAction : null;
        let thinkingMessageSent = false;

        // Wizard relay: ação especial que inicia o fluxo conversacional de envio
        if (localAction?.relayWizardStart) {
          const mention = mentionFromContext(context);
          setPendingRelayWizard(groupId, senderNum, { step: 'waiting_number' });
          const askMsg = `${mention} Para qual número você quer enviar a mensagem? (só os dígitos, ex: 5521999998888)`;
          await client.sendMessage(groupId, askMsg);
          await appendConversationEntry({ groupId, direction: 'outbound', text: askMsg, senderJid: null, senderNumber: null });
          return;
        }

        let response = '';
        if (localAction?.handled) {
          response = localAction.response || '';
        } else {
          // Modo silencioso: não chama IA quando ativado
          if (settingsStore.get().silentMode) {
            return;
          }
          {
            const currentSettings = settingsStore.get();
            const thinkingText = String(currentSettings.thinkingMessageText || config.thinkingMessageText || '').trim();
            if (currentSettings.showThinkingMessage && thinkingText) {
              try {
                await client.sendMessage(groupId, thinkingText);
                thinkingMessageSent = true;
              } catch {
                // nao bloqueia resposta final por falha no aviso de processamento.
              }
            }

            let recentContext = '';
            try {
              const recent = await listRecentConversationEntries(groupId, 8);
              recentContext = buildRecentContextText(recent);
            } catch {
              // sem contexto extra.
            }

            let conversationReferences = '';
            const webContextQuery = extractWebContextQuery(text);
            if (webContextQuery) {
              try {
                const search = await runWebSearch(webContextQuery);
                if (Array.isArray(search?.results) && search.results.length) {
                  conversationReferences = [
                    'Resultados de busca web relevantes para a solicitacao atual:',
                    search.summary,
                    'Use esse material apenas como apoio e deixe claro quando a resposta depender desses resultados.'
                  ].join('\n');
                }
              } catch (error) {
                logger.warn('Falha ao enriquecer contexto com busca web', {
                  error: error instanceof Error ? error.message : String(error),
                  query: webContextQuery
                });
              }
            }

            const imageAttachments = await resolveRelevantImageAttachments({
              text,
              context: {
                ...localActionContext,
                groupId
              },
              limit: 2,
              allowRecentFallback: true
            });

            response = await askAI(text, {
              groupId,
              senderNumber: context?.senderNumber || '',
              isAdminSender: isAdminSenderContext(context),
              isFullSender: false,
              recentContext,
              conversationReferences,
              imageAttachments
            });

            // Se a resposta usou imagens, cancela pendência do menu de imagem para
            // evitar que a próxima mensagem do usuário seja interceptada como opção do menu.
            if (imageAttachments.length > 0) {
              popPendingImageAction(groupId, senderNum);
            }

            const delegatedActionText = extractLocalActionDirective(response);
            if (delegatedActionText) {
              const delegatedAction = await tryHandleLocalAction(delegatedActionText, localActionContext);
              if (delegatedAction?.handled) {
                resolvedLocalAction = delegatedAction;
                response = delegatedAction.response || response;
              } else {
                const sanitized = stripLocalActionDirectives(response);
                response = sanitized || 'Nao consegui executar essa acao local agora. Tente novamente com mais detalhes.';
              }
            }
          }
        }

        if (!resolvedLocalAction) {
          const currentSettings = settingsStore.get();
          const fallbackSet = new Set(
            [config.fallbackMessage, currentSettings.fallbackMessage]
              .map((item) => String(item || '').trim())
              .filter(Boolean)
          );
          const normalizedResponse = String(response || '').trim();

          if (fallbackSet.has(normalizedResponse)) {
            // Auto-recuperacao: notificar circuito e enfileirar retry em background
            selfHealingService.checkAndNotifyCircuit();
            selfHealingService.queueRetry(groupId, text, { groupId, senderNumber: context?.senderNumber || '' }, mentionFromContext(context));
            try {
              if (shouldUseWebFallback(text)) {
                const search = await runWebSearch(text);
                response = `Nao consegui gerar a resposta completa da IA agora, mas trouxe um resumo por busca web:\n${search.summary}`;
                if (thinkingMessageSent) {
                  response = `${response}\n\n(Obs: resposta via busca web devido timeout do modelo principal.)`;
                }
              } else {
                response =
                  'Nao consegui concluir essa solicitacao agora. Tente novamente em instantes ou reformule em uma frase direta.';
              }
            } catch {
              // Mantem fallback original se busca falhar.
            }
          }
        }

        if (!resolvedLocalAction && !isFullSenderContext(context)) {
          response = sanitizeNonFullResponse(response);
        }

        if (Array.isArray(resolvedLocalAction?.mediaItems) && resolvedLocalAction.mediaItems.length) {
          if (response && response.trim()) {
            const safeResponse = stripLocalActionDirectives(response);
            if (safeResponse) {
              await client.sendMessage(groupId, safeResponse);
              response = safeResponse;
            }
          }

          for (const item of resolvedLocalAction.mediaItems) {
            try {
              if (!item?.path) continue;
              const media = MessageMedia.fromFilePath(item.path);
              const sent = await client.sendMessage(groupId, media, {
                caption: item.caption || ''
              });
              const sentMessageId = sent?.id?._serialized || '';
              if (item.mediaId && sentMessageId) {
                await mediaStore.bindMessageId(item.mediaId, sentMessageId);
              }
            } catch (error) {
              logger.error('Falha ao enviar item de midia no grupo', {
                error: error instanceof Error ? error.message : String(error),
                mediaId: item?.mediaId || null
              });
            }
          }
        } else if (resolvedLocalAction?.mediaPath) {
          try {
            const media = MessageMedia.fromFilePath(resolvedLocalAction.mediaPath);
            await client.sendMessage(groupId, media, {
              caption: resolvedLocalAction.mediaCaption || response || ''
            });
          } catch (error) {
            logger.error('Falha ao enviar midia no grupo', {
              error: error instanceof Error ? error.message : String(error)
            });
          }
        } else if (response && response.trim()) {
          const safeResponse = stripLocalActionDirectives(response);
          if (!safeResponse) {
            logger.warn('Resposta continha apenas diretiva LOCAL_ACTION nao resolvida. Nao enviada.', {
              groupId
            });
            await client.sendMessage(
              groupId,
              'Nao consegui executar essa acao local agora. Tente novamente com mais detalhes.'
            );
          } else {
            await client.sendMessage(groupId, safeResponse);
            response = safeResponse;
          }
        } else {
          logger.warn('Resposta vazia apos bridge. Nao enviada.');
          return;
        }

        if (typeof resolvedLocalAction?.afterSend === 'function') {
          const runInBackground = Boolean(resolvedLocalAction?.runAfterSendInBackground);
          if (runInBackground) {
            void Promise.resolve()
              .then(() => resolvedLocalAction.afterSend())
              .catch((error) => {
                logger.error('Falha em acao pos-envio local (background)', {
                  error: error instanceof Error ? error.message : String(error)
                });
              });
          } else {
            try {
              await resolvedLocalAction.afterSend();
            } catch (error) {
              logger.error('Falha em acao pos-envio local', {
                error: error instanceof Error ? error.message : String(error)
              });
            }
          }
        }

        try {
          await appendConversationEntry({
            groupId,
            direction: 'outbound',
            text: response || resolvedLocalAction?.mediaCaption || '[midia enviada]',
            senderJid: null,
            senderNumber: null
          });
        } catch (error) {
          logger.warn('Falha ao salvar historico de saida', {
            error: error instanceof Error ? error.message : String(error)
          });
        }

        logger.info('Resposta enviada ao grupo autorizado', {
          groupId,
          chars: (response || resolvedLocalAction?.mediaCaption || '').length,
          elapsedMs: Date.now() - startedAt
        });
      })
      .catch(async (error) => {
        const errorMessage = error instanceof Error ? error.message : String(error);

        logger.error('Falha durante processamento de mensagem', {
          error: errorMessage
        });

        updateRuntimeState({ lastError: errorMessage });

        try {
          await client.sendMessage(groupId, config.fallbackMessage);
        } catch (sendError) {
          logger.error('Falha ao enviar fallback ao grupo', {
            error: sendError instanceof Error ? sendError.message : String(sendError)
          });
        }
      });
  }
});

let shuttingDown = false;

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Timeout ao encerrar: ${label}`));
      }, ms);
      timer.unref?.();
    })
  ]);
}

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;

  logger.warn('Encerrando servicos', { signal });

  // Marcar jobs FULL que estejam em 'running' como error antes de sair
  // Evita jobs presos em estado inconsistente após restart
  selfHealingService.markStaleJobsAsError('Serviço reiniciado (shutdown) enquanto job estava em execução.');

  const forceExitTimer = setTimeout(() => {
    logger.error('Forcando encerramento do processo apos timeout de shutdown');
    process.exit(1);
  }, 12000);
  forceExitTimer.unref?.();

  if (dailySchedulerTimer) {
    clearInterval(dailySchedulerTimer);
    dailySchedulerTimer = null;
  }

  try {
    await withTimeout(client.destroy(), 7000, 'client.destroy');
  } catch (error) {
    logger.error('Erro ao encerrar cliente WhatsApp', {
      error: error instanceof Error ? error.message : String(error)
    });
  }

  try {
    await withTimeout(panel.close(), 4000, 'panel.close');
  } catch (error) {
    logger.error('Erro ao encerrar painel web', {
      error: error instanceof Error ? error.message : String(error)
    });
  }

  clearTimeout(forceExitTimer);
  process.exit(0);
}

// Auto-recuperacao: notificar antes de crash
process.on('uncaughtException', (err) => {
  logger.error('uncaughtException', { error: err instanceof Error ? err.message : String(err) });
  void selfHealingService.notifyPreCrash(err instanceof Error ? err.message : String(err))
    .finally(() => process.exit(1));
});

process.on('unhandledRejection', (reason) => {
  logger.warn('unhandledRejection', { reason: String(reason).slice(0, 200) });
});
process.on('SIGINT', () => {
  void shutdown('SIGINT');
});

process.on('SIGTERM', () => {
  void shutdown('SIGTERM');
});

client
  .initialize()
  .catch((error) => {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error('Falha ao iniciar cliente WhatsApp', { error: errorMessage });
    updateRuntimeState({ whatsappStatus: 'erro_init', lastError: errorMessage });
    process.exit(1);
  });
