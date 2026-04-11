import { mkdir, readdir, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { config } from './config.js';

const DATA_DIR = 'data';
const BACKUP_DIR = join('data', 'backups');
const MAX_BACKUPS = 7;
const BACKUP_TIMEOUT_MS = 120_000; // 2 min
const CMD_OUTPUT_LIMIT = 12_000;
const VALIDATION_TIMEOUT_MS = 20 * 60_000; // 20 min
const TEST_SUITE_TIMEOUT_MS = 25 * 60_000; // 25 min
const GIT_TIMEOUT_MS = 3 * 60_000; // 3 min
const GIT_PUSH_TIMEOUT_MS = 5 * 60_000; // 5 min
const README_FILE = join(process.cwd(), 'README.md');
const BACKUP_STATUS_START = '<!-- BACKUP_STATUS:START -->';
const BACKUP_STATUS_END = '<!-- BACKUP_STATUS:END -->';

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
export function startBackupScheduler(intervalHours = 24, mode = 'data_only') {
  const intervalMs = intervalHours * 3_600_000;
  const firstRunMs = 3_600_000; // 1h

  const run = async () => {
    let result;
    if (String(mode || '').toLowerCase() === 'validated_github') {
      result = await runValidatedGithubBackupPlan({ trigger: 'scheduler' });
      console.info(JSON.stringify({ event: 'auto_backup_validated', ...result }));
    } else {
      result = await createBackup();
      console.info(JSON.stringify({ event: 'auto_backup', ...result }));
    }
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
  const trigger = String(options.trigger || 'manual').trim() || 'manual';
  const startedAtIso = new Date().toISOString();
  const startedAtLabel = toSaoPauloLabel(startedAtIso);
  const runId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const runSummary = {
    runId,
    trigger,
    startedAtIso,
    startedAtLabel,
    status: 'INICIADO',
    branches,
    validation: 'PENDENTE',
    testSuite: config.githubBackupRunTestSuite ? 'PENDENTE' : 'DESATIVADA',
    backupFile: '-',
    gitBundleFile: '-',
    commitHash: '',
    commitCreated: false,
    readmeCommitHash: '',
    readmeCommitCreated: false,
    pushTarget: '-',
    pushStatus: 'PENDENTE',
    rollbackApplied: false,
    note: 'Execucao em andamento.'
  };
  let originalHead = '';
  let primaryCommitCreated = false;
  let primaryCommitHash = '';
  let readmeCommitCreated = false;
  let readmeCommitHash = '';
  let pushSucceededCount = 0;

  const failWithRollback = async (stepName, message) => {
    const result = failPlan(steps, stepName, message);
    runSummary.status = 'FALHA';
    runSummary.note = message;

    if (config.githubBackupAutoRollback && primaryCommitCreated && originalHead && pushSucceededCount === 0) {
      const rollbackResult = await runCommand('git', ['reset', '--mixed', originalHead], {
        timeoutMs: GIT_TIMEOUT_MS
      });
      const rollbackOk = rollbackResult.ok;
      runSummary.rollbackApplied = rollbackOk;
      steps.push({
        name: 'rollback_local',
        ok: rollbackOk,
        detail: rollbackOk
          ? `Rollback local aplicado para ${String(originalHead).slice(0, 12)}.`
          : summarizeCommandFailure(rollbackResult, 'Falha ao aplicar rollback local apos erro do plano.')
      });
    }

    const readmeStatus = await updateReadmeBackupStatus({
      ...runSummary,
      status: 'FALHA',
      finishedAtIso: new Date().toISOString(),
      note: message
    });
    steps.push({
      name: 'readme_status',
      ok: readmeStatus.ok,
      detail: readmeStatus.ok
        ? 'README atualizado com status de falha.'
        : `README nao foi atualizado: ${readmeStatus.error || 'erro desconhecido'}`
    });

    result.rollbackApplied = runSummary.rollbackApplied;
    result.commitCreated = primaryCommitCreated;
    result.commitHash = primaryCommitHash;
    result.readmeCommitCreated = readmeCommitCreated;
    result.readmeCommitHash = readmeCommitHash;
    result.branches = branches;
    result.pushTarget = runSummary.pushTarget;
    return result;
  };

  if (!config.githubBackupEnabled) {
    return await failWithRollback(
      'backup_plan_disabled',
      'Plano de backup GitHub desativado (GITHUB_BACKUP_ENABLED=false).'
    );
  }

  const gitRepoCheck = await runCommand('git', ['rev-parse', '--is-inside-work-tree'], {
    timeoutMs: GIT_TIMEOUT_MS
  });
  if (!gitRepoCheck.ok || !/true/i.test(gitRepoCheck.stdout || '')) {
    return await failWithRollback('precheck_git', 'Diretorio atual nao e um repositorio git.');
  }
  steps.push({ name: 'precheck_git', ok: true, detail: 'Repositorio Git detectado.' });

  const originalHeadResult = await runCommand('git', ['rev-parse', 'HEAD'], { timeoutMs: GIT_TIMEOUT_MS });
  if (!originalHeadResult.ok) {
    return await failWithRollback(
      'precheck_head',
      summarizeCommandFailure(originalHeadResult, 'Falha ao identificar HEAD atual para rollback.')
    );
  }
  originalHead = String(originalHeadResult.stdout || '').trim();
  steps.push({ name: 'precheck_head', ok: true, detail: `HEAD base: ${originalHead.slice(0, 12)}.` });

  const validation = await runCommand('npm', ['run', 'check'], {
    timeoutMs: VALIDATION_TIMEOUT_MS
  });
  if (!validation.ok) {
    const detail = summarizeCommandFailure(validation, 'Falha na validacao do codigo (npm run check).');
    runSummary.validation = 'FALHA';
    return await failWithRollback('validacao', detail);
  }
  runSummary.validation = 'OK';
  steps.push({ name: 'validacao', ok: true, detail: 'npm run check concluido com sucesso.' });

  if (config.githubBackupRunTestSuite) {
    const testSuiteResult = await runCommand('node', ['scripts/test-suite.js'], {
      timeoutMs: TEST_SUITE_TIMEOUT_MS
    });
    if (!testSuiteResult.ok) {
      const detail = summarizeCommandFailure(
        testSuiteResult,
        'Falha na bateria funcional (node scripts/test-suite.js).'
      );
      runSummary.testSuite = 'FALHA';
      return await failWithRollback('test_suite', detail);
    }
    runSummary.testSuite = 'OK';
    steps.push({ name: 'test_suite', ok: true, detail: 'Bateria funcional concluida com sucesso.' });
  }

  const backupResult = await createBackup();
  if (!backupResult.ok) {
    return await failWithRollback(
      'backup_data',
      `Falha ao criar backup de data/: ${backupResult.error || 'erro desconhecido'}`
    );
  }
  const backupFile = String(backupResult.path || '').split('/').pop() || backupResult.path;
  runSummary.backupFile = backupFile;
  steps.push({ name: 'backup_data', ok: true, detail: `Backup data criado: ${backupFile}` });

  const bundleTs = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const gitBundlePath = join(BACKUP_DIR, `git-bundle-${bundleTs}.bundle`);
  const bundleResult = await runCommand('git', ['bundle', 'create', gitBundlePath, '--all'], {
    timeoutMs: GIT_TIMEOUT_MS
  });
  if (!bundleResult.ok) {
    const detail = summarizeCommandFailure(bundleResult, 'Falha ao gerar bundle git.');
    return await failWithRollback('backup_git_bundle', detail);
  }
  const gitBundleFile = gitBundlePath.split('/').pop() || gitBundlePath;
  runSummary.gitBundleFile = gitBundleFile;
  steps.push({ name: 'backup_git_bundle', ok: true, detail: `Bundle git criado: ${gitBundleFile}` });

  const readmeLocalStatus = await updateReadmeBackupStatus({
    ...runSummary,
    status: 'VALIDADO_LOCAL',
    finishedAtIso: new Date().toISOString(),
    note: 'Validacao e backup concluidos localmente. Push em andamento.'
  });
  if (!readmeLocalStatus.ok) {
    return await failWithRollback(
      'readme_status_local',
      `Falha ao atualizar README antes do push: ${readmeLocalStatus.error || 'erro desconhecido'}`
    );
  }
  steps.push({
    name: 'readme_status_local',
    ok: true,
    detail: 'README atualizado com status local (pre-push).'
  });

  const stageResult = await runCommand('git', ['add', '-A'], { timeoutMs: GIT_TIMEOUT_MS });
  if (!stageResult.ok) {
    const detail = summarizeCommandFailure(stageResult, 'Falha ao preparar arquivos para commit.');
    return await failWithRollback('git_add', detail);
  }
  steps.push({ name: 'git_add', ok: true, detail: 'Arquivos preparados para commit.' });

  const statusResult = await runCommand('git', ['status', '--porcelain'], { timeoutMs: GIT_TIMEOUT_MS });
  if (!statusResult.ok) {
    const detail = summarizeCommandFailure(statusResult, 'Falha ao verificar status do git.');
    return await failWithRollback('git_status', detail);
  }

  if ((statusResult.stdout || '').trim()) {
    const commitMsg = `Backup validado ${startedAtLabel}`;
    const commitResult = await runCommand('git', ['commit', '-m', commitMsg], { timeoutMs: GIT_TIMEOUT_MS });
    if (!commitResult.ok) {
      const detail = summarizeCommandFailure(commitResult, 'Falha ao criar commit de backup.');
      return await failWithRollback('git_commit', detail);
    }
    const hashResult = await runCommand('git', ['rev-parse', '--short', 'HEAD'], { timeoutMs: GIT_TIMEOUT_MS });
    primaryCommitCreated = true;
    primaryCommitHash = hashResult.ok ? (hashResult.stdout || '').trim() : '';
    runSummary.commitCreated = primaryCommitCreated;
    runSummary.commitHash = primaryCommitHash;
    steps.push({
      name: 'git_commit',
      ok: true,
      detail: `Commit de backup criado${primaryCommitHash ? ` (${primaryCommitHash})` : ''}.`
    });
  } else {
    steps.push({ name: 'git_commit', ok: true, detail: 'Sem alteracoes pendentes para commit.' });
  }

  const branchEnsuring = await ensureLocalBranches(branches);
  if (!branchEnsuring.ok) {
    return await failWithRollback(
      'git_branches',
      branchEnsuring.message || 'Falha ao preparar branches de backup.'
    );
  }
  steps.push({ name: 'git_branches', ok: true, detail: branchEnsuring.message });

  const pushTarget = await resolvePushTarget();
  if (!pushTarget.ok) {
    return await failWithRollback(
      'git_push_target',
      pushTarget.message || 'Nao foi possivel resolver destino de push.'
    );
  }
  runSummary.pushTarget = pushTarget.display;
  steps.push({ name: 'git_push_target', ok: true, detail: `Destino: ${pushTarget.display}` });

  for (const branch of branches) {
    const pushResult = await pushBranchWithRetry(pushTarget.target, branch);
    if (!pushResult.ok) {
      const detail = summarizeCommandFailure(pushResult, `Falha no push da branch ${branch}.`);
      runSummary.pushStatus = 'FALHA';
      return await failWithRollback(`git_push_${branch}`, detail);
    }
    pushSucceededCount += 1;
    steps.push({
      name: `git_push_${branch}`,
      ok: true,
      detail: `Branch ${branch} enviada com sucesso${pushResult.attempts > 1 ? ` (tentativa ${pushResult.attempts})` : ''}.`
    });
  }

  runSummary.pushStatus = 'OK';

  const postPushHead = await runCommand('git', ['rev-parse', '--short', 'HEAD'], { timeoutMs: GIT_TIMEOUT_MS });
  const postPushHeadHash = postPushHead.ok ? String(postPushHead.stdout || '').trim() : primaryCommitHash;
  const readmePublishedStatus = await updateReadmeBackupStatus({
    ...runSummary,
    status: 'PUBLICADO_GITHUB',
    finishedAtIso: new Date().toISOString(),
    note: `Backup validado publicado no GitHub (${branches.join(', ')}).`,
    commitHash: postPushHeadHash || primaryCommitHash,
    commitCreated: primaryCommitCreated
  });
  if (!readmePublishedStatus.ok) {
    return await failWithRollback(
      'readme_status_final',
      `Falha ao atualizar README final: ${readmePublishedStatus.error || 'erro desconhecido'}`
    );
  }
  steps.push({
    name: 'readme_status_final',
    ok: true,
    detail: 'README atualizado com status final publicado.'
  });

  const readmeStage = await runCommand('git', ['add', 'README.md'], { timeoutMs: GIT_TIMEOUT_MS });
  if (!readmeStage.ok) {
    return await failWithRollback(
      'git_add_readme',
      summarizeCommandFailure(readmeStage, 'Falha ao preparar commit do README.')
    );
  }

  const readmeStatusPorcelain = await runCommand('git', ['status', '--porcelain', 'README.md'], {
    timeoutMs: GIT_TIMEOUT_MS
  });
  if (!readmeStatusPorcelain.ok) {
    return await failWithRollback(
      'git_status_readme',
      summarizeCommandFailure(readmeStatusPorcelain, 'Falha ao verificar alteracao do README.')
    );
  }

  if ((readmeStatusPorcelain.stdout || '').trim()) {
    const readmeCommit = await runCommand(
      'git',
      ['commit', '-m', `Atualiza README de backup ${toSaoPauloLabel(new Date().toISOString())}`],
      { timeoutMs: GIT_TIMEOUT_MS }
    );
    if (!readmeCommit.ok) {
      return await failWithRollback(
        'git_commit_readme',
        summarizeCommandFailure(readmeCommit, 'Falha ao criar commit de status do README.')
      );
    }

    const readmeHead = await runCommand('git', ['rev-parse', '--short', 'HEAD'], { timeoutMs: GIT_TIMEOUT_MS });
    readmeCommitCreated = true;
    readmeCommitHash = readmeHead.ok ? String(readmeHead.stdout || '').trim() : '';
    runSummary.readmeCommitCreated = readmeCommitCreated;
    runSummary.readmeCommitHash = readmeCommitHash;
    steps.push({
      name: 'git_commit_readme',
      ok: true,
      detail: `Commit de status README criado${readmeCommitHash ? ` (${readmeCommitHash})` : ''}.`
    });

    for (const branch of branches) {
      const pushReadme = await pushBranchWithRetry(pushTarget.target, branch);
      if (!pushReadme.ok) {
        const detail = summarizeCommandFailure(
          pushReadme,
          `Falha ao publicar commit de status README na branch ${branch}.`
        );
        return await failWithRollback(`git_push_readme_${branch}`, detail);
      }
      steps.push({
        name: `git_push_readme_${branch}`,
        ok: true,
        detail: `README publicado na branch ${branch}${pushReadme.attempts > 1 ? ` (tentativa ${pushReadme.attempts})` : ''}.`
      });
    }
  } else {
    steps.push({
      name: 'git_commit_readme',
      ok: true,
      detail: 'README sem alteracoes apos atualizacao final.'
    });
  }

  return {
    ok: true,
    steps,
    message: `Plano de backup concluido. Validacao OK e push realizado em ${branches.join(', ')}.`,
    backupFile,
    gitBundleFile,
    commitCreated: primaryCommitCreated,
    commitHash: primaryCommitHash,
    readmeCommitCreated,
    readmeCommitHash,
    branches,
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

async function pushBranchWithRetry(target, branch, maxAttempts = 2) {
  let lastResult = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const pushResult = await runCommand('git', ['push', target, branch], {
      timeoutMs: GIT_PUSH_TIMEOUT_MS
    });
    if (pushResult.ok) {
      return { ...pushResult, attempts: attempt, ok: true };
    }
    lastResult = { ...pushResult, attempts: attempt, ok: false };

    // tenta autocorrecao simples para non-fast-forward
    const failureText = `${pushResult.stderr || ''}\n${pushResult.stdout || ''}`.toLowerCase();
    const canRebase = /non-fast-forward|fetch first|rejected/.test(failureText);
    if (canRebase && attempt < maxAttempts) {
      const fetch = await runCommand('git', ['fetch', target, branch], {
        timeoutMs: GIT_PUSH_TIMEOUT_MS
      });
      if (!fetch.ok) {
        lastResult = {
          ...lastResult,
          stderr: `${lastResult.stderr || ''}\n${fetch.stderr || fetch.stdout || ''}`.trim()
        };
        break;
      }

      const rebase = await runCommand('git', ['rebase', 'FETCH_HEAD'], {
        timeoutMs: GIT_PUSH_TIMEOUT_MS
      });
      if (rebase.ok) continue;
      await runCommand('git', ['rebase', '--abort'], { timeoutMs: GIT_TIMEOUT_MS }).catch(() => {});
      lastResult = {
        ...lastResult,
        stderr: `${lastResult.stderr || ''}\n${rebase.stderr || rebase.stdout || ''}`.trim()
      };
      break;
    }
  }
  return lastResult || { ok: false, attempts: 1, stderr: 'Falha de push sem detalhe.' };
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

async function updateReadmeBackupStatus(payload = {}) {
  if (!config.githubBackupUpdateReadme) {
    return { ok: true, skipped: true };
  }

  try {
    const current = await readFile(README_FILE, 'utf8');
    const block = renderBackupStatusBlock(payload);
    const next = upsertBackupStatusBlock(current, block);
    if (next !== current) {
      await writeFile(README_FILE, next, 'utf8');
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, error: String(error?.message || error) };
  }
}

function upsertBackupStatusBlock(readmeText, statusBlock) {
  const src = String(readmeText || '');
  const start = src.indexOf(BACKUP_STATUS_START);
  const end = src.indexOf(BACKUP_STATUS_END);

  if (start >= 0 && end > start) {
    const before = src.slice(0, start);
    const after = src.slice(end + BACKUP_STATUS_END.length);
    return `${before}${statusBlock}${after}`.replace(/\n{3,}/g, '\n\n');
  }

  const section = `\n## Status do Backup Validado (Auto)\n\n${statusBlock}`;
  if (!src.endsWith('\n')) return `${src}\n${section}\n`;
  return `${src}${section}\n`;
}

function renderBackupStatusBlock(payload = {}) {
  const status = String(payload.status || 'INDEFINIDO').trim();
  const icon = status.includes('FALHA')
    ? '❌'
    : status.includes('PUBLICADO')
      ? '✅'
      : '🟡';
  const finishedAtIso = String(payload.finishedAtIso || '');
  const finishedAtLabel = finishedAtIso ? toSaoPauloLabel(finishedAtIso) : toSaoPauloLabel(new Date().toISOString());
  const startedAtLabel = payload.startedAtIso
    ? toSaoPauloLabel(payload.startedAtIso)
    : String(payload.startedAtLabel || '-');
  const runId = String(payload.runId || '-');
  const trigger = String(payload.trigger || 'manual');
  const branches = Array.isArray(payload.branches) && payload.branches.length
    ? payload.branches.join(', ')
    : 'main, homologacao';
  const note = String(payload.note || '').trim() || '-';
  const validation = String(payload.validation || 'N/D');
  const testSuite = String(payload.testSuite || 'N/D');
  const backupFile = String(payload.backupFile || '-');
  const gitBundleFile = String(payload.gitBundleFile || '-');
  const commitInfo = payload.commitCreated
    ? `${String(payload.commitHash || '').trim() || '(hash indisponivel)'}`
    : 'sem alteracoes pendentes';
  const readmeCommitInfo = payload.readmeCommitCreated
    ? `${String(payload.readmeCommitHash || '').trim() || '(hash indisponivel)'}`
    : 'nao houve commit exclusivo do README';
  const pushTarget = String(payload.pushTarget || '-');
  const pushStatus = String(payload.pushStatus || 'N/D');
  const rollback = payload.rollbackApplied ? 'sim (rollback local aplicado)' : 'nao';

  return [
    `${BACKUP_STATUS_START}`,
    `> Bloco atualizado automaticamente pelo plano de backup validado.`,
    `- Run ID: \`${runId}\``,
    `- Trigger: \`${trigger}\``,
    `- Inicio: ${startedAtLabel} (America/Sao_Paulo)`,
    `- Fim: ${finishedAtLabel} (America/Sao_Paulo)`,
    `- Status: ${icon} **${status}**`,
    `- Validacao (\`npm run check\`): **${validation}**`,
    `- Suite funcional (\`node scripts/test-suite.js\`): **${testSuite}**`,
    `- Backup \`data/\`: \`${backupFile}\``,
    `- Bundle git: \`${gitBundleFile}\``,
    `- Commit principal: \`${commitInfo}\``,
    `- Commit README: \`${readmeCommitInfo}\``,
    `- Destino push: \`${pushTarget}\``,
    `- Branches: \`${branches}\``,
    `- Push: **${pushStatus}**`,
    `- Rollback automatico: **${rollback}**`,
    `- Observacao: ${note}`,
    `${BACKUP_STATUS_END}`
  ].join('\n');
}

function toSaoPauloLabel(isoLike) {
  const date = isoLike ? new Date(isoLike) : new Date();
  if (Number.isNaN(date.getTime())) return String(isoLike || '-');
  return date.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
}
