export const PRICES = {
    avaliacaoInicial: 'R$ 200,00',
    sessaoAvulsa: 'R$ 200,00',
    pacoteMensal: 'R$ 160,00/sessão (~R$ 640/mês)',
    neuropsicologica: 'R$ 2.400,00 (10 sessões)',
    testeLinguinha: 'R$ 150,00',
};

export const FEATURES = { campanhaAvulsa200: true }; // toggle rápido
export function getSessaoAvulsa() {
    return FEATURES.campanhaAvulsa200 ? PRICES.sessaoAvulsaCampanha : PRICES.sessaoAvulsaDefault;
}