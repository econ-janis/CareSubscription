const TEXTS = {
  es: {
    subtitle: (date) => `Creadas en los últimos 3 meses · Corte: ${date}`,
    distribution: 'Distribución por estado',
    detail: 'Detalle por estado',
    status: 'Estado',
    total: 'Total',
    percent: '%',
    openTickets: 'Tickets abiertos',
    key: 'Clave',
    summary: 'Resumen',
    noTickets: 'No hay tickets en el período.',
    noOpenTickets: 'Sin tickets abiertos',
    donutCenter: 'Total',
    chartAlt: (total) => `Gráfico de distribución por estado: ${total} tickets`,
  },
  pt: {
    subtitle: (date) => `Criados nos últimos 3 meses · Corte: ${date}`,
    distribution: 'Distribuição por status',
    detail: 'Detalhe por status',
    status: 'Status',
    total: 'Total',
    percent: '%',
    openTickets: 'Tickets abertos',
    key: 'Chave',
    summary: 'Resumo',
    noTickets: 'Não há tickets no período.',
    noOpenTickets: 'Sem tickets abertos',
    donutCenter: 'Total',
    chartAlt: (total) => `Gráfico de distribuição por status: ${total} tickets`,
  },
};

function t(language) {
  return TEXTS[language] || TEXTS.es;
}

module.exports = { t, LANGUAGES: Object.keys(TEXTS) };
