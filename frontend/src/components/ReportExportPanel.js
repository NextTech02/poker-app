import React, { useState, useCallback, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import api from '../config/api';
import { useToast } from '../contexts/ToastContext';
import { useCurrency } from '../contexts/CurrencyContext';
import { exportSections } from '../utils/reportExport';
import './ReportExportPanel.css';

// Painel "Exportar" da aba Relatórios.
// Monta as seções a partir dos dados já na tela (summary) + busca sob demanda
// o financeiro detalhado (/reports/financial) e, se pedido, a premiação por
// torneio (/reports/tournament/{id}). Gera CSV / Excel / PDF via reportExport.

const FORMATS = [
  { id: 'xlsx', ext: '.xlsx' },
  { id: 'csv', ext: '.csv' },
  { id: 'pdf', ext: '.pdf' },
];

// Seções disponíveis. `needsFinancial` = depende de /reports/financial.
const SECTION_DEFS = [
  { id: 'summary', needsFinancial: false },
  { id: 'financial', needsFinancial: true },
  { id: 'players', needsFinancial: false },
  { id: 'tournaments', needsFinancial: true },
  { id: 'transactions', needsFinancial: true },
  { id: 'prizes', needsFinancial: true, needsTournaments: true },
  // Lançamentos da etapa: vêm dos próprios endpoints, não do /reports/financial.
  { id: 'expenses', needsExpenses: true },
  { id: 'revenues', needsRevenues: true },
];

const typeLabelMap = (t) => ({
  buy_in: t('reports.buyIns', 'Buy-ins'),
  rebuy: t('reports.rebuys', 'Rebuys'),
  addon: t('reports.addons', 'Add-ons'),
  fee: t('reports.fees', 'Taxas'),
  prize: t('financial.typePrize', 'Prêmio'),
});

const ReportExportPanel = ({ summary, dateRange }) => {
  const { t } = useTranslation();
  const { toast } = useToast();
  const { formatCurrency } = useCurrency();

  const [open, setOpen] = useState(false);
  const [format, setFormat] = useState('xlsx');
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState({
    summary: true,
    financial: true,
    players: true,
    tournaments: true,
    transactions: true,
    prizes: true,
    expenses: true,
    revenues: true,
  });

  // Acessibilidade: o fundo escuro fecha no clique, mas quem usa só o teclado
  // precisa do Esc para sair do modal.
  useEffect(() => {
    if (!open) return undefined;
    const onKeyDown = (ev) => {
      if (ev.key === 'Escape' && !busy) setOpen(false);
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open, busy]);

  const toggle = (id) => setSelected((s) => ({ ...s, [id]: !s[id] }));

  const secTitle = (id) => t(`reports.export.sec_${id}`, {
    summary: 'Resumo geral',
    financial: 'Financeiro (DRE)',
    players: 'Jogadores',
    tournaments: 'Torneios',
    transactions: 'Transações',
    prizes: 'Premiação',
    expenses: 'Despesas',
    revenues: 'Outras receitas',
  }[id]);

  const buildSections = useCallback((financial, prizesByTournament, expenses, revenues) => {
    const sections = [];
    const s = summary || {};
    const categorias = typeLabelMap(t);
    // Meios de entrada cadastrados pelo diretor ("Buy-in", "Doble", "Tasa"…).
    const meios = (s.byBuyType || []).map((b) => b.name).filter(Boolean);

    if (selected.summary) {
      const totalBuyIns = s.totalBuyIns || 0;
      const rebuyRate = totalBuyIns
        ? ((s.totalRebuys + s.totalAddons) / totalBuyIns) * 100
        : 0;
      sections.push({
        kind: 'keyvalue',
        title: secTitle('summary'),
        keyLabel: t('reports.export.metric', 'Métrica'),
        valueLabel: t('reports.export.value', 'Valor'),
        rows: [
          { label: t('reports.period', 'Período'), value: `${dateRange.start} — ${dateRange.end}`, type: 'text' },
          { label: t('reports.totalRevenue', 'Receita Total'), value: s.totalRevenue, type: 'currency' },
          { label: t('reports.totalTournaments', 'Total de Torneios'), value: s.totalTournaments, type: 'int' },
          { label: t('reports.totalEntries', 'Total de Entradas'), value: s.totalPlayers, type: 'int' },
          { label: t('reports.avgTicket', 'Ticket Médio'), value: s.avgBuyIn, type: 'currency' },
          { label: t('cashRegister.totalBuyIns', 'Total Buy-ins'), value: s.totalBuyIns, type: 'int' },
          { label: t('cashRegister.totalRebuys', 'Total Rebuys'), value: s.totalRebuys, type: 'int' },
          { label: t('cashRegister.totalAddons', 'Total Add-ons'), value: s.totalAddons, type: 'int' },
          { label: t('reports.totalFees', 'Total Taxas'), value: s.totalFees || 0, type: 'int' },
          { label: t('reports.rebuyRate', 'Taxa de Rebuy/Add-on'), value: rebuyRate, type: 'percent' },
        ],
      });
    }

    // Vendas do período por MEIO de entrada — a Tasa, o Doble e cada item
    // cobrado, com quantidade e valor. Antes só saía junto de "Jogadores".
    if ((selected.summary || selected.players) && meios.length > 0) {
      sections.push({
        kind: 'table',
        title: t('reports.byBuyType', 'Por meio de entrada'),
        columns: [
          { key: 'name', label: t('reports.buyType', 'Meio'), type: 'text' },
          { key: 'category', label: t('reports.buyTypeCategory', 'Categoria'), type: 'text' },
          { key: 'count', label: t('reports.buyTypeCount', 'Quantidade'), type: 'int' },
          { key: 'amount', label: t('reports.buyTypeAmount', 'Valor'), type: 'currency' },
        ],
        rows: (s.byBuyType || []).map((b) => ({ ...b, category: categorias[b.category] || b.category })),
      });
    }

    if (selected.financial && financial) {
      const rev = financial.revenue || {};
      sections.push({
        kind: 'keyvalue',
        title: secTitle('financial'),
        keyLabel: t('reports.export.metric', 'Métrica'),
        valueLabel: t('reports.export.value', 'Valor'),
        rows: [
          { label: t('financial.revenueBuyIns', 'Receita Buy-ins'), value: rev.buy_ins, type: 'currency' },
          { label: t('financial.revenueRebuys', 'Receita Rebuys'), value: rev.rebuys, type: 'currency' },
          { label: t('financial.revenueAddons', 'Receita Add-ons'), value: rev.addons, type: 'currency' },
          { label: t('financial.dreFees', 'Taxas'), value: rev.fees || 0, type: 'currency' },
          { label: t('financial.grossRevenue', 'Receita Bruta'), value: financial.gross_revenue, type: 'currency' },
          { label: t('financial.ticketsRedeemed', 'Tickets Resgatados'), value: financial.tickets_redeemed_value, type: 'currency' },
          { label: t('financial.prizes', 'Prêmios'), value: financial.prizes, type: 'currency' },
          { label: t('financial.operationalResult', 'Resultado Operacional'), value: financial.operational_result, type: 'currency' },
          { label: t('financial.rake', 'Rake'), value: financial.rake, type: 'currency' },
          { label: t('financial.netResult', 'Resultado Líquido'), value: financial.net_result, type: 'currency' },
          { label: t('financial.pendingCredits', 'Créditos Pendentes'), value: financial.pending_credits, type: 'currency' },
          { label: t('financial.availableTickets', 'Tickets Disponíveis'), value: financial.available_tickets, type: 'int' },
        ],
      });
    }

    if (selected.players) {
      // Com meios cadastrados pelo diretor, uma coluna por MEIO (o que ele
      // vê na tela); sem (backend antigo), as três categorias fixas.
      const colunasPorMeio = meios.length > 0
        ? meios.map((nome) => ({ key: `meio:${nome}`, label: nome, type: 'int' }))
        : [
          { key: 'buy_ins', label: t('reports.buyIns', 'Buy-ins'), type: 'int' },
          { key: 'rebuys', label: t('reports.rebuys', 'Rebuys'), type: 'int' },
          { key: 'addons', label: t('reports.addons', 'Add-ons'), type: 'int' },
        ];
      sections.push({
        kind: 'table',
        title: secTitle('players'),
        columns: [
          { key: 'player_name', label: t('players.columnPlayer', 'Jogador'), type: 'text' },
          { key: 'total_entries', label: t('reports.totalEntries', 'Entradas'), type: 'int' },
          ...colunasPorMeio,
          { key: 'total_spent', label: t('cashRegister.totalGeneral', 'Total Gasto'), type: 'currency' },
        ],
        rows: (s.playerReports || []).map((p) => ({
          ...p,
          ...Object.fromEntries(meios.map((nome) => [`meio:${nome}`, p.by_buy_type?.[nome] ?? 0])),
        })),
      });
    }

    if (selected.tournaments && financial) {
      sections.push({
        kind: 'table',
        title: secTitle('tournaments'),
        columns: [
          { key: 'tournament_name', label: t('financial.tournament', 'Torneio'), type: 'text' },
          { key: 'players', label: t('tournamentReport.players', 'Jogadores'), type: 'int' },
          { key: 'buy_ins_count', label: t('reports.buyIns', 'Buy-ins'), type: 'int' },
          { key: 'rebuys_count', label: t('reports.rebuys', 'Rebuys'), type: 'int' },
          { key: 'addons_count', label: t('reports.addons', 'Add-ons'), type: 'int' },
          { key: 'fees_count', label: t('reports.fees', 'Taxas'), type: 'int' },
          { key: 'revenue', label: t('tournamentReport.revenue', 'Receita'), type: 'currency' },
          { key: 'prizes', label: t('financial.prizes', 'Prêmios'), type: 'currency' },
          { key: 'net', label: t('financial.net', 'Líquido'), type: 'currency' },
        ],
        rows: financial.by_tournament || [],
      });

      // Cada torneio aberto por meio de entrada: uma linha por (torneio, meio).
      const porMeio = (financial.by_tournament || []).flatMap((bt) => (bt.by_buy_type || []).map((m) => ({
        tournament_name: bt.tournament_name,
        name: m.name,
        category: categorias[m.category] || m.category,
        count: m.count,
        amount: m.amount,
      })));
      if (porMeio.length > 0) {
        sections.push({
          kind: 'table',
          title: t('reports.export.sec_tournamentsByBuyType', 'Torneios por meio de entrada'),
          columns: [
            { key: 'tournament_name', label: t('financial.tournament', 'Torneio'), type: 'text' },
            { key: 'name', label: t('reports.buyType', 'Meio'), type: 'text' },
            { key: 'category', label: t('reports.buyTypeCategory', 'Categoria'), type: 'text' },
            { key: 'count', label: t('reports.buyTypeCount', 'Quantidade'), type: 'int' },
            { key: 'amount', label: t('reports.buyTypeAmount', 'Valor'), type: 'currency' },
          ],
          rows: porMeio,
        });
      }
    }

    if (selected.transactions && financial) {
      sections.push({
        kind: 'table',
        title: secTitle('transactions'),
        columns: [
          { key: 'created_at', label: t('common.date', 'Data'), type: 'date' },
          { key: 'tournament_name', label: t('financial.tournament', 'Torneio'), type: 'text' },
          { key: 'player_name', label: t('players.columnPlayer', 'Jogador'), type: 'text' },
          { key: 'type', label: t('financial.type', 'Tipo'), type: 'text' },
          { key: 'description', label: t('financial.colDescription', 'Descrição'), type: 'text' },
          { key: 'payment_method', label: t('financial.paymentMethod', 'Forma de Pgto'), type: 'text' },
          { key: 'amount', label: t('financial.amount', 'Valor'), type: 'currency' },
        ],
        rows: (financial.transactions || []).map((tx) => ({
          ...tx,
          // Taxa (Bono Dealer, Tasa) é gravada como add-on com a marca is_fee.
          type: tx.type === 'addon' && tx.is_fee ? categorias.fee : (categorias[tx.type] || tx.type),
          // O que foi vendido, como o clube chama ("Doble", "Bono Dealer").
          description: tx.buy_type_name
            || (tx.type === 'prize' && tx.prize_kind === 'knockout'
              ? t('financial.descKnockout', 'Prêmio por eliminação (KO)') : '—'),
          payment_method: tx.payment_method || tx.payment_source || '—',
        })),
      });
    }

    if (selected.expenses && expenses && expenses.length) {
      sections.push({
        kind: 'table',
        title: secTitle('expenses'),
        columns: [
          { key: 'created_at', label: t('common.date', 'Data'), type: 'date' },
          { key: 'description', label: t('expenses.colDescription', 'Descrição'), type: 'text' },
          { key: 'category_name', label: t('expenses.colCategory', 'Categoria'), type: 'text' },
          { key: 'stage_name', label: t('expenses.colStage', 'Etapa'), type: 'text' },
          { key: 'supplier', label: t('expenses.colSupplier', 'Fornecedor'), type: 'text' },
          { key: 'status', label: t('common.status', 'Status'), type: 'text' },
          { key: 'amount', label: t('expenses.colAmount', 'Valor'), type: 'currency' },
        ],
        rows: expenses.map((e) => ({
          ...e,
          status: e.status === 'pago'
            ? t('expenses.statusPaid', 'Pago')
            : t('expenses.statusPending', 'A pagar'),
        })),
      });
    }

    if (selected.revenues && revenues && revenues.length) {
      sections.push({
        kind: 'table',
        title: secTitle('revenues'),
        columns: [
          { key: 'created_at', label: t('common.date', 'Data'), type: 'date' },
          { key: 'description', label: t('expenses.colDescription', 'Descrição'), type: 'text' },
          { key: 'source', label: t('revenues.colSource', 'Origem'), type: 'text' },
          { key: 'stage_name', label: t('expenses.colStage', 'Etapa'), type: 'text' },
          { key: 'status', label: t('common.status', 'Status'), type: 'text' },
          { key: 'amount', label: t('expenses.colAmount', 'Valor'), type: 'currency' },
        ],
        rows: revenues.map((r) => ({
          ...r,
          status: r.status === 'recebido'
            ? t('revenues.statusReceived', 'Recebido')
            : t('revenues.statusPending', 'A receber'),
        })),
      });
    }

    if (selected.prizes && prizesByTournament && prizesByTournament.length) {
      sections.push({
        kind: 'table',
        title: secTitle('prizes'),
        columns: [
          { key: 'tournament_name', label: t('financial.tournament', 'Torneio'), type: 'text' },
          { key: 'position', label: t('tournamentReport.position', 'Posição'), type: 'int' },
          { key: 'prize_type', label: t('tournamentReport.type', 'Tipo'), type: 'text' },
          { key: 'player_name', label: t('tournamentReport.player', 'Jogador'), type: 'text' },
          { key: 'prize_amount', label: t('tournamentReport.amount', 'Valor'), type: 'currency' },
          { key: 'released', label: t('tournamentReport.released', 'Liberado'), type: 'text' },
          { key: 'paid', label: t('tournamentReport.paid', 'Pago'), type: 'text' },
        ],
        rows: prizesByTournament,
      });
    }

    return sections;
  }, [summary, selected, dateRange, t]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleExport = async () => {
    const chosen = SECTION_DEFS.filter((d) => selected[d.id]);
    if (!chosen.length) {
      toast.error(t('reports.export.noneSelected', 'Selecione pelo menos uma seção'));
      return;
    }
    setBusy(true);
    try {
      // Busca o financeiro só se alguma seção precisar.
      let financial = null;
      if (chosen.some((d) => d.needsFinancial)) {
        const res = await api.get('/reports/financial', { params: dateRange });
        financial = res.data;
      }

      // Premiação: 1 chamada por torneio do período (resiliente a falhas).
      let prizesByTournament = [];
      if (selected.prizes && financial && (financial.by_tournament || []).length) {
        const results = await Promise.allSettled(
          financial.by_tournament.map((bt) =>
            api.get(`/reports/tournament/${bt.tournament_id}`).then((r) => ({ bt, data: r.data }))
          )
        );
        results.forEach((r) => {
          if (r.status !== 'fulfilled') return;
          const { bt, data } = r.value;
          (data.prizes || []).forEach((p) => {
            prizesByTournament.push({
              tournament_name: bt.tournament_name,
              position: p.position,
              prize_type: p.prize_type === 'vaga'
                ? t('tournamentReport.seatPrize', 'Vaga')
                : t('tournamentReport.cashPrize', 'Dinheiro'),
              player_name: p.player_name || '—',
              prize_amount: p.prize_amount,
              released: p.released ? '✓' : '—',
              paid: p.paid ? '✓' : '—',
            });
          });
        });
      }

      // Lançamentos da etapa: buscados só quando a seção está marcada.
      let expenses = [];
      let revenues = [];
      if (chosen.some((d) => d.needsExpenses)) {
        expenses = (await api.get('/expenses', { params: dateRange }).catch(() => ({ data: [] }))).data || [];
      }
      if (chosen.some((d) => d.needsRevenues)) {
        revenues = (await api.get('/revenues', { params: dateRange }).catch(() => ({ data: [] }))).data || [];
      }

      const sections = buildSections(financial, prizesByTournament, expenses, revenues);
      const filename = `relatorio_${dateRange.start}_a_${dateRange.end}`;
      await exportSections(sections, {
        format,
        filename,
        formatCurrency,
        meta: {
          title: t('reports.export.docTitle', 'Relatório de Torneios'),
          subtitle: `${t('reports.period', 'Período')}: ${dateRange.start} — ${dateRange.end}`,
          footer: t('reports.export.docTitle', 'Relatório de Torneios'),
          brandRgb: [114, 51, 248],
        },
      });

      toast.success(t('reports.export.success', 'Relatório exportado'));
      setOpen(false);
    } catch (err) {
      const msg = err?.message === 'no-sections'
        ? t('reports.export.noneSelected', 'Selecione pelo menos uma seção')
        : t('reports.export.error', 'Falha ao exportar. Tente novamente.');
      toast.error(msg);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rex-wrap">
      <button className="rex-trigger" onClick={() => setOpen(true)} type="button">
        <svg viewBox="0 0 24 24" fill="currentColor" width="18" height="18">
          <path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z" />
        </svg>
        {t('reports.export.button', 'Exportar')}
      </button>

      {open && (
        <div
          className="rex-overlay"
          role="presentation"
          onClick={(e) => { if (e.target === e.currentTarget && !busy) setOpen(false); }}
        >
          <div className="rex-modal" role="dialog" aria-modal="true">
            <div className="rex-head">
              <div>
                <h3>{t('reports.export.title', 'Exportar relatórios')}</h3>
                <p>{t('reports.export.subtitle', 'Escolha o formato e o que incluir na análise')}</p>
              </div>
              <button className="rex-close" onClick={() => !busy && setOpen(false)} aria-label={t('common.close', 'Fechar')} type="button">×</button>
            </div>

            <div className="rex-body">
              <div className="rex-field">
                <label className="rex-label">{t('reports.export.format', 'Formato')}</label>
                <div className="rex-formats">
                  {FORMATS.map((f) => (
                    <button
                      key={f.id}
                      type="button"
                      className={`rex-format ${format === f.id ? 'active' : ''}`}
                      onClick={() => setFormat(f.id)}
                    >
                      <span className="rex-format-name">{t(`reports.export.fmt_${f.id}`, f.id.toUpperCase())}</span>
                      <span className="rex-format-ext">{f.ext}</span>
                    </button>
                  ))}
                </div>
                <p className="rex-hint">
                  {format === 'xlsx' && t('reports.export.hintXlsx', 'Uma planilha com várias abas — ideal para análise em Excel, Sheets ou Power BI.')}
                  {format === 'csv' && t('reports.export.hintCsv', 'Arquivo único com todas as seções empilhadas (UTF-8).')}
                  {format === 'pdf' && t('reports.export.hintPdf', 'Documento formatado com a marca — para apresentação/impressão.')}
                </p>
              </div>

              <div className="rex-field">
                <label className="rex-label">{t('reports.export.include', 'Incluir no arquivo')}</label>
                <div className="rex-sections">
                  {SECTION_DEFS.map((d) => (
                    <label key={d.id} className={`rex-check ${selected[d.id] ? 'on' : ''}`}>
                      <input type="checkbox" checked={!!selected[d.id]} onChange={() => toggle(d.id)} />
                      <span>{secTitle(d.id)}</span>
                    </label>
                  ))}
                </div>
              </div>
            </div>

            <div className="rex-foot">
              <button className="rex-btn ghost" onClick={() => !busy && setOpen(false)} type="button" disabled={busy}>
                {t('common.cancel', 'Cancelar')}
              </button>
              <button className="rex-btn primary" onClick={handleExport} type="button" disabled={busy}>
                {busy ? t('reports.export.gathering', 'Preparando…') : t('reports.export.run', 'Exportar')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default ReportExportPanel;
