import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import PlayerSelect from '../PlayerSelect';
import Button from '../Button';
import { useEscapeKey } from '../../hooks/useEscapeKey';
import { JOGADORES_POR_EQUIPE } from '../../utils/equipes';
import './Equipes.css';

/**
 * Cadastro (e edição) de uma equipe: nome, os 4 integrantes NA ORDEM do
 * revezamento da final e quem é o capitão. Integrante que já caiu na Fase 1
 * não pode sair — o servidor recusa com o motivo.
 */
const EquipeFormModal = ({ equipe, onSalvar, onFechar, ocupado = false, erro = '' }) => {
  const { t } = useTranslation();
  useEscapeKey(!ocupado, onFechar);
  const iniciais = (equipe?.members || []).map((m) => m.player_id);
  const [nome, setNome] = useState(equipe?.name || '');
  const [jogadores, setJogadores] = useState(
    Array.from({ length: JOGADORES_POR_EQUIPE }, (_, i) => iniciais[i] || ''),
  );
  const [capitao, setCapitao] = useState(equipe?.captain_player_id || '');
  const [erroLocal, setErroLocal] = useState('');

  const trocar = (indice, valor) => {
    setErroLocal('');
    setJogadores((atual) => atual.map((p, i) => (i === indice ? valor : p)));
  };

  const enviar = (e) => {
    e.preventDefault();
    const escolhidos = jogadores.filter(Boolean);
    if (!nome.trim()) {
      setErroLocal(t('teams.nameRequired', 'Dê um nome à equipe.'));
      return;
    }
    if (!escolhidos.length) {
      setErroLocal(t('teams.membersRequired', 'Escolha os integrantes da equipe.'));
      return;
    }
    if (new Set(escolhidos).size !== escolhidos.length) {
      setErroLocal(t('errors.integrante_repetido', 'O mesmo jogador aparece duas vezes na equipe.'));
      return;
    }
    const cap = escolhidos.includes(capitao) ? capitao : '';
    if (!cap) {
      setErroLocal(t('teams.captainRequired', 'Marque quem é o capitão.'));
      return;
    }
    onSalvar({ name: nome.trim(), captain_player_id: cap, player_ids: escolhidos });
  };

  const mensagem = erroLocal || erro;
  return (
    <div className="eq-overlay" role="presentation" onClick={(e) => { if (e.target === e.currentTarget && !ocupado) onFechar(); }}>
      <div
        className="eq-modal"
        role="dialog"
        aria-modal="true"
        aria-label={equipe ? t('teams.editTeam', 'Editar equipe') : t('teams.newTeam', 'Nova equipe')}
      >
        <div className="eq-modal-header">
          <h3>{equipe ? t('teams.editTeam', 'Editar equipe') : t('teams.newTeam', 'Nova equipe')}</h3>
          <button type="button" className="eq-close" onClick={onFechar} disabled={ocupado} aria-label={t('common.close', 'Fechar')}>✕</button>
        </div>
        <form onSubmit={enviar}>
          <div className="eq-field">
            <label htmlFor="eq-nome">{t('teams.teamName', 'Nome da equipe')}</label>
            <input id="eq-nome" value={nome} onChange={(e) => { setErroLocal(''); setNome(e.target.value); }} maxLength={80} disabled={ocupado} autoFocus />
          </div>
          <p className="eq-hint">
            {t('teams.membersHint', 'Os integrantes na ORDEM do revezamento da final (dá para mudar depois). Marque o capitão: ele desempata e representa a equipe na final.')}
          </p>
          {jogadores.map((valor, i) => (
            <div className="eq-member-row" key={i}>
              <span className="eq-member-order">{i + 1}</span>
              <div className="eq-member-select">
                <PlayerSelect name={`membro_${i}`} value={valor} onChange={(e) => trocar(i, e.target.value)} />
              </div>
              <label className="eq-captain">
                <input
                  type="radio"
                  name="capitao"
                  checked={!!valor && capitao === valor}
                  onChange={() => setCapitao(valor)}
                  disabled={!valor || ocupado}
                  aria-label={t('teams.captainOf', 'Capitão (integrante {{n}})', { n: i + 1 })}
                />
                {t('teams.captain', 'Capitão')}
              </label>
            </div>
          ))}
          {mensagem && <div className="eq-erro" role="alert">{mensagem}</div>}
          <div className="eq-modal-footer">
            <Button type="button" variant="secondary" onClick={onFechar} disabled={ocupado}>{t('common.cancel', 'Cancelar')}</Button>
            <Button type="submit" disabled={ocupado}>{t('common.save', 'Salvar')}</Button>
          </div>
        </form>
      </div>
    </div>
  );
};

export default EquipeFormModal;
