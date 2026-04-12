import { spawnSync } from 'node:child_process';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const IGNORED_DIRECTORIES = new Set([
  '.git',
  '.sync_backups',
  'data',
  'logs',
  'node_modules',
  'tools'
]);

const OUTPUT_LIMIT = 2000;

function clampTail(text, limit = OUTPUT_LIMIT) {
  const value = String(text || '').trim();
  if (!value) return '(sem saida)';
  if (value.length <= limit) return value;
  return `...${value.slice(-(limit - 3))}`;
}

function runNodeCommand(args, options = {}) {
  const result = spawnSync(process.execPath, args, {
    cwd: process.cwd(),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options
  });

  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    throw Object.assign(new Error(`Command failed: node ${args.join(' ')}`), {
      status: result.status,
      signal: result.signal,
      stdout: result.stdout || '',
      stderr: result.stderr || ''
    });
  }

  return {
    stdout: result.stdout || '',
    stderr: result.stderr || ''
  };
}

async function persistLastValidation({ ok, status, summary, output }) {
  const logsDir = join(process.cwd(), 'logs');
  const lastValidationPath = join(logsDir, 'last-validation.json');

  await mkdir(logsDir, { recursive: true });
  await writeFile(
    lastValidationPath,
    JSON.stringify(
      {
        ts: new Date().toISOString(),
        ok,
        status,
        summary,
        output: clampTail(output),
        willRestart: false
      },
      null,
      2
    ) + '\n',
    'utf8'
  );
}

async function collectJavaScriptFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];

  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const fullPath = join(dir, entry.name);

    if (entry.isDirectory()) {
      if (IGNORED_DIRECTORIES.has(entry.name)) continue;
      files.push(...await collectJavaScriptFiles(fullPath));
      continue;
    }

    if (entry.isFile() && entry.name.endsWith('.js')) {
      files.push(fullPath);
    }
  }

  return files;
}

const projectRoot = process.cwd();
const files = await collectJavaScriptFiles(projectRoot);
let phase = 'preparacao';
let combinedOutput = '';

function emitStdout(line = '') {
  const text = `${line}\n`;
  process.stdout.write(text);
  combinedOutput += text;
}

if (!files.length) {
  emitStdout('Nenhum arquivo JavaScript encontrado para validar.');
  await persistLastValidation({
    ok: true,
    status: 'exit 0',
    summary: 'Validacao manual via npm run check: nenhum arquivo JavaScript encontrado.',
    output: combinedOutput
  });
  process.exit(0);
}

try {
  phase = 'sintaxe';
  for (const file of files) {
    runNodeCommand(['--check', file]);
  }

  phase = 'mensagens temporarias';
  {
    const result = runNodeCommand([join(process.cwd(), 'scripts', 'validate-group-temporary-messages.js')]);
    combinedOutput += result.stdout + result.stderr;
  }

  phase = 'workflow de backup';
  {
    const result = runNodeCommand([join(process.cwd(), 'scripts', 'validate-backup-workflow.js')]);
    combinedOutput += result.stdout + result.stderr;
  }

  emitStdout(`Validacao de sintaxe concluida: ${files.length} arquivo(s) JavaScript verificado(s).`);

  // ─── Suíte de testes funcionais ────────────────────────────────────────────
  emitStdout('\nExecutando suíte de testes funcionais...');

  phase = 'suite de testes';
  const testResult = runNodeCommand(['--experimental-vm-modules', join(process.cwd(), 'scripts', 'test-suite.js')], {
    cwd: process.cwd()
  });
  combinedOutput += testResult.stdout + testResult.stderr;

  emitStdout('\nValidacao completa finalizada com sucesso.');

  const testSummaryMatch = testResult.stdout.match(/RESULTADO:\s*(\d+)\s+passou,\s*(\d+)\s+falhou/);
  const summary = testSummaryMatch
    ? `Validacao manual via npm run check: sintaxe OK em ${files.length} arquivo(s); ${testSummaryMatch[1]} passou, ${testSummaryMatch[2]} falhou.`
    : `Validacao manual via npm run check: sintaxe OK em ${files.length} arquivo(s) e suíte funcional concluída com sucesso.`;

  await persistLastValidation({
    ok: true,
    status: 'exit 0',
    summary,
    output: combinedOutput
  });
} catch (error) {
  const status =
    typeof error?.status === 'number'
      ? `exit ${error.status}`
      : error?.signal
        ? `signal ${error.signal}`
        : 'exit 1';
  const failureOutput = [combinedOutput, error?.stdout, error?.stderr, error?.message].filter(Boolean).join('\n');
  await persistLastValidation({
    ok: false,
    status,
    summary: `Validacao manual via npm run check falhou na etapa de ${phase}.`,
    output: failureOutput
  });
  process.exit(typeof error?.status === 'number' ? error.status : 1);
}
