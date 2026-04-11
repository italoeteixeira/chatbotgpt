# WhatsApp + IA (Codex / Copilot)

Plataforma operacional para WhatsApp rodando em Linux. Responde com IA (Codex CLI ou Copilot CLI, trocaveis em tempo real), executa comandos administrativos e expoe um painel web de controle com autenticacao, SSE e auditoria.

O projeto saiu da fase de prova de conceito. O diferencial agora esta em governanca, observabilidade e inteligencia util sobre o historico do grupo.

## Documentacao

- **Comandos:** [`COMANDOS.md`](COMANDOS.md)
- **Historico de entregas:** [`CHANGELOG.md`](CHANGELOG.md)
- **Estado do projeto / roadmap:** [`processos/STATUS.md`](processos/STATUS.md)

## Ja implementado e em producao

**IA e roteamento**
- Resposta por IA no grupo autorizado (Codex + Copilot, fallback automatico)
- Multi-Grupo de Resposta
- Modo Silencioso (`modo silencioso` / `modo normal`) — para IA sem desligar bot

**Historico e resumos**
- Resumo do Dia / o que perdi? / resumo da semana (IA sobre historico do grupo)
- Historico de conversa persistido por grupo

**Automacoes (modo FULL)**
- Jobs FULL com watchdog, auto-recuperacao de travados e timeouts corretos
- `startFullAutoJobDirect` e status em tempo real via painel

**Comunicacao e relay**
- Relay de mensagens privadas com wizard conversacional (`@ enviar mensagem`)
- Encaminhamento de respostas via quote

**Grupo e moderacao**
- Adicionar/remover/promover membros
- Avisos, remocao automatica no limite de palavras proibidas
- ACL por niveis: autorizado, admin, full, privado

**Agenda, lembretes e notas**
- Agenda nomeada, lembretes com recorrencia, alarmes, notas/textos

**Midia**
- Ingestao automatica, indexacao com hash, protecao por senha, listagem e envio
- Transcricao de audio automatica no grupo

**Financeiro**
- `@despesa` / `@despesas` por grupo com exportacao CSV

**Operacao Linux**
- Exec de comandos por allowlist, ping, status de processo

**Painel web**
- Login/sessao, tema escuro, SSE em tempo real
- Configuracoes com auditoria e rollback
- Gerenciamento de midia, moderacao, ACL, multi-grupo

**Operacional**
- Backup automatico diario de `data/` (`fazer backup` / `listar backups`)
- Plano de backup validado para GitHub (somente FULL): validacao completa + suite funcional + backup + push + atualizacao automatica do README (`plano de backup github`)
- Busca web e geracao de imagem
- Configuracao dinamica com auditoria

## Proximas entregas prioritarias

Ver detalhes completos em [`processos/STATUS.md`](processos/STATUS.md).

**Eixo A — Portal como centro de comando**
- Aba FULL Dev (lista de jobs, log, visualizador do .txt gerado)
- Dashboard de observabilidade por grupo
- Preview de midia no painel
- Badge de conexao do WhatsApp no header
- RBAC: perfis viewer / operator / admin no painel

**Eixo B — Inteligencia do bot**
- Memoria semantica com TTL e categorias por usuario/grupo
- Relay com sugestao inteligente (IA sugere resposta antes de encaminhar)
- Fluxos de confirmacao para acoes sensiveis
- Enquete rapida (`!votacao`)
- Execucao agendada de jobs FULL

**Eixo C — Base tecnica**
- Migracao gradual de JSONs para SQLite (moderation, identities, alarms)
- Healthchecks mais detalhados por provider e worker

## O que este projeto faz

- responde no grupo autorizado (`GROUP_JID_AUTORIZADO` ou `GROUP_INVITE_LINK`) e pode expandir para Multi-Grupo de Resposta
- suporta Multi-Grupo de Resposta (grupo principal + grupos extras)
- ignora grupos fora da lista de resposta e mensagens do proprio bot
- pode responder chat privado somente para numeros com permissao privada concedida por admin
- responde somente quando mencionado (configuravel)
- restringe por remetentes autorizados
- permite acoes de admin no grupo (adicionar, remover, promover)
- aprende e memoriza apelidos/IDs para remover/promover por mencao
- modera palavras proibidas (apaga, avisa, remove no limite)
- gerencia agenda e notas em SQLite local
- salva historico de conversa por grupo
- executa comandos Linux (se habilitado)
- faz busca web
- gera imagem e envia no grupo
- salva fotos/videos/documentos recebidos com hash e indice
- transcreve audio recebido automaticamente no grupo autorizado
- gerencia configuracoes dinamicas com auditoria/rollback
- mostra QR/estado/log em painel web

## Requisitos

- Linux com Node.js 20+ (recomendado Node 22+)
- Google Chrome/Chromium (WhatsApp Web via Puppeteer)
- Pelo menos um provedor de IA CLI instalado:
  - **Codex CLI** (via extensao VS Code `openai.chatgpt`) autenticado (`codex login`)
  - **Copilot CLI** (`npm install -g @github/copilot`) autenticado (`copilot login` ou via `COPILOT_GITHUB_TOKEN`)
- O painel web detecta automaticamente quais provedores estao instalados

## Configuracao

1. Instalar dependencias:

```bash
npm install
```

2. Criar `.env`:

```bash
cp .env.example .env
```

3. Ajustar no `.env`:

- `GROUP_JID_AUTORIZADO` ou `GROUP_INVITE_LINK`
- `REQUIRE_MENTION=true` para responder so com mencao
- `AUTHORIZED_SENDER_NUMBERS=...` para controlar quem fala com o bot
- `ADMIN_SENDER_NUMBERS=...` para comandos sensiveis (grupo/servidor)
- `FULL_SENDER_NUMBERS=...` para acesso total (inclui admin + autorizado)
- `GITHUB_BACKUP_ENABLED=true` para habilitar backup validado com push
- `GITHUB_BACKUP_UPDATE_README=true` para atualizar automaticamente o README a cada backup validado
- `GITHUB_BACKUP_RUN_TEST_SUITE=true` para rodar bateria funcional (`node scripts/test-suite.js`) antes do push
- `GITHUB_BACKUP_AUTO_ROLLBACK=true` para rollback local seguro caso falhe apos commit
- `BACKUP_SCHEDULER_MODE=validated_github` para agendador executar o plano completo (ou `data_only`)
- `BACKUP_SCHEDULER_INTERVAL_HOURS=24` para periodicidade do agendador
- `CODEX_REASONING_EFFORT=low` para reduzir latencia de resposta
- `AI_PROVIDER=codex` ou `AI_PROVIDER=copilot` para escolher o motor de IA padrao
- `COPILOT_BIN=copilot` (auto-detectado se instalado)
- `COPILOT_MODEL=` modelo do Copilot (opcional)
- `COPILOT_REASONING_EFFORT=low` esforco de raciocinio do Copilot
- `COPILOT_TIMEOUT_MS=30000` timeout do Copilot em ms
- `COPILOT_GITHUB_TOKEN=gho_...` token OAuth do GitHub para autenticacao headless do Copilot (alternativa ao `copilot login`)
- `NOTIFICATION_GROUP_JID=...` grupo para notificacoes internas do bot
- `NOTIFICATION_GROUP_NAME=...` nome do grupo de notificacoes
- `MEDIA_INGEST_ENABLED=true` para salvar midia recebida
- `MEDIA_ROOT_DIR=...` para pasta raiz de arquivos recebidos
- `AUDIO_TRANSCRIPTION_ENABLED=true` para transcrever audio recebido
- `AUDIO_TRANSCRIPTION_PROVIDER=whisper` (offline local) ou `openai`
- `AUDIO_TRANSCRIPTION_WHISPER_MODEL=...` (quando provider for whisper)
- `BOT_DATABASE_FILE=...` para caminho do banco SQLite (agenda/notas)
- `TERMINAL_ALLOWLIST=...` para restringir comandos Linux permitidos
- `SHOW_THINKING_MESSAGE=true` para enviar "Pesquisando..." antes da resposta
- `THINKING_MESSAGE_TEXT=Pesquisando...` para texto do aviso

4. Para transcricao offline com `whisper` (sem chave de API), instalar uma vez:

```bash
mkdir -p tools
git clone --depth 1 https://github.com/ggml-org/whisper.cpp tools/whisper.cpp
cmake -S tools/whisper.cpp -B tools/whisper.cpp/build -DCMAKE_BUILD_TYPE=Release
cmake --build tools/whisper.cpp/build -j"$(nproc)"
cd tools/whisper.cpp && bash ./models/download-ggml-model.sh small
```

## Descobrir JID do grupo

```bash
npm run groups
```

## Execucao

```bash
npm start
```

Painel web: `http://localhost:8787` (ou `PORT` configurada).

## Painel web

O painel possui tema escuro (fundo `#0e1117`) e navegacao integrada entre paginas, sem popups.

Paginas disponiveis:

| Pagina | Rota | Funcao |
|---|---|---|
| Dashboard | `/` | Status, IA, configuracao, midia, moderacao, logs |
| Processos | `/processos.html` | Jobs automatizados e tarefas em andamento |
| Multi-Grupo | `/multi-grupos.html` | Mapa de grupos, roteamento, permissoes |
| Config Bot | `/bot-config-menu.html` | Menu didatico de configuracao (espelho do comando no WhatsApp) |
| Usuarios | `/usuarios.html` | Gerenciamento de usuarios do painel |
| Login | `/login.html` | Autenticacao do painel |

Autenticacao:

- `PANEL_BOOTSTRAP_USERNAME` e `PANEL_BOOTSTRAP_PASSWORD` definem credenciais iniciais
- Sessao via cookie seguro
- Suporte a multiplos usuarios com CRUD via API

Eventos em tempo real:

- Endpoint SSE `GET /events` para stream de logs e status ao vivo
- Dashboard atualiza automaticamente via EventSource

## Comandos de grupo (admin do bot)

Adicionar (somente por numero):

- `@bot adiciona 21 96486-6832 ao grupo`
- `@bot adicionar 5521964866832`

Remover (todos os formatos abaixo sao aceitos):

- `@bot remover 21 96486-6832`
- `@bot remover 5521964866832`
- `@bot remover @168762183561413`
- `@bot remover @Fernanda ❤️` (apos aprendizado de alias)

Promover para admin:

- `@bot coloca 21 96486-6832 como admin do grupo`
- `@bot promove 5521964866832 admin`
- `@bot coloca @Fernanda ❤️ como admin`

Verificar permissao no grupo:

- `@bot verifica suas permissoes`

Controle avançado do grupo:

- `@bot status do grupo`
- `@bot listar admins do grupo`
- `@bot fechar grupo` / `@bot abrir grupo`
- `@bot bloquear edicao de info do grupo` / `@bot liberar edicao de info do grupo`
- `@bot somente admin adiciona no grupo` / `@bot liberar adicao de membros no grupo`
- `@bot mudar nome do grupo para Time Operacoes`
- `@bot descricao do grupo: Regras e avisos oficiais`
- `@bot link do grupo`
- `@bot renovar link do grupo`
- `@bot listar solicitacoes de entrada`
- `@bot aprovar solicitacoes de entrada` (ou informando numero)
- `@bot rejeitar solicitacoes de entrada` (ou informando numero)
- `@bot adicionar admin do grupo 21 96486-6832`
- `@bot remover admin do grupo 21 96486-6832`

Controle de grupo via painel/API:

- `GET /api/group/control`
- `POST /api/group/control/action`
  - `set_subject`
  - `set_description`
  - `set_messages_admins_only`
  - `set_info_admins_only`
  - `set_add_members_admins_only`
  - `get_invite_link`
  - `refresh_invite_link`
  - `list_membership_requests`
  - `approve_membership_requests`
  - `reject_membership_requests`

## Aprendizado de memoria (alias -> numero)

O bot grava memoria por grupo em `data/identities.json`.

Comando de aprendizado:

- `@bot numero 21 96486-6832 e Fernanda`
- `@bot numero 21 96486-6832 e @Fernanda ❤️`
- `@bot numero 21 96486-6832 e @168762183561413`

Depois disso, comandos com `@Fernanda` (ou `@168...`) podem ser resolvidos para o numero real.

## Moderacao

Exemplos:

- `@bot palavras proibidas`
- `@bot adicionar palavra proibida: sexo`
- `@bot remover palavra proibida: sexo`
- `@bot criterio, nao falar sexo`
- `@bot ninguem pode falar a palavra sexo, se falar avise por 3 vezes, na terceira vez remova do grupo`
- `@bot limite de avisos 3`
- `@bot listar avisos`
- `@bot resetar avisos`

Arquivos:

- `data/moderation.json`

## Agenda, notas e historico

Agenda:

- `@bot agenda: dentista amanha 13h`
- `@bot listar agenda` (lista por assunto com classificacao inteligente local)
- `@bot listar agenda com indices` (lista numerada para editar/apagar por numero)
- `@bot editar agenda 1: dentista quinta 14h`
- `@bot apagar agenda 1`
- `@bot apagar agenda` / `@bot apagar a agenda` (limpa toda a agenda do grupo)
- `@bot limpar agenda` / `@bot limpar a agenda` / `@bot apagar toda a agenda`
- `@bot configurar bom dia todos os dias as 05:00`
- `@bot listar mensagem diaria`
- `@bot desativar mensagem diaria`
- `@bot me lembra as 22h de hoje que eu tenho que tomar remedio`
- `@bot listar lembretes`
- `@bot cancelar lembrete 1`

Notas:

- `@bot salvar texto: comprar cafe`
- `@bot listar textos`
- `@bot apagar texto 1`
- `@bot limpar todos os textos` / `@bot limpar textos`

Historico:

- `@bot mostrar historico`

Arquivos:

- `data/bot.sqlite` (agenda/notas)
- `data/scheduled-messages.json` (rotina diaria por grupo)
- `data/conversas/...`

## Servidor Linux e operacao

Status/processos/comandos:

- `@bot status servidor linux`
- `@bot localiza processo`
- `@bot lista os processos no linux`
- `@bot manda um ping no servidor para o IP 8.8.8.8`
- `@bot ping 8.8.8.8`
- `@bot cmd: ps -ef | rg node`
- `@bot executar comando: ls -la`

Comandos Linux dinamicos respeitam:

- `enableTerminalExec` (configuracao em runtime)
- `terminalAllowlist` (prefixos permitidos)
- bloqueio de padroes perigosos (`rm -rf /`, `shutdown`, `reboot`, etc.)

Reinicio automatico (opcional):

- `@bot reinicia bot` (requer `ENABLE_SELF_RESTART=true`)

## Configuracao dinamica (admin)

- `@bot ajuda configuracao bot`
- `@bot mostrar configuracao bot`
- `@bot status configuracao bot`
- `@bot configurar bot` (abre menu interativo por secoes)
- `@bot bot configuracao` (alias do menu interativo)
- `@bot configurar bot menu <numero>` (abre secao do menu)
- `@bot bot configuracao <numero>` (atalho por numero)
- `@bot listar modelos do bot`
- `@bot configurar bot: testar modelos` (teste real de disponibilidade)
- `@bot listar auditoria configuracao bot`
- `@bot configurar bot: requireMention=false`
- `@bot configurar bot: codexTimeoutMs=18000`
- `@bot configurar bot: terminalAllowlist=ps,df,free,uptime`
- `@bot configurar bot: mencao obrigatoria=true` (alias em portugues)
- `@bot configurar bot: timeout ia=20000` (alias em portugues)
- `@bot configurar bot: limite resposta=2200` (alias em portugues)
- `@bot configurar bot: modelo copilot=gpt-5-mini`
- `@bot configurar bot: modelo full copilot=gpt-5-mini`
- `@bot configurar bot: modelo fallback copilot=gpt-4.1`
- `@bot configurar bot: modelo codex=gpt-5.4-mini`
- `@bot configurar bot: modelo fallback=gpt-5.4`
- `@bot rollback configuracao <audit-id>`

Persistencia:

- `data/bot-settings.json`
- `data/bot-settings-audit.jsonl`

Painel web:

- `GET /api/settings`
- `PUT /api/settings`
- `GET /api/settings/audit`
- `POST /api/settings/rollback/:id`
- `GET /bot-config-menu.html` (menu visual protegido com a mesma autenticacao do portal)

Secoes do menu interativo (`configurar bot menu <numero>`):

- `1` IA
- `2` Respostas
- `3` Terminal
- `4` Midia
- `5` Relay
- `6` Modo silencioso
- `7` Auditoria e rollback
- `8` Status geral
- `9` Permissoes e multi-grupo
- `10` Mapa de recursos

## Controle de interacao (admin)

Via chat (admin):

- `@bot autoriza 21 96486-6832`
- `@bot libera 21 96486-6832`
- `@bot bloquear 21 96486-6832`
- `@bot remover autorizacao 21 96486-6832`
- `@bot listar autorizados`
- `@bot listar admins do bot`
- `@bot listar full`
- `@bot adiciona admin do bot 21 96486-6832`
- `@bot remove admin do bot 21 96486-6832`
- `@bot adicionar full 21 96486-6832`
- `@bot remover full 21 96486-6832`
- `@bot listar privado`
- `@bot autorizar privado 21 96486-6832`
- `@bot remover privado 21 96486-6832`
- `@bot listar grupos de resposta`
- `@bot adicionar grupo de resposta 120363400000000000@g.us`
- `@bot remover grupo de resposta 120363400000000000@g.us`

Via painel/API:

- `GET /api/access-control`
- `GET /api/access-control/recent-senders`
- `POST /api/access-control/authorized`
- `DELETE /api/access-control/authorized/:number`
- `POST /api/access-control/full`
- `DELETE /api/access-control/full/:number`
- `POST /api/access-control/admins`
- `DELETE /api/access-control/admins/:number`
- `GET /api/response-routing`
- `GET /api/response-routing/diagnostics`
- `POST /api/response-routing/groups`
- `DELETE /api/response-routing/groups/:groupId`
- `POST /api/response-routing/private`
- `DELETE /api/response-routing/private/:number`

Janela dedicada no painel:

- `Multi-Grupo` (botao no topo do portal) abre `/multi-grupos.html` para gerenciar:
  - mapa de grupos com flags de resposta (mencao, roteamento, bot admin, pode responder ou nao)
  - flags do modo global de resposta (`se mencionar` ou `sem mencionar`)
  - grupos extras de resposta
  - numeros autorizados no chat privado
  - controle do grupo principal (nome, descricao, convite, travas, solicitacoes)
  - permissoes efetivas e edicao de autorizado/admin/FULL
  - autorizacao rapida por remetentes recentes do grupo

## Provedores de IA

O bot suporta multiplos provedores de IA CLI, selecionaveis em tempo real pelo painel web ou por comando no WhatsApp.

### Provedores disponiveis

| Provedor | CLI | Extensao VS Code | Autenticacao |
|---|---|---|---|
| **Codex** | `codex exec -` | `openai.chatgpt` | `codex login` |
| **Copilot** | `copilot -p` | `github.copilot-chat` + `@github/copilot` | `copilot login` |

### Painel de IA

No painel web (`/`), a secao **Inteligencia Artificial** mostra:

- Cada provedor detectado com status (instalado/nao encontrado)
- Binario e origem (extensao VS Code)
- Botao **Testar** para enviar prompt de verificacao e medir tempo de resposta
- Botao **Testar FULL** (quando o provedor suporta modo FULL no painel)
- Seletor de modelos por provedor (principal/FULL/fallback) com opcao de salvar
- Botao **Ativar como padrao** para trocar o provedor ativo sem reiniciar
- Indicador visual de qual provedor esta em uso

### APIs de IA

- `GET /api/ai-providers` — lista provedores detectados e qual esta ativo
- `POST /api/ai-providers/test` — testa um provedor com parametros opcionais:
  - corpo minimo: `{"provider":"codex"}` ou `{"provider":"copilot"}`
  - corpo completo: `{"provider":"copilot","mode":"full","model":"gpt-5-mini"}`
- `POST /api/ai-providers/activate` — ativa um provedor como padrao

### Troca via WhatsApp (admin)

- `@bot configurar bot: aiProvider=copilot`
- `@bot configurar bot: aiProvider=codex`

## Modo FULL (palavra-chave)

- Palavra-chave para executar alteracao automatica de codigo: `@ valida <pedido>`
- Exemplo: `@ valida ajustar mensagem de retorno do comando agenda`
- Alternativas: `dev: <pedido>` ou `full: <pedido>`
- Se o pedido passar de 1400 caracteres, o bot pede resumo para evitar timeout.
- Quando uma solicitacao FULL termina com validacao OK, o bot reinicia automaticamente se `ENABLE_SELF_RESTART=true`.

Gerenciar jobs:

- `status da minha solicitacao` — ver andamento
- `listar processos full` — historico de jobs
- `log do processo <id>` — log completo de um job
- `log full` — log do job mais recente

Timeouts configurados:

- Timeout Copilot modo FULL: 360 s (`copilotFullTimeoutMs`)
- Timeout maximo por job: 60 min (`fullAutoDevTimeoutMs`)
- Watchdog: jobs presos > 95 min sao encerrados automaticamente

Observacao:

- numeros fixos do `.env` aparecem como `Fixo (.env)` no painel e nao sao removidos por endpoint dinamico.

## Heartbeat e auto-monitoramento

O watchdog envia heartbeat automatico para o grupo de notificacoes configurado:

- Periodicidade: a cada **30 minutos**
- Status da IA (circuit breaker), uptime e fila pendente de retries
- Resumo de uso do Copilot
- Teste real de disponibilidade de modelos (timeout de 20s por modelo), com saida no formato:
  - `modelo ✅ disponivel (Xms)`
  - `modelo ❌ indisponivel (...)`
  - `modelo ❌ sem quota (402)`

Matriz atual de teste no heartbeat:

- Copilot: `gpt-5-mini`, `gpt-4.1`, `gpt-5`, `claude-sonnet-4.6`, `claude-3.7-sonnet`
- Codex: `gpt-5.4-mini`, `gpt-5.4`, `gpt-5-mini`, `gpt-5`

## Moderacao e palavras proibidas

Via chat (admin):

- `@bot status moderacao`
- `@bot ajuda moderacao`
- `@bot palavras proibidas`
- `@bot adicionar palavra proibida: sexo`
- `@bot adicionar palavras proibidas: sexo, nudez, spam`
- `@bot remover palavra proibida: sexo`
- `@bot ninguem pode falar a palavra sexo, 3 avisos`
- `@bot redefinir avisos`
- `@bot redefinir avisos 21 96486-6832`

Via painel/API:

- `GET /api/moderation`
- `PUT /api/moderation`
- `POST /api/moderation/keywords`
- `DELETE /api/moderation/keywords/:keyword`
- `POST /api/moderation/keywords/clear`
- `POST /api/moderation/warnings/reset`

## Busca e imagem

- `@bot buscar: cotacao do dolar hoje`
- `@bot gera uma foto de cachorro astronauta`

## Midia recebida e painel de arquivos

Quando recebe imagem/video/documento no grupo autorizado, o bot:

- valida MIME/tamanho conforme configuracao
- salva em estrutura por `grupo/data/tipo/remetente`
- calcula `sha256`
- indexa no arquivo de metadados

Quando recebe audio (`audio`/`ptt`) no grupo autorizado, o bot:

- transcreve automaticamente
- responde no grupo com `Transcricao do audio @numero: ...`
- usa provider configurado em `.env` (`whisper` local ou `openai`)

Consulta via chat (admin):

- `@bot listar imagens salvas`
- `@bot listar videos salvos`
- `@bot listar midias salvas`
- `@bot enviar 3 imagens salvas` (envia os arquivos no chat)
- `@bot apagar midia <id>`
- `@bot proteger midia <id> senha 1234`
- `@bot desproteger midia <id> senha 1234`
- citando a mensagem da midia enviada pelo bot:
  - `@bot proteger arquivo senha 1234`
  - `@bot baixar arquivo senha 1234`
  - `@bot apagar arquivo senha 1234`
- `@bot onde salva imagem, video e textos?`

APIs:

- `GET /api/media`
- `GET /api/media/:id`
- `GET /api/media/:id/download`
- `POST /api/media/:id/protect`
- `DELETE /api/media/:id`
- `POST /api/media/cleanup`

Protecao por senha:

- se o arquivo estiver protegido com senha, `/api/media/:id/download` exige `?password=<senha>`
- no painel, ao baixar/excluir arquivo protegido, a UI pede senha
- no chat, quando voce envia senha para liberar/apagar arquivo protegido, o bot tenta apagar a mensagem de senha do grupo apos validar

## Apagar mensagem no grupo

- O bot ja apaga mensagens automaticamente na moderacao (quando regra detecta palavra proibida).
- Tambem pode apagar manualmente uma mensagem especifica:
  1. responda/cite a mensagem alvo
  2. envie `@bot apagar mensagem`

## Arquivos de estado persistente

- `data/access-control.json`: numeros autorizados/admin/full/privado e grupos extras de resposta
- `data/identities.json`: aliases e IDs aprendidos para contatos
- `data/moderation.json`: regras de moderacao e avisos
- `data/bot.sqlite`: agenda e notas (SQLite + WAL)
- `data/conversas/...`: historico diario por grupo
- `data/media-index.json`: indice de arquivos de midia
- `data/midias/...`: arquivos fisicos salvos
- `data/bot-settings.json`: configuracao dinamica
- `data/bot-settings-audit.jsonl`: auditoria de mudancas
- `data/alarms.json`: alarmes agendados
- `data/reminders.json`: lembretes com horario
- `data/scheduled-messages.json`: mensagens programadas (bom dia, etc.)
- `data/group-config.json`: configuracao especifica por grupo
- `data/agenda.json` / `data/agenda.jsonl`: agenda legado e log
- `data/despesas/...`: registros de despesas
- `data/group-databases/...`: bancos por grupo
- `data/imagens/...`: imagens geradas por IA
- `data/relay-chats.json`: relays ativos e historico

## Relay de mensagens (privado → grupo)

Permite enviar mensagens privadas para um contato externo diretamente do grupo. As respostas sao encaminhadas de volta automaticamente.

Wizard conversacional (sem precisar saber o numero de memoria):

- `@ enviar mensagem` — bot pergunta o numero, depois a mensagem
- `@ manda mensagem` — idem

Modo direto:

- `!relay 21982011918 Ola, tudo bem?`
- `enviar mensagem para 21982011918`

Responder a relay ativo:

- `!resp 21982011918 Pode sim!`
- Citar mensagem encaminhada pelo bot — responde automaticamente ao contato

Gerenciar:

- `!relays` / `relays ativos` — listar relays ativos
- `!relay-stop 21982011918` — encerrar relay
- `encerrar mensagem 21982011918` — idem (linguagem natural)

Config: `relaySenderName` em `data/bot-settings.json` define o nome exibido no cabecalho da mensagem.

## Despesas

Rastreamento de despesas por grupo com exportacao para planilha (CSV / XLSX).

Adicionar:

- `!despesa 45,90 almoco`
- `@despesa 200 combustivel`
- `adicionar despesa 89,99 Uber`
- Encaminhar comprovante de pagamento — bot faz OCR automaticamente

Visualizar:

- `despesas` — resumo geral
- `listar despesas` / `mostrar despesas`
- `despesas do mes` — filtrar por periodo

Exportar:

- `exportar despesas` — CSV e XLSX
- `exportar despesas xlsx`

Apagar:

- `apagar despesa id 3`
- `apagar todas as despesas` (pede confirmacao)
- `confirmo apagar todas as despesas`

Arquivos: `data/despesas/`

## Troubleshooting rapido

Se **adiciona**, mas **nao remove**:

1. confirme que o bot e admin: `@bot verifica suas permissoes`
2. tente remover por numero completo: `@bot remover 55...`
3. ensine alias/ID e tente por mencao:
   - `@bot numero 21 ... e Fernanda`
   - `@bot remover @Fernanda`
4. se retornar detalhe tecnico (ex.: `Detalhe: remove ...`), use esse detalhe para diagnostico

Se cair em resposta generica de fallback:

- verifique timeout da IA (`CODEX_TIMEOUT_MS` ou `COPILOT_TIMEOUT_MS`)
- confira se o comando deveria ser local (grupo/servidor/moderacao) e nao pergunta aberta
- no painel, use os botoes **Testar** e **Testar FULL** na secao de IA
- no WhatsApp, use `@bot configurar bot: testar modelos` para validar disponibilidade real dos modelos

## Seguranca operacional

- filtro estrito por grupo autorizado
- ignora mensagens privadas sem permissao e mensagens do proprio bot
- ignora grupos fora da lista de resposta
- opcionalmente exige mencao
- opcionalmente restringe remetentes/admins
- timeout e truncamento de entrada/saida
- allowlist para comandos Linux e bloqueio de padroes perigosos
- fallback padrao em erro

## Exemplo systemd

Arquivo `/etc/systemd/system/whatsapp-codex.service`:

```ini
[Unit]
Description=WhatsApp Codex Bridge
After=network.target

[Service]
Type=simple
User=SEU_USUARIO
WorkingDirectory=/caminho/do/projeto
ExecStart=/usr/bin/npm start
Restart=always
RestartSec=5
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
```

Ativar:

```bash
sudo systemctl daemon-reload
sudo systemctl enable whatsapp-codex
sudo systemctl start whatsapp-codex
sudo systemctl status whatsapp-codex
```

## Deploy no servidor remoto

O projeto inclui script de sincronizacao em `scripts/sync-local-remote-merge.sh`.

Requisitos no servidor:

- Ubuntu 24.04+ com Node.js 22+
- `npm install -g @github/copilot` para Copilot CLI
- `COPILOT_GITHUB_TOKEN` no `.env` para autenticacao headless (sem navegador)
- `codex` instalado e autenticado (`codex login`) para Codex CLI
- `~/.codex/auth.json` e `~/.copilot/config.json` no usuario do servico

Sincronizar:

```bash
bash scripts/sync-local-remote-merge.sh
```

O script envia arquivos locais, recebe alteracoes remotas e faz merge bidirecional.

## Modulos do codigo-fonte

| Arquivo | Funcao |
|---|---|
| `src/index.js` | Ponto de entrada principal |
| `src/config.js` | Carregamento de .env e auto-deteccao de binarios IA |
| `src/whatsappBot.js` | Conexao WhatsApp e tratamento de mensagens |
| `src/aiBridge.js` | Roteador de provedores IA (Codex/Copilot) |
| `src/codexBridge.js` | Integracao Codex CLI |
| `src/copilotBridge.js` | Integracao Copilot CLI |
| `src/localActions.js` | Parser de comandos locais (grupo/moderacao/agenda) |
| `src/accessControl.js` | Gerenciamento de permissoes (autorizado/admin/full) |
| `src/botDatabase.js` | Operacoes SQLite (agenda/notas/usuarios) |
| `src/settingsStore.js` | Configuracao dinamica com auditoria |
| `src/runtimeState.js` | Estado de execucao atual |
| `src/conversationStore.js` | Historico de conversas |
| `src/messageQueue.js` | Fila de mensagens com ordenacao |
| `src/reminderStore.js` | Lembretes agendados |
| `src/alarmStore.js` | Alarmes |
| `src/scheduledMessagesStore.js` | Mensagens programadas (rotinas) |
| `src/expenseService.js` | Rastreamento de despesas |
| `src/fullAutoJobStore.js` | Jobs de automacao completa |
| `src/groupStore.js` | Metadados de grupos |
| `src/mediaStore.js` | Indexacao e gerenciamento de midia |
| `src/mediaTypeUtils.js` | Deteccao de tipo MIME |
| `src/moderationEngine.js` | Filtragem de palavras e avisos |
| `src/imageService.js` | Geracao de imagem via IA |
| `src/audioTranscriptionService.js` | Transcricao audio->texto (Whisper) |
| `src/searchService.js` | Busca web |
| `src/documentContextService.js` | Indexacao de documentos |
| `src/imageContextService.js` | Indexacao de imagens |
| `src/logger.js` | Logger centralizado |
| `src/panelAuth.js` | Autenticacao do painel web |
| `src/webPanel.js` | Servidor Express com 51 endpoints REST |
| `src/listGroups.js` | Enumeracao de grupos WhatsApp |

## Status do Backup Validado (Auto)

<!-- BACKUP_STATUS:START -->
> Bloco atualizado automaticamente pelo plano de backup validado.
- Run ID: `mnuiy9eb-4xhcwl`
- Trigger: `manual`
- Inicio: 11/04/2026, 13:03:40 (America/Sao_Paulo)
- Fim: 11/04/2026, 13:03:44 (America/Sao_Paulo)
- Status: 🟡 **VALIDADO_LOCAL**
- Validacao (`npm run check`): **OK**
- Suite funcional (`node scripts/test-suite.js`): **OK**
- Backup `data/`: `backup-2026-04-11T16-03-44.tar.gz`
- Bundle git: `git-bundle-2026-04-11T16-03-44.bundle`
- Commit principal: `sem alteracoes pendentes`
- Commit README: `nao houve commit exclusivo do README`
- Destino push: `-`
- Branches: `main, homologacao`
- Push: **PENDENTE**
- Rollback automatico: **nao**
- Observacao: Validacao e backup concluidos localmente. Push em andamento.
<!-- BACKUP_STATUS:END -->
