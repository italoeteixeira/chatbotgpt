# 📖 Referência de Comandos — WhatsApp Bot

> **Atualizado em:** 2026-04-10  
> **Versão:** produção (`root@191.252.159.213 /opt/chatbot`)  
> **Serviço:** `whatsapp-codex.service`

---

## Sumário

1. [IA Geral (chat normal)](#-ia-geral)
2. [Modo FULL — Desenvolvimento Autônomo](#-modo-full--desenvolvimento-autônomo)
3. [Terminal Linux](#-terminal-linux)
4. [Agenda](#-agenda)
5. [Lembretes](#-lembretes)
6. [Mensagem Diária Automática](#-mensagem-diária-automática)
7. [Relay — Mensagens Privadas no Grupo](#-relay--mensagens-privadas-no-grupo)
8. [Notas / Textos](#-notas--textos)
9. [Busca Web](#-busca-web)
10. [Geração de Imagem](#-geração-de-imagem)
11. [Biblioteca de Mídia](#-biblioteca-de-mídia)
12. [Histórico de Conversa](#-histórico-de-conversa)
13. [Moderação](#-moderação)
14. [Controle do Grupo](#-controle-do-grupo)
15. [ACL — Controle de Acesso](#-acl--controle-de-acesso)
16. [Configurações do Bot (Admin)](#-configurações-do-bot-admin)
17. [Multi-grupo / Roteamento](#-multi-grupo--roteamento)
18. [Despesas](#-despesas)
19. [Alias de Contatos](#-alias-de-contatos)
20. [Ops / Servidor](#-ops--servidor)
21. [Misc](#-misc)
22. [Configuração Atual em Produção](#-configuração-atual-em-produção)
23. [Permissões por Nível](#-permissões-por-nível)
24. [Arquivos de Estado](#-arquivos-de-estado)

---

## 🤖 IA Geral

Qualquer mensagem enviada no grupo autorizado é respondida pelo motor de IA (Copilot como primário, Codex como fallback).

| Situação | Comportamento |
|---|---|
| `requireMention: false` (padrão) | Bot responde a toda mensagem |
| `requireMention: true` | Bot só responde se mencionado |
| `showThinkingMessage: true` | Exibe "Processando..." antes da resposta |
| Áudio/PTT recebido | Transcreve automaticamente e responde |
| Imagem/vídeo/documento recebido | Salva na biblioteca de mídia automaticamente |

**Provedor ativo:** Copilot CLI (`/usr/bin/copilot`)  
**Fallback:** Codex (`gpt-5.4-mini`) quando Copilot demorar

---

## ⚡ Modo FULL — Desenvolvimento Autônomo

> Requer permissão **full**. O bot executa código, edita arquivos, valida e reinicia serviços autonomamente.

### Iniciar solicitação

```
@valida <descrição do que fazer>
dev: <descrição do que fazer>
full: <descrição do que fazer>
```

**Exemplos:**
```
@valida corrigir o bug no parseAgendaCommand para datas no formato DD/MM
dev: adicionar comando para listar últimas despesas por grupo
full: refatorar o sistema de moderação para suportar regex
```

### Acompanhar e gerenciar jobs

| Comando | Descrição |
|---|---|
| `status da minha solicitação` | Ver andamento do job em execução |
| `status` | Idem (forma curta) |
| `listar processos full` | Histórico dos últimos jobs |
| `ver processos full` | Idem |
| `log do processo <id>` | Log completo de um job específico |
| `log full` | Log do job mais recente |
| `log job <id>` | Idem por ID |

**Limites configurados:**
- Timeout por job: **60 min** (`fullAutoDevTimeoutMs`)
- Timeout no Copilot FULL: **6 min** (`copilotFullTimeoutMs`)
- Jobs presos são detectados pelo watchdog a cada 5 min

### Plano de backup validado (FULL)

| Comando | Descrição |
|---|---|
| `plano de backup github` | Roda `npm run check` + `node scripts/test-suite.js`, cria backup de `data/`, gera bundle git, atualiza `README` automaticamente e publica no GitHub |
| `backup validado` | Alias para o mesmo fluxo |
| `backup no github` | Alias para o mesmo fluxo |

**Requisitos:**
- Permissão **FULL**
- `GITHUB_BACKUP_ENABLED=true`
- `GITHUB_BACKUP_REPO` configurado
- `GITHUB_BACKUP_TOKEN` (ou push por `origin` com SSH já autenticado)
- `GITHUB_BACKUP_UPDATE_README=true` para atualizar README em toda execução
- `GITHUB_BACKUP_RUN_TEST_SUITE=true` para bateria funcional antes do push
- `GITHUB_BACKUP_AUTO_ROLLBACK=true` para rollback local seguro em caso de falha após commit

---

## 💻 Terminal Linux

> Requer `enableTerminalExec: true` + permissão **admin** ou **full**.

### Prefixos aceitos

```
cmd: <comando>
terminal: <comando>
bash: <comando>
sh: <comando>
sudo <comando>
executar comando: <comando>
rodar <comando>
run <comando>
```

**Exemplos:**
```
cmd: df -h
sudo systemctl status nginx
executar comando: ps aux | grep node
rodar journalctl -u whatsapp-codex -n 50
```

**Comandos bloqueados automaticamente:**
`rm -rf /`, `mkfs`, `dd if=`, `shutdown`, `reboot`, `halt`, `poweroff`, `init 0/6`, forks bomb, `killall node`, `pkill`, `kill -9 1`, operações em `/etc/`, `/boot/`, `/dev/`

**Allowlist configurada em produção:** ~60 comandos (`ps`, `df`, `top`, `git`, `npm`, `systemctl`, `journalctl`, `docker`, `sqlite3`, `mkdir`, `cp`, `mv`, `rm`, `chmod`, `chown`, `curl`, `wget`, etc.)

---

## 📅 Agenda

### Agenda padrão do grupo

| Comando | Descrição |
|---|---|
| `agenda` | Listar todos os itens |
| `listar agenda` / `ver agenda` | Idem |
| `agenda: <texto>` | Adicionar item |
| `agendar <evento>` | Adicionar |
| `coloca na agenda <evento>` | Adicionar |
| `anota na agenda <evento>` | Adicionar |
| `marca na agenda <evento>` | Adicionar |
| `listar agenda com índices` | Listar com números para referência |
| `editar agenda <N>: <novo texto>` | Editar item pelo número |
| `apagar agenda <N>` | Remover item pelo número |
| `apagar agenda <texto>` | Remover item pelo conteúdo |
| `limpar agenda` | Remover toda a agenda |
| `apagar toda a agenda` | Idem |

**Exemplos:**
```
agenda: dentista amanhã 13h
agendar reunião com cliente na sexta às 15h
editar agenda 2: reunião sexta 16h
apagar agenda 2
listar agenda com índices
```

### Agendas nomeadas

| Comando | Descrição |
|---|---|
| `agendas` | Listar todas as agendas nomeadas |
| `criar agenda <nome>` | Criar nova agenda com nome |
| `nova agenda <nome>` | Idem |
| `apagar agenda <nome>` | Deletar agenda nomeada |

**Exemplos:**
```
criar agenda consultas
criar agenda compras
agendas
apagar agenda consultas
```

---

## ⏰ Lembretes

| Comando | Descrição |
|---|---|
| `me lembra às <hora> <mensagem>` | Lembrete em horário fixo hoje |
| `me lembra às 14h de amanhã <mensagem>` | Lembrete para amanhã |
| `me lembra em <X> min/horas <mensagem>` | Lembrete relativo |
| `me lembra em 2 horas <mensagem>` | Idem |
| `me lembra toda segunda às 9h <msg>` | Recorrente por dia da semana |
| `me lembra todos os dias às 22h <msg>` | Recorrente diário |
| `lembretes` / `meus lembretes` | Listar lembretes ativos |
| `listar lembretes` | Idem |
| `cancelar lembrete <N>` | Cancelar pelo número |
| `cancelar todos os lembretes` | Cancelar todos |
| `limpar lembretes` | Idem |

**Exemplos:**
```
me lembra às 22h de hoje que eu tenho que tomar remédio
me lembra em 30 min de checar o deploy
me lembra toda terça às 8h reunião de equipe
listar lembretes
cancelar lembrete 2
```

---

## 📅 Mensagem Diária Automática

| Comando | Descrição |
|---|---|
| `configurar mensagem diária todo dia às <hora>` | Ativar bom dia automático |
| `configurar bom dia todo dia às <hora>` | Idem |
| `configurar mensagem diária todo dia às <hora> mensagem: <texto>` | Com texto customizado |
| `listar mensagem diária` | Ver configuração atual |
| `desativar mensagem diária` | Cancelar |

**Exemplos:**
```
configurar bom dia todo dia às 07:00
configurar mensagem diária todo dia às 20h mensagem: Boa noite, pessoal!
listar mensagem diária
desativar mensagem diária
```

---

## 📡 Relay — Mensagens Privadas no Grupo

O relay permite enviar mensagens privadas para um contato externo diretamente do grupo. As respostas são encaminhadas de volta ao grupo automaticamente.

> **Remetente configurado:** "Italo Teixeira" (`relaySenderName`)

### Iniciar relay

| Comando | Descrição |
|---|---|
| `@ enviar mensagem` | Wizard: bot pergunta o número, depois a mensagem |
| `@ manda mensagem` | Idem (variação) |
| `!relay <número> <mensagem>` | Envio direto com número |
| `enviar mensagem para <número>` | Linguagem natural com número |

**Exemplos:**
```
@ enviar mensagem
   → Bot: Qual o número? (com DDD)
   → Você: 21982011918
   → Bot: Qual a mensagem?
   → Você: Olá, tudo bem?
   → Bot: ✅ Mensagem enviada!

!relay 21982011918 Olá, tudo bem?
enviar mensagem para 21 98201-1918
```

### Responder a relay ativo

| Comando | Descrição |
|---|---|
| `!resp <número> <mensagem>` | Responder a um relay ativo |
| `responder para <número>: <mensagem>` | Linguagem natural |
| Citar msg encaminhada pelo bot | Responde automaticamente ao contato |

```
!resp 21982011918 Pode sim, às 15h!
```

### Gerenciar relays

| Comando | Descrição |
|---|---|
| `!relays` | Listar relays ativos |
| `relays ativos` | Idem |
| `!relay-stop <número>` | Encerrar relay com contato |
| `encerrar mensagem <número>` | Idem (linguagem natural) |
| `parar relay <número>` | Idem |
| `cancelar relay <número>` | Idem |

---

## 📝 Notas / Textos

| Comando | Descrição |
|---|---|
| `textos` / `notas` | Listar notas salvas |
| `listar textos` / `listar notas` | Idem |
| `salvar texto: <conteúdo>` | Salvar nova nota |
| `criar nota: <conteúdo>` | Idem |
| `anotar texto: <conteúdo>` | Idem |
| `editar texto <N>: <novo conteúdo>` | Editar nota pelo número |
| `editar nota <N>: <novo conteúdo>` | Idem |
| `apagar texto <N>` | Remover nota específica |
| `apagar nota <N>` | Idem |
| `limpar textos` / `limpar notas` | Remover todas |
| `apagar todos os textos` | Idem |

**Exemplos:**
```
salvar texto: comprar café e leite
criar nota: configurar alertas de disco no servidor
listar textos
editar texto 1: comprar café, leite e pão
apagar texto 2
```

---

## 🔍 Busca Web

| Comando | Descrição |
|---|---|
| `buscar <assunto>` | Busca na internet |
| `busque <assunto>` | Idem |
| `pesquisar <assunto>` | Idem |
| `procurar sobre <assunto>` | Idem |
| `buscar na internet: <assunto>` | Explícito |
| `veja no google <assunto>` | Idem |

**Exemplos:**
```
buscar: cotação do dólar hoje
pesquisar previsão do tempo São Paulo amanhã
procurar sobre atualização Ubuntu 24.04
```

---

## 🖼️ Geração de Imagem

| Comando | Descrição |
|---|---|
| `gerar imagem: <descrição>` | Gera imagem por IA e envia no grupo |
| `gera imagem de <descrição>` | Idem |
| `criar foto de <descrição>` | Idem |
| `cria uma foto de <descrição>` | Idem |

**Exemplos:**
```
gerar imagem: cachorro astronauta em Marte estilo realista
cria foto de logo cyberpunk para empresa de tecnologia
```

---

## 🗂️ Biblioteca de Mídia

Arquivos recebidos no grupo são salvos automaticamente quando `mediaIngestEnabled: true`.

### Listar e buscar

| Comando | Descrição |
|---|---|
| `imagens` / `fotos` | Listar imagens salvas |
| `vídeos` | Listar vídeos salvos |
| `documentos` | Listar documentos salvos |
| `listar mídias` | Listar todas as mídias |
| `listar arquivos` | Idem |

### Enviar arquivos no chat

| Comando | Descrição |
|---|---|
| `enviar imagens` | Reenviar imagens salvas (padrão: 3) |
| `enviar 5 vídeos` | Reenviar N vídeos |
| `enviar arquivos salvos` | Idem geral |

### Salvar e proteger

| Comando | Descrição |
|---|---|
| `salvar` (citando mídia) | Salva a mídia citada |
| `proteger mídia <id> senha: <senha>` | Proteger arquivo específico por ID |
| `proteger arquivo senha: <senha>` (citando) | Proteger arquivo citado |
| `desproteger mídia <id> senha: <senha>` | Remover proteção |
| `desproteger arquivo senha: <senha>` (citando) | Idem citando |

### Baixar e apagar

| Comando | Descrição |
|---|---|
| `baixar arquivo senha: <senha>` (citando) | Baixar arquivo protegido |
| `apagar mídia <id>` | Remover por ID |
| `apagar arquivo senha: <senha>` (citando) | Remover arquivo protegido |
| `limpar todas as mídias` | Apagar tudo |
| `limpar todas as imagens` | Apagar só imagens |

### Info

| Comando | Descrição |
|---|---|
| `onde salva imagens` | Ver caminhos de armazenamento |
| `onde salva vídeos e textos` | Idem |

**Config atual:**
- Ingestão automática: ✅ ativa
- Tamanho máximo: 20 MB
- Retenção: 30 dias
- MIMEs aceitos: `image/`, `video/`, `audio/`, `application/pdf`, `text/plain`, Word/Office

---

## 💬 Histórico de Conversa

| Comando | Descrição |
|---|---|
| `listar conversas` | Ver histórico do grupo |
| `últimas mensagens` | Idem |
| `histórico de conversa` | Idem |
| `limpar histórico` | Apagar histórico local do grupo |
| `apagar conversas` | Idem |

---

## 🛡️ Moderação

> Requer permissão **admin**.

### Status e ajuda

| Comando | Descrição |
|---|---|
| `moderação` | Ver status atual da moderação |
| `status moderação` | Idem |
| `ajuda moderação` | Ver comandos disponíveis |

### Palavras proibidas

| Comando | Descrição |
|---|---|
| `palavras proibidas` | Listar palavras banidas |
| `adicionar palavra proibida: <palavra>` | Adicionar palavra |
| `adicionar palavras proibidas: <p1>, <p2>` | Adicionar múltiplas |
| `remover palavra proibida: <palavra>` | Remover palavra |
| `limpar palavras proibidas` | Zerar lista inteira |
| `ativar moderação` | Habilitar filtro |
| `desativar moderação` | Desabilitar filtro |

### Linguagem natural

```
ninguém pode falar a palavra sexo
não falar spam
ninguém pode falar a palavra racismo, se falar avise, na 3ª vez remova
```

### Avisos e remoção automática

| Comando | Descrição |
|---|---|
| `limite de avisos: <N>` | Definir nº máx de avisos antes de remoção |
| `listar avisos` | Ver avisos por membro |
| `resetar avisos <número>` | Zerar avisos de um membro |
| `resetar avisos` | Zerar todos os avisos |

---

## 👥 Controle do Grupo

> Requer permissão **admin**.

### Membros

| Comando | Descrição |
|---|---|
| `adicionar <número> no grupo` | Adicionar membro |
| `adicionar <número>` | Atalho (sem precisar escrever "no grupo") |
| `remover <número> do grupo` | Remover membro |
| `remover <número>` | Atalho |
| `promover <número> admin do grupo` | Tornar admin do grupo |
| `rebaixar admin <número>` | Remover permissão de admin |
| `adicionar admin do grupo <número>` | Idem para promover |
| `remover admin do grupo <número>` | Idem para rebaixar |

### Informações do grupo

| Comando | Descrição |
|---|---|
| `status do grupo` | Resumo completo do grupo |
| `listar admins do grupo` | Ver lista de admins |
| `mudar nome do grupo para: <nome>` | Renomear grupo |
| `mudar descrição do grupo para: <desc>` | Alterar descrição |
| `link do grupo` | Obter link de convite |
| `renovar link do grupo` | Gerar novo link (revoga o antigo) |

### Modos e restrições

| Comando | Descrição |
|---|---|
| `fechar grupo para mensagens` | Somente admins enviam msgs |
| `abrir grupo para mensagens` | Todos podem enviar |
| `bloquear edição de info do grupo` | Somente admins editam nome/descrição |
| `liberar edição de info do grupo` | Todos podem editar |
| `somente admin adiciona no grupo` | Restringir adição de membros |
| `liberar adição de membros no grupo` | Todos podem adicionar |

### Mensagens temporárias (autodestruição)

| Comando | Descrição |
|---|---|
| `ativar mensagens temporárias: <duração>` | Ex: "24 horas", "7 dias" |
| `mensagens temporárias: 1 dia` | Idem |
| `status mensagens temporárias` | Ver configuração atual |
| `desativar mensagens temporárias` | Desligar |

### Solicitações de entrada

| Comando | Descrição |
|---|---|
| `listar solicitações de entrada` | Ver pedidos pendentes |
| `aprovar solicitação de entrada` | Aceitar todos pendentes |
| `aprovar solicitação <número>` | Aceitar específico |
| `rejeitar solicitação de entrada` | Recusar todos |
| `rejeitar solicitação <número>` | Recusar específico |

---

## 🔑 ACL — Controle de Acesso

> Requer permissão **admin**.

### Gerenciar usuários autorizados

| Comando | Descrição |
|---|---|
| `listar autorizados` | Ver números autorizados |
| `autorizar <número>` | Liberar acesso ao bot |
| `liberar <número>` | Idem |
| `bloquear <número>` | Revogar acesso |
| `remover autorização <número>` | Idem |

### Admins do bot

| Comando | Descrição |
|---|---|
| `listar admins do bot` | Ver admins |
| `adicionar admin do bot <número>` | Promover a admin |
| `remover admin do bot <número>` | Rebaixar admin |

### Usuários FULL (acesso total)

| Comando | Descrição |
|---|---|
| `listar full` | Ver usuários com acesso full |
| `adicionar full <número>` | Conceder acesso full |
| `remover full <número>` | Revogar acesso full |

### Acesso privado (chat direto com bot)

| Comando | Descrição |
|---|---|
| `listar privado` | Ver números com acesso privado |
| `autorizar privado <número>` | Liberar chat privado com bot |
| `remover privado <número>` | Revogar chat privado |

### Checar próprias permissões

| Comando | Descrição |
|---|---|
| `verificar permissões` | Ver suas permissões atuais |
| `você é admin?` | Idem |
| `sou full?` | Idem |

---

## ⚙️ Configurações do Bot (Admin)

> Requer permissão **admin**. Mudanças são gravadas em `data/bot-settings.json` com auditoria.

### Visualizar e auditar

| Comando | Descrição |
|---|---|
| `configurar bot` | Abre o menu interativo de configuração (por seções) |
| `bot configuracao` | Alias do menu interativo |
| `configurar bot menu <numero>` | Abre seção específica do menu |
| `bot configuracao <numero>` | Alias por número |
| `mostrar configuração bot` | Ver todas as configurações atuais |
| `status configuração bot` | Idem |
| `ajuda configuração bot` | Listar chaves disponíveis |
| `listar modelos do bot` | Mostrar modelos conhecidos e status recente |
| `configurar bot: testar modelos` | Rodar teste real de disponibilidade de modelos |
| `listar auditoria configuração bot` | Histórico de mudanças |
| `rollback configuração <audit-id>` | Reverter para versão anterior |

### Seções do menu interativo

| Número | Seção |
|---|---|
| `1` | Inteligência Artificial |
| `2` | Comportamento de respostas |
| `3` | Terminal Linux |
| `4` | Mídia |
| `5` | Relay (mensagens privadas) |
| `6` | Modo silencioso |
| `7` | Auditoria e rollback |
| `8` | Status geral |
| `9` | Permissões e multi-grupo |
| `10` | Mapa de recursos do projeto |

### Alterar configuração

```
configurar bot: <chave>=<valor>
```

**Exemplos:**
```
configurar bot: requireMention=false
configurar bot: mencao obrigatoria=true
configurar bot: timeout ia=30000
configurar bot: timeout copilot=90000
configurar bot: timeout modo full=360000
configurar bot: limite resposta=2200
configurar bot: provedor ia=copilot
configurar bot: provedor ia=codex
configurar bot: modelo copilot=gpt-5-mini
configurar bot: modelo full copilot=gpt-5-mini
configurar bot: modelo fallback copilot=gpt-4.1
configurar bot: modelo codex=gpt-5.4-mini
configurar bot: modelo fallback=gpt-5.4
configurar bot: testar modelos
configurar bot: salvar midia automatica=true
configurar bot: retencao de midia=30
configurar bot: permitir comandos linux=true
configurar bot: relaySenderName=João Silva
configurar bot: prompt do sistema=Você é um assistente objetivo...
```

### Modelos conhecidos (referência rápida)

- **Copilot:** `gpt-5-mini`, `gpt-4.1`, `gpt-5`, `claude-sonnet-4.6`, `claude-3.7-sonnet`
- **Codex:** `gpt-5.4-mini`, `gpt-5.4`, `gpt-5-mini`, `gpt-5`

Atalhos aceitos no painel/configuração:

- `gpt` / `chatgpt` / `openai` (resolve para o padrão do provedor/modo)

### Chaves disponíveis e seus aliases em português

| Chave | Alias em português |
|---|---|
| `requireMention` | `mencao obrigatoria` |
| `fallbackMessage` | `mensagem fallback` |
| `showThinkingMessage` | `mensagem pesquisando` |
| `thinkingMessageText` | — |
| `maxInputChars` | `limite entrada` |
| `maxOutputChars` | `limite resposta` |
| `aiProvider` | `provedor ia` / `provedor de ia` |
| `codexModel` | `modelo ia` / `modelo codex` |
| `codexReasoningEffort` | `raciocinio ia` |
| `codexTimeoutMs` | `timeout ia` / `timeout codex` |
| `codexFallbackModel` | `modelo fallback` |
| `codexFallbackTimeoutMs` | `timeout fallback` |
| `codexFallbackOnTimeout` | `fallback em timeout` |
| `copilotModel` | `modelo copilot` |
| `copilotReasoningEffort` | `raciocinio copilot` |
| `copilotTimeoutMs` | `timeout copilot` |
| `copilotFullTimeoutMs` | `timeout full copilot` / `timeout modo full` |
| `copilotFallbackModel` | `modelo fallback copilot` |
| `copilotFallbackOnTimeout` | `fallback em timeout copilot` |
| `enableTerminalExec` | `permitir comandos linux` / `execucao terminal` |
| `terminalAllowlist` | `allowlist terminal` / `comandos permitidos terminal` |
| `mediaIngestEnabled` | `salvar midia automatica` |
| `mediaRootDir` | `pasta de midia` |
| `mediaMaxBytes` | `limite tamanho midia` |
| `mediaRetentionDays` | `retencao de midia` |
| `mediaAllowedMimePrefixes` | `mimes permitidos de midia` |
| `relaySenderName` | — |
| `systemPrompt` | `prompt do sistema` |
| `fullAutoDevTimeoutMs` | — |

---

## 🌐 Multi-grupo / Roteamento

| Comando | Descrição |
|---|---|
| `listar grupos de resposta` | Ver grupos configurados para multi-resposta |
| `adicionar grupo de resposta <id>` | Adicionar grupo (formato: `120363...@g.us`) |
| `remover grupo de resposta <id>` | Remover grupo da lista |

**Exemplo:**
```
adicionar grupo de resposta 120363400000000000@g.us
listar grupos de resposta
```

---

## 💰 Despesas

Rastreamento de despesas por grupo, com exportação para planilha.

### Visualizar

| Comando | Descrição |
|---|---|
| `despesas` / `@despesas` | Resumo geral de despesas |
| `mostrar despesas` | Listar todas |
| `listar despesas` | Idem |
| `despesas do mês` | Filtrar por período |
| `despesas de janeiro` | Filtrar por mês |

### Adicionar despesa

| Comando | Descrição |
|---|---|
| `!despesa <valor> <título>` | Adicionar manualmente |
| `@despesa <valor> <título>` | Idem |
| `adicionar despesa 50,00 almoço` | Linguagem natural |
| `registrar despesa 120 combustível` | Idem |
| Encaminhar comprovante de pagamento | Bot faz OCR e adiciona automaticamente |

**Exemplos:**
```
!despesa 45,90 almoço restaurante
@despesa 200 material de escritório
adicionar despesa 89,99 Uber
```

### Apagar despesas

| Comando | Descrição |
|---|---|
| `apagar despesa id <N>` | Apagar por ID |
| `!despesas apagar <N>` | Idem via prefixo |
| `apagar todas as despesas` | Solicitar exclusão total (pede confirmação) |
| `confirmo apagar todas as despesas` | Confirmar exclusão total |

### Exportar

| Comando | Descrição |
|---|---|
| `exportar despesas` | Exportar como CSV e XLSX |
| `exportar despesas xlsx` | Só Excel |
| `exportar despesas csv` | Só CSV |
| `@despesas exportar` | Idem via prefixo |

---

## 🏷️ Alias de Contatos

Permite associar apelidos a números para usar em comandos de grupo.

| Comando | Descrição |
|---|---|
| `o número <nº> é <nome>` | Associar apelido a número |

**Exemplos:**
```
o número 21 9 6486-6832 é Fernanda
o número 5521964866832 é @Fernanda ❤️
```

Após aprender, você pode usar:
```
remover @Fernanda do grupo
promover @Fernanda admin do grupo
```

---

## 🔧 Ops / Servidor

> Requer permissão **admin**.

| Comando | Descrição |
|---|---|
| `ip público` / `ip do servidor` | Ver IP externo do servidor |
| `ip externo` | Idem |
| `listar processos` | Ver processos em execução |
| `status servidor linux` | Status geral do bot/serviço |
| `Bot está rodando?` | Idem |
| `reiniciar bot` | Restart do serviço (requer `ENABLE_SELF_RESTART=true`) |
| `ping <IP>` / `ping 8.8.8.8` | Testar conectividade |
| `ping <domínio>` | Idem por hostname |

**Observabilidade automática:**
- Heartbeat enviado para o grupo de notificações a cada 30 minutos, incluindo status da IA, uptime, fila pendente e teste real de disponibilidade de modelos.

---

## 🗑️ Misc

| Comando | Descrição |
|---|---|
| `apagar mensagem` (citando msg) | Deleta a mensagem citada no grupo |

---

## ⚙️ Configuração Atual em Produção

| Parâmetro | Valor |
|---|---|
| **Provedor IA** | `copilot` |
| **Modelo Copilot** | padrão (auto) |
| **Raciocínio Copilot normal** | `medium` |
| **Raciocínio Copilot FULL** | `high` |
| **Timeout Copilot normal** | 90 s |
| **Timeout Copilot FULL** | 360 s (6 min) |
| **Fallback em timeout Copilot** | ✅ ativo |
| **Modelo Codex (fallback)** | `gpt-5.4-mini` |
| **Timeout Codex** | 30 s |
| **Timeout job FULL máx** | 60 min |
| **Menção obrigatória** | ❌ (responde a tudo) |
| **Mensagem "Processando..."** | ✅ ativo |
| **Terminal Linux** | ✅ ativo |
| **Salvar mídia automático** | ✅ ativo |
| **Tamanho máx mídia** | 20 MB |
| **Retenção mídia** | 30 dias |
| **Nome no relay** | `Italo Teixeira` |
| **Mensagem fallback** | "Estou com lentidão para responder agora..." |

---

## 🔐 Permissões por Nível

| Nível | Comandos disponíveis |
|---|---|
| **Autorizado** | IA geral, agenda, lembretes, notas, busca, imagem, despesas, relay, histórico, migdia |
| **Admin** | Tudo do autorizado + moderação, controle de grupo, ACL, configurações do bot, terminal, ops |
| **Full** | Tudo do admin + Modo FULL (desenvolvimento autônomo) |
| **Privado** | Acessa o bot via chat privado (1:1) |

---

## 📁 Arquivos de Estado

| Arquivo | Conteúdo |
|---|---|
| `data/access-control.json` | Autorizados, admins, full, privado, grupos de resposta |
| `data/identities.json` | Aliases e IDs de contatos aprendidos |
| `data/moderation.json` | Palavras proibidas, avisos por membro, configurações |
| `data/bot.sqlite` | Agenda e notas (SQLite + WAL) |
| `data/conversas/` | Histórico diário por grupo |
| `data/media-index.json` | Índice de arquivos de mídia |
| `data/midias/` | Arquivos físicos salvos |
| `data/bot-settings.json` | Configuração dinâmica atual |
| `data/bot-settings-audit.jsonl` | Auditoria de mudanças de configuração |
| `data/reminders.json` | Lembretes agendados |
| `data/scheduled-messages.json` | Mensagens programadas (bom dia, etc.) |
| `data/group-config.json` | Configuração específica por grupo |
| `data/agenda.json` | Agenda (SQLite como fonte principal) |
| `data/despesas/` | Registros de despesas por grupo |
| `data/relay-chats.json` | Relays ativos e histórico |
| `data/alarms.json` | Alarmes agendados |
| `data/imagens/` | Imagens geradas por IA |
| `data/group-databases/` | Bancos SQLite por grupo |

---

## 🔌 APIs do Painel Web

O painel em `http://localhost:8787` expõe endpoints REST:

| Endpoint | Método | Descrição |
|---|---|---|
| `/api/settings` | GET/PUT | Configurações dinâmicas |
| `/api/settings/audit` | GET | Histórico de mudanças |
| `/api/settings/rollback/:id` | POST | Reverter configuração |
| `/api/access-control` | GET | Listar controle de acesso |
| `/api/access-control/authorized` | POST/DELETE | Gerenciar autorizados |
| `/api/access-control/full` | POST/DELETE | Gerenciar full |
| `/api/access-control/admins` | POST/DELETE | Gerenciar admins |
| `/api/response-routing/groups` | POST/DELETE | Multi-grupo |
| `/api/response-routing/private` | POST/DELETE | Acesso privado |
| `/api/media` | GET | Listar mídias |
| `/api/media/:id/download` | GET | Baixar mídia |
| `/api/media/:id/protect` | POST | Proteger mídia |
| `/api/media/:id` | DELETE | Remover mídia |
| `/api/media/cleanup` | POST | Limpar mídias expiradas |
| `/api/moderation` | GET/PUT | Moderação |
| `/api/moderation/keywords` | POST/DELETE | Palavras proibidas |
| `/api/moderation/warnings/reset` | POST | Resetar avisos |
| `/api/group/control` | GET | Status do grupo |
| `/api/group/control/action` | POST | Ações no grupo |
| `/api/ai-providers` | GET | Provedores de IA detectados |
| `/api/ai-providers/test` | POST | Testar provedor (`mode: normal/full`, `model` opcional) |
| `/api/ai-providers/activate` | POST | Ativar provedor |
| `/bot-config-menu.html` | GET | Menu visual de configuração (protegido por login do painel) |
| `/api/full-jobs` | GET | Listar jobs FULL |
| `/events` | GET (SSE) | Stream de logs em tempo real |
