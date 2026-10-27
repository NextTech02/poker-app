import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import api from '../config/api';
import Button from './Button';
import { useCurrency } from '../contexts/CurrencyContext';
import { useEscapeKey } from '../hooks/useEscapeKey';
import { isOnline } from '../offline/connectivity';
import { avisarQueOCaixaMudou } from '../utils/eventosDoCaixa';
import './ExcluirComVendasModal.css';

// Teto de rodadas: cada uma estorna por ~20 s no servidor. Bem acima de
// qualquer torneio real; existe só para um servidor que nunca termine não
// prender a tela num laço.
const MAX_RODADAS = 60;

/**
 * Excluir um torneio criado por engano JUNTO com as compras.
 *
 * O servidor passa cada venda pelo mesmo estorno do Caixa (gaveta, caixa da
 * etapa, contadores, fidelidade) e só então apaga o torneio. Ele trabalha em
 * RODADAS: esta tela chama de novo enquanto sobrar venda, mostrando o
 * progresso. Interromper no meio é seguro — o que foi estornado fica
 * estornado, e a próxima tentativa continua de onde parou.
 *
 * O nome digitado confere que é ESTE torneio; o motivo vai em cada estorno.
 * Os avisos do estorno (sangria já feita, caixa já fechado) são tarefas
 * manuais: ficam na tela até o admin dizer que leu.
 *
 * @param {object}   impacto   o de GET /tournaments/{id}/delete-impact
 * @param {function} onClose
 * @param {function} onChanged chamado quando algo mudou (para recarregar a lista)
 */
const ExcluirComVendasModal = ({ impacto, onClose, onChanged }) => {
  const { t } = useTranslation();
  const { formatCurrency } = useCurrency();
  const [motivo, setMotivo] = useState('');
  const [nome, setNome] = useState('');
  const [rodando, setRodando] = useState(false);
  const [progresso, setProgresso] = useState(null); // { estornadas, devolvido }
  const [erro, setErro] = useState('');
  const [avisos, setAvisos] = useState(null); // null = ainda não terminou

  useEscapeKey(!rodando && avisos === null, onClose);

  const nomeConfere = nome.trim().replace(/\s+/g, ' ').toLowerCase()
    === (impacto.tournament_name || '').trim().replace(/\s+/g, ' ').toLowerCase();
  const podeEnviar = !rodando && motivo.trim().length >= 3 && nomeConfere;

  const executar = async (e) => {
    e.preventDefault();
    if (!podeEnviar) return;
    if (!isOnline()) {
      setErro(t('tournaments.deleteWithSalesOnline', 'Estornar as vendas exige conexão.'));
      return;
    }
    setRodando(true);
    setErro('');
    let estornadas = 0;
    let devolvido = 0;
    const juntados = [];
    try {
      for (let rodada = 0; rodada < MAX_RODADAS; rodada += 1) {
        // eslint-disable-next-line no-await-in-loop -- uma rodada por vez: o servidor retoma de onde a anterior parou
        const { data } = await api.post(`/tournaments/${impacto.tournament_id}/cancel-sales-and-delete`, {
          reason: motivo.trim(),
          confirm_name: nome,
        });
        estornadas += data?.cancelled || 0;
        devolvido += data?.refunded_amount || 0;
        (data?.warnings || []).forEach((a) => { if (!juntados.includes(a)) juntados.push(a); });
        setProgresso({ estornadas, devolvido, restantes: data?.remaining || 0 });
        if (data?.deleted || !data?.remaining) break;
      }
      avisarQueOCaixaMudou();
      onChanged?.();
      setAvisos(juntados);
    } catch (err) {
      // O que já foi estornado continua estornado: a lista recarrega para
      // mostrar o estado real, e o modal fica aberto para tentar de novo.
      if (estornadas) {
        avisarQueOCaixaMudou();
        onChanged?.();
      }
      setErro(err.userMessage || err.response?.data?.detail?.message
        || t('tournaments.deleteWithSalesError', 'Não foi possível estornar as vendas e excluir o torneio.'));
    } finally {
      setRodando(false);
    }
  };

  if (avisos !== null) {
    return (
      <div className="modal-overlay">
        <div className="modal ecv" role="alertdialog" aria-labelledby="ecv-titulo">
          <div className="modal-header">
            <h2 id="ecv-titulo">{t('tournaments.deleteWithSalesDoneTitle', 'Torneio excluído')}</h2>
          </div>
          <div className="modal-body">
            <p>
              {t('tournaments.deleteWithSalesDone', '{{count}} venda(s) estornada(s), {{amount}} devolvido(s) aos jogadores, e o torneio "{{name}}" foi excluído.', {
                count: progresso?.estornadas || 0,
                amount: formatCurrency(progresso?.devolvido || 0),
                name: impacto.tournament_name,
              })}
            </p>
            {avisos.length > 0 && (
              <>
                <p className="ecv-alerta">
                  {t('tournaments.deleteWithSalesWarnings', 'O estorno não conseguiu acertar sozinho os itens abaixo. Resolva cada um antes de fechar a noite:')}
                </p>
                <ul className="ecv-avisos">
                  {avisos.map((a) => <li key={a}>{a}</li>)}
                </ul>
              </>
            )}
          </div>
          <div className="modal-actions">
            <Button type="button" onClick={onClose}>
              {avisos.length > 0
                ? t('cashRegister.cancelWarningsAck', 'Entendi, vou acertar')
                : t('common.close', 'Fechar')}
            </Button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="modal-overlay" role="presentation" onClick={(e) => { if (e.target === e.currentTarget && !rodando) onClose(); }}>
      <div className="modal ecv" role="dialog" aria-modal="true" aria-labelledby="ecv-titulo">
        <div className="modal-header">
          <h2 id="ecv-titulo">{t('tournaments.deleteWithSalesTitle', 'Excluir com todas as compras')}</h2>
        </div>
        <form onSubmit={executar}>
          <div className="modal-body">
            <p>
              {t('tournaments.deleteWithSalesIntro', 'O torneio "{{name}}" tem {{entries}} venda(s) somando {{amount}}. Para excluí-lo, cada venda será ESTORNADA como no Caixa: o dinheiro sai da gaveta de quem vendeu e do caixa da etapa e volta para o jogador. Depois o torneio e tudo o que é dele são apagados. Não há como desfazer.', {
                name: impacto.tournament_name,
                entries: impacto.entries || 0,
                amount: formatCurrency(impacto.entries_amount || 0),
              })}
            </p>
            <div className="form-group">
              <label htmlFor="ecv-motivo">{t('tournaments.deleteWithSalesReason', 'Motivo')}</label>
              <input
                id="ecv-motivo"
                type="text"
                value={motivo}
                onChange={(e) => setMotivo(e.target.value)}
                placeholder={t('tournaments.deleteWithSalesReasonPlaceholder', 'Ex.: torneio criado por engano')}
                disabled={rodando}
                autoFocus
              />
            </div>
            <div className="form-group">
              <label htmlFor="ecv-nome">
                {t('tournaments.deleteWithSalesConfirmName', 'Digite o nome do torneio para confirmar: {{name}}', { name: impacto.tournament_name })}
              </label>
              <input
                id="ecv-nome"
                type="text"
                value={nome}
                onChange={(e) => setNome(e.target.value)}
                autoComplete="off"
                disabled={rodando}
              />
            </div>
            {progresso && (
              <p className="ecv-progresso" role="status">
                {t('tournaments.deleteWithSalesProgress', '{{count}} venda(s) estornada(s) até agora ({{amount}}).', {
                  count: progresso.estornadas,
                  amount: formatCurrency(progresso.devolvido),
                })}
              </p>
            )}
            {erro && <p className="ecv-erro" role="alert">{erro}</p>}
          </div>
          <div className="modal-actions">
            <Button type="button" variant="secondary" onClick={onClose} disabled={rodando}>
              {t('common.cancel', 'Cancelar')}
            </Button>
            <Button type="submit" variant="danger" disabled={!podeEnviar}>
              {rodando
                ? t('tournaments.deleteWithSalesRunning', 'Estornando...')
                : t('tournaments.deleteWithSalesSubmit', 'Estornar tudo e excluir')}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
};

export default ExcluirComVendasModal;
