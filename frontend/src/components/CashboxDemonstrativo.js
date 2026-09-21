import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import api from '../config/api';
import { useToast } from '../contexts/ToastContext';
import { useStage } from '../contexts/StageContext';
import Card from './Card';
import Button from './Button';
import EmptyState from './EmptyState';
import { SkeletonStatCard, SkeletonTableRow } from './SkeletonLoader';
import { useCurrency } from '../contexts/CurrencyContext';
import { aoMudarOCaixa } from '../utils/eventosDoCaixa';
import useRealtimeRefresh from '../hooks/useRealtimeRefresh';
import './CashboxDemonstrativo.css';
import { primeiroDiaDoMes, hojeLocal } from '../utils/datasLocais';

const firstOfMonth = () => primeiroDiaDoMes();
const today = () => hojeLocal();

// Perfil por âncora: o que as colunas "entradas"/"saídas" SOMAM e como se
// CHAMAM. A gaveta é a mesma infraestrutura nos três módulos, mas cada tela só
// pode falar do seu — "Entradas (jogo)" num turno de bar faz o conferente achar
// que o sistema misturou os módulos. Estreitar as colunas não quebra a conta
// (inicial + suprimento − retirada + entradas − saídas = esperado) porque a
// gaveta ancorada em turno/dia só recebe lançamentos do próprio módulo: buy-in
// e prêmio caem na gaveta da etapa, compra de fichas na do dia de cash.
const PERFIS = {
  etapa: {
    // Financeiro (por etapa): TODAS as entradas e saídas do ledger. O esperado
    // soma o ledger inteiro; se a tela mostrasse só o torneio, o conferente
    // veria um esperado que não bate com a soma das colunas — e é assim que um
    // relatório parece errado sem estar.
    entradas: (s) => (s.total_buy_ins || 0) + (s.total_rebuys || 0) + (s.total_addons || 0)
      + (s.total_cash_buy_ins || 0) + (s.total_bar_sales || 0),
    saidas: (s) => (s.total_prizes_paid || 0) + (s.total_cash_outs || 0) + (s.total_refunds || 0),
    grandEntradas: (d) => (d.grand_buy_ins || 0) + (d.grand_cash_buy_ins || 0) + (d.grand_bar_sales || 0),
    grandSaidas: (d) => (d.grand_prizes || 0) + (d.grand_cash_outs || 0) + (d.grand_refunds || 0),
    rotulos: {
      entradas: 'cashbox.entries',
      saidas: 'cashbox.outflows',
      totalEntradas: 'cashbox.totalEntries',
      totalSaidas: 'cashbox.totalOutflows',
      semSessoes: 'cashbox.noSessions',
      semSessoesDica: 'cashbox.noSessionsHint',
    },
  },
  bar: {
    entradas: (s) => s.total_bar_sales || 0,
    saidas: (s) => s.total_refunds || 0,
    grandEntradas: (d) => d.grand_bar_sales || 0,
    grandSaidas: (d) => d.grand_refunds || 0,
    rotulos: {
      entradas: 'cashbox.barSales',
      saidas: 'cashbox.barRefunds',
      totalEntradas: 'cashbox.barSalesTotal',
      totalSaidas: 'cashbox.barRefundsTotal',
      semSessoes: 'cashbox.noSessionsShift',
      semSessoesDica: 'cashbox.noSessionsShiftHint',
    },
  },
  cash: {
    entradas: (s) => s.total_cash_buy_ins || 0,
    saidas: (s) => (s.total_cash_outs || 0) + (s.total_refunds || 0),
    grandEntradas: (d) => d.grand_cash_buy_ins || 0,
    grandSaidas: (d) => (d.grand_cash_outs || 0) + (d.grand_refunds || 0),
    rotulos: {
      entradas: 'cash.turnover',
      saidas: 'cash.paid',
      totalEntradas: 'cash.turnover',
      totalSaidas: 'cash.paid',
      semSessoes: 'cashbox.noSessionsDay',
      semSessoesDica: 'cashbox.noSessionsDayHint',
    },
  },
};

/**
 * `anchor` (opcional): `{ barShiftId }` ou `{ cashDayId }` escopa o
 * demonstrativo a uma gaveta por turno/dia em vez da etapa do header — e muda
 * o que a tela diz (ver PERFIS). Com âncora não há filtro de período: o
 * recorte É o turno/dia.
 */
const CashboxDemonstrativo = ({ anchor = null }) => {
  const { t } = useTranslation();
  const { toast } = useToast();
  const { selectedStage } = useStage();
  const { formatCurrency } = useCurrency();
  const anchorParams = anchor?.barShiftId
    ? { bar_shift_id: anchor.barShiftId }
    : anchor?.cashDayId ? { cash_day_id: anchor.cashDayId } : {};
  const anchorKey = JSON.stringify(anchorParams);
  const perfil = PERFIS[anchor?.barShiftId ? 'bar' : anchor?.cashDayId ? 'cash' : 'etapa'];
  const ancorado = perfil !== PERFIS.etapa;
  // Sem âncora, trocar de etapa é trocar de relatório. Com âncora, a etapa do
  // header não entra na conta (o backend a ignora quando há turno/dia).
  const etapaRelevante = ancorado ? null : selectedStage?.id;

  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [staffOptions, setStaffOptions] = useState([]);
  const [filters, setFilters] = useState({
    start: firstOfMonth(),
    end: today(),
    staff_id: '',
  });

  // Lista de funcionários (derivada dos caixas da etapa) para o filtro.
  const loadStaff = useCallback(async () => {
    try {
      const res = await api.get('/cashboxes', { params: JSON.parse(anchorKey), _silentError: true });
      const seen = new Map();
      (res.data || []).forEach((cb) => {
        if (cb.staff_id && !seen.has(cb.staff_id)) {
          seen.set(cb.staff_id, cb.staff_name || cb.staff_email || cb.staff_id);
        }
      });
      setStaffOptions(Array.from(seen, ([id, name]) => ({ id, name })));
    } catch (_) {
      setStaffOptions([]);
    }
  }, [anchorKey]);

  // `silencioso`: recarga disparada por evento/realtime, não pelo usuário —
  // trocar cards e tabela por esqueleto a cada movimento da gaveta piscaria.
  const load = useCallback(async ({ silencioso = false } = {}) => {
    if (!silencioso) setLoading(true);
    try {
      const params = { ...JSON.parse(anchorKey) };
      // Com âncora, o período É o turno/dia. "Início do mês → hoje" por cima
      // dele escondia o turno da virada do mês — e todo turno antigo.
      if (!ancorado) {
        if (filters.start) params.date_from = `${filters.start}T00:00:00`;
        if (filters.end) params.date_to = `${filters.end}T23:59:59`;
        if (filters.staff_id) params.staff_id = filters.staff_id;
      }
      const res = await api.get('/cashboxes/demonstrativo', { params, _silentError: true });
      setData(res.data);
    } catch (err) {
      toast.error(err.userMessage || t('cashbox.demoError'));
      setData(null);
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filters, t, anchorKey, ancorado]);

  // Recarrega lista de funcionários ao trocar de etapa. Com âncora o filtro
  // não existe: a tabela já diz quem é quem, e o painel logo acima lista as
  // gavetas.
  useEffect(() => {
    if (ancorado) return;
    loadStaff();
  }, [loadStaff, etapaRelevante, ancorado]);

  // Carrega o relatório ao montar, ao trocar de etapa (reset implícito não, mas re-busca).
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [etapaRelevante, anchorKey]);

  // Na tela do turno não há botão "Gerar": quem mexe na gaveta é o painel logo
  // acima (abrir, fechar, suprir, retirar) — e ele avisa. Sem escutar, o
  // demonstrativo mostraria a gaveta de antes do movimento até um F5.
  useEffect(
    () => (ancorado ? aoMudarOCaixa(() => { load({ silencioso: true }); }) : undefined),
    [ancorado, load],
  );

  // O aviso acima só cobre este navegador. O barman abre e fecha a gaveta no
  // tablet dele: para isso, o mesmo canal que o CashboxBanner usa.
  useRealtimeRefresh({
    canal: `cashbox-demo-${anchor?.barShiftId || anchor?.cashDayId || 'sem-ancora'}`,
    tabelas: [{
      table: 'cashboxes',
      filter: anchor?.barShiftId
        ? `bar_shift_id=eq.${anchor.barShiftId}`
        : `cash_day_id=eq.${anchor?.cashDayId}`,
    }],
    aoMudar: () => load({ silencioso: true }),
    intervaloDeSeguranca: 60000,
    ativo: ancorado,
  });

  const sessions = data?.sessions || [];
  const grandEntradas = perfil.grandEntradas(data || {});
  const grandSaidas = perfil.grandSaidas(data || {});

  const diffClass = (d) => {
    if (d === null || d === undefined) return '';
    if (d === 0) return 'cb-demo__ok';
    return 'cb-demo__bad';
  };

  return (
    <div className="cb-demo">
      {/* Filtros */}
      {!ancorado && (
        <Card className="cb-demo__filters-card">
          <div className="cb-demo__filters">
            <div className="form-group">
              <label>{t('cashbox.periodStart')}</label>
              <input
                type="date"
                value={filters.start}
                onChange={(e) => setFilters((p) => ({ ...p, start: e.target.value }))}
              />
            </div>
            <div className="form-group">
              <label>{t('cashbox.periodEnd')}</label>
              <input
                type="date"
                value={filters.end}
                onChange={(e) => setFilters((p) => ({ ...p, end: e.target.value }))}
              />
            </div>
            <div className="form-group">
              <label>{t('cashbox.staff')}</label>
              <select
                value={filters.staff_id}
                onChange={(e) => setFilters((p) => ({ ...p, staff_id: e.target.value }))}
              >
                <option value="">{t('cashbox.allStaff')}</option>
                {staffOptions.map((s) => (
                  <option key={s.id} value={s.id}>{s.name}</option>
                ))}
              </select>
            </div>
            <div className="cb-demo__filter-actions">
              <Button onClick={() => load()}>{t('cashbox.generate')}</Button>
            </div>
          </div>
        </Card>
      )}

      {/* Totais */}
      <div className="stats-grid">
        {loading ? (
          <><SkeletonStatCard /><SkeletonStatCard /><SkeletonStatCard /><SkeletonStatCard /></>
        ) : data ? (
          <>
            <Card className="stat-card">
              <div className="stat-info">
                <h3>{formatCurrency(grandEntradas)}</h3>
                <p>{t(perfil.rotulos.totalEntradas)}</p>
              </div>
            </Card>
            <Card className="stat-card">
              <div className="stat-info">
                <h3>{formatCurrency(grandSaidas)}</h3>
                <p>{t(perfil.rotulos.totalSaidas)}</p>
              </div>
            </Card>
            <Card className="stat-card">
              <div className="stat-info">
                <h3>{formatCurrency(data.grand_expected)}</h3>
                <p>{t('cashbox.expectedTotal')}</p>
              </div>
            </Card>
            <Card className="stat-card">
              <div className="stat-info">
                <h3 className={diffClass(data.grand_difference)}>{formatCurrency(data.grand_difference)}</h3>
                <p>{t('cashbox.differenceTotal')}</p>
              </div>
            </Card>
          </>
        ) : null}
      </div>

      {/* Tabela de sessões */}
      <Card title={t('cashbox.demoTitle')}>
        {loading ? (
          <div className="table-container">
            <table className="transactions-table">
              <thead>
                <tr>
                  <th>{t('cashbox.staff')}</th><th>{t('cashbox.opening')}</th><th>{t('cashbox.closing')}</th>
                  <th>{t('cashbox.initialBalanceShort')}</th><th>{t('cashbox.supply')}</th><th>{t('cashbox.sangria')}</th>
                  <th>{t(perfil.rotulos.entradas)}</th><th>{t(perfil.rotulos.saidas)}</th>
                  <th>{t('cashbox.expectedShort')}</th><th>{t('cashbox.countedShort')}</th><th>{t('cashbox.difference')}</th>
                </tr>
              </thead>
              <tbody>
                <SkeletonTableRow cols={11} />
                <SkeletonTableRow cols={11} />
                <SkeletonTableRow cols={11} />
              </tbody>
            </table>
          </div>
        ) : sessions.length === 0 ? (
          <EmptyState
            icon={null}
            title={t(perfil.rotulos.semSessoes)}
            subtitle={t(perfil.rotulos.semSessoesDica)}
          />
        ) : (
          <div className="table-container">
            <table className="transactions-table cb-demo__table">
              <thead>
                <tr>
                  <th>{t('cashbox.staff')}</th>
                  <th>{t('cashbox.opening')}</th>
                  <th>{t('cashbox.closing')}</th>
                  <th className="amount">{t('cashbox.initialBalanceShort')}</th>
                  <th className="amount">{t('cashbox.supply')}</th>
                  <th className="amount">{t('cashbox.sangria')}</th>
                  <th className="amount">{t(perfil.rotulos.entradas)}</th>
                  <th className="amount">{t(perfil.rotulos.saidas)}</th>
                  <th className="amount">{t('cashbox.expectedShort')}</th>
                  <th className="amount">{t('cashbox.countedShort')}</th>
                  <th className="amount">{t('cashbox.difference')}</th>
                </tr>
              </thead>
              <tbody>
                {sessions.map((s) => (
                  <tr key={s.session_id}>
                    <td>{s.staff_name || '—'}</td>
                    <td>{new Date(s.opened_at).toLocaleString('pt-BR')}</td>
                    <td>
                      {s.is_open ? (
                        <span className="cb-demo__pill-open">{t('cashbox.statusOpen')}</span>
                      ) : s.closed_at ? (
                        new Date(s.closed_at).toLocaleString('pt-BR')
                      ) : '—'}
                    </td>
                    <td className="amount">{formatCurrency(s.initial_balance)}</td>
                    <td className="amount">{formatCurrency(s.total_supply)}</td>
                    <td className="amount">{formatCurrency(s.total_sangria)}</td>
                    <td className="amount">{formatCurrency(perfil.entradas(s))}</td>
                    <td className="amount">{formatCurrency(perfil.saidas(s))}</td>
                    <td className="amount">{formatCurrency(s.expected_balance)}</td>
                    <td className="amount">
                      {s.actual_balance === null || s.actual_balance === undefined
                        ? '—'
                        : formatCurrency(s.actual_balance)}
                    </td>
                    <td className={`amount ${diffClass(s.difference)}`}>
                      {s.difference === null || s.difference === undefined ? '—' : formatCurrency(s.difference)}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="cb-demo__totals-row">
                  <td colSpan={3}>{t('cashbox.total')}</td>
                  <td className="amount">{formatCurrency(data.grand_initial)}</td>
                  <td className="amount">{formatCurrency(data.grand_supply)}</td>
                  <td className="amount">{formatCurrency(data.grand_sangria)}</td>
                  <td className="amount">{formatCurrency(grandEntradas)}</td>
                  <td className="amount">{formatCurrency(grandSaidas)}</td>
                  <td className="amount">{formatCurrency(data.grand_expected)}</td>
                  <td className="amount">{formatCurrency(data.grand_actual)}</td>
                  <td className={`amount ${diffClass(data.grand_difference)}`}>{formatCurrency(data.grand_difference)}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
};

export default CashboxDemonstrativo;
