# Respostas a avaliações sem IA paga

Implementação por regras locais, sem rede, banco, modelos de IA ou efeitos de publicação. Não exige worker. Não gera cobrança de IA; operações HTTP/Google do Make continuam sujeitas ao plano contratado e a hospedagem do CRM mantém seu custo normal.

## Publicação e configuração pendentes

1. Desativar o cenário atual até substituir a IA e validar. Não executar Run once no fluxo antigo.
2. Publicar a alteração do backend pelo procedimento habitual. Este trabalho não fez commit, push ou deploy.
3. Configurar GMB_REVIEW_REPLY_TOKEN no backend: segredo aleatório exclusivo, mínimo 32 caracteres. Não usar JWT de usuário. Sem segredo, endpoint retorna 503. Não colocar segredo na URL, código ou relatórios.
4. No Make, substituir Make AI Toolkit por HTTP > Make a request, entre Watch Reviews e Create/Update a Review Reply.
5. POST https://fono-inova-crm-back.onrender.com/api/gmb/reviews/reply. Content-Type application/json. Header x-gmb-review-token com o segredo em conexão segura do Make.
6. Corpo JSON estruturado com reviewId = Watch Reviews / Name, comment = Watch Reviews / Comment (vazio quando ausente), starRating = Watch Reviews / Star Rating, existingReply = Watch Reviews / Review Reply / Comment (vazio quando ausente). Usar serialização JSON do módulo, nunca concatenar comentários no JSON bruto.
7. Parse response habilitado. Filtro antes da publicação: data.eligible igual a true E data.reply não vazio. Reply comment = data.reply; Review name continua Watch Reviews / Name. Erros HTTP devem interromper, sem fallback para resposta automática.
8. Preservar filtro original de 4/5 estrelas sem resposta e intervalo de 60 minutos. Avaliações negativas, comentários com ressalvas e respostas existentes não são publicados pelo novo gerador. eligible=false deve seguir para revisão manual. Não marcar como respondido nem descartar a avaliação na revisão.
9. Validar primeiro somente o módulo HTTP com textos fictícios, sem executar o publicador. Depois ativar e conferir uma execução elegível no History. As respostas antigas não são editadas.

## Contrato

Resposta: { success: true, data: { eligible, reply, reason, mode: 'rules', aiCost: 0 } }.
reason: already_replied, manual_review_rating ou manual_review_comment. Entrada inválida retorna 400; token incorreto 401. Limite: 60 requisições autenticadas/minuto/IP.

Reconhece acolhimento, equipe e ambiente. Variação determinística por ID evita mudar a resposta numa repetição. Não lê prontuários, não ecoa nomes ou texto clínico. Não equivale à compreensão livre de uma IA; frases de temas iguais podem repetir e críticas implícitas podem exigir revisão humana. Sem cadastro de avaliações e sem alteração das respostas publicadas.

Teste: node --test tests/unit/gmbReviewReplies.test.mjs (sem MongoDB, Redis, workers ou chamadas de IA).
