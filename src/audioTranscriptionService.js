import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { promisify } from 'node:util';
import ffmpegStatic from 'ffmpeg-static';
import { config } from './config.js';

const execFileAsync = promisify(execFile);

function normalizeProvider(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (['auto', 'openai', 'whisper'].includes(normalized)) return normalized;
  return 'auto';
}

async function fileExists(filePath, executableOnly = false) {
  const mode = executableOnly ? constants.X_OK : constants.F_OK;
  try {
    await access(filePath, mode);
    return true;
  } catch {
    return false;
  }
}

async function commandExists(binary) {
  const normalized = String(binary || '').trim();
  if (!normalized) return false;

  if (normalized.includes('/') || normalized.startsWith('.')) {
    return fileExists(normalized, true);
  }

  try {
    await execFileAsync('which', [normalized]);
    return true;
  } catch {
    return false;
  }
}

function toLogError(error) {
  if (!error) return 'erro desconhecido';
  if (error instanceof Error) {
    const details = [];

    if (typeof error.message === 'string' && error.message.trim()) {
      details.push(error.message.trim());
    }

    const stderr = String(error.stderr || '').trim();
    if (stderr) {
      details.push(stderr.slice(0, 280));
    }

    return details.join(' | ') || 'erro desconhecido';
  }

  return String(error);
}

function compactWhitespace(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

/**
 * Pos-processamento do texto transcrito para melhorar qualidade.
 * - Remove artefatos comuns do Whisper ("[musica]", timestamps, etc.)
 * - Normaliza espacos e pontuacao
 * - Capitaliza inicio de frases
 */
function postProcessTranscription(text) {
  let cleaned = String(text || '').trim();
  if (!cleaned) return '';

  // Remove artefatos comuns do Whisper/OpenAI
  cleaned = cleaned
    .replace(/\[(?:musica|music|aplausos|risos|silencio|inaudivel)\]/gi, '')
    .replace(/\((?:musica|music|aplausos|risos|silencio|inaudivel)\)/gi, '')
    .replace(/\d{1,2}:\d{2}(?::\d{2})?(?:\.\d+)?\s*-->?\s*\d{1,2}:\d{2}(?::\d{2})?(?:\.\d+)?/g, '')
    .replace(/^\s*\d+\s*$/gm, '');

  // Normaliza espacos multiplos e quebras de linha excessivas
  cleaned = cleaned.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();

  // Capitaliza inicio de frase apos ponto final, exclamacao, interrogacao
  cleaned = cleaned.replace(/([.!?])\s+([a-záàâãéèêíïóôõúç])/g, (_, punct, letter) => {
    return `${punct} ${letter.toUpperCase()}`;
  });

  // Capitaliza primeira letra do texto
  if (cleaned.length > 0) {
    cleaned = cleaned[0].toUpperCase() + cleaned.slice(1);
  }

  // Garante ponto final se nao termina com pontuacao
  if (cleaned && !/[.!?…]$/.test(cleaned)) {
    cleaned += '.';
  }

  return cleaned;
}

function foldIntentText(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

function normalizeStatusProvider(value) {
  const normalized = normalizeProvider(value);
  if (normalized === 'auto') return 'openai+whisper';
  return normalized;
}

function extensionFromMime(mime = '') {
  const normalized = String(mime || '').toLowerCase();
  if (normalized.includes('ogg')) return 'ogg';
  if (normalized.includes('mpeg') || normalized.includes('mp3')) return 'mp3';
  if (normalized.includes('wav')) return 'wav';
  if (normalized.includes('mp4')) return 'mp4';
  if (normalized.includes('webm')) return 'webm';
  return 'bin';
}

export function truncateTranscriptionText(text, maxChars = config.audioTranscriptionMaxChars) {
  const normalized = String(text || '').trim();
  if (!normalized) return '';

  const limit = Math.max(100, Number.parseInt(String(maxChars || 0), 10) || config.audioTranscriptionMaxChars);
  if (normalized.length <= limit) return normalized;

  const suffix = '\n\n[transcricao truncada]';
  const room = Math.max(20, limit - suffix.length);
  return `${normalized.slice(0, room).trimEnd()}${suffix}`;
}

async function convertToWav(inputPath, tempDir) {
  const configured = String(config.audioTranscriptionFfmpegBin || '').trim();
  const ffmpegBin = configured || ffmpegStatic || '';

  if (!ffmpegBin) {
    return { ok: false, error: 'ffmpeg indisponivel para converter audio.' };
  }

  const exists = await commandExists(ffmpegBin);
  if (!exists) {
    return { ok: false, error: `ffmpeg nao encontrado: ${ffmpegBin}` };
  }

  const outputPath = join(tempDir, 'audio.wav');

  try {
    await execFileAsync(
      ffmpegBin,
      ['-hide_banner', '-loglevel', 'error', '-y', '-i', inputPath, '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', outputPath],
      { timeout: config.audioTranscriptionTimeoutMs }
    );

    return { ok: true, outputPath };
  } catch (error) {
    return { ok: false, error: toLogError(error) };
  }
}

async function transcribeWithOpenAi(entry) {
  const apiKey = String(config.openaiApiKey || '').trim();
  if (!apiKey) {
    return { ok: false, reason: 'OPENAI_API_KEY nao configurada.' };
  }

  const filePath = String(entry?.absolutePath || '').trim();
  if (!filePath) {
    return { ok: false, reason: 'arquivo de audio sem caminho.' };
  }

  const model = String(config.audioTranscriptionModel || '').trim() || 'gpt-4o-mini-transcribe';
  const apiBase = String(config.openaiApiBaseUrl || 'https://api.openai.com/v1').replace(/\/+$/, '');
  const endpoint = `${apiBase}/audio/transcriptions`;

  try {
    const bytes = await readFile(filePath);
    const body = new FormData();
    body.append('model', model);

    const language = String(config.audioTranscriptionLanguage || '').trim();
    if (language) body.append('language', language);

    // Prompt de contexto melhora precisao para portugues brasileiro
    const defaultPrompt = 'Transcreva com precisao este audio em portugues brasileiro. Use pontuacao correta, incluindo virgulas, pontos, e interrogacoes. Mantenha nomes proprios e termos tecnicos.';
    const prompt = String(config.audioTranscriptionPrompt || '').trim() || defaultPrompt;
    body.append('prompt', prompt);

    body.append('response_format', 'text');
    body.append(
      'file',
      new Blob([bytes], { type: String(entry?.mimeType || 'application/octet-stream') }),
      String(entry?.fileName || basename(filePath) || 'audio.ogg')
    );

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.audioTranscriptionTimeoutMs);
    timer.unref?.();

    let response;
    try {
      response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`
        },
        body,
        signal: controller.signal
      });
    } finally {
      clearTimeout(timer);
    }

    const contentType = String(response.headers.get('content-type') || '').toLowerCase();
    const payloadText = await response.text();

    if (!response.ok) {
      return {
        ok: false,
        reason: `OpenAI HTTP ${response.status}: ${compactWhitespace(payloadText).slice(0, 280) || 'sem detalhe'}`
      };
    }

    let transcript = payloadText;
    if (contentType.includes('application/json')) {
      try {
        const parsed = JSON.parse(payloadText);
        transcript = String(parsed?.text || payloadText);
      } catch {
        transcript = payloadText;
      }
    }

    const normalized = postProcessTranscription(transcript);
    if (!normalized) {
      return { ok: false, reason: 'transcricao vazia retornada pela API.' };
    }

    return {
      ok: true,
      provider: 'openai',
      text: truncateTranscriptionText(normalized)
    };
  } catch (error) {
    return {
      ok: false,
      reason: toLogError(error)
    };
  }
}

async function transcribeWithWhisper(entry) {
  const whisperBin = String(config.audioTranscriptionWhisperBin || 'whisper-cli').trim() || 'whisper-cli';
  const whisperModel = String(config.audioTranscriptionWhisperModel || '').trim();

  if (!whisperModel) {
    return { ok: false, reason: 'AUDIO_TRANSCRIPTION_WHISPER_MODEL nao configurado.' };
  }

  const hasWhisper = await commandExists(whisperBin);
  if (!hasWhisper) {
    return { ok: false, reason: `binario de transcricao nao encontrado: ${whisperBin}` };
  }

  const hasModel = await fileExists(whisperModel, false);
  if (!hasModel) {
    return { ok: false, reason: `modelo whisper nao encontrado: ${whisperModel}` };
  }

  const audioPath = String(entry?.absolutePath || '').trim();
  if (!audioPath) {
    return { ok: false, reason: 'arquivo de audio sem caminho.' };
  }

  const tempDir = await mkdtemp(join(tmpdir(), 'wa-audio-transcribe-'));

  try {
    const convert = await convertToWav(audioPath, tempDir);
    if (!convert.ok) {
      return { ok: false, reason: `falha ao converter audio: ${convert.error}` };
    }

    const outPrefix = join(tempDir, 'out');
    const args = ['-m', whisperModel, '-f', convert.outputPath, '-otxt', '-of', outPrefix];

    const language = String(config.audioTranscriptionWhisperLanguage || '').trim();
    if (language) {
      args.push('-l', language);
    }

    await execFileAsync(whisperBin, args, {
      timeout: config.audioTranscriptionTimeoutMs
    });

    const transcriptPath = `${outPrefix}.txt`;
    const rawText = await readFile(transcriptPath, 'utf8');
    const normalized = postProcessTranscription(rawText);

    if (!normalized) {
      return { ok: false, reason: 'transcricao vazia retornada pelo whisper.' };
    }

    return {
      ok: true,
      provider: 'whisper',
      text: truncateTranscriptionText(normalized)
    };
  } catch (error) {
    return { ok: false, reason: toLogError(error) };
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

function shouldTranscribeEntry(entry) {
  if (!config.audioTranscriptionEnabled) return false;
  if (!entry || typeof entry !== 'object') return false;
  if (entry.deletedAt) return false;

  const mediaType = String(entry.mediaType || '').toLowerCase();
  const mimeType = String(entry.mimeType || '').toLowerCase();
  if (mediaType === 'audio') return true;
  return mimeType.startsWith('audio/');
}

export async function transcribeMediaEntry(entry) {
  if (!shouldTranscribeEntry(entry)) {
    return { ok: false, skipped: true, reason: 'tipo de midia nao elegivel para transcricao.' };
  }

  const provider = normalizeProvider(config.audioTranscriptionProvider);
  const attempts = provider === 'auto' ? ['openai', 'whisper'] : [provider];
  const reasons = [];

  for (const mode of attempts) {
    const result = mode === 'openai' ? await transcribeWithOpenAi(entry) : await transcribeWithWhisper(entry);
    if (result.ok) return result;
    if (result.reason) reasons.push(`${mode}: ${result.reason}`);
  }

  return {
    ok: false,
    skipped: false,
    reason: reasons.join(' | ') || 'nao foi possivel transcrever o audio.'
  };
}

export function parseAudioTranscriptionIntent(text) {
  const folded = foldIntentText(text);
  if (!folded) return null;

  const mentionsTranscription = /\b(transcri(?:c|v)[a-z]*|transcrever|transcreve|transcricao)\b/.test(folded);
  const mentionsAudio = /\b(audio|audios|voz|mensagem de voz|gravacao|gravacoes)\b/.test(folded);
  const capabilityHint = /\b(pode|consegue|tem|suporta|faz)\b/.test(folded);

  if (mentionsTranscription && mentionsAudio && capabilityHint) {
    return { action: 'capability' };
  }

  if (mentionsTranscription && mentionsAudio) {
    return { action: 'transcribe' };
  }

  return null;
}

export function getAudioTranscriptionStatus() {
  const provider = normalizeProvider(config.audioTranscriptionProvider);
  const usingOpenAi = provider === 'openai' || provider === 'auto';
  const usingWhisper = provider === 'whisper' || provider === 'auto';

  const hasOpenAi = !usingOpenAi || Boolean(String(config.openaiApiKey || '').trim());
  const hasWhisper =
    !usingWhisper ||
    (Boolean(String(config.audioTranscriptionWhisperBin || '').trim()) &&
      Boolean(String(config.audioTranscriptionWhisperModel || '').trim()));

  const enabled = Boolean(config.audioTranscriptionEnabled);
  const available = enabled && (hasOpenAi || hasWhisper);

  return {
    enabled,
    available,
    provider: normalizeStatusProvider(provider),
    reason: available
      ? ''
      : enabled
      ? 'Configuracao incompleta (defina OPENAI_API_KEY ou Whisper bin/model).'
      : 'Transcricao de audio desativada no .env.'
  };
}

export function buildAudioTranscriptionCapabilityMessage(status = {}, options = {}) {
  if (options?.mentionsVsCode) {
    return 'Sim. Funciona no servidor Linux sem depender do VS Code aberto.';
  }

  if (!status.enabled) {
    return 'A transcricao de audio esta desativada no momento.';
  }

  if (!status.available) {
    return `A transcricao de audio esta habilitada, mas falta configuracao: ${status.reason || 'verifique .env'}`;
  }

  return `Sim. A transcricao de audio esta ativa (${status.provider || 'provider padrao'}). Envie o audio no grupo que eu transcrevo automaticamente.`;
}

export function buildAutomaticAudioTranscriptionReceipt() {
  return 'Transcrevendo audio...';
}

async function transcribeDownloadedMessageMedia(message) {
  if (!message?.hasMedia || typeof message.downloadMedia !== 'function') {
    return { ok: false, message: 'Nao encontrei audio para transcrever nessa mensagem.' };
  }

  const media = await message.downloadMedia();
  if (!media?.data) {
    return { ok: false, message: 'Nao consegui baixar o audio para transcricao.' };
  }

  const mimeType = String(media.mimetype || '').toLowerCase();
  const isAudio = mimeType.startsWith('audio/') || ['audio', 'ptt', 'voice'].includes(String(message.type || '').toLowerCase());
  if (!isAudio) {
    return { ok: false, message: 'A mensagem citada nao e um audio.' };
  }

  const tempDir = await mkdtemp(join(tmpdir(), 'wa-audio-request-'));
  try {
    const ext = extensionFromMime(mimeType);
    const fileName = media.filename || `audio.${ext}`;
    const absolutePath = join(tempDir, fileName);
    const bytes = Buffer.from(String(media.data), 'base64');
    await writeFile(absolutePath, bytes);

    const result = await transcribeMediaEntry({
      mediaType: 'audio',
      mimeType: mimeType || 'audio/ogg',
      absolutePath,
      fileName
    });

    if (!result.ok) {
      return { ok: false, message: `Nao consegui transcrever agora: ${result.reason || 'erro desconhecido'}` };
    }

    return {
      ok: true,
      text: result.text || '',
      sourceLabel: result.provider || 'audio'
    };
  } catch (error) {
    return {
      ok: false,
      message: `Falha na transcricao: ${toLogError(error)}`
    };
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

export async function transcribeAudioRequest({ context = {} } = {}) {
  const incoming = context?.message || null;
  if (!incoming) {
    return { ok: false, message: 'Nao encontrei mensagem de audio para transcrever.' };
  }

  if (incoming.hasQuotedMsg && typeof incoming.getQuotedMessage === 'function') {
    try {
      const quoted = await incoming.getQuotedMessage();
      const quotedResult = await transcribeDownloadedMessageMedia(quoted);
      if (quotedResult.ok) return quotedResult;
    } catch {
      // segue para tentativa na mensagem atual.
    }
  }

  return transcribeDownloadedMessageMedia(incoming);
}
