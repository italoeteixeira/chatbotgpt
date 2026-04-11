import { runValidatedGithubBackupPlan } from '../src/backupService.js';

const startedAt = Date.now();
const result = await runValidatedGithubBackupPlan();
const elapsedMs = Date.now() - startedAt;

const lines = [];
lines.push(result.ok ? 'Plano de backup validado: OK' : 'Plano de backup validado: FALHOU');
lines.push(`Tempo total: ${elapsedMs}ms`);

if (Array.isArray(result.steps) && result.steps.length) {
  lines.push('');
  lines.push('Etapas:');
  for (const step of result.steps) {
    const mark = step.ok ? 'OK' : 'ERRO';
    const detail = step.detail ? ` - ${step.detail}` : '';
    lines.push(`- [${mark}] ${step.name}${detail}`);
  }
}

if (result.backupFile) lines.push(`Backup data: ${result.backupFile}`);
if (result.gitBundleFile) lines.push(`Bundle git: ${result.gitBundleFile}`);
if (result.pushTarget) lines.push(`Destino push: ${result.pushTarget}`);
if (result.commitCreated) lines.push(`Commit criado: ${result.commitHash || '(hash indisponivel)'}`);
if (result.readmeCommitCreated) lines.push(`Commit README: ${result.readmeCommitHash || '(hash indisponivel)'}`);
if (Array.isArray(result.branches)) lines.push(`Branches: ${result.branches.join(', ')}`);
if (result.rollbackApplied) lines.push('Rollback local aplicado: sim');

console.log(lines.join('\n'));

if (!result.ok) process.exit(1);
