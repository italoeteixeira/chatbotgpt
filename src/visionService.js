import { spawn } from 'node:child_process';
import { askCodex } from './codexBridge.js';
import { config } from './config.js';
import { settingsStore } from './settingsStore.js';
import { logger } from './logger.js';

const VISION_DESCRIBE_PROMPT =
  'Analise esta imagem em detalhes. Identifique: tipo de objeto ou cena principal, ' +
  'todo texto visível (marcas, etiquetas, modelos, números, códigos, inscrições), ' +
  'características físicas relevantes, contexto geral. Seja objetivo e preciso. ' +
  'Se houver texto legível, transcreva-o exatamente como aparece na imagem.';

// Padrões que indicam que o Codex retornou mensagem de fallback (erro) em vez de análise real.
const FALLBACK_PATTERNS = [
  /lentid[aã]o/i,
  /tente novamente/i,
  /n[aã]o consegui responder/i,
  /tempo limite excedido/i,
  /nao consegui responder/i
];

/**
 * Verifica se o texto retornado pelo Codex é uma mensagem de fallback/erro,
 * não uma análise visual real.
 */
function isCodexFallback(text, runtimeFallbackMessage = '') {
  if (!text) return true;
  const normalized = String(text).trim();
  // Compara com a mensagem de fallback configurada
  if (runtimeFallbackMessage && normalized === runtimeFallbackMessage.trim()) return true;
  return FALLBACK_PATTERNS.some((p) => p.test(normalized));
}

/**
 * Realiza análise visual usando o Copilot CLI com suporte a imagens via caminho de arquivo.
 * O Copilot CLI com --allow-all-paths consegue ler e interpretar arquivos de imagem.
 */
async function callCopilotCliVision(imagePaths, question = '') {
  const token =
    process.env.COPILOT_GITHUB_TOKEN ||
    process.env.GH_TOKEN ||
    process.env.GITHUB_TOKEN ||
    '';

  const copilotBin = String(config.copilotBin || 'copilot').trim();

  // Monta o prompt incluindo os caminhos das imagens para que o CLI possa lê-las
  const imagePathsText = imagePaths.map((p, i) => `Imagem ${i + 1}: ${p}`).join('\n');
  const analysisRequest = question
    ? `Analise esta imagem e responda à pergunta: ${question}\n\nDescreva também o que você identifica visualmente: objetos, texto visível, marcas, modelos, etiquetas.`
    : VISION_DESCRIBE_PROMPT;

  const prompt = `${analysisRequest}\n\n${imagePathsText}`;

  const args = ['-p', prompt, '-s', '--no-color', '--no-ask-user', '--allow-all-paths'];

  const env = { ...process.env };
  if (token) env.COPILOT_GITHUB_TOKEN = token;

  logger.debug('visionService: chamando Copilot CLI para análise visual', {
    copilotBin,
    imageCount: imagePaths.length
  });

  return new Promise((resolve) => {
    let stdout = '';
    let timedOut = false;

    let child;
    try {
      child = spawn(copilotBin, args, {
        cwd: config.codexWorkdir || '/opt/chatbot',
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: false
      });
    } catch (spawnErr) {
      const reason = spawnErr instanceof Error ? spawnErr.message : String(spawnErr);
      logger.warn('visionService: falha ao iniciar Copilot CLI', { reason });
      resolve({ ok: false, reason });
      return;
    }

    child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', () => {});

    const timeoutMs = 90000;
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGKILL'); } catch {}
    }, timeoutMs);

    child.on('error', (err) => {
      clearTimeout(timer);
      const reason = err instanceof Error ? err.message : String(err);
      logger.warn('visionService: erro no Copilot CLI', { reason });
      resolve({ ok: false, reason });
    });

    child.on('close', () => {
      clearTimeout(timer);
      if (timedOut) {
        logger.warn('visionService: Copilot CLI timeout na análise visual');
        resolve({ ok: false, reason: 'timeout no Copilot CLI' });
        return;
      }
      const text = stdout.trim();
      if (text) {
        logger.info('visionService: análise via Copilot CLI concluída', {
          imageCount: imagePaths.length,
          chars: text.length
        });
        resolve({ ok: true, description: text });
      } else {
        logger.warn('visionService: Copilot CLI retornou resposta vazia');
        resolve({ ok: false, reason: 'Copilot CLI retornou resposta vazia' });
      }
    });

    child.stdin.end();
  });
}

/**
 * Classifies an attachment entry into a routing category.
 * Returns: 'audio' | 'photo' | 'pdf' | 'text' | 'video' | 'document' | 'unknown'
 */
export function classifyAttachment(entry) {
  if (!entry) return 'unknown';
  const mediaType = String(entry.mediaType || '').toLowerCase();
  const mimeType = String(entry.mimeType || '').toLowerCase();
  const fileName = String(entry.fileName || '').toLowerCase();

  if (mediaType === 'audio' || mimeType.startsWith('audio/')) return 'audio';
  if (mimeType === 'application/pdf' || fileName.endsWith('.pdf')) return 'pdf';
  if (mediaType === 'image' || mimeType.startsWith('image/')) return 'photo';
  if (mimeType.startsWith('text/') || fileName.endsWith('.txt')) return 'text';
  if (mediaType === 'video' || mimeType.startsWith('video/')) return 'video';
  return 'document';
}

/**
 * Analyzes an image using the Codex CLI vision capability, with Copilot CLI as fallback.
 * imagePaths: string[] — absolute paths to image files
 * question: optional user question to guide analysis
 * context: optional context for askCodex (groupId, senderNumber, etc.)
 *
 * Returns { ok: true, description: string } or { ok: false, reason: string }
 */
export async function analyzeImageWithVision(imagePaths, question = '', context = {}) {
  const paths = (Array.isArray(imagePaths) ? imagePaths : [imagePaths])
    .map((p) => String(p || '').trim())
    .filter(Boolean);

  if (!paths.length) {
    return { ok: false, reason: 'nenhum caminho de imagem fornecido' };
  }

  await settingsStore.ensureReady();
  const runtime = settingsStore.get();
  const runtimeFallbackMessage = String(runtime.fallbackMessage || config.fallbackMessage || '').trim();

  const analysisPrompt = question
    ? `Analise esta imagem e responda à pergunta: ${question}\n\nDescreva também o que você identifica visualmente: objetos, texto visível, marcas, modelos, etiquetas.`
    : VISION_DESCRIBE_PROMPT;

  const imageAttachments = paths.map((p) => ({ path: p, source: 'vision_analysis' }));

  // Tenta Codex CLI primeiro (suporta -i para imagens)
  let codexFailed = false;
  try {
    const result = await askCodex(analysisPrompt, {
      groupId: context.groupId || '',
      senderNumber: context.senderNumber || '',
      isAdminSender: false,
      isFullSender: false,
      imageAttachments
    });

    const text = String(result || '').trim();

    // Detecta se o Codex retornou mensagem de fallback em vez de análise real
    if (text && !isCodexFallback(text, runtimeFallbackMessage)) {
      logger.info('visionService: análise visual concluída via Codex', {
        imageCount: paths.length,
        chars: text.length
      });
      return { ok: true, description: text };
    }

    logger.warn('visionService: Codex retornou fallback/vazio — tentando Copilot CLI', {
      textSnippet: text.slice(0, 80)
    });
    codexFailed = true;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    logger.warn('visionService: Codex lançou exceção — tentando Copilot CLI', {
      reason: reason.slice(0, 200)
    });
    codexFailed = true;
  }

  if (codexFailed) {
    return callCopilotCliVision(paths, question);
  }

  return { ok: false, reason: 'análise visual não retornou descrição' };
}
