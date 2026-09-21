// utils/websiteLeadPayload.js
// Extrai nome/telefone/e-mail do corpo de POST /api/leads/from-website.
//
// Dois formatos são aceitos:
//  - "dadosPessoais" (contrato original do endpoint): { dadosPessoais: { nome, telefone, email } }
//  - "flat" (o que o site envia): { nome, telefone, email } no topo do body
// Se os dois vierem, `dadosPessoais` tem precedência (desde que traga nome E telefone).
// Nada aqui tem relação com a lista de interesse de convênios.

export function extractWebsiteLeadPersonalData(body) {
    const data = body && typeof body === 'object' ? body : {};

    const structured = data.dadosPessoais;
    if (structured?.nome && structured?.telefone) {
        return {
            nome: structured.nome,
            telefone: structured.telefone,
            email: structured.email || null,
            format: 'dadosPessoais',
        };
    }

    if (data.nome && data.telefone) {
        return {
            nome: data.nome,
            telefone: data.telefone,
            email: data.email || null,
            format: 'flat',
        };
    }

    return null;
}

export default extractWebsiteLeadPersonalData;
