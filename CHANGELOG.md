# CHANGELOG

## [2026-04-09] — Melhorias entregues

### Adicionado
- **Modo Silencioso** (`modo silencioso` / `modo normal` / `status modo silencioso`): admin pode silenciar respostas de IA sem desligar o bot. Comandos locais continuam funcionando normalmente.
- **Resumo do Dia** (`resumo do dia` / `o que perdi?` / `resumo da semana`): gera resumo automático das últimas mensagens do grupo usando IA.
- **Backup Automático** (`fazer backup` / `listar backups`): backup diário agendado da pasta `data/` em `.tar.gz`, mantendo os 7 mais recentes. Também acionável manualmente por admin.
- `src/backupService.js`: novo serviço com `createBackup()`, `listBackups()` e `startBackupScheduler()`.
- `silentMode` integrado ao `settingsStore` (defaultSettings + sanitizeSettings + BOT_SETTINGS_ALLOWED_KEYS).
- `CHANGELOG.md`: histórico de entregas.
- `COMANDOS.md`: referência completa de todos os comandos (~400 linhas, 22 categorias).
- `processos/STATUS.md`: mapa de estado atual do projeto (implementado vs. pendente vs. roadmap).

### Corrigido / Melhorado
- `parseSilentModeCommand`: ordena verificação de `status` antes de `on` para evitar conflito de regex.
- `tryHandleLocalAction`: despacho para Silent Mode, Backup e Resumo inserido antes do bloco Relay.

### Removido (obsoletos)
- `index.js`, `config.js`, `localActions.js` da raiz (cópias antigas; entrada real é `src/`).
- `chatbot.txt` (arquivo legado sem uso).
- `PLANO_VALIDACAO_BOT_INTELIGENTE.md`, `PLANO_VALIDACAO_ATUALIZACAO_2026-04-06.md`.
- `RELATORIO_VALIDACAO_2026-03-31.md`, `RELATORIO_MELHORIAS_2026-04-06.md`, `RELATORIO_SESSAO_2026-04-08.md`, `RELATORIO_SYNC_2026-04-06.md`.

---

## [2026-04 e anteriores] — Histórico de entregas

### Relay / Encaminhamento de Mensagens Privadas
- Wizard conversacional `@ enviar mensagem` com fluxo passo a passo.
- `relaySenderName`: persiste o nome do remetente no relay (corrigido no `sanitizeSettings`).
- Respostas via quote no grupo são encaminhadas automaticamente ao contato.

### Modo FULL (automações e desenvolvimento)
- Timeout Copilot CLI corrigido: 2min → 6min.
- Timeout de jobs FULL: 30min → 90min.
- Runtime `fullAutoDevTimeoutMs`: 20min → 60min.
- Jobs "running" obsoletos são zerados no startup.
- Watchdog periódico (`selfHealingService.js`) detecta e auto-recupera jobs travados.

### Despesas
- `@despesa` / `@despesas`: controle financeiro por grupo com exportação CSV.

### Bug fixes
- `isFullSender` não aplicava mais timeout de 360s para todos os autorizados.

### Documentação
- `COMANDOS.md`: referência completa de todos os comandos.
- `README.md`: atualizado com links, Relay e Despesas.
