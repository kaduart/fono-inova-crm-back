# Ensaio de restauração de backup (dados fictícios)

`scripts/backup/validar-restauracao-ficticia.sh` repete os passos do `backup-noturno.yml` em dois MongoDB descartáveis (Docker, loopback):

1. cria dados fictícios na origem: 500 pacientes, 1.500 agendamentos (com Decimal128), 1.000 pagamentos (com acentos e emoji), `payment_operations` e `outbound_deliveries`, mais os índices;
2. `mongodump --archive --gzip`;
3. cifra e decifra com `gpg` AES256 e uma senha fictícia;
4. `mongorestore --stopOnError` num Mongo vazio;
5. compara origem e destino por coleção: contagem, sha256 do conteúdo em EJSON canônico e definição dos índices;
6. testa dois casos que precisam falhar: senha errada e arquivo truncado.

Resultado em 18/11/2026: as 5 coleções ficaram idênticas e os dois casos negativos foram recusados.

**O que isto prova:** que o procedimento (ferramentas, flags, cifra, restauração e conferência) funciona e detecta arquivo ruim.

**O que isto NÃO prova:** que o backup real de produção está bom. O job noturno falha por autenticação desde 02/11. Enquanto ele não gerar um arquivo, não há backup real para restaurar. A conferência do backup real exige rodar este mesmo passo 5 sobre um arquivo real, num banco descartável, com autorização do Kadu.
