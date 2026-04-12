# Plano de Validacao - Menu de Configuracao do Bot

Atualizado em: 2026-04-11

## Escopo

Validar o novo menu de configuracao integrado em:

- comando WhatsApp (`@ configurar bot` / `@ bot configuracao`)
- pagina web protegida (`/bot-config-menu.html`)

## Criterios de aprovacao

- menu abre no chat com secoes numeradas
- alias `@ bot configuracao` funciona
- comando por secao (`menu 1..10`) funciona
- pagina web abre somente autenticado
- pagina web carrega dados reais das APIs de configuracao
- toda acao de clique no painel interativo gera log tecnico
- cada acao critica retorna verificacao de aplicacao (OK/FALHA) no proprio painel
- navegacao do portal inclui link `Config Bot`
- sem regressao na suite de validacao do projeto

## Casos de teste

### 1) WhatsApp - abertura do menu

- Entrada: `@ configurar bot`
- Esperado: resposta com menu e secoes 1..10

- Entrada: `@ bot configuracao`
- Esperado: mesmo menu

### 2) WhatsApp - secoes

- Entrada: `@ configurar bot menu 1`
- Esperado: detalhes de IA e comandos de ajuste

- Entrada: `@ configurar bot menu 4`
- Esperado: detalhes de midia e comandos

- Entrada: `@ bot configuracao 8`
- Esperado: status completo da configuracao

### 3) Web - rota protegida

- URL: `/bot-config-menu.html`
- Esperado: requer login de painel e abre com sessao ativa

### 4) Web - dados dinamicos

- A pagina deve consumir:
  - `GET /api/settings`
  - `GET /api/ai-providers`
  - `GET /api/settings/audit?limit=8`
  - `GET /api/access-control`
- Esperado: valores renderizados no simulador e tabela de chaves

### 4.1) Web - log e verificacao de aplicacao

- Toda acao `POST/PUT/DELETE` em `/api/*` deve registrar evento em `data/panel-interactive-actions.jsonl`
- Endpoint de consulta:
  - `GET /api/panel-actions/logs?limit=40`
- Esperado:
  - log com actor, rota, status HTTP, tempo e resultado da verificacao
  - retorno da acao com campo `verification` quando aplicavel
  - painel exibindo feedback didatico com esperado x atual e motivo

### 5) Navegacao

- Verificar links `Config Bot` em:
  - dashboard
  - processos
  - multi-grupo
  - usuarios

### 6) Regressao tecnica

- Executar: `npm run check`
- Esperado: 0 falhas

## Resultado desta validacao

- Status: APROVADO
- Execucao tecnica: `npm run check` concluido com sucesso
- Resultado: `204 passou, 0 falhou`

## Evidencias de implementacao

- `src/localActions.js`: parser e respostas do menu interativo no chat
- `src/webPanel.js`: rota autenticada `/bot-config-menu.html`
- `src/webPanel.js`: auditoria de acoes interativas + verificacao automatica de aplicacao
- `public/bot-config-menu.html`: interface visual com mapeamento completo
- `processos/whatsapp_bot_config_menu.html`: versao atualizada do menu
