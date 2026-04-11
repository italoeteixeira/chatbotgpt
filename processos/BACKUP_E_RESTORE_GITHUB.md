# Backup e Restauração no GitHub (Projeto chatbot)

## 1) Estado atual configurado
- Repositório Git inicializado localmente.
- Remote `origin` configurado para `https://github.com/italoeteixeira/chatbot.git`.
- Workflow de backup diário criado em `.github/workflows/backup.yml`.
- Script local de backup diário criado em `scripts/git-backup-daily.sh`.

## 2) Segredos necessários no GitHub Actions
No repositório `italoeteixeira/chatbot`, configurar em **Settings > Secrets and variables > Actions**:

- `BACKUP_TOKEN`: token com permissão de push no repositório de backup.
- `BACKUP_REPO`: no formato `usuario/repositorio-backup`.
  - Exemplo: `italoeteixeira/chatbot-backup`

## 3) Backup diário automático
- O workflow `Daily Backup` executa todo dia às 02:00 UTC e também manualmente via `workflow_dispatch`.
- Ele espelha branches e tags para o repositório informado em `BACKUP_REPO`.

## 4) Backup diário manual (local)
```bash
cd /home/italo/Área\ de\ trabalho/chatbot
./scripts/git-backup-daily.sh
```

## 5) Restauração rápida
```bash
git clone https://github.com/italoeteixeira/chatbot.git
cd chatbot
git log --oneline
git checkout <hash_commit>
```

## 6) Observação de segurança
- Nunca versionar `.env`, sessão WhatsApp (`.wwebjs_auth`) e base local (`data/`).
- Se token tiver sido exposto, revogar e gerar outro imediatamente.

