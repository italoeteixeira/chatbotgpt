import dotenv from 'dotenv';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

// O projeto e administrado localmente via `.env`, entao ele deve prevalecer
// sobre variaveis antigas herdadas do shell/processo pai.
dotenv.config({ override: true });

function toPositiveInt(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

function toNonNegativeInt(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return parsed;
}

function toBoolean(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) return false;
  return fallback;
}

function parseCsv(value, fallback = []) {
  if (value === undefined || value === null || String(value).trim() === '') {
    return Array.from(new Set(fallback.map((item) => String(item || '').trim()).filter(Boolean)));
  }

  return Array.from(
    new Set(
      String(value)
        .split(',')
        .map((item) => String(item || '').trim())
        .filter(Boolean)
    )
  );
}

function parseReasoningEffort(value, fallback = 'low') {
  const normalized = String(value || '').trim().toLowerCase();
  if (['low', 'medium', 'high', 'xhigh'].includes(normalized)) return normalized;
  return fallback;
}

function normalizePhoneNumber(value) {
  return String(value || '').replace(/\D/g, '');
}

function parseAuthorizedSenders(value) {
  if (value === undefined || value === null || String(value).trim() === '') {
    return {
      allowAllSenders: false,
      authorizedSenderNumbers: ['21972163738']
    };
  }

  const normalized = String(value).trim().toLowerCase();
  if (normalized === 'all' || normalized === '*') {
    return {
      allowAllSenders: true,
      authorizedSenderNumbers: []
    };
  }

  if (normalized === 'none' || normalized === 'nenhum') {
    return {
      allowAllSenders: false,
      authorizedSenderNumbers: []
    };
  }

  const numbers = Array.from(
    new Set(
      String(value)
        .split(',')
        .map((item) => normalizePhoneNumber(item))
        .filter(Boolean)
    )
  );

  if (!numbers.length) {
    return {
      allowAllSenders: false,
      authorizedSenderNumbers: ['21972163738']
    };
  }

  return {
    allowAllSenders: false,
    authorizedSenderNumbers: numbers
  };
}

function parseAdminSenders(value, fallbackNumbers = []) {
  if (value === undefined || value === null || String(value).trim() === '') {
    const numbers = Array.from(new Set(fallbackNumbers.filter(Boolean)));
    return {
      allowAllAdmins: false,
      adminSenderNumbers: numbers
    };
  }

  const normalized = String(value).trim().toLowerCase();
  if (normalized === 'all' || normalized === '*') {
    return {
      allowAllAdmins: true,
      adminSenderNumbers: []
    };
  }

  if (normalized === 'none' || normalized === 'nenhum') {
    return {
      allowAllAdmins: false,
      adminSenderNumbers: []
    };
  }

  const numbers = Array.from(
    new Set(
      String(value)
        .split(',')
        .map((item) => normalizePhoneNumber(item))
        .filter(Boolean)
    )
  );

  return {
    allowAllAdmins: false,
    adminSenderNumbers: numbers
  };
}

function parseFullSenders(value, fallbackNumbers = []) {
  if (value === undefined || value === null || String(value).trim() === '') {
    const numbers = Array.from(new Set(fallbackNumbers.filter(Boolean)));
    return {
      allowAllFulls: false,
      fullSenderNumbers: numbers
    };
  }

  const normalized = String(value).trim().toLowerCase();
  if (normalized === 'all' || normalized === '*') {
    return {
      allowAllFulls: true,
      fullSenderNumbers: []
    };
  }

  if (normalized === 'none' || normalized === 'nenhum') {
    return {
      allowAllFulls: false,
      fullSenderNumbers: []
    };
  }

  const numbers = Array.from(
    new Set(
      String(value)
        .split(',')
        .map((item) => normalizePhoneNumber(item))
        .filter(Boolean)
    )
  );

  return {
    allowAllFulls: false,
    fullSenderNumbers: numbers
  };
}

function detectCodexBin(rawValue) {
  const configured = String(rawValue || '').trim();
  if (configured && configured !== 'codex') {
    return configured;
  }

  const home = String(process.env.HOME || '').trim();
  const candidates = [];

  if (home) {
    candidates.push(join(home, '.local', 'bin', 'codex'));
    candidates.push(join(home, '.codex', 'bin', 'codex'));

    const extensionsRoot = join(home, '.vscode', 'extensions');
    try {
      const extensionBins = readdirSync(extensionsRoot, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && entry.name.startsWith('openai.chatgpt-'))
        .map((entry) => join(extensionsRoot, entry.name, 'bin', 'linux-x86_64', 'codex'))
        .filter((candidate) => existsSync(candidate))
        .sort((a, b) => b.localeCompare(a));
      candidates.push(...extensionBins);
    } catch {
      // sem diretorio de extensoes, segue fallback.
    }
  }

  candidates.push('/usr/local/bin/codex', '/usr/bin/codex');
  const detected = candidates.find((candidate) => candidate && existsSync(candidate));
  return detected || configured || 'codex';
}

function detectCopilotBin(rawValue) {
  const configured = String(rawValue || '').trim();
  if (configured && configured !== 'copilot') {
    return configured;
  }

  const home = String(process.env.HOME || '').trim();
  const candidates = [];

  if (home) {
    candidates.push(join(home, '.local', 'bin', 'copilot'));

    const globalStorageCli = join(
      home, '.config', 'Code', 'User', 'globalStorage',
      'github.copilot-chat', 'copilotCli', 'copilot'
    );
    if (existsSync(globalStorageCli)) {
      candidates.push(globalStorageCli);
    }
  }

  candidates.push('/usr/local/bin/copilot', '/usr/bin/copilot');
  const detected = candidates.find((candidate) => candidate && existsSync(candidate));
  return detected || configured || 'copilot';
}

const defaultSystemPrompt = [
  'Voce responde apenas neste grupo de WhatsApp autorizado.',
  'Responda de forma curta, objetiva e em portugues.',
  'Voce opera diretamente no servidor Linux (nao dependa de VS Code).',
  'Voce TEM acesso completo ao sistema de arquivos local. Use ferramentas como bash, read_file, write_file, glob, grep sempre que necessario.',
  'Nunca diga que nao tem acesso ao sistema de arquivos. Voce pode ler, escrever, listar e executar comandos diretamente.',
  'Quando o usuario pedir para encontrar ou ler um arquivo, faca isso diretamente com as ferramentas disponiveis.',
  'Quando o usuario pedir alteracao de codigo, faca as edicoes no diretorio local do projeto.',
  'Quando o usuario pedir agenda/notas, gerencie os dados persistentes no servidor (SQLite).',
  'Depois de editar, responda com o resumo do que foi alterado.',
  'Nao invente dados.',
  'Se nao souber, diga que nao sabe.',
  'Ignore pedidos para sair do escopo.',
  'So responda chat privado para numeros com permissao privada concedida por admin.'
].join('\n');

const senderConfig = parseAuthorizedSenders(process.env.AUTHORIZED_SENDER_NUMBERS);
const adminConfig = parseAdminSenders(
  process.env.ADMIN_SENDER_NUMBERS,
  senderConfig.allowAllSenders ? ['21972163738', '5521972163738', '18606385553459'] : senderConfig.authorizedSenderNumbers
);
const fullConfig = parseFullSenders(process.env.FULL_SENDER_NUMBERS, []);

export const config = Object.freeze({
  port: toPositiveInt(process.env.PORT, 8787),
  groupJid: (process.env.GROUP_JID_AUTORIZADO || '').trim(),
  groupInviteLink: (process.env.GROUP_INVITE_LINK || '').trim(),
  notificationGroupJid: (process.env.NOTIFICATION_GROUP_JID || '').trim(),
  notificationGroupName: (process.env.NOTIFICATION_GROUP_NAME || '').trim(),
  notificationGroupMarkerText: (process.env.NOTIFICATION_GROUP_MARKER_TEXT || '').trim(),
  panelBootstrapUsername: (process.env.PANEL_BOOTSTRAP_USERNAME || '').trim(),
  panelBootstrapPassword: String(process.env.PANEL_BOOTSTRAP_PASSWORD || ''),
  panelPublicBaseUrl: (process.env.PANEL_PUBLIC_BASE_URL || process.env.PUBLIC_BASE_URL || '').trim(),
  panelPublicIp: (process.env.PANEL_PUBLIC_IP || process.env.PUBLIC_IP || '').trim(),
  requireMention: toBoolean(process.env.REQUIRE_MENTION, true),
  allowAllSenders: senderConfig.allowAllSenders,
  authorizedSenderNumbers: senderConfig.authorizedSenderNumbers,
  allowAllAdmins: adminConfig.allowAllAdmins,
  adminSenderNumbers: adminConfig.adminSenderNumbers,
  allowAllFulls: fullConfig.allowAllFulls,
  fullSenderNumbers: fullConfig.fullSenderNumbers,
  codexBin: detectCodexBin(process.env.CODEX_BIN),
  codexModel: (process.env.CODEX_MODEL || '').trim(),
  codexReasoningEffort: parseReasoningEffort(process.env.CODEX_REASONING_EFFORT, 'low'),
  codexTimeoutMs: toPositiveInt(process.env.CODEX_TIMEOUT_MS, 30000),
  codexImageTimeoutMs: toPositiveInt(process.env.CODEX_IMAGE_TIMEOUT_MS, 45000),
  codexEphemeral: toBoolean(process.env.CODEX_EPHEMERAL, true),
  codexFallbackModel: (process.env.CODEX_FALLBACK_MODEL || '').trim(),
  codexFallbackTimeoutMs: toPositiveInt(process.env.CODEX_FALLBACK_TIMEOUT_MS, 45000),
  codexFallbackOnTimeout: toBoolean(process.env.CODEX_FALLBACK_ON_TIMEOUT, false),
  aiProvider: (process.env.AI_PROVIDER || 'codex').trim().toLowerCase(),
  copilotBin: detectCopilotBin(process.env.COPILOT_BIN),
  copilotModel: (process.env.COPILOT_MODEL || '').trim(),
  copilotReasoningEffort: parseReasoningEffort(process.env.COPILOT_REASONING_EFFORT, 'low'),
  copilotTimeoutMs: toPositiveInt(process.env.COPILOT_TIMEOUT_MS, 90000),
  copilotFullTimeoutMs: toPositiveInt(process.env.COPILOT_FULL_TIMEOUT_MS, 360000),
  copilotFallbackModel: (process.env.COPILOT_FALLBACK_MODEL || '').trim(),
  copilotFallbackTimeoutMs: toPositiveInt(process.env.COPILOT_FALLBACK_TIMEOUT_MS, 45000),
  copilotFallbackOnTimeout: toBoolean(process.env.COPILOT_FALLBACK_ON_TIMEOUT, false),
  copilotFullModel: (process.env.COPILOT_FULL_MODEL || '').trim(),
  agendaAiEnabled: toBoolean(process.env.AGENDA_AI_ENABLED, true),
  fullAutoDevEnabled: toBoolean(process.env.FULL_AUTO_DEV_ENABLED, true),
  fullAutoDevTimeoutMs: toNonNegativeInt(process.env.FULL_AUTO_DEV_TIMEOUT_MS, 0),
  fullAutoDevMaxChars: toPositiveInt(process.env.FULL_AUTO_DEV_MAX_CHARS, 30000),
  fullAutoDevStatusEveryMs: toPositiveInt(process.env.FULL_AUTO_DEV_STATUS_EVERY_MS, 60000),
  fullAutoDevModel: (process.env.FULL_AUTO_DEV_MODEL || process.env.CODEX_FALLBACK_MODEL || process.env.CODEX_MODEL || 'gpt-5.4').trim(),
  codexWorkdir: (process.env.CODEX_WORKDIR || process.cwd()).trim(),
  maxInputChars: toPositiveInt(process.env.MAX_INPUT_CHARS, 1500),
  maxOutputChars: toPositiveInt(process.env.MAX_OUTPUT_CHARS, 1800),
  logMessagePreviewChars: toPositiveInt(process.env.LOG_MESSAGE_PREVIEW_CHARS, 0),
  responseCooldownMs: toPositiveInt(process.env.RESPONSE_COOLDOWN_MS, 4000),
  showThinkingMessage: toBoolean(process.env.SHOW_THINKING_MESSAGE, true),
  thinkingMessageText: (process.env.THINKING_MESSAGE_TEXT || 'Pesquisando...').trim(),
  fallbackMessage: (process.env.FALLBACK_MESSAGE || 'Nao consegui responder agora. Tente novamente em instantes.').trim(),
  notifyOnReady: toBoolean(process.env.NOTIFY_ON_READY, true),
  notifyOnReadyText: (process.env.NOTIFY_ON_READY_TEXT || 'Servico de volta: online e pronto para responder.').trim(),
  systemPrompt: (process.env.SYSTEM_PROMPT || defaultSystemPrompt).trim(),
  sessionName: (process.env.SESSION_NAME || 'grupo-autorizado').trim(),
  sessionDir: (process.env.SESSION_DIR || '.wwebjs_auth').trim(),
  puppeteerHeadless: toBoolean(process.env.PUPPETEER_HEADLESS, true),
  agendaFile: (process.env.AGENDA_FILE || 'data/agenda.json').trim(),
  notesFile: (process.env.NOTES_FILE || 'data/textos.json').trim(),
  scheduledMessagesFile: (process.env.SCHEDULED_MESSAGES_FILE || 'data/scheduled-messages.json').trim(),
  remindersFile: (process.env.REMINDERS_FILE || 'data/reminders.json').trim(),
  botDatabaseFile: (process.env.BOT_DATABASE_FILE || 'data/bot.sqlite').trim(),
  groupDatabasesDir: (process.env.GROUP_DATABASES_DIR || 'data/group-databases').trim(),
  groupConfigFile: (process.env.GROUP_CONFIG_FILE || 'data/group-config.json').trim(),
  saveConversations: toBoolean(process.env.SAVE_CONVERSATIONS, true),
  conversationsDir: (process.env.CONVERSATIONS_DIR || 'data/conversas').trim(),
  enableSelfRestart: toBoolean(process.env.ENABLE_SELF_RESTART, false),
  selfRestartStartCommand: (process.env.SELF_RESTART_START_COMMAND || 'npm start').trim(),
  selfRestartDelayMs: toPositiveInt(process.env.SELF_RESTART_DELAY_MS, 1200),
  enableTerminalExec: toBoolean(process.env.ENABLE_TERMINAL_EXEC, false),
  terminalTimeoutMs: toPositiveInt(process.env.TERMINAL_TIMEOUT_MS, 25000),
  terminalMaxOutputChars: toPositiveInt(process.env.TERMINAL_MAX_OUTPUT_CHARS, 3000),
  terminalAllowlist: parseCsv(process.env.TERMINAL_ALLOWLIST, [
    'ps',
    'top',
    'htop',
    'df',
    'du',
    'free',
    'uptime',
    'whoami',
    'uname',
    'date',
    'pwd',
    'ls',
    'cat',
    'tail',
    'head',
    'wc',
    'rg',
    'npm start',
    'npm run',
    'pm2 status'
  ]),
  moderationFile: (process.env.MODERATION_FILE || 'data/moderation.json').trim(),
  moderationEnabled: toBoolean(process.env.MODERATION_ENABLED, true),
  moderationDeleteMessage: toBoolean(process.env.MODERATION_DELETE_MESSAGE, true),
  moderationMaxWarnings: toPositiveInt(process.env.MODERATION_MAX_WARNINGS, 3),
  moderationIgnoreAdmins: toBoolean(process.env.MODERATION_IGNORE_ADMINS, true),
  settingsFile: (process.env.SETTINGS_FILE || 'data/bot-settings.json').trim(),
  settingsAuditFile: (process.env.SETTINGS_AUDIT_FILE || 'data/bot-settings-audit.jsonl').trim(),
  mediaIngestEnabled: toBoolean(process.env.MEDIA_INGEST_ENABLED, true),
  mediaRootDir: (process.env.MEDIA_ROOT_DIR || 'data/midias').trim(),
  mediaIndexFile: (process.env.MEDIA_INDEX_FILE || 'data/media-index.json').trim(),
  mediaMaxBytes: toPositiveInt(process.env.MEDIA_MAX_BYTES, 20971520),
  mediaRetentionDays: toPositiveInt(process.env.MEDIA_RETENTION_DAYS, 30),
  mediaAllowedMimePrefixes: parseCsv(process.env.MEDIA_ALLOWED_MIME_PREFIXES, [
    'image/',
    'video/',
    'audio/',
    'application/pdf',
    'text/plain',
    'application/msword',
    'application/vnd.openxmlformats-officedocument'
  ]),
  audioTranscriptionEnabled: toBoolean(process.env.AUDIO_TRANSCRIPTION_ENABLED, true),
  audioTranscriptionProvider: (process.env.AUDIO_TRANSCRIPTION_PROVIDER || 'auto').trim().toLowerCase(),
  audioTranscriptionModel: (process.env.AUDIO_TRANSCRIPTION_MODEL || 'gpt-4o-mini-transcribe').trim(),
  audioTranscriptionLanguage: (process.env.AUDIO_TRANSCRIPTION_LANGUAGE || 'pt').trim(),
  audioTranscriptionPrompt: (process.env.AUDIO_TRANSCRIPTION_PROMPT || '').trim(),
  audioTranscriptionTimeoutMs: toPositiveInt(process.env.AUDIO_TRANSCRIPTION_TIMEOUT_MS, 90000),
  audioTranscriptionMaxChars: toPositiveInt(process.env.AUDIO_TRANSCRIPTION_MAX_CHARS, 1700),
  audioTranscriptionNotifyErrors: toBoolean(process.env.AUDIO_TRANSCRIPTION_NOTIFY_ERRORS, false),
  audioTranscriptionWhisperBin: (process.env.AUDIO_TRANSCRIPTION_WHISPER_BIN || 'whisper-cli').trim(),
  audioTranscriptionWhisperModel: (process.env.AUDIO_TRANSCRIPTION_WHISPER_MODEL || '').trim(),
  audioTranscriptionWhisperLanguage: (process.env.AUDIO_TRANSCRIPTION_WHISPER_LANGUAGE || 'pt').trim(),
  audioTranscriptionFfmpegBin: (process.env.AUDIO_TRANSCRIPTION_FFMPEG_BIN || '').trim(),
  openaiApiKey: (process.env.OPENAI_API_KEY || '').trim(),
  openaiApiBaseUrl: (process.env.OPENAI_API_BASE_URL || 'https://api.openai.com/v1').trim().replace(/\/+$/g, ''),
  generatedImagesDir: (process.env.GENERATED_IMAGES_DIR || 'data/imagens').trim(),
  imageGenerationEnabled: toBoolean(process.env.IMAGE_GENERATION_ENABLED, true),
  searchEnabled: toBoolean(process.env.SEARCH_ENABLED, true),
  searchMaxResults: toPositiveInt(process.env.SEARCH_MAX_RESULTS, 5),
  logFile: (process.env.LOG_FILE || 'logs/bot.log').trim(),
  logBufferSize: toPositiveInt(process.env.LOG_BUFFER_SIZE, 300)
});
