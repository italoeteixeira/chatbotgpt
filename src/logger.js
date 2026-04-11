import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { EventEmitter } from 'node:events';
import { config } from './config.js';

export const logEvents = new EventEmitter();

const buffer = [];

async function persistLog(line) {
  try {
    await mkdir(dirname(config.logFile), { recursive: true });
    await appendFile(config.logFile, line + '\n', 'utf8');
  } catch {
    // Evita quebrar o bot por falha de escrita de log.
  }
}

function pushToBuffer(entry) {
  buffer.push(entry);
  if (buffer.length > config.logBufferSize) {
    buffer.splice(0, buffer.length - config.logBufferSize);
  }
}

function toLine(entry) {
  const payload = {
    ts: entry.ts,
    level: entry.level,
    message: entry.message,
    meta: entry.meta
  };

  return JSON.stringify(payload);
}

export function getRecentLogs() {
  return [...buffer];
}

export function log(level, message, meta = {}) {
  const entry = {
    ts: new Date().toISOString(),
    level,
    message,
    meta
  };

  pushToBuffer(entry);
  logEvents.emit('log', entry);

  const line = toLine(entry);
  if (level === 'error') {
    console.error(line);
  } else {
    console.log(line);
  }

  void persistLog(line);
}

export const logger = {
  debug: (message, meta = {}) => log('debug', message, meta),
  info: (message, meta = {}) => log('info', message, meta),
  warn: (message, meta = {}) => log('warn', message, meta),
  error: (message, meta = {}) => log('error', message, meta)
};
