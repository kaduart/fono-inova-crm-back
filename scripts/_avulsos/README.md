# Scripts avulsos (movidos da raiz do back em 01/11/2026)

Consultas, auditorias e diagnósticos pontuais que estavam soltos na raiz do back.
Nenhum é usado pelo servidor, pelos workers ou pelo package.json. Foram só movidos, nada foi apagado.

Rodar sempre a partir da pasta `back` (o `dotenv` lê o `.env` da pasta atual):

    node scripts/_avulsos/<arquivo>.mjs

Atenção: vários leem `MONGO_URI` do `.env`. Confira para qual banco ele aponta antes de rodar,
e nunca rode script que grava (ex.: migrate-liminar-financial.mjs com DRY_RUN=false) em produção
sem autorização explícita.
