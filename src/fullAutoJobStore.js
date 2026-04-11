import { EventEmitter } from 'node:events';
import { botDatabase } from './botDatabase.js';

const MAX_HISTORY = 120;

const jobsById = new Map();
const latestJobIdByRequester = new Map();

export const fullAutoJobEvents = new EventEmitter();

function normalizeGroupId(value) {
  return String(value || 'sem-grupo').trim() || 'sem-grupo';
}

/**
 * Normalização canônica de número de telefone para chave de rastreamento.
 * Remove prefixos @c.us/@s.whatsapp.net, código do país duplicado, e espaços.
 * Resultado: somente dígitos, sem '+', sem '@domínio'.
 */
function normalizeSenderNumber(value) {
  let s = String(value || '').trim();
  if (!s || s === 'desconhecido') return 'desconhecido';
  // Remove domínio WhatsApp (@c.us, @s.whatsapp.net, etc)
  s = s.replace(/@\S+$/, '');
  // Remove caracteres não numéricos (exceto '+' temporariamente)
  s = s.replace(/[^\d+]/g, '');
  // Remove '+' inicial
  s = s.replace(/^\+/, '');
  // Normaliza código de país BR: remove 55 duplo se número tiver > 13 dígitos
  if (s.startsWith('55') && s.length > 13) s = s.slice(2);
  return s || 'desconhecido';
}

function buildRequesterKey({ groupId, senderNumber }) {
  return `${normalizeGroupId(groupId)}::${normalizeSenderNumber(senderNumber)}`;
}

function cloneJob(job, now = Date.now()) {
  if (!job) return null;

  const startedAt = Number(job.startedAt || 0);
  const finishedAt = Number(job.finishedAt || 0) || null;
  const effectiveEnd = finishedAt || now;

  return {
    ...job,
    logLines: Array.isArray(job.logLines) ? [...job.logLines] : [],
    elapsedMs: startedAt > 0 ? Math.max(0, effectiveEnd - startedAt) : 0,
    isRunning: job.status === 'running'
  };
}

function sortJobsDesc(left, right) {
  const leftStartedAt = Number(left?.startedAt || 0);
  const rightStartedAt = Number(right?.startedAt || 0);
  return rightStartedAt - leftStartedAt;
}

function pruneFinishedJobs() {
  if (jobsById.size <= MAX_HISTORY) return;

  const removable = [...jobsById.values()]
    .filter((job) => job.status !== 'running')
    .sort((left, right) => {
      const leftFinishedAt = Number(left?.finishedAt || left?.updatedAt || left?.startedAt || 0);
      const rightFinishedAt = Number(right?.finishedAt || right?.updatedAt || right?.startedAt || 0);
      return leftFinishedAt - rightFinishedAt;
    });

  while (jobsById.size > MAX_HISTORY && removable.length) {
    const job = removable.shift();
    if (!job) break;
    jobsById.delete(job.id);

    const requesterKey = buildRequesterKey(job);
    if (latestJobIdByRequester.get(requesterKey) === job.id) {
      latestJobIdByRequester.delete(requesterKey);
    }
  }
}

function emitSnapshot() {
  fullAutoJobEvents.emit('update', getFullAutoJobsSnapshot());
}

export function createFullAutoJob({
  id,
  groupId,
  senderNumber,
  request,
  status = 'running',
  statusLabel = '',
  detail = ''
}) {
  const startedAt = Date.now();
  const job = {
    id: String(id || '').trim(),
    groupId: normalizeGroupId(groupId),
    senderNumber: normalizeSenderNumber(senderNumber),
    request: String(request || '').trim(),
    status: String(status || 'running').trim() || 'running',
    statusLabel: String(statusLabel || '').trim(),
    detail: String(detail || '').trim(),
    summary: '',
    error: '',
    validationStatus: '',
    logLines: [],
    filesChanged: [],   // arquivos editados durante a execução do job
    startedAt,
    updatedAt: startedAt,
    finishedAt: null
  };

  jobsById.set(job.id, job);
  latestJobIdByRequester.set(buildRequesterKey(job), job.id);
  pruneFinishedJobs();
  emitSnapshot();

  // Persist to DB asynchronously (fire-and-forget)
  setImmediate(() => {
    try {
      botDatabase.saveFullJob(job);
    } catch {
      // ignore db errors on create
    }
  });

  return cloneJob(job);
}

export function getFullAutoJobById(jobId) {
  const normalizedId = String(jobId || '').trim();
  if (!normalizedId) return null;
  return cloneJob(jobsById.get(normalizedId));
}

export function getLatestFullAutoJob({ groupId, senderNumber } = {}) {
  const requesterKey = buildRequesterKey({ groupId, senderNumber });
  const jobId = latestJobIdByRequester.get(requesterKey);
  if (!jobId) return null;
  return cloneJob(jobsById.get(jobId));
}

export function updateFullAutoJob(jobId, patch = {}) {
  const normalizedId = String(jobId || '').trim();
  const job = jobsById.get(normalizedId);
  if (!job) return null;

  const nextStatus = String(patch.status || job.status || 'running').trim() || 'running';
  const updatedAt = Number(patch.updatedAt || Date.now());

  Object.assign(job, {
    ...patch,
    status: nextStatus,
    statusLabel:
      patch.statusLabel === undefined ? job.statusLabel : String(patch.statusLabel || '').trim(),
    detail: patch.detail === undefined ? job.detail : String(patch.detail || '').trim(),
    summary: patch.summary === undefined ? job.summary : String(patch.summary || '').trim(),
    error: patch.error === undefined ? job.error : String(patch.error || '').trim(),
    validationStatus:
      patch.validationStatus === undefined ? job.validationStatus : String(patch.validationStatus || '').trim(),
    updatedAt
  });

  if (nextStatus === 'running') {
    job.finishedAt = null;
  } else if (patch.finishedAt !== undefined) {
    job.finishedAt = Number(patch.finishedAt || 0) || null;
  } else if (!job.finishedAt) {
    job.finishedAt = updatedAt;
  }

  pruneFinishedJobs();
  emitSnapshot();

  // Persist to DB asynchronously (fire-and-forget)
  const jobSnapshot = { ...job };
  setImmediate(() => {
    try {
      botDatabase.saveFullJob(jobSnapshot);
    } catch {
      // ignore db errors on update
    }
  });

  return cloneJob(job);
}

export function appendJobLog(jobId, line) {
  const normalizedId = String(jobId || '').trim();
  const job = jobsById.get(normalizedId);
  const logLine = String(line || '').trim();
  if (!logLine) return;

  if (job) {
    job.logLines.push(logLine);
    job.updatedAt = Date.now();
    // Persist updated job
    const jobSnapshot = { ...job };
    setImmediate(() => {
      try {
        botDatabase.saveFullJob(jobSnapshot);
      } catch {
        // ignore
      }
    });
  } else {
    // Job not in memory — update DB directly
    const existing = botDatabase.getFullJobById(normalizedId);
    if (existing) {
      existing.logLines.push(logLine);
      existing.updatedAt = Date.now();
      try {
        botDatabase.saveFullJob(existing);
      } catch {
        // ignore
      }
    }
  }
}

/**
 * Registra um arquivo modificado durante a execução de um job FULL.
 * Deduplica entradas; persiste de forma assíncrona.
 */
export function appendFileChanged(jobId, filePath) {
  const normalizedId = String(jobId || '').trim();
  const file = String(filePath || '').trim();
  if (!normalizedId || !file) return;

  const job = jobsById.get(normalizedId);
  if (!job) return;

  if (!Array.isArray(job.filesChanged)) job.filesChanged = [];
  if (!job.filesChanged.includes(file)) {
    job.filesChanged.push(file);
    job.updatedAt = Date.now();
    const jobSnapshot = { ...job };
    setImmediate(() => {
      try { botDatabase.saveFullJob(jobSnapshot); } catch { /* ignore */ }
    });
  }
}

export async function loadJobsFromDb() {
  try {
    await botDatabase.ensureReady();
    const jobs = botDatabase.listFullJobsByAge({ limit: 500, daysBack: 30 });
    for (const job of jobs) {
      // Jobs que ficaram como 'running' de restarts anteriores são marcados como
      // error para não ficarem presos em estado inconsistente.
      if (job.status === 'running') {
        const stale = {
          ...job,
          logLines: Array.isArray(job.logLines) ? job.logLines : [],
          status: 'error',
          error: 'Interrompido: processo reiniciado enquanto job estava em execução.',
          updatedAt: Date.now()
        };
        jobsById.set(job.id, stale);
        latestJobIdByRequester.set(buildRequesterKey(job), job.id);
        try { botDatabase.saveFullJob(stale); } catch { /* ignore */ }
        continue;
      }
      if (!jobsById.has(job.id)) {
        jobsById.set(job.id, {
          ...job,
          logLines: Array.isArray(job.logLines) ? job.logLines : []
        });
        latestJobIdByRequester.set(buildRequesterKey(job), job.id);
      }
    }
    pruneFinishedJobs();
  } catch {
    // ignore errors on startup restore
  }
}

export function listFullAutoJobs({ limit = MAX_HISTORY } = {}) {
  const normalizedLimit = Math.max(1, Number(limit || MAX_HISTORY) || MAX_HISTORY);
  return [...jobsById.values()]
    .sort(sortJobsDesc)
    .slice(0, normalizedLimit)
    .map((job) => cloneJob(job));
}

export function getFullAutoJobsSnapshot({ limit = MAX_HISTORY } = {}) {
  const items = listFullAutoJobs({ limit });
  return {
    ok: true,
    updatedAt: new Date().toISOString(),
    runningCount: items.filter((job) => job.status === 'running').length,
    total: jobsById.size,
    items
  };
}

export function hasRunningFullJobs() {
  for (const job of jobsById.values()) {
    if (job.status === 'running') return true;
  }
  return false;
}

export async function waitForFullJobsToComplete(maxMs = 300_000) {
  if (!hasRunningFullJobs()) return;
  const deadline = Date.now() + maxMs;
  await new Promise((resolve) => {
    const check = () => {
      if (!hasRunningFullJobs() || Date.now() >= deadline) {
        fullAutoJobEvents.off('update', check);
        resolve();
        return;
      }
    };
    fullAutoJobEvents.on('update', check);
    // Also poll in case events were missed.
    const poll = setInterval(() => {
      if (!hasRunningFullJobs() || Date.now() >= deadline) {
        clearInterval(poll);
        fullAutoJobEvents.off('update', check);
        resolve();
      }
    }, 2000);
  });
}
