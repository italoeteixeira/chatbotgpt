import { mkdir, readdir, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { config } from './config.js';

const DATA_DIR = 'data';
const BACKUP_DIR = join('data', 'backups');
const MAX_BACKUPS = 7;
const BACKUP_TIMEOUT_MS = 120_000; // 2 min
const CMD_OUTPUT_LIMIT = 12_000;
const VALIDATION_TIMEOUT_MS = 20 * 60_000; // 20 min
const GIT_TIMEOUT_MS = 3 * 60_000; // 3 min
const GIT_PUSH_TIMEOUT_MS = 5 * 60_000; // 5 min

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

/**
 * Plano de backup validado:
 * 1) valida o projeto (npm run check)
 * 2) cria backup da pasta data/
 * 3) gera bundle completo do git
 * 4) comita alterações pendentes (se houver)
 * 5) faz push de branches no GitHub
 *
 * @param {object} [options]
 * @param {string[]} [options.branches]
 * @returns {Promise<{
 *  ok: boolean,
 *  steps: Array<{name: string, ok: boolean, detail?: string}>,
 *  message: string,
 *  backupFile?: string,
 *  gitBundleFile?: string,
 *  commitHash?: string,
 *  commitCreated?: boolean,
 *  pushTarget?: string
 * }>}
 */
export async function runValidatedGithubBackupPlan(options = {}) {
  const steps = [];
  const branches = normalizeBranches(options.branches || config.githubBackupBranches || ['main', 'homologacao']);

  if (!config.githubBackupEnabled) {
    return failPlan(
      steps,
      'backup_plan_disabled',
      'Plano de backup GitHub desativado (GITHUB_BACKUP_ENABLED=false).'
    );
  }

  const gitRepoCheck = await runCommand('git', ['rev-parse', '--is-inside-work-tree'], {
    timeoutMs: GIT_TIMEOUT_MS
  });
  if (!gitRepoCheck.ok || !/true/i.test(gitRepoCheck.stdout || '')) {
    return failPlan(steps, 'precheck_git', 'Diretorio atual nao e um repositorio git.');
  }
  steps.push({ name: 'precheck_git', ok: true, detail: 'Repositorio Git detectado.' });

  const validation = await runCommand('npm', ['run', 'check'], {
    timeoutMs: VALIDATION_TIMEOUT_MS
  });
  if (!validation.ok) {
    const detail = summarizeCommandFailure(validation, 'Falha na validacao do codigo (npm run check).');
    return failPlan(steps, 'validacao', detail);
  }
  steps.push({ name: 'validacao', ok: true, detail: 'npm run check concluido com sucesso.' });

  const backupResult = await createBackup();
  if (!backupResult.ok) {
    return failPlan(steps, 'backup_data', `Falha ao criar backup de data/: ${backupResult.error || 'erro desconhecido'}`);
  }
  const backupFile = String(backupResult.path || '').split('/').pop() || backupResult.path;
  steps.push({ name: 'backup_data', ok: true, detail: `Backup data criado: ${backupFile}` });

  const bundleTs = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const gitBundlePath = join(BACKUP_DIR, `git-bundle-${bundleTs}.bundle`);
  const bundleResult = await runCommand('git', ['bundle', 'create', gitBundlePath, '--all'], {
    timeoutMs: GIT_TIMEOUT_MS
  });
  if (!bundleResult.ok) {
    const detail = summarizeCommandFailure(bundleResult, 'Falha ao gerar bundle git.');
    return failPlan(steps, 'backup_git_bundle', detail);
  }
  const gitBundleFile = gitBundlePath.split('/').pop() || gitBundlePath;
  steps.push({ name: 'backup_git_bundle', ok: true, detail: `Bundle git criado: ${gitBundleFile}` });

  const stageResult = await runCommand('git', ['add', '-A'], { timeoutMs: GIT_TIMEOUT_MS });
  if (!stageResult.ok) {
    const detail = summarizeCommandFailure(stageResult, 'Falha ao preparar arquivos para commit.');
    return failPlan(steps, 'git_add', detail);
  }
  steps.push({ name: 'git_add', ok: true, detail: 'Arquivos preparados para commit.' });

  const statusResult = await runCommand('git', ['status', '--porcelain'], { timeoutMs: GIT_TIMEOUT_MS });
  if (!statusResult.ok) {
    const detail = summarizeCommandFailure(statusResult, 'Falha ao verificar status do git.');
    return failPlan(steps, 'git_status', detail);
  }

  let commitCreated = false;
  let commitHash = '';
  if ((statusResult.stdout || '').trim()) {
    const commitMsg = `Backup validado ${new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })}`;
    const commitResult = await runCommand('git', ['commit', '-m', commitMsg], { timeoutMs: GIT_TIMEOUT_MS });
    if (!commitResult.ok) {
      const detail = summarizeCommandFailure(commitResult, 'Falha ao criar commit de backup.');
      return failPlan(steps, 'git_commit', detail);
    }
    const hashResult = await runCommand('git', ['rev-parse', '--short', 'HEAD'], { timeoutMs: GIT_TIMEOUT_MS });
    commitCreated = true;
    commitHash = hashResult.ok ? (hashResult.stdout || '').trim() : '';
    steps.push({
      name: 'git_commit',
      ok: true,
      detail: `Commit de backup criado${commitHash ? ` (${commitHash})` : ''}.`
    });
  } else {
    steps.push({ name: 'git_commit', ok: true, detail: 'Sem alteracoes pendentes para commit.' });
  }

  const branchEnsuring = await ensureLocalBranches(branches);
  if (!branchEnsuring.ok) {
    return failPlan(steps, 'git_branches', branchEnsuring.message || 'Falha ao preparar branches de backup.');
  }
  steps.push({ name: 'git_branches', ok: true, detail: branchEnsuring.message });

  const pushTarget = await resolvePushTarget();
  if (!pushTarget.ok) {
    return failPlan(steps, 'git_push_target', pushTarget.message || 'Nao foi possivel resolver destino de push.');
  }
  steps.push({ name: 'git_push_target', ok: true, detail: `Destino: ${pushTarget.display}` });

  for (const branch of branches) {
    const pushResult = await runCommand('git', ['push', pushTarget.target, branch], {
      timeoutMs: GIT_PUSH_TIMEOUT_MS
    });
    if (!pushResult.ok) {
      const detail = summarizeCommandFailure(pushResult, `Falha no push da branch ${branch}.`);
      return failPlan(steps, `git_push_${branch}`, detail);
    }
    steps.push({ name: `git_push_${branch}`, ok: true, detail: `Branch ${branch} enviada com sucesso.` });
  }

  return {
    ok: true,
    steps,
    message: `Plano de backup concluido. Validacao OK e push realizado em ${branches.join(', ')}.`,
    backupFile,
    gitBundleFile,
    commitCreated,
    commitHash,
    pushTarget: pushTarget.display
  };
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

async function runCommand(command, args, options = {}) {
  const timeoutMs = Number(options.timeoutMs || 60_000);
  const cwd = options.cwd || process.cwd();
  const env = { ...process.env, ...(options.env || {}) };

  return await new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const appendChunk = (chunk, target) => {
      const text = String(chunk || '');
      if (target === 'stdout') {
        stdout = `${stdout}${text}`.slice(-CMD_OUTPUT_LIMIT);
      } else {
        stderr = `${stderr}${text}`.slice(-CMD_OUTPUT_LIMIT);
      }
    };

    child.stdout.on('data', (chunk) => appendChunk(chunk, 'stdout'));
    child.stderr.on('data', (chunk) => appendChunk(chunk, 'stderr'));

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 1500).unref();
    }, timeoutMs);

    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({
        ok: false,
        exitCode: -1,
        signal: null,
        stdout: stdout.trim(),
        stderr: String(error?.message || error),
        timedOut
      });
    });

    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({
        ok: !timedOut && code === 0,
        exitCode: Number.isInteger(code) ? code : -1,
        signal: signal || null,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        timedOut
      });
    });
  });
}

async function ensureLocalBranches(branches) {
  try {
    const currentBranchResult = await runCommand('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      timeoutMs: GIT_TIMEOUT_MS
    });
    if (!currentBranchResult.ok) {
      return { ok: false, message: 'Nao foi possivel identificar a branch atual.' };
    }
    const currentBranch = (currentBranchResult.stdout || 'main').trim() || 'main';

    for (const branch of branches) {
      const existsResult = await runCommand('git', ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], {
        timeoutMs: GIT_TIMEOUT_MS
      });
      if (existsResult.ok) continue;
      const createResult = await runCommand('git', ['branch', branch, currentBranch], {
        timeoutMs: GIT_TIMEOUT_MS
      });
      if (!createResult.ok) {
        return {
          ok: false,
          message: summarizeCommandFailure(createResult, `Falha ao criar branch local ${branch}.`)
        };
      }
    }
    return { ok: true, message: `Branches prontas: ${branches.join(', ')}.` };
  } catch (error) {
    return { ok: false, message: String(error?.message || error) };
  }
}

async function resolvePushTarget() {
  const originUrlResult = await runCommand('git', ['remote', 'get-url', 'origin'], { timeoutMs: GIT_TIMEOUT_MS });
  if (!originUrlResult.ok) {
    return { ok: false, message: 'Remote origin nao configurado.' };
  }

  const originUrl = (originUrlResult.stdout || '').trim();
  if (!originUrl) return { ok: false, message: 'Remote origin vazio.' };

  const repoSlug = normalizeRepoSlug(config.githubBackupRepo) || normalizeRepoSlug(originUrl);
  const token = String(config.githubBackupToken || '').trim();

  if (token && repoSlug) {
    return {
      ok: true,
      target: `https://x-access-token:${token}@github.com/${repoSlug}.git`,
      display: `https://github.com/${repoSlug}.git`
    };
  }

  return { ok: true, target: 'origin', display: sanitizeRemoteForDisplay(originUrl) };
}

function normalizeRepoSlug(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';

  let slug = raw;
  slug = slug.replace(/^https?:\/\/[^@]*@?github\.com\//i, '');
  slug = slug.replace(/^git@github\.com:/i, '');
  slug = slug.replace(/^github\.com\//i, '');
  slug = slug.replace(/\.git$/i, '');
  slug = slug.replace(/^\/+|\/+$/g, '');

  if (!/^[^/\s]+\/[^/\s]+$/.test(slug)) return '';
  return slug;
}

function sanitizeRemoteForDisplay(value) {
  const raw = String(value || '').trim();
  if (!raw) return '-';
  return raw.replace(/\/\/[^@]+@/g, '//***@');
}

function normalizeBranches(value) {
  const list = Array.isArray(value) ? value : [];
  const unique = [];
  for (const item of list) {
    const branch = String(item || '').trim();
    if (!branch) continue;
    if (unique.includes(branch)) continue;
    unique.push(branch);
  }
  return unique.length ? unique : ['main', 'homologacao'];
}

function summarizeCommandFailure(result, fallback) {
  if (!result) return fallback;
  if (result.timedOut) return `${fallback} Tempo limite excedido.`;
  const err = String(result.stderr || result.stdout || '').trim();
  if (!err) return fallback;
  return `${fallback} ${err.slice(0, 600)}`;
}

function failPlan(steps, stepName, message) {
  steps.push({ name: stepName, ok: false, detail: message });
  return { ok: false, steps, message };
}
