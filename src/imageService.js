import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { config } from './config.js';
import { askAI } from './aiBridge.js';
import { logger } from './logger.js';

const IMAGE_PROVIDER_BASE_URL = 'https://image.pollinations.ai/prompt/';
const IMAGE_FETCH_TIMEOUT_MS = 45000;
const IMAGE_MAX_ATTEMPTS = 5;
const IMAGE_PROVIDER_COOLDOWN_MS = 120000;
const IMAGE_REQUEST_SPACING_MS = 30000;

let imageRequestQueue = Promise.resolve();
let providerRateLimitedUntil = 0;
let nextImageRequestAt = 0;

function extensionFromContentType(contentType) {
  const ct = String(contentType || '').toLowerCase();
  if (ct.includes('png')) return 'png';
  if (ct.includes('webp')) return 'webp';
  if (ct.includes('jpeg') || ct.includes('jpg')) return 'jpg';
  return 'jpg';
}

function clampPrompt(text) {
  const normalized = String(text || '').trim();
  if (!normalized) return '';
  if (normalized.length <= 240) return normalized;
  return normalized.slice(0, 240);
}

function normalizeDerivedPrompt(text) {
  const normalized = String(text || '')
    .replace(/^\s*LOCAL_ACTION\s*:.+$/gim, '')
    .replace(/```(?:\w+)?/g, ' ')
    .replace(/^\s*(prompt|prompt final|image prompt)\s*:\s*/i, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^["'`]+|["'`]+$/g, '');

  return clampPrompt(normalized);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchImageResponse(url, timeoutMs = 20000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, {
      method: 'GET',
      headers: {
        Accept: 'image/*'
      },
      signal: controller.signal
    });
  } finally {
    clearTimeout(timer);
  }
}

function parseRetryAfterMs(value) {
  const normalized = String(value || '').trim();
  if (!normalized) return 0;

  const seconds = Number.parseInt(normalized, 10);
  if (Number.isFinite(seconds) && seconds > 0) {
    return seconds * 1000;
  }

  const target = Date.parse(normalized);
  if (!Number.isFinite(target)) return 0;

  return Math.max(0, target - Date.now());
}

function next429DelayMs(attempt, response) {
  const retryAfterMs = parseRetryAfterMs(response?.headers?.get('retry-after'));
  if (retryAfterMs > 0) {
    return Math.min(Math.max(retryAfterMs, 5000), 180000);
  }

  return Math.min(15000 * 2 ** Math.max(0, attempt - 1), 120000);
}

function nextRetryDelayMs(attempt, status) {
  if (status === 429) {
    return 0;
  }

  return Math.min(4000 * attempt, 20000);
}

function rememberProviderCooldown(delayMs) {
  if (delayMs <= 0) return;
  providerRateLimitedUntil = Math.max(providerRateLimitedUntil, Date.now() + delayMs);
}

function rememberNextRequestWindow(delayMs) {
  if (delayMs <= 0) return;
  nextImageRequestAt = Math.max(nextImageRequestAt, Date.now() + delayMs);
}

async function waitForProviderAvailability() {
  const waitUntil = Math.max(providerRateLimitedUntil, nextImageRequestAt);
  const remainingMs = waitUntil - Date.now();
  if (remainingMs <= 0) return;

  logger.warn('Aguardando janela do provedor de imagem', {
    waitMs: remainingMs
  });
  await sleep(remainingMs);
}

async function runImageRequestExclusively(task) {
  const previous = imageRequestQueue.catch(() => {});
  let release;
  imageRequestQueue = new Promise((resolve) => {
    release = resolve;
  });

  await previous;

  try {
    return await task();
  } finally {
    release();
  }
}

export async function generateImageFromPrompt(rawPrompt) {
  const prompt = clampPrompt(rawPrompt);
  if (!prompt) {
    throw new Error('Prompt de imagem vazio.');
  }

  if (!config.imageGenerationEnabled) {
    throw new Error('Geracao de imagem desativada (IMAGE_GENERATION_ENABLED=false).');
  }

  return runImageRequestExclusively(async () => {
    await waitForProviderAvailability();

    // Endpoint sem chave para gerar imagens no servidor.
    let response = null;

    for (let attempt = 1; attempt <= IMAGE_MAX_ATTEMPTS; attempt += 1) {
      const url = `${IMAGE_PROVIDER_BASE_URL}${encodeURIComponent(prompt)}?width=1024&height=1024&nologo=true&safe=true&seed=${Date.now()}-${attempt}`;

      try {
        response = await fetchImageResponse(url, IMAGE_FETCH_TIMEOUT_MS);
      } catch (error) {
        if (attempt >= IMAGE_MAX_ATTEMPTS) {
          const message = error instanceof Error ? error.message : String(error);
          throw new Error(`Falha ao contactar o provedor de imagem: ${message}`);
        }

        await sleep(nextRetryDelayMs(attempt, 0));
        continue;
      }

      if (response.ok) {
        break;
      }

      const retryable = response.status === 429 || response.status >= 500;
      if (!retryable || attempt >= IMAGE_MAX_ATTEMPTS) {
        if (response.status === 429) {
          throw new Error('Provedor de imagem temporariamente indisponivel por limite de uso. Aguarde cerca de 1 minuto e tente novamente.');
        }

        throw new Error(`Falha no provedor de imagem (${response.status}).`);
      }

      const delayMs = response.status === 429
        ? Math.max(next429DelayMs(attempt, response), IMAGE_PROVIDER_COOLDOWN_MS)
        : nextRetryDelayMs(attempt, response.status);

      if (response.status === 429) {
        rememberProviderCooldown(delayMs);
        logger.warn('Provedor de imagem respondeu com rate limit', {
          status: response.status,
          attempt,
          retryAfterMs: delayMs
        });
      }

      await sleep(delayMs);
    }

    const contentType = response.headers.get('content-type') || 'image/jpeg';
    const bytes = Buffer.from(await response.arrayBuffer());

    if (!bytes.length) {
      throw new Error('Imagem vazia retornada pelo provedor.');
    }

    await mkdir(config.generatedImagesDir, { recursive: true });

    const ext = extensionFromContentType(contentType);
    const fileName = `img-${Date.now()}-${randomUUID().slice(0, 8)}.${ext}`;
    const filePath = join(config.generatedImagesDir, fileName);
    await writeFile(filePath, bytes);
    rememberNextRequestWindow(IMAGE_REQUEST_SPACING_MS);

    return filePath;
  });
}

export async function generateImageVariationFromReference({
  referenceImagePath,
  instruction,
  groupId = '',
  senderNumber = ''
} = {}) {
  const normalizedPath = String(referenceImagePath || '').trim();
  const normalizedInstruction = String(instruction || '').trim();

  if (!normalizedPath) {
    throw new Error('Imagem de referencia ausente.');
  }

  if (!normalizedInstruction) {
    throw new Error('Instrucao de manipulacao vazia.');
  }

  const derivedPromptRaw = await askAI(
    [
      'Analise a imagem anexada e o pedido do usuario.',
      'Responda apenas com um unico prompt curto em ingles para gerar uma nova imagem baseada na referencia.',
      'Preserve os elementos visuais principais da imagem e aplique somente a transformacao pedida.',
      'Nao explique nada, nao use aspas, nao use markdown, maximo de 220 caracteres.',
      `Pedido do usuario: ${normalizedInstruction}`
    ].join('\n'),
    {
      groupId,
      senderNumber,
      imageAttachments: [
        {
          path: normalizedPath,
          source: 'reference_image'
        }
      ]
    }
  );

  const prompt = normalizeDerivedPrompt(derivedPromptRaw);
  if (!prompt) {
    throw new Error('Nao foi possivel derivar um prompt de variacao a partir da imagem.');
  }

  const filePath = await generateImageFromPrompt(prompt);
  return {
    filePath,
    prompt
  };
}
