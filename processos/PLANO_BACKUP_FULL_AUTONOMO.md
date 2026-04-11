# Plano de Backup FULL Autonomo (Servidor)

Atualizado em: 2026-04-11

## Objetivo

Garantir que o bot, quando acionado por um usuario com permissao FULL, execute um fluxo de backup robusto e auditavel:

1. Validar codigo e comportamento (`npm run check`)
2. Criar backup local de dados (`data/backups/backup-*.tar.gz`)
3. Gerar backup de historico git (`data/backups/git-bundle-*.bundle`)
4. Commitar alteracoes pendentes (se houver)
5. Publicar no GitHub (`main` + `homologacao`)

## Comandos no bot (FULL)

- `plano de backup github`
- `backup validado`
- `backup no github`

## Regras de seguranca

- Comando bloqueado para usuario que nao seja FULL.
- Se `npm run check` falhar, o backup para antes do push.
- Token GitHub nunca e retornado em mensagens do bot.
- Destino de push exibido em formato mascarado.

## Dependencias de ambiente no servidor

Adicionar no `.env` do servidor:

```env
GITHUB_BACKUP_ENABLED=true
GITHUB_BACKUP_REPO=italoeteixeira/chatbotgpt
GITHUB_BACKUP_TOKEN=***token-com-permissao-de-push***
GITHUB_BACKUP_BRANCHES=main,homologacao
```

## Sequencia de validacao operacional

1. Rodar `npm run check` no servidor
2. Executar `npm run backup:validated` no servidor
3. Verificar no GitHub se `main` e `homologacao` foram atualizadas
4. Confirmar retorno no bot com resumo das etapas

## Resultado esperado

- Fluxo de backup autônomo e repetivel
- Sem push se houver regressao de teste
- Evidencia local (tar + bundle) e remota (GitHub)
