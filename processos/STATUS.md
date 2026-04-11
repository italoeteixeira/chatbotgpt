# Estado do Projeto — 2026-04-09

Mapa atualizado do que está implementado, em maturidade operacional, e o que
ainda é roadmap. Atualizar a cada entrega relevante.

---

## ✅ Já no produto (implementado e em produção)

### IA e roteamento
- Resposta por IA no grupo autorizado (Codex + Copilot, troca em tempo real)
- Fallback automático entre providers e entre modelos
- Multi-Grupo de Resposta (grupo principal + grupos extras)
- Modo silencioso (`modo silencioso` / `modo normal` / `status modo silencioso`)

### Histórico e resumos
- Histórico de conversa persistido por grupo (SQLite)
- Resumo do Dia / "o que perdi?" / resumo da semana (IA sobre histórico do grupo)

### Automações (modo FULL)
- Jobs FULL com fila, watchdog, auto-recuperação de travados
- Timeouts corretos: Copilot CLI 6min, job 90min, runtime 60min
- Jobs "running" obsoletos zerados no startup
- `startFullAutoJobDirect` acessível via painel

### Comunicação e relay
- Relay de mensagens privadas com wizard conversacional (`@ enviar mensagem`)
- Encaminhamento de respostas via quote no grupo

### Grupo e moderação
- Adicionar / remover / promover membros
- Avisos, remoção automática no limite de palavras proibidas
- ACL por níveis: autorizado, admin, full, privado
- Persistência em `data/access-control.json`

### Agenda, lembretes e notas
- Agenda nomeada, lembretes com recorrência, alarmes com soneca
- Notas / textos por grupo

### Mídia
- Ingestão automática, indexação com hash, proteção por senha
- Listagem, envio de mídias salvas, remoção pontual e em lote
- Transcrição de áudio automática no grupo

### Financeiro
- `@despesa` / `@despesas` por grupo com exportação CSV

### Operação Linux
- Exec de comandos por allowlist, ping diagnóstico, status de processo

### Painel web
- Login / sessão, tema escuro, SSE em tempo real
- Configurações com auditoria e rollback
- Gerenciamento de mídia, moderação, ACL, multi-grupo, processos FULL
- Tela dedicada `Config Bot` (`/bot-config-menu.html`) protegida por login, espelhando o menu de configuração do WhatsApp

### Operacional / base
- Backup automático diário de `data/` (`.tar.gz`, mantém 7 últimos)
- `fazer backup` / `listar backups` acionáveis manualmente
- Busca web e geração de imagem
- Idempotência de relatórios FULL (`_txtSentRegistry` persistido em disco)
- Configuração dinâmica com auditoria
- Menu interativo no chat para configuração (`@ configurar bot` / `@ bot configuracao`) com seções numeradas

---

## 🔶 Em operação consolidada (funciona, mas pode amadurecer)

- Comandos administrativos de grupo (maturidade de UX pode melhorar)
- Biblioteca de mídia (funcional, mas sem preview no painel)
- Configuração via WhatsApp (funciona, mas sem validação visual no painel)
- Logs e auditoria (existem, mas sem dashboard visual)

---

## 🔲 Roadmap — próximas entregas prioritárias

### Eixo A — Portal como centro de comando

| Item | Impacto | Notas |
|---|---|---|
| **Aba FULL Dev** | Alto | Lista de jobs, status, log, visualizador do `.txt` gerado, cancelamento |
| **Dashboard de observabilidade** | Alto | Métricas por grupo, alertas operacionais, uptime por provider |
| **Preview de mídia no painel** | Médio | Modal para imagem, player para vídeo/áudio |
| **Badge de conexão no header** | Médio | Status WhatsApp (conectado / reconectando / desconectado) em tempo real |
| **RBAC no painel** | Alto | Perfis: viewer / operator / admin |
| **Widget de ações rápidas** | Médio | Botões: ping, limpar cache, checar disco, reiniciar serviço |

### Eixo B — Inteligência do bot

| Item | Impacto | Notas |
|---|---|---|
| **Memória semântica** | Alto | Por usuário e grupo, com TTL, categorias, consulta e limpeza seletiva |
| **Relay com sugestão inteligente** | Médio | IA sugere resposta antes de encaminhar; grupo aprova |
| **Fluxos de confirmação** | Médio | "Confirma?" antes de ações sensíveis (config, Linux, FULL, grupo) |
| **Enquete rápida (`!votacao`)** | Baixo | Pergunta + opções, reações, apuração automática |
| **FULL agendado** | Médio | `@valida agendar para 22h: ...` para jobs recorrentes/agendados |
| **Inbox de incidentes** | Médio | "Houve erro hoje?", "Últimos warnings", alerta por padrão repetido |
| **Assistente privado** | Baixo | Continuar tarefas do grupo no privado |

### Eixo C — Base técnica

| Item | Impacto | Notas |
|---|---|---|
| **Migração gradual para SQLite** | Alto | `moderation.json`, `identities.json`, `alarms.json`, demais JSONs auxiliares |
| **Healthchecks detalhados** | Médio | Por provider, worker e fila; expor no dashboard |
| **Fila formal de ingestão de mídia** | Médio | Evitar perda em volumes altos |

---

## Conclusão estratégica

O projeto saiu da fase de prova de conceito. O motor está sólido.
O próximo salto é sobre três frentes:

1. **Portal como ferramenta de operação real** — não só visualização, mas ação
2. **Inteligência baseada em histórico** — memória semântica, resumos, incidentes
3. **Persistência e governança** — menos JSON espalhado, mais SQLite, RBAC
