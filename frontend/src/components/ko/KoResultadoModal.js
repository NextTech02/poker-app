import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import api from '../../config/api';
import { useCurrency } from '../../contexts/CurrencyContext';
import { useEscapeKey } from '../../hooks/useEscapeKey';
import { abatimentosDePremios, buscarDividas } from '../../utils/fiado';
import { imprimirBilheteKo } from './bilheteKo';
import './Ko.css';

/**
 * Depois da eliminação num torneio KO: o que ela gerou e o pagamento NA HORA.
 *
 * O KO já está registrado — fechar este quadro não perde nada: o pagamento
 * fica pendente na aba KO da Premiação. "Pagar agora" desconta do caixa geral
 * (precisa de saldo, ou seja, de sangria feita).
 */
const KoResultadoModal = ({ tournamentId, knockout, torneioNome, assentoDoJogador = () => null, onFechar, onPago }) => {
  const { t, i18n } = useTranslation();
  const { formatCurrency = (v) => String(v) } = useCurrency() || {};
  const [pagos, setPagos] = useState(() => new Set((knockout?.payouts || []).filter((p) => p.paid).map((p) => p.id)));
  const [pagando, setPagando] = useState(null);
  const [erro, setErro] = useState('');
  // FIADO do eliminador: quem deve recebe o líquido (conta única do jogador).
  const [dividas, setDividas] = useState({});
  useEscapeKey(!pagando, onFechar);

  const eliminadores = (knockout?.payouts || []).map((p) => p.eliminator_player_id).join(',');
  useEffect(() => {
    let vivo = true;
    buscarDividas(eliminadores.split(',')).then((d) => { if (vivo) setDividas(d); });
    return () => { vivo = false; };
  }, [eliminadores]);

  if (!knockout) return null;
  const payouts = knockout.payouts || [];
  const mystery = knockout.format === 'mystery';
  // Sorteio físico: ainda não há valor — só o comprovante para trocar.
  const comprovante = !!knockout.envelope_pending;
  const abatimentos = abatimentosDePremios(payouts.filter((p) => !pagos.has(p.id)), dividas);

  const pagar = async (p) => {
    setPagando(p.id);
    setErro('');
    try {
      const abate = abatimentos[p.id];
      await api.post(
        `/tournaments/${tournamentId}/knockouts/payouts/${p.id}/pay`,
        abate !== undefined ? { debt_offset_amount: abate } : {},
      );
      setPagos((atual) => new Set(atual).add(p.id));
      if (abate) {
        setDividas((d) => ({ ...d, [p.eliminator_player_id]: Math.max(Number(d[p.eliminator_player_id] || 0) - abate, 0) }));
      }
      if (onPago) onPago(p);
    } catch (err) {
      setErro(err.userMessage || t('ko.payError', 'Não foi possível pagar o prêmio.'));
    } finally {
      setPagando(null);
    }
  };

  const imprimir = (p) => imprimirBilheteKo({
    jogador: p.eliminator_name,
    ...(assentoDoJogador(p.eliminator_player_id) || {}),
    comprovante,
    valor: Number(p.cash_amount),
    vitima: knockout.eliminated_name,
    formato: knockout.format,
    torneio: torneioNome,
    idioma: i18n?.language,
    formatarValor: formatCurrency,
  });

  return (
    <div className="ko-overlay" role="presentation" onClick={(e) => { if (e.target === e.currentTarget && !pagando) onFechar(); }}>
      <div className="ko-modal" role="dialog" aria-modal="true" aria-labelledby="ko-res-titulo">
        <div className="ko-modal-header">
          <h3 id="ko-res-titulo">
            {comprovante ? t('ko.voucherTitle', 'Comprovante Mystery')
              : mystery ? t('ko.envelopeDrawnTitle', 'Envelope sorteado') : t('ko.registeredTitle', 'KO registrado')}
          </h3>
          <button type="button" className="ko-close" onClick={onFechar} disabled={!!pagando} aria-label={t('common.close', 'Fechar')}>✕</button>
        </div>
        <p className="ko-hint">
          {t('ko.victimLine', { name: knockout.eliminated_name || '—', defaultValue: `Eliminado: ${knockout.eliminated_name || '—'}` })}
          {!comprovante && ' · '}
          {comprovante ? null : mystery
            ? t('ko.envelopeValue', { value: formatCurrency(Number(knockout.bounty_value)), defaultValue: `Envelope: ${formatCurrency(Number(knockout.bounty_value))}` })
            : t('ko.bountyValue', { value: formatCurrency(Number(knockout.bounty_value)), defaultValue: `Bounty: ${formatCurrency(Number(knockout.bounty_value))}` })}
        </p>

        {comprovante ? (
          <>
            <p className="ko-hint">{t('ko.voucherHint', 'Entregue o comprovante: o jogador troca por um envelope no ponto de troca, e o staff registra o valor na aba Mystery.')}</p>
            <ul className="ko-payouts">
              {payouts.map((p) => (
                <li key={p.id} className="ko-payout">
                  <div className="ko-payout-info"><strong>{p.eliminator_name || '—'}</strong></div>
                  <div className="ko-payout-acoes">
                    <button type="button" className="ko-btn-secondary" onClick={() => imprimir(p)}>
                      {t('ko.printVoucher', 'Imprimir comprovante')}
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          </>
        ) : payouts.length === 0 ? (
          <p className="ko-sem-pagamento">{t('ko.keptForChampion', 'Sem eliminador: o valor fica guardado para o campeão.')}</p>
        ) : (
          <ul className="ko-payouts">
            {payouts.map((p) => {
              const pago = pagos.has(p.id);
              return (
                <li key={p.id} className="ko-payout">
                  <div className="ko-payout-info">
                    <strong>{p.eliminator_name || '—'}</strong>
                    <span className="ko-payout-valor">{formatCurrency(Number(p.cash_amount))}</span>
                    {Number(p.added_to_bounty) > 0 && (
                      <span className="ko-payout-soma">
                        {t('ko.addedToBounty', { value: formatCurrency(Number(p.added_to_bounty)), defaultValue: `+ ${formatCurrency(Number(p.added_to_bounty))} no bounty` })}
                      </span>
                    )}
                    {!pago && abatimentos[p.id] > 0 && (
                      <span className="ko-payout-soma">
                        {t('fiado.koOffset', 'Fiado: abate {{offset}} · paga {{net}}', {
                          offset: formatCurrency(abatimentos[p.id]),
                          net: formatCurrency(Math.max(Number(p.cash_amount) - abatimentos[p.id], 0)),
                        })}
                      </span>
                    )}
                  </div>
                  <div className="ko-payout-acoes">
                    <button type="button" className="ko-btn-secondary" onClick={() => imprimir(p)}>
                      {t('ko.printTicket', 'Imprimir bilhete')}
                    </button>
                    {pago ? (
                      <span className="ko-pago">{t('ko.paid', 'Pago')}</span>
                    ) : (
                      <button
                        type="button"
                        className="ko-btn-primary"
                        onClick={() => pagar(p)}
                        disabled={!!pagando || Number(p.cash_amount) <= 0}
                      >
                        {pagando === p.id ? t('ko.paying', 'Pagando…') : t('ko.payNow', 'Pagar agora')}
                      </button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}

        {erro && <div className="ko-erro" role="alert">{erro}</div>}

        <div className="ko-actions">
          <span className="ko-nota">
            {mystery
              ? t('ko.pendingNoteMystery', 'O que não for pago agora fica pendente na aba Mystery da Premiação.')
              : t('ko.pendingNote', 'O que não for pago agora fica pendente na aba KO da Premiação.')}
          </span>
          <button type="button" className="ko-btn-secondary" onClick={onFechar} disabled={!!pagando}>
            {t('common.close', 'Fechar')}
          </button>
        </div>
      </div>
    </div>
  );
};

export default KoResultadoModal;
