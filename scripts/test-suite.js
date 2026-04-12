/**
 * test-suite.js — Suíte de testes funcionais completa do bot.
 *
 * Roda após cada job FULL (via check-all.js) e valida:
 *   1. Sintaxe ESM de todos os módulos críticos (import dinâmico)
 *   2. Parser de despesas (@despesa / @despesas / linguagem natural)
 *   3. Parser de lembrete
 *   4. Parser de agenda
 *   5. Parser de moderação
 *   6. Parser de comando FULL (fullAutoDevCommand)
 *   7. Roteamento tryHandleLocalAction (@despesa → despesa, não vai pra IA)
 *   8. Banco de dados (leitura do SQLite)
 *   9. expenseService: add, list, delete via handleExpenseCommand
 *
 * Saída:
 *   - Imprime cada teste com PASS/FAIL
 *   - Ao final: resumo e exit(0) tudo OK ou exit(1) com falhas
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

// ─── utilitários ────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
const failures = [];

function assert(name, condition, detail = '') {
  if (condition) {
    console.log(`  ✅ PASS  ${name}`);
    passed++;
  } else {
    console.log(`  ❌ FAIL  ${name}${detail ? ' — ' + detail : ''}`);
    failed++;
    failures.push({ name, detail });
  }
}

function assertEq(name, actual, expected) {
  const ok = actual === expected;
  assert(name, ok, ok ? '' : `got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
}

function section(title) {
  console.log(`\n── ${title} `);
}

// ─── 1. Import dinâmico dos módulos críticos ────────────────────────────────

section('1. Importação dos módulos críticos');

const modules = [
  'src/expenseService.js',
  'src/localActions.js',
  'src/codexBridge.js',
  'src/aiBridge.js',
  'src/reminderStore.js',
  'src/botDatabase.js',
  'src/fullAutoJobStore.js',
  'src/settingsStore.js',
  'src/moderationEngine.js',
  'src/conversationStore.js',
  'src/mediaStore.js',
  'src/scheduledMessagesStore.js',
  'src/selfHealingService.js',
  'src/webPanel.js',
  'src/visionService.js',
  'src/accessControl.js',
  'src/groupStore.js',
  'src/config.js',
  'src/audioTranscriptionService.js',
  'src/mediaTypeUtils.js',
  'src/runtimeState.js',
  'src/copilotUsageTracker.js',
  'src/imageContextService.js',
  'src/panelAuth.js',
];

const loaded = {};
for (const mod of modules) {
  try {
    loaded[mod] = await import(join(ROOT, mod));
    assert(`import ${mod}`, true);
  } catch (e) {
    assert(`import ${mod}`, false, e.message.slice(0, 120));
  }
}

// ─── 2. Parser de despesas ──────────────────────────────────────────────────

section('2. Parser de despesas (expenseService)');

const { parseExpenseCommand, handleExpenseCommand } = loaded['src/expenseService.js'] || {};

if (!parseExpenseCommand) {
  assert('parseExpenseCommand exportado', false, 'função não encontrada no módulo');
} else {
  assert('parseExpenseCommand exportado', true);

  const ctx = { groupId: '120363425653503107@g.us', senderNumber: '5521972163738' };

  // @despesa valor titulo
  {
    const r = parseExpenseCommand('@despesa 50 combustivel', ctx);
    assert('@despesa 50 combustivel → add_manual', r?.action === 'add_manual');
    assert('@despesa amountCents = 5000', r?.amountCents === 5000);
    assert('@despesa title = "combustivel"', r?.title === 'combustivel');
  }

  // @despesas (listar)
  {
    const r = parseExpenseCommand('@despesas', ctx);
    assert('@despesas → summary', r?.action === 'summary');
  }

  // @despesa com vírgula
  {
    const r = parseExpenseCommand('@despesa 180,50 material escritorio', ctx);
    assert('@despesa 180,50 → amountCents = 18050', r?.amountCents === 18050);
  }

  // @despesas apagar id
  {
    const r = parseExpenseCommand('@despesas apagar id 7', ctx);
    assert('@despesas apagar id 7 → delete_by_id', r?.action === 'delete_by_id');
  }

  // linguagem natural — apagar despesa id
  {
    const r = parseExpenseCommand('apagar despesa id 3', ctx);
    assert('linguagem natural "apagar despesa id 3" → delete_by_id', r?.action === 'delete_by_id');
  }

  // linguagem natural — mostrar / listar despesas
  {
    const r = parseExpenseCommand('mostrar despesas', ctx);
    assert('linguagem natural "mostrar despesas" → summary/list', r !== null && r.action != null);
  }

  // @despesas exportar csv
  {
    const r = parseExpenseCommand('@despesas exportar csv', ctx);
    assert('@despesas exportar csv → export', r?.action === 'export');
  }

  // handleExpenseCommand — add_manual funcional (banco real)
  if (handleExpenseCommand) {
    try {
      const parsed = parseExpenseCommand('@despesa 1 teste-automatico', ctx);
      const result = await handleExpenseCommand(parsed, { text: '@despesa 1 teste-automatico', context: ctx });
      const msg = typeof result === 'string' ? result : (result?.response || '');
      assert('handleExpenseCommand add_manual retorna resposta', msg.length > 0);
      // Limpa a despesa de teste
      const { botDatabase } = loaded['src/botDatabase.js'] || {};
      const db = botDatabase?.adminDb;
      if (db?.prepare) {
        db.prepare("DELETE FROM expenses WHERE group_id=? AND descricao='teste-automatico'").run(ctx.groupId);
      }
    } catch (e) {
      assert('handleExpenseCommand add_manual funcional', false, e.message.slice(0, 120));
    }
  }
}

// ─── 3. tryHandleLocalAction — roteamento @despesa ───────────────────────────

section('3. Roteamento tryHandleLocalAction (@despesa não vai para IA)');

const { tryHandleLocalAction } = loaded['src/localActions.js'] || {};

if (!tryHandleLocalAction) {
  assert('tryHandleLocalAction exportado', false, 'não encontrada');
} else {
  assert('tryHandleLocalAction exportado', true);

  const ctx = {
    groupId: '120363425653503107@g.us',
    senderNumber: '5521972163738',
    authorizationMode: 'full',
    isGroupAdminSender: false,
    chatType: 'group',
    mentionedIds: [],
  };

  // @despesas deve retornar handled:true sem ir para a IA
  try {
    const r = await tryHandleLocalAction('@despesas', ctx);
    assert('@despesas → handled:true (não vai pra IA)', r?.handled === true);
    assert('@despesas → response contém "Despesa"', typeof r?.response === 'string' && r.response.length > 0);
  } catch (e) {
    assert('@despesas via tryHandleLocalAction', false, e.message.slice(0, 120));
  }

  // "@despesa 50 combustivel" deve retornar handled:true
  try {
    const r = await tryHandleLocalAction('@despesa 50 combustivel', ctx);
    assert('@despesa 50 combustivel → handled:true', r?.handled === true);
  } catch (e) {
    assert('@despesa 50 combustivel via tryHandleLocalAction', false, e.message.slice(0, 120));
  }

  // "apagar despesa id 999" deve retornar handled:true (linguagem natural)
  try {
    const r = await tryHandleLocalAction('apagar despesa id 999', ctx);
    assert('linguagem natural "apagar despesa id 999" → handled:true', r?.handled === true);
  } catch (e) {
    assert('linguagem natural despesa via tryHandleLocalAction', false, e.message.slice(0, 120));
  }
}

// ─── 3.1. Menu de configuração do bot ───────────────────────────────────────

section('3.1. Menu de configuração do bot');

if (!tryHandleLocalAction) {
  assert('menu de configuração usa tryHandleLocalAction', false, 'função não encontrada');
} else {
  const ctx = {
    groupId: '120363425653503107@g.us',
    senderNumber: '5521972163738',
    authorizationMode: 'full',
    isGroupAdminSender: true,
    chatType: 'group',
    mentionedIds: [],
  };

  const openMainMenu = async () => {
    const result = await tryHandleLocalAction('configurar bot', ctx);
    assert('configurar bot → handled:true', result?.handled === true);
    assert(
      'configurar bot → mostra menu principal',
      typeof result?.response === 'string' && result.response.includes('Responda apenas com o numero da secao:')
    );
  };

  const openSection = async (option) => {
    await openMainMenu();
    return tryHandleLocalAction(String(option), ctx);
  };

  const topLevelChecks = [
    ['1', '🤖 *Inteligencia Artificial*'],
    ['2', '💬 *Comportamento de respostas*'],
    ['3', '🖥️ *Terminal Linux*'],
    ['4', '🖼️ *Midia*'],
    ['5', '📡 *Relay (mensagens privadas)*'],
    ['6', '🔇 *Modo silencioso*'],
    ['7', '🧾 *Auditoria e rollback*'],
    ['8', '📊 *Status geral da configuracao*'],
    ['9', '🔐 *Permissoes e Multi-Grupo*'],
    ['10', '🗺️ *Mapa de recursos do projeto*'],
  ];

  for (const [option, expected] of topLevelChecks) {
    try {
      const result = await openSection(option);
      assert(`menu principal opção ${option} → handled:true`, result?.handled === true);
      assert(
        `menu principal opção ${option} → abre a seção correta`,
        typeof result?.response === 'string' && result.response.includes(expected)
      );
    } catch (e) {
      assert(`menu principal opção ${option}`, false, e.message.slice(0, 120));
    }
  }

  const iaOptionChecks = [
    ['2', 'Trocar provedor de IA'],
    ['3', 'Modelos do Copilot'],
    ['4', 'Modelos do Codex'],
    ['5', 'Mencao obrigatoria ao bot'],
    ['7', 'Configuracao dinamica atual:'],
    ['8', 'BOT | MENU DE CONFIGURACAO'],
  ];

  for (const [option, expected] of iaOptionChecks) {
    try {
      await openSection('1');
      const result = await tryHandleLocalAction(option, ctx);
      assert(`IA opção ${option} → handled:true`, result?.handled === true);
      assert(
        `IA opção ${option} → resposta esperada`,
        typeof result?.response === 'string' && result.response.includes(expected)
      );
    } catch (e) {
      assert(`IA opção ${option}`, false, e.message.slice(0, 120));
    }
  }

  try {
    await openSection('1');
    const result = await tryHandleLocalAction('menu principal', ctx);
    assert('menu principal dentro da seção IA → handled:true', result?.handled === true);
    assert(
      'menu principal dentro da seção IA → volta ao início',
      typeof result?.response === 'string' && result.response.includes('BOT | MENU DE CONFIGURACAO')
    );
  } catch (e) {
    assert('menu principal dentro da seção IA', false, e.message.slice(0, 120));
  }
}

// ─── 4. Parser de lembrete ──────────────────────────────────────────────────

section('4. Parser de lembrete');

if (tryHandleLocalAction) {
  const ctx = {
    groupId: '120363425653503107@g.us',
    senderNumber: '5521972163738',
    authorizationMode: 'authorized',
    isGroupAdminSender: false,
    chatType: 'group',
    mentionedIds: [],
  };

  try {
    const r = await tryHandleLocalAction('lembrete amanhã às 9h reunião', ctx);
    assert('lembrete amanhã às 9h → handled:true', r?.handled === true);
  } catch (e) {
    assert('lembrete amanhã às 9h', false, e.message.slice(0, 80));
  }

  try {
    const r = await tryHandleLocalAction('meus lembretes', ctx);
    assert('meus lembretes → handled:true', r?.handled === true);
  } catch (e) {
    assert('meus lembretes', false, e.message.slice(0, 80));
  }
}

// ─── 5. Parser de agenda ────────────────────────────────────────────────────

section('5. Parser de agenda');

if (tryHandleLocalAction) {
  const ctx = {
    groupId: '120363425653503107@g.us',
    senderNumber: '5521972163738',
    authorizationMode: 'authorized',
    isGroupAdminSender: false,
    chatType: 'group',
    mentionedIds: [],
  };

  try {
    const r = await tryHandleLocalAction('agenda de hoje', ctx);
    assert('agenda de hoje → handled:true', r?.handled === true);
    assert('agenda de hoje → response existe', typeof r?.response === 'string' && r.response.length > 0);
  } catch (e) {
    assert('agenda de hoje', false, e.message.slice(0, 80));
  }

  try {
    const r = await tryHandleLocalAction('ver agenda', ctx);
    assert('ver agenda → handled:true', r?.handled === true);
  } catch (e) {
    assert('ver agenda', false, e.message.slice(0, 80));
  }

  try {
    const r = await tryHandleLocalAction('tem agenda?', ctx);
    assert('tem agenda? → handled:true', r?.handled === true);
  } catch (e) {
    assert('tem agenda?', false, e.message.slice(0, 80));
  }

  try {
    const r = await tryHandleLocalAction('Busca pra mim se a cantora Pitty tem agenda de show aqui no Rio de janeiro', ctx);
    assert(
      'agenda de show nao cai na agenda local',
      !/Sua agenda esta vazia no momento/i.test(r?.response || '')
    );
  } catch (e) {
    assert('agenda de show nao cai na agenda local', false, e.message.slice(0, 80));
  }
}

// ─── 6. Parser de moderação ─────────────────────────────────────────────────

section('6. Parser de moderação');

if (tryHandleLocalAction) {
  const ctx = {
    groupId: '120363425653503107@g.us',
    senderNumber: '21972163738',     // admin
    authorizationMode: 'admin',
    isGroupAdminSender: true,
    chatType: 'group',
    mentionedIds: [],
  };

  try {
    const r = await tryHandleLocalAction('palavras proibidas', ctx);
    assert('palavras proibidas → handled:true', r?.handled === true);
  } catch (e) {
    assert('palavras proibidas', false, e.message.slice(0, 80));
  }
}

// ─── 7. Parser de comando FULL ──────────────────────────────────────────────

section('7. Parser de comando FULL (remetente FULL)');

if (tryHandleLocalAction) {
  const ctxFull = {
    groupId: '120363425653503107@g.us',
    senderNumber: '5521972163738',   // FULL
    authorizationMode: 'full',
    isGroupAdminSender: false,
    chatType: 'group',
    mentionedIds: [],
  };

  try {
    const r = await tryHandleLocalAction('status da minha solicitação', ctxFull);
    assert('status da minha solicitação → handled:true', r?.handled === true);
  } catch (e) {
    assert('status da minha solicitação', false, e.message.slice(0, 80));
  }
}

// ─── 8. Banco de dados ──────────────────────────────────────────────────────

section('8. Banco de dados (SQLite)');

try {
  const { botDatabase } = loaded['src/botDatabase.js'] || {};
  if (!botDatabase) throw new Error('botDatabase não exportado');
  // adminDb usa inicialização lazy — precisa chamar ensureReady() antes de acessar db.prepare()
  await botDatabase.adminDb.ensureReady();
  const db = botDatabase.adminDb.db;
  if (!db || typeof db.prepare !== 'function') throw new Error('adminDb.db.prepare não é função');
  const row = db.prepare('SELECT 1 AS ok').get();
  assert('SQLite acessível', row?.ok === 1);

  // Tabela expenses existe
  const tbl = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='expenses'").get();
  assert('tabela expenses existe', tbl?.name === 'expenses');

  // Tabela full_auto_jobs existe
  const tbl2 = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='full_auto_jobs'").get();
  assert('tabela full_auto_jobs existe', tbl2?.name === 'full_auto_jobs');
} catch (e) {
  assert('banco de dados acessível', false, e.message.slice(0, 120));
}

// ─── 9. Imports críticos encadeados ─────────────────────────────────────────

section('9. Exports críticos presentes');

const checks = [
  ['src/expenseService.js',          'parseExpenseCommand'],
  ['src/expenseService.js',          'handleExpenseCommand'],
  ['src/localActions.js',            'tryHandleLocalAction'],
  ['src/localActions.js',            'startFullAutoJobDirect'],
  ['src/fullAutoJobStore.js',        'getFullAutoJobById'],
  ['src/fullAutoJobStore.js',        'listFullAutoJobs'],
  ['src/reminderStore.js',           'reminderStore'],
  ['src/settingsStore.js',           'settingsStore'],
  ['src/moderationEngine.js',        'ModerationEngine'],
  ['src/botDatabase.js',             'botDatabase'],
  ['src/visionService.js',           'classifyAttachment'],
  ['src/visionService.js',           'analyzeImageWithVision'],
  ['src/accessControl.js',           'accessControl'],
  ['src/accessControl.js',           'AccessControl'],
  ['src/accessControl.js',           'normalizeGroupId'],
  ['src/accessControl.js',           'normalizePhoneNumber'],
  ['src/audioTranscriptionService.js', 'parseAudioTranscriptionIntent'],
  ['src/audioTranscriptionService.js', 'getAudioTranscriptionStatus'],
  ['src/audioTranscriptionService.js', 'truncateTranscriptionText'],
  ['src/mediaTypeUtils.js',          'looksLikeAudioMedia'],
  ['src/mediaTypeUtils.js',          'inferMediaType'],
  ['src/mediaTypeUtils.js',          'foldText'],
  ['src/mediaTypeUtils.js',          'normalizeMimeType'],
  ['src/runtimeState.js',            'getRuntimeState'],
  ['src/runtimeState.js',            'updateRuntimeState'],
  ['src/runtimeState.js',            'stateEvents'],
  ['src/copilotUsageTracker.js',     'recordCopilotRequest'],
  ['src/copilotUsageTracker.js',     'getCopilotUsageStats'],
  ['src/copilotUsageTracker.js',     'getCopilotUsageSummary'],
  ['src/imageContextService.js',     'extractMessageText'],
  ['src/imageContextService.js',     'messageHasImageMedia'],
  ['src/panelAuth.js',               'panelAuth'],
  ['src/groupStore.js',              'groupStore'],
  ['src/config.js',                  'config'],
];

for (const [mod, exp] of checks) {
  const m = loaded[mod];
  if (!m) {
    assert(`${mod} → ${exp}`, false, 'módulo não carregado');
    continue;
  }
  const ok = exp === 'default' ? m.default != null : typeof m[exp] !== 'undefined';
  assert(`${mod} exporta ${exp}`, ok);
}

// ─── 9.1. settingsStore — persistência de timeouts/flags Copilot ───────────

section('9.1. settingsStore — persistencia de configuracoes Copilot');

const { SettingsStore } = loaded['src/settingsStore.js'] || {};

if (!SettingsStore) {
  assert('SettingsStore exportado', false, 'classe não encontrada');
} else {
  try {
    const tempRoot = mkdtempSync(join(tmpdir(), 'chatbot-settings-store-'));
    const filePath = join(tempRoot, 'bot-settings.json');
    const auditFilePath = join(tempRoot, 'bot-settings-audit.jsonl');
    const store = new SettingsStore({ filePath, auditFilePath });
    await store.ensureReady();

    await store.update({
      requireMention: false,
      copilotFullTimeoutMs: 0,
      copilotFallbackOnTimeout: true
    }, {
      actor: 'test-suite',
      source: 'test'
    });

    const current = store.get();
    const persisted = JSON.parse(readFileSync(filePath, 'utf8'));

    assertEq('settingsStore persiste copilotFullTimeoutMs=0', current.copilotFullTimeoutMs, 0);
    assertEq('settingsStore persiste copilotFallbackOnTimeout=true', current.copilotFallbackOnTimeout, true);
    assertEq('arquivo persiste copilotFullTimeoutMs=0', persisted.copilotFullTimeoutMs, 0);
    assertEq('arquivo persiste copilotFallbackOnTimeout=true', persisted.copilotFallbackOnTimeout, true);
  } catch (e) {
    assert('settingsStore persiste configuracoes Copilot', false, e.message.slice(0, 160));
  }
}

// ─── 10. mediaTypeUtils — testes funcionais ─────────────────────────────────

section('10. mediaTypeUtils — testes funcionais');

const {
  looksLikeAudioMedia,
  inferMediaType,
  foldText,
  normalizeMimeType,
} = loaded['src/mediaTypeUtils.js'] || {};

if (!looksLikeAudioMedia) {
  assert('mediaTypeUtils carregado', false, 'módulo não carregado');
} else {
  assert('looksLikeAudioMedia(audio/ogg) → true',  looksLikeAudioMedia({ mimeType: 'audio/ogg' })  === true);
  assert('looksLikeAudioMedia(image/png) → false', looksLikeAudioMedia({ mimeType: 'image/png' }) === false);
  assert('looksLikeAudioMedia(audio/mp4) → true',  looksLikeAudioMedia({ mimeType: 'audio/mp4' })  === true);
  assertEq('inferMediaType(audio/ogg) → "audio"',  inferMediaType({ mimeType: 'audio/ogg' }),  'audio');
  assertEq('inferMediaType(image/jpeg) → "image"', inferMediaType({ mimeType: 'image/jpeg' }), 'image');
  assertEq('inferMediaType(video/mp4) → "video"',  inferMediaType({ mimeType: 'video/mp4' }),  'video');
  assertEq('foldText("  Hello World  ") → "hello world"', foldText('  Hello World  '), 'hello world');
  assertEq('normalizeMimeType("IMAGE/JPEG") → "image/jpeg"', normalizeMimeType('IMAGE/JPEG'), 'image/jpeg');
}

// ─── 11. visionService — classifyAttachment ──────────────────────────────────

section('11. visionService — classifyAttachment');

const { classifyAttachment } = loaded['src/visionService.js'] || {};

if (!classifyAttachment) {
  assert('visionService carregado', false, 'módulo não carregado');
} else {
  assertEq('classifyAttachment(image/jpeg) → "photo"', classifyAttachment({ mimeType: 'image/jpeg' }), 'photo');
  assertEq('classifyAttachment(video/mp4) → "video"',  classifyAttachment({ mimeType: 'video/mp4' }),  'video');
  assertEq('classifyAttachment(audio/ogg) → "audio"',  classifyAttachment({ mimeType: 'audio/ogg' }),  'audio');
}

// ─── 12. accessControl — utilitários ─────────────────────────────────────────

section('12. accessControl — utilitários');

const {
  accessControl,
  normalizeGroupId,
  normalizePhoneNumber,
} = loaded['src/accessControl.js'] || {};

if (!normalizeGroupId) {
  assert('accessControl carregado', false, 'módulo não carregado');
} else {
  assert('accessControl instância existe', accessControl != null);
  assertEq(
    'normalizeGroupId preserva JID',
    normalizeGroupId('120363425653503107@g.us'),
    '120363425653503107@g.us',
  );
  assertEq(
    'normalizePhoneNumber preserva número',
    normalizePhoneNumber('5521972163738'),
    '5521972163738',
  );
  assert('normalizeGroupId retorna string', typeof normalizeGroupId('120363425653503107@g.us') === 'string');
  assert('normalizePhoneNumber retorna string', typeof normalizePhoneNumber('5521972163738') === 'string');
}

// ─── 13. runtimeState ────────────────────────────────────────────────────────

section('13. runtimeState');

const { getRuntimeState, updateRuntimeState, stateEvents } = loaded['src/runtimeState.js'] || {};

if (!getRuntimeState) {
  assert('runtimeState carregado', false, 'módulo não carregado');
} else {
  const state = getRuntimeState();
  assert('getRuntimeState retorna objeto',  state !== null && typeof state === 'object');
  assert('state.whatsappStatus existe',     'whatsappStatus' in state);
  assert('state.startedAt existe',          'startedAt' in state);
  assert('stateEvents é EventEmitter',      stateEvents != null && typeof stateEvents.on === 'function');

  updateRuntimeState({ _testKey: 'ok' });
  assert('updateRuntimeState persiste valor', getRuntimeState()._testKey === 'ok');
  // limpa chave de teste
  updateRuntimeState({ _testKey: undefined });
}

// ─── 14. copilotUsageTracker ─────────────────────────────────────────────────

section('14. copilotUsageTracker');

const {
  recordCopilotRequest,
  getCopilotUsageStats,
  getCopilotUsageSummary,
  formatCopilotUsageReport,
} = loaded['src/copilotUsageTracker.js'] || {};

if (!recordCopilotRequest) {
  assert('copilotUsageTracker carregado', false, 'módulo não carregado');
} else {
  try {
    recordCopilotRequest({ model: 'gpt-4o', inputChars: 100, outputChars: 200, stage: 'test', success: true, timedOut: false });
    assert('recordCopilotRequest executa sem erro', true);
  } catch (e) {
    assert('recordCopilotRequest executa sem erro', false, e.message.slice(0, 80));
  }

  const stats = getCopilotUsageStats();
  assert('getCopilotUsageStats retorna objeto',          stats !== null && typeof stats === 'object');
  assert('getCopilotUsageStats.totalRequests ≥ 1',       stats.totalRequests >= 1);
  assert('getCopilotUsageStats.byModel é array',         Array.isArray(stats.byModel));
  assert('getCopilotUsageSummary retorna string',        typeof getCopilotUsageSummary() === 'string');
  assert('formatCopilotUsageReport retorna string',      typeof formatCopilotUsageReport() === 'string');
}

// ─── 15. audioTranscriptionService — funções puras ───────────────────────────

section('15. audioTranscriptionService — funções puras');

const {
  parseAudioTranscriptionIntent,
  getAudioTranscriptionStatus,
  truncateTranscriptionText,
} = loaded['src/audioTranscriptionService.js'] || {};

if (!parseAudioTranscriptionIntent) {
  assert('audioTranscriptionService carregado', false, 'módulo não carregado');
} else {
  const r1 = parseAudioTranscriptionIntent('transcrever áudio');
  assert('parseAudioTranscriptionIntent("transcrever áudio") → não null', r1 !== null);
  assert('parseAudioTranscriptionIntent("transcrever áudio").action === "transcribe"', r1?.action === 'transcribe');

  const r2 = parseAudioTranscriptionIntent('bom dia como vai');
  assert('parseAudioTranscriptionIntent(texto comum) → null', r2 === null);

  const status = getAudioTranscriptionStatus();
  assert('getAudioTranscriptionStatus retorna objeto',  status !== null && typeof status === 'object');
  assert('status.enabled é boolean',                   typeof status.enabled === 'boolean');
  assert('status.provider definido',                   'provider' in status);

  const truncated = truncateTranscriptionText('a'.repeat(200), 100);
  assert('truncateTranscriptionText limita tamanho',   truncated.length <= 110);
}

// ─── 16. config — chaves obrigatórias ────────────────────────────────────────

section('16. config — chaves obrigatórias');

const { config } = loaded['src/config.js'] || {};

if (!config) {
  assert('config carregado', false, 'módulo não carregado');
} else {
  assert('config é objeto frozen', Object.isFrozen(config));
  assert('config.port definido',            config.port != null);
  assert('config.codexModel definido',      typeof config.codexModel === 'string' && config.codexModel.length > 0);
  assert('config.openaiApiBaseUrl definido', typeof config.openaiApiBaseUrl === 'string' && config.openaiApiBaseUrl.length > 0);
  assert('config.aiProvider definido',      typeof config.aiProvider === 'string' && config.aiProvider.length > 0);
  assert('config.agendaFile definido',      typeof config.agendaFile === 'string');
  assert('config.botDatabaseFile definido', typeof config.botDatabaseFile === 'string');
}

// ─── 17. Banco de dados — tabelas adicionais ─────────────────────────────────

section('17. Banco de dados — tabelas adicionais');

try {
  const { botDatabase } = loaded['src/botDatabase.js'] || {};
  await botDatabase.adminDb.ensureReady();
  const db = botDatabase.adminDb.db;

  const tables = ['bot_items', 'bot_meta', 'expenses', 'full_auto_jobs', 'panel_users'];
  for (const tbl of tables) {
    const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(tbl);
    assert(`tabela ${tbl} existe`, row?.name === tbl);
  }
} catch (e) {
  assert('tabelas adicionais acessíveis', false, e.message.slice(0, 120));
}

// ─── 18. notas via tryHandleLocalAction ──────────────────────────────────────

section('18. Notas via tryHandleLocalAction');

if (tryHandleLocalAction) {
  const ctx = {
    groupId: '120363425653503107@g.us',
    senderNumber: '5521972163738',
    authorizationMode: 'full',
    isGroupAdminSender: false,
    chatType: 'group',
    mentionedIds: [],
  };

  try {
    const r = await tryHandleLocalAction('minhas notas', ctx);
    assert('minhas notas → handled:true', r?.handled === true);
    assert('minhas notas → response existe', typeof r?.response === 'string' && r.response.length > 0);
  } catch (e) {
    assert('minhas notas', false, e.message.slice(0, 80));
  }
}

// ─── 19. modo silencioso e relay via tryHandleLocalAction ────────────────────

section('19. Modo silencioso e relay via tryHandleLocalAction');

if (tryHandleLocalAction) {
  const ctx = {
    groupId: '120363425653503107@g.us',
    senderNumber: '5521972163738',
    authorizationMode: 'full',
    isGroupAdminSender: true,
    chatType: 'group',
    mentionedIds: [],
  };

  try {
    const r = await tryHandleLocalAction('modo silencioso status', ctx);
    assert('modo silencioso status → handled:true', r?.handled === true);
  } catch (e) {
    assert('modo silencioso status', false, e.message.slice(0, 80));
  }

  try {
    const r = await tryHandleLocalAction('relay status', ctx);
    assert('relay status → handled:true', r?.handled === true);
  } catch (e) {
    assert('relay status', false, e.message.slice(0, 80));
  }
}

// ─── Resumo ──────────────────────────────────────────────────────────────────

console.log('\n' + '═'.repeat(60));
console.log(`RESULTADO: ${passed} passou, ${failed} falhou`);

if (failures.length) {
  console.log('\nFalhas:');
  for (const f of failures) {
    console.log(`  • ${f.name}${f.detail ? ': ' + f.detail : ''}`);
  }
}

console.log('═'.repeat(60));

if (failed > 0) {
  process.exit(1);
}
