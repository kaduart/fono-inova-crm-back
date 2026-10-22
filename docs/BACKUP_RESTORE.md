# Backup e restauração do MongoDB de produção

Contexto: em 21/10/2026 o banco de produção foi apagado e o Atlas M0 (gratuito) não tem backup. Desde então:

- **Produção** fica num cluster M0 próprio (projeto "Producao" no Atlas). Só o Render tem o usuário de **escrita**.
- **Dev** fica no cluster antigo. Máquinas locais e IAs usam só o dev e, quando precisam de dado real, o usuário **somente leitura** de produção.
- **Backup**: `.github/workflows/backup-noturno.yml` roda todo dia às 03:00 (Brasília), faz `mongodump` com o usuário de leitura, criptografa (AES256) e guarda 14 dias como artifact do GitHub. O próprio job faz um **teste real de restauração** num MongoDB descartável do runner e falha se a contagem restaurada for diferente da do dump.

## Secrets do workflow

| Secret | Valor |
|---|---|
| `MONGO_BACKUP_URI` | URI do usuário **somente leitura** de produção, com o nome do banco |
| `BACKUP_PASSPHRASE` | senha da criptografia — guardar também fora do GitHub (sem ela o backup não abre) |

## Restaurar (sempre num banco NOVO, nunca por cima de produção)

1. GitHub → Actions → `backup-noturno` → execução desejada → baixar o artifact `mongo-prod-<data>`.
2. Descriptografar:
   ```bash
   gpg --batch --passphrase "<BACKUP_PASSPHRASE>" -d mongo-prod-<data>.archive.gz.gpg > restore.archive.gz
   ```
3. Restaurar num banco novo do cluster de **dev** para conferir (troque `<banco_origem>` pelo nome do banco de produção):
   ```bash
   mongorestore --uri "<URI_DEV>" --archive=restore.archive.gz --gzip \
     --nsFrom "<banco_origem>.*" --nsTo "restore_<data>.*"
   ```
4. Conferir contagens (patients, appointments, sessions, payments, packages) antes de qualquer decisão de usar o backup em produção.
5. Apagar `restore.archive.gz` ao terminar (dado de saúde — LGPD).

**Teste de restauração**: fazer os passos 1–4 logo após configurar o workflow e depois uma vez por mês. Backup que nunca foi restaurado não está validado.

## Trazer um paciente de produção para dev

```bash
node scripts/trazer-paciente-pra-dev.mjs --patient <id|telefone|nome>
```

Usa `PROD_URI_READONLY` (somente leitura) e grava no `MONGO_URI` local (dev). Mascara nome, CPF, telefone, e-mail e endereço por padrão. Ver o cabeçalho do script.
