# Menu de Configuracao do Bot (Chat + Web)

Atualizado em: 2026-04-10

## Objetivo

Unificar configuracao dinamica em dois canais:

1. WhatsApp (`@ configurar bot` / `@ bot configuracao`)
2. Web (`/bot-config-menu.html`)

Comportamento esperado:

- menu didatico e interativo por secoes
- comandos prontos para copiar e executar
- valores reais do runtime exibidos no painel
- mesma autenticacao do portal WhatsApp (cookie/sessao)

## Comandos no WhatsApp

### Entrada principal

- `@ configurar bot`
- `@ bot configuracao`

### Navegacao por secoes

- `@ configurar bot menu 1`
- `@ bot configuracao 4`
- `@ configurar bot menu status`

### Secoes

1. Inteligencia Artificial
2. Comportamento de respostas
3. Terminal Linux
4. Midia
5. Relay
6. Modo silencioso
7. Auditoria e rollback
8. Status geral
9. Permissoes e multi-grupo
10. Mapa de recursos

## Tela web

Rota protegida:

- `/bot-config-menu.html`

Autenticacao:

- mesma sessao do painel (`/login.html`)
- sem credencial adicional

Dados carregados na tela:

- `GET /api/settings`
- `GET /api/ai-providers`
- `GET /api/settings/audit?limit=8`
- `GET /api/access-control`

## Mapeamento de configuracoes

A tela e o menu do bot cobrem as chaves dinamicas principais:

- `aiProvider`
- `codexModel`, `codexFallbackModel`, `codexTimeoutMs`, `codexReasoningEffort`
- `copilotModel`, `copilotFullModel`, `copilotFallbackModel`, `copilotTimeoutMs`, `copilotFullTimeoutMs`, `copilotReasoningEffort`
- `requireMention`, `showThinkingMessage`, `thinkingMessageText`
- `maxInputChars`, `maxOutputChars`, `fallbackMessage`, `systemPrompt`
- `enableTerminalExec`, `terminalAllowlist`
- `mediaIngestEnabled`, `mediaRootDir`, `mediaMaxBytes`, `mediaRetentionDays`, `mediaAllowedMimePrefixes`
- `relaySenderName`
- `silentMode`

## Arquivos alterados

- `src/localActions.js`
- `src/webPanel.js`
- `public/bot-config-menu.html`
- `processos/whatsapp_bot_config_menu.html`
- `public/index.html`
- `public/processos.html`
- `public/bot-config-menu.html`
- `public/usuarios.html`
- `README.md`
- `COMANDOS.md`
- `processos/STATUS.md`

## Observacao de UX

- `@ configurar bot` agora abre menu interativo (nao apenas resumo curto)
- `mostrar configuracao bot` continua disponivel para ver o status completo
- menu web inclui copia rapida de comandos e mapa de funcoes do projeto
