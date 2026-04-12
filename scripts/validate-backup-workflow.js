import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const workflowPath = resolve(process.cwd(), process.argv[2] || '.github/workflows/backup.yml');
const content = await readFile(workflowPath, 'utf8');
const lines = content.split(/\r?\n/);
const errors = [];

function findLine(pattern) {
  return lines.findIndex((line) => pattern.test(line));
}

const invalidSecretsIfLine = findLine(/^\s*if:\s*(?:\$\{\{\s*)?[^#\n]*\bsecrets\./);
if (invalidSecretsIfLine !== -1) {
  errors.push(
    `Linha ${invalidSecretsIfLine + 1}: GitHub Actions nao aceita uso direto de secrets.* em if:. `
    + 'Use uma etapa para copiar os secrets para env e gerar um output intermediario.'
  );
}

const requiredPatterns = [
  {
    pattern: /^name:\s+Daily Backup\s*$/,
    message: 'Workflow deve manter o nome "Daily Backup".'
  },
  {
    pattern: /^\s*workflow_dispatch:\s*$/,
    message: 'Workflow precisa aceitar execucao manual via workflow_dispatch.'
  },
  {
    pattern: /^\s*-\s+name:\s+Check backup configuration\s*$/,
    message: 'Workflow precisa validar BACKUP_TOKEN/BACKUP_REPO antes do push.'
  },
  {
    pattern: /^\s*id:\s+backup_config\s*$/,
    message: 'Etapa de validacao deve expor o id "backup_config".'
  },
  {
    pattern: /^\s*echo "enabled=true" >> "\$GITHUB_OUTPUT"\s*$/,
    message: 'Etapa de validacao deve sinalizar enabled=true no GITHUB_OUTPUT.'
  },
  {
    pattern: /^\s*echo "enabled=false" >> "\$GITHUB_OUTPUT"\s*$/,
    message: 'Etapa de validacao deve sinalizar enabled=false no GITHUB_OUTPUT.'
  },
  {
    pattern: /^\s*if:\s*steps\.backup_config\.outputs\.enabled == 'true'\s*$/,
    message: 'Etapa de mirror deve depender de steps.backup_config.outputs.enabled.'
  },
  {
    pattern: /^\s*BACKUP_TOKEN:\s+\$\{\{\s*secrets\.BACKUP_TOKEN\s*\}\}\s*$/,
    message: 'Workflow precisa mapear BACKUP_TOKEN a partir de secrets.BACKUP_TOKEN.'
  },
  {
    pattern: /^\s*BACKUP_REPO:\s+\$\{\{\s*secrets\.BACKUP_REPO\s*\}\}\s*$/,
    message: 'Workflow precisa mapear BACKUP_REPO a partir de secrets.BACKUP_REPO.'
  }
];

for (const { pattern, message } of requiredPatterns) {
  if (findLine(pattern) === -1) errors.push(message);
}

if (errors.length) {
  console.error(`Validacao do workflow de backup falhou: ${workflowPath}`);
  for (const error of errors) {
    console.error(`- ${error}`);
  }
  process.exit(1);
}

console.log(`Validacao do workflow de backup: OK (${workflowPath})`);
