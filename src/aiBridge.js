import { spawn } from 'node:child_process';
import { askCodex } from './codexBridge.js';
import { askCopilot } from './copilotBridge.js';
import { analyzeImageWithVision } from './visionService.js';
import { settingsStore } from './settingsStore.js';
import { logger } from './logger.js';

function hasImageAttachments(value) {
  return Array.isArray(value) && value.some((item) => String(item?.path || '').trim());
}

function getImagePaths(attachments) {
  if (!Array.isArray(attachments)) return [];
  return attachments
    .map((item) => String(item?.path || '').trim())
    .filter(Boolean);
}

/**
 * Executa OCR local usando tesseract.
 * Retorna o texto extraído ou string vazia se falhar.
 */
function runLocalOcr(imagePath, timeoutMs = 15000) {
  return new Promise((resolve) => {
    const child = spawn('tesseract', [imagePath, 'stdout', '-l', 'por+eng'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: timeoutMs
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });

    child.on('error', () => resolve(''));
    child.on('close', (code) => {
      if (code === 0 && stdout.trim()) {
        resolve(stdout.trim());
      } else {
        logger.debug('tesseract OCR falhou ou vazio', { code, stderr: stderr.slice(0, 200) });
        resolve('');
      }
    });
  });
}

export async function askAI(rawText, options = {}) {
  await settingsStore.ensureReady();
  const runtime = settingsStore.get();
  const provider = String(runtime.aiProvider || 'codex').toLowerCase();
  const requiresImageInput = hasImageAttachments(options.imageAttachments);

  logger.debug('askAI roteando para provider', {
    provider,
    requiresImageInput
  });

  // Copilot não suporta -i (imagem inline).
  // Pipeline multimodal: visão (codex -i) em paralelo com OCR local; combina sinais.
  if (provider === 'copilot' && requiresImageInput) {
    const imagePaths = getImagePaths(options.imageAttachments);
    const isOcrOnly = /extrair?\s*(todo\s*o?\s*)?texto|ocr|ler\s*texto|retorne?\s*apenas\s*o\s*texto/i.test(rawText);

    // Para pedidos de OCR puro usamos apenas tesseract (mais rápido e preciso para texto)
    if (isOcrOnly) {
      const ocrResults = await Promise.all(imagePaths.map((p) => runLocalOcr(p)));
      const ocrText = ocrResults.filter(Boolean).join('\n---\n');
      if (ocrText) {
        logger.info('OCR local (tesseract) extraiu texto com sucesso', { imageCount: imagePaths.length, ocrChars: ocrText.length });
        return ocrText;
      }
      logger.info('OCR local nao encontrou texto na imagem', { imageCount: imagePaths.length });
      return 'Não consegui extrair texto desta imagem. Verifique se a imagem contém texto legível e tente novamente.';
    }

    // Para análise/descrição/perguntas visuais: rodamos visão (codex) e OCR em paralelo
    const visionContext = { groupId: options.groupId, senderNumber: options.senderNumber };
    const [visionSettled, ocrSettled] = await Promise.allSettled([
      analyzeImageWithVision(imagePaths, rawText, visionContext),
      Promise.all(imagePaths.map((p) => runLocalOcr(p)))
    ]);

    const visionResult = visionSettled.status === 'fulfilled' ? visionSettled.value : { ok: false };
    const ocrParts = ocrSettled.status === 'fulfilled' ? ocrSettled.value.filter(Boolean) : [];
    const ocrText = ocrParts.join('\n---\n');

    logger.debug('askAI multimodal: sinais coletados', {
      visionOk: visionResult.ok,
      visionChars: visionResult.ok ? visionResult.description?.length : 0,
      ocrChars: ocrText.length
    });

    // Se visão retornou resposta direta e satisfatória, devolve direto
    if (visionResult.ok && visionResult.description) {
      const contextParts = [`[Análise visual da imagem]:\n${visionResult.description}`];
      if (ocrText) contextParts.push(`[Texto extraído por OCR local]:\n${ocrText}`);

      const enrichedText = [rawText, '', ...contextParts].join('\n\n');
      return askCopilot(enrichedText, { ...options, imageAttachments: undefined });
    }

    // Visão falhou — tenta apenas com OCR
    if (ocrText) {
      logger.info('Visão falhou; usando OCR como fallback', { imageCount: imagePaths.length, ocrChars: ocrText.length });
      const enrichedText = `${rawText}\n\n[Texto extraído da(s) imagem(ns) por OCR local]:\n${ocrText}`;
      return askCopilot(enrichedText, { ...options, imageAttachments: undefined });
    }

    // Nem visão nem OCR funcionaram
    logger.info('Visão e OCR sem resultado; informando limitação ao usuário', { imageCount: imagePaths.length });
    const noInfoPrompt = `${rawText}\n\n[Nota do sistema: recebi uma imagem, mas tanto a análise visual quanto o OCR local não retornaram resultado para ela. Informe ao usuário de forma gentil que a análise não foi possível neste momento e sugira enviar a pergunta com mais detalhes ou tentar novamente.]`;
    return askCopilot(noInfoPrompt, { ...options, imageAttachments: undefined });
  }

  if (provider === 'copilot') {
    return askCopilot(rawText, options);
  }

  return askCodex(rawText, options);
}
