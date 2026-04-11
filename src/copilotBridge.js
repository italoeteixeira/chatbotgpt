import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { config } from './config.js';
import { logger } from './logger.js';
import { settingsStore } from './settingsStore.js';
import { recordCopilotRequest } from './copilotUsageTracker.js';

function clampText(text, maxChars) {
  if (!text) return '';
  const normalized = String(text).replace(/\u0000/g, '').trim();
  // 0 ou falsy = sem limite
  if (!maxChars || maxChars <= 0 || normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, maxChars)}...`;
}

function isTimeoutMessage(message) {
  return /tempo limite excedido/i.test(String(message || ''));
}

const CHAT_CWD = join(tmpdir(), 'copilot-chat-cwd');
let lastInstructionsHash = '';

function ensureChatCwd(systemPrompt) {
  const promptText = String(systemPrompt || '').trim();
  const hash = String(promptText.length) + '_' + promptText.slice(0, 60);
  if (hash !== lastInstructionsHash || !existsSync(join(CHAT_CWD, '.github', 'copilot-instructions.md'))) {
    mkdirSync(join(CHAT_CWD, '.github'), { recursive: true });
    writeFileSync(join(CHAT_CWD, '.github', 'copilot-instructions.md'), promptText, 'utf8');
    lastInstructionsHash = hash;
  }
  return CHAT_CWD;
}

function buildChatPrompt(userText, runtime, options = {}) {
  const now = new Date().toISOString();
  const groupId = String(options.groupId || config.groupJid || 'nao definido');
  const senderNumber = String(options.senderNumber || 'desconhecido');
  const isFull = Boolean(options.isFullSender);
  const senderRole = isFull ? 'full' : options.isAdminSender ? 'admin' : 'membro';
  const recentContext = String(options.recentContext || '').trim();
  const conversationReferences = String(options.conversationReferences || '').trim();

  const lines = [
    'Contexto tecnico fixo:',
    `- Grupo: ${groupId}`,
    `- Data UTC: ${now}`,
    `- Remetente: ${senderNumber} (${senderRole})`,
    '- Responda de forma util, contextual e com iniciativa.',
    '- Se nao precisar acao local, responda normalmente em linguagem natural.',
    isFull ? '- Remetente FULL: pode executar acoes operacionais no servidor.' : '',
    !isFull ? '- Remetente nao FULL: nao execute alteracoes de codigo/arquivos.' : '',
    isFull ? '' : '',
    isFull ? '## PERMISSOES ATIVAS (remetente FULL):' : '',
    isFull ? '- Voce TEM acesso total ao sistema de arquivos do projeto em /opt/chatbot' : '',
    isFull ? '- USE as ferramentas write_file, edit_file, str_replace_based_edit para fazer alteracoes AGORA' : '',
    isFull ? '- Para cada correcao: leia o arquivo → edite → salve. Nao apenas descreva.' : '',
    isFull ? '- Apos editar, rode: npm run check (em /opt/chatbot) para validar.' : ''
  ];

  if (conversationReferences) {
    lines.push('', 'Referencias adicionais:', conversationReferences);
  }
  if (recentContext) {
    lines.push('', 'Contexto recente do grupo:', recentContext);
  }

  lines.push('', 'Mensagem recebida no grupo:', userText);

  return lines.filter((l) => l !== '').join('\n');
}

async function runCopilot({ prompt, model, timeoutMs, stage, maxOutputChars, reasoningEffort, allowTools = false, cwd }) {
  const effectiveCwd = cwd || (allowTools ? config.codexWorkdir : tmpdir());
  const args = [
    '-p', prompt,
    '-s',
    '--no-color',
    '--no-ask-user'
  ];
  if (allowTools) {
    args.push('--allow-all-tools');
  }
  const startedAt = Date.now();

  if (model) {
    args.push('--model', model);
  }
  if (reasoningEffort) {
    args.push('--effort', reasoningEffort);
  }

  logger.debug('Executando Copilot CLI', {
    command: config.copilotBin,
    args: args.map((a) => (a === prompt ? '<prompt>' : a)),
    cwd: effectiveCwd,
    stage
  });

  const child = spawn(config.copilotBin, args, {
    cwd: effectiveCwd,
    env: process.env,
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: true
  });

  let stdout = '';
  let stderr = '';
  let timedOut = false;

  function killTree() {
    try { process.kill(-child.pid, 'SIGKILL'); } catch {}
    try { child.kill('SIGKILL'); } catch {}
  }

  const timeout = setTimeout(() => {
    timedOut = true;
    killTree();
  }, timeoutMs);

  child.stdout.on('data', (chunk) => {
    stdout += chunk.toString('utf8');
  });

  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString('utf8');
  });

  const exitCode = await new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('exit', (code) => resolve(code));

    const safetyTimeout = setTimeout(() => {
      killTree();
      resolve(null);
    }, timeoutMs + 5000);
    safetyTimeout.unref();

    child.on('close', () => clearTimeout(safetyTimeout));
  }).finally(() => clearTimeout(timeout));

  if (timedOut) {
    killTree();
    recordCopilotRequest({ model, inputChars: prompt.length, outputChars: 0, stage, success: false, timedOut: true });
    throw new Error(`Tempo limite excedido (${timeoutMs}ms)`);
  }

  const candidate = stdout.trim();

  if (exitCode !== 0 && !candidate) {
    recordCopilotRequest({ model, inputChars: prompt.length, outputChars: 0, stage, success: false, timedOut: false });
    throw new Error(`Copilot retornou codigo ${exitCode}. stderr=${stderr.trim() || 'vazio'}`);
  }

  if (!candidate) {
    recordCopilotRequest({ model, inputChars: prompt.length, outputChars: 0, stage, success: false, timedOut: false });
    throw new Error('Copilot retornou resposta vazia');
  }

  logger.debug('Copilot concluido', {
    elapsedMs: Date.now() - startedAt,
    stage
  });

  const result = clampText(candidate, maxOutputChars);
  recordCopilotRequest({ model, inputChars: prompt.length, outputChars: result.length, stage, success: true, timedOut: false });
  return result;
}

export async function askCopilot(rawText, options = {}) {
  await settingsStore.ensureReady();
  const runtime = settingsStore.get();

  const input = clampText(rawText, runtime.maxInputChars);
  if (!input) {
    return 'Envie uma mensagem com texto para eu responder.';
  }

  const isFullSender = Boolean(options.isFullSender);
  const chatCwd = isFullSender ? config.codexWorkdir : ensureChatCwd(runtime.systemPrompt || config.systemPrompt);
  const allowTools = isFullSender;
  const prompt = buildChatPrompt(input, runtime, options);

  const regularModel = runtime.copilotModel || config.copilotModel || '';
  const fullModel = runtime.copilotFullModel || config.copilotFullModel || regularModel;
  const model = isFullSender ? fullModel : regularModel;
  const fallbackModel = runtime.copilotFallbackModel || config.copilotFallbackModel || '';
  const baseEffort = runtime.copilotReasoningEffort || config.copilotReasoningEffort || runtime.codexReasoningEffort;
  const reasoningEffort = isFullSender
    ? (runtime.copilotFullReasoningEffort || config.copilotFullReasoningEffort || 'high')
    : baseEffort;
  const baseTimeoutMs = runtime.copilotTimeoutMs || config.copilotTimeoutMs || runtime.codexTimeoutMs;
  const fullTimeoutMs = runtime.copilotFullTimeoutMs || config.copilotFullTimeoutMs || 360000;
  const timeoutMs = isFullSender ? Math.max(baseTimeoutMs, fullTimeoutMs) : baseTimeoutMs;
  const fallbackTimeoutMs = runtime.copilotFallbackTimeoutMs || config.copilotFallbackTimeoutMs || runtime.codexFallbackTimeoutMs;

  try {
    return await runCopilot({
      prompt,
      model,
      timeoutMs,
      stage: 'primary',
      maxOutputChars: runtime.maxOutputChars,
      reasoningEffort,
      allowTools,
      cwd: chatCwd
    });
  } catch (error) {
    const primaryError = error instanceof Error ? error.message : String(error);
    const shouldTryFallback =
      Boolean(fallbackModel) &&
      (runtime.copilotFallbackOnTimeout || runtime.codexFallbackOnTimeout || !isTimeoutMessage(primaryError));

    if (shouldTryFallback) {
      logger.warn('Falha no Copilot primario; tentando fallback', {
        primaryError,
        fallbackModel
      });

      try {
        return await runCopilot({
          prompt,
          model: fallbackModel,
          timeoutMs: fallbackTimeoutMs,
          stage: 'fallback',
          maxOutputChars: runtime.maxOutputChars,
          reasoningEffort,
          allowTools,
          cwd: chatCwd
        });
      } catch (fallbackError) {
        logger.error('Falha no fallback do Copilot', {
          error: fallbackError instanceof Error ? fallbackError.message : String(fallbackError)
        });
        return runtime.fallbackMessage || config.fallbackMessage;
      }
    }

    if (fallbackModel && isTimeoutMessage(primaryError) && !runtime.codexFallbackOnTimeout) {
      logger.warn('Falha no Copilot primario por timeout; fallback desativado para timeout', {
        timeoutMs
      });
      return runtime.fallbackMessage || config.fallbackMessage;
    }

    logger.error('Falha ao consultar Copilot CLI', { error: primaryError });
    return runtime.fallbackMessage || config.fallbackMessage;
  }
}
