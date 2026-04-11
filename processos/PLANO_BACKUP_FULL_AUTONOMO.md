# Plano de Backup FULL Autonomo (Servidor)

Atualizado em: 2026-04-11

## Objetivo

Garantir que o bot, quando acionado por um usuario com permissao FULL, execute um fluxo de backup robusto e auditavel:

1. Validar codigo (`npm run check`)
2. Rodar bateria funcional (`node scripts/test-suite.js`)
3. Criar backup local de dados (`data/backups/backup-*.tar.gz`)
4. Gerar backup de historico git (`data/backups/git-bundle-*.bundle`)
5. Atualizar README automaticamente com status tecnico do backup
6. Commitar alteracoes pendentes (se houver)
7. Publicar no GitHub (`main` + `homologacao`)
8. Reaplicar status final no README e publicar novamente

## Comandos no bot (FULL)

- `plano de backup github`
- `backup validado`
- `backup no github`

## Regras de seguranca

- Comando bloqueado para usuario que nao seja FULL.
- Se `npm run check` falhar, o backup para antes do push.
- Se `test-suite` falhar, o backup para antes do push.
- Em erro apos commit, aplica rollback local seguro (`git reset --mixed <head-base>`) se nao houve push.
- Token GitHub nunca e retornado em mensagens do bot.
- Destino de push exibido em formato mascarado.

## Dependencias de ambiente no servidor

Adicionar no `.env` do servidor:

```env
GITHUB_BACKUP_ENABLED=true
GITHUB_BACKUP_REPO=italoeteixeira/chatbotgpt
GITHUB_BACKUP_TOKEN=***token-com-permissao-de-push***
GITHUB_BACKUP_BRANCHES=main,homologacao
GITHUB_BACKUP_UPDATE_README=true
GITHUB_BACKUP_RUN_TEST_SUITE=true
GITHUB_BACKUP_AUTO_ROLLBACK=true
BACKUP_SCHEDULER_MODE=validated_github
BACKUP_SCHEDULER_INTERVAL_HOURS=24
```

## Sequencia de validacao operacional

1. Rodar `npm run check` no servidor
2. Rodar `node scripts/test-suite.js`
3. Executar `npm run backup:validated` no servidor
4. Verificar no GitHub se `main` e `homologacao` foram atualizadas
5. Confirmar bloco `BACKUP_STATUS` no `README.md` remoto
6. Confirmar retorno no bot com resumo das etapas

## Resultado esperado

- Fluxo de backup autônomo e repetivel
- Sem push se houver regressao de teste
- README sempre atualizado e publicado em cada backup validado
- Evidencia local (tar + bundle) e remota (GitHub)
