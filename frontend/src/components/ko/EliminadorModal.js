import React, { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useEscapeKey } from '../../hooks/useEscapeKey';
import './Ko.css';

/**
 * "Quem eliminou?" — a pergunta que transforma uma eliminação em prêmio KO.
 *
 * Quem está na MESMA mesa da vítima vem primeiro (é quase sempre um deles).
 * Mais de um marcado = pote dividido: o bounty é repartido em partes iguais.
 * "Sem eliminador" é para abandono ou desclassificação: o bounty fica guardado
 * e vai para o campeão no encerramento.
 *
 * `candidatos`: [{ id (tournament_player), nome, mesa }], já ordenados.
 */
const EliminadorModal = ({
  vitima, candidatos = [], formato, mesaDaVitima = null, enviando = false,
  titulo, textoConfirmar, inicial = [], onConfirmar, onFechar,
}) => {
  const { t } = useTranslation();
  const [marcados, setMarcados] = useState(() => new Set(inicial));
  const [semAutor, setSemAutor] = useState(false);
  const [busca, setBusca] = useState('');
  useEscapeKey(!enviando, onFechar);

  const visiveis = useMemo(() => {
    const termo = busca.trim().toLowerCase();
    if (!termo) return candidatos;
    return candidatos.filter((c) => String(c.nome || '').toLowerCase().includes(termo));
  }, [busca, candidatos]);

  const alternar = (id) => {
    setSemAutor(false);
    setMarcados((atual) => {
      const novo = new Set(atual);
      if (novo.has(id)) novo.delete(id); else novo.add(id);
      return novo;
    });
  };

  const pronto = semAutor || marcados.size > 0;
  const confirmar = () => {
    if (!pronto || enviando) return;
    onConfirmar({ eliminated_by: semAutor ? [] : Array.from(marcados), no_eliminator: semAutor });
  };

  let dica = t('ko.hintKo', 'Quem eliminou leva o bounty inteiro do jogador.');
  if (formato === 'pko') dica = t('ko.hintPko', 'Quem eliminou leva parte do bounty em dinheiro; o resto soma no bounty dele.');
  if (formato === 'mystery') dica = t('ko.hintMystery', 'Cada eliminação sorteia um envelope para quem eliminou.');

  return (
    <div className="ko-overlay" role="presentation" onClick={(e) => { if (e.target === e.currentTarget && !enviando) onFechar(); }}>
      <div className="ko-modal" role="dialog" aria-modal="true" aria-labelledby="ko-elim-titulo">
        <div className="ko-modal-header">
          <h3 id="ko-elim-titulo">{titulo || t('ko.whoEliminated', { name: vitima, defaultValue: `Quem eliminou ${vitima}?` })}</h3>
          <button type="button" className="ko-close" onClick={onFechar} disabled={enviando} aria-label={t('common.close', 'Fechar')}>✕</button>
        </div>
        <p className="ko-hint">{dica}</p>

        <input
          type="search"
          className="ko-search"
          value={busca}
          onChange={(e) => setBusca(e.target.value)}
          placeholder={t('ko.searchPlayer', 'Buscar jogador')}
          aria-label={t('ko.searchPlayer', 'Buscar jogador')}
        />

        <ul className="ko-candidatos" aria-label={t('ko.candidates', 'Jogadores')}>
          {visiveis.length === 0 && <li className="ko-vazio">{t('ko.noCandidates', 'Nenhum jogador encontrado.')}</li>}
          {visiveis.map((c) => {
            const mesmaMesa = mesaDaVitima != null && c.mesa === mesaDaVitima;
            return (
              <li key={c.id}>
                <label className={`ko-candidato ${marcados.has(c.id) ? 'marcado' : ''}`}>
                  <input
                    type="checkbox"
                    checked={marcados.has(c.id)}
                    onChange={() => alternar(c.id)}
                    disabled={enviando}
                  />
                  <span className="ko-candidato-nome">{c.nome}</span>
                  {c.mesa != null && (
                    <span className={`ko-candidato-mesa ${mesmaMesa ? 'mesma' : ''}`}>
                      {t('ko.tableShort', { number: c.mesa, defaultValue: `Mesa ${c.mesa}` })}
                    </span>
                  )}
                </label>
              </li>
            );
          })}
        </ul>

        {marcados.size > 1 && !semAutor && (
          <p className="ko-split">{t('ko.splitPot', { count: marcados.size, defaultValue: `Pote dividido entre ${marcados.size} jogadores.` })}</p>
        )}

        <label className="ko-sem-autor">
          <input
            type="checkbox"
            checked={semAutor}
            onChange={(e) => { setSemAutor(e.target.checked); if (e.target.checked) setMarcados(new Set()); }}
            disabled={enviando}
          />
          <span>
            {formato === 'mystery'
              ? t('ko.noEliminatorMystery', 'Sem eliminador (abandono ou desclassificação) — o envelope fica para o campeão')
              : t('ko.noEliminator', 'Sem eliminador (abandono ou desclassificação) — o bounty vai para o campeão')}
          </span>
        </label>

        <div className="ko-actions">
          <button type="button" className="ko-btn-secondary" onClick={onFechar} disabled={enviando}>
            {t('common.cancel', 'Cancelar')}
          </button>
          <button type="button" className="ko-btn-danger" onClick={confirmar} disabled={!pronto || enviando}>
            {enviando ? t('ko.saving', 'Gravando…') : (textoConfirmar || t('ko.confirmEliminate', 'Eliminar'))}
          </button>
        </div>
      </div>
    </div>
  );
};

export default EliminadorModal;
