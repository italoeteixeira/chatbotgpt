import { mkdir, readdir, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

const DATA_DIR = 'data';
const BACKUP_DIR = join('data', 'backups');
const MAX_BACKUPS = 7;
const BACKUP_TIMEOUT_MS = 120_000; // 2 min

/**
 * Cria um backup comprimido da pasta data/ (excluindo subpasta backups).
 * @param {string} [dataDir]    caminho relativo ao cwd
 * @param {string} [backupDir]  pasta de destino
 * @param {number} [maxBackups] quantos backups manter
 * @returns {Promise<{ok: boolean, path?: string, error?: string}>}
 */
export async function createBackup(
  dataDir = DATA_DIR,
  backupDir = BACKUP_DIR,
  maxBackups = MAX_BACKUPS,
) {
  try {
    const cwd = process.cwd();
    const backupDirFull = join(cwd, backupDir);
    await mkdir(backupDirFull, { recursive: true });

    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const outFile = join(backupDirFull, `backup-${ts}.tar.gz`);

    await new Promise((resolve, reject) => {
      const child = spawn(
        'tar',
        ['--exclude=backups', '-czf', outFile, '-C', cwd, dataDir],
        { stdio: ['ignore', 'pipe', 'pipe'] },
      );
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error('backup timeout'));
      }, BACKUP_TIMEOUT_MS);
      child.on('exit', (code) => {
        clearTimeout(timer);
        if (code === 0) resolve();
        else reject(new Error(`tar exit ${code}`));
      });
    });

    // Garante que o arquivo existe e tem tamanho > 0
    const info = await stat(outFile);
    if (info.size === 0) throw new Error('backup file empty');

    await _gcOldBackups(backupDirFull, maxBackups);

    return { ok: true, path: outFile };
  } catch (err) {
    return { ok: false, error: String(err?.message ?? err) };
  }
}

/**
 * Lista os backups disponíveis.
 * @param {string} [backupDir]
 * @returns {Promise<string[]>} nomes dos arquivos em ordem crescente
 */
export async function listBackups(backupDir = BACKUP_DIR) {
  try {
    const backupDirFull = join(process.cwd(), backupDir);
    const files = await readdir(backupDirFull).catch(() => []);
    return files
      .filter((f) => f.startsWith('backup-') && f.endsWith('.tar.gz'))
      .sort();
  } catch {
    return [];
  }
}

/**
 * Inicia agendador automático de backup.
 * Primeiro backup 1h após o start; depois a cada intervalHours.
 * @param {number} [intervalHours]
 */
export function startBackupScheduler(intervalHours = 24) {
  const intervalMs = intervalHours * 3_600_000;
  const firstRunMs = 3_600_000; // 1h

  const run = async () => {
    const result = await createBackup();
    console.info(JSON.stringify({ event: 'auto_backup', ...result }));
    setTimeout(run, intervalMs);
  };

  setTimeout(run, firstRunMs);
}

// ─── helpers ────────────────────────────────────────────────────────────────

async function _gcOldBackups(backupDirFull, maxBackups) {
  const files = (await readdir(backupDirFull))
    .filter((f) => f.startsWith('backup-') && f.endsWith('.tar.gz'))
    .sort();
  const toDelete = files.slice(0, Math.max(0, files.length - maxBackups));
  for (const f of toDelete) {
    await unlink(join(backupDirFull, f)).catch(() => {});
  }
}
