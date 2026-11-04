import React, { useDeferredValue, useEffect, useMemo, useState, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useListaDeJogadores, MAX_OPCOES } from '../hooks/useListaDeJogadores';
import './PlayerMultiSelect.css';

/**
 * Seleção de VÁRIOS jogadores (busca por digitação + fichas removíveis).
 *
 * Componente separado do <PlayerSelect> de propósito: aquele é usado em meia
 * dúzia de telas com o contrato de evento sintético `{target:{name,value}}`, e
 * enfiar um modo múltiplo nele arriscaria quebrar o caixa e a premiação por
 * causa de uma tela só.
 *
 * A lista de escolhidos fica SEMPRE visível: emitir vaga em lote é dinheiro
 * saindo, e o operador precisa conferir nome por nome antes de confirmar.
 */
const PlayerMultiSelect = ({ values = [], onChange, disabled = false }) => {
  const { t } = useTranslation();
  // Mesma lista em memória do <PlayerSelect> (ver useListaDeJogadores).
  const { players, loading } = useListaDeJogadores();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const wrapRef = useRef(null);

  useEffect(() => {
    const handler = (e) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const norm = (s) => (s || '').toString().toLowerCase();
  // Apelido entre parênteses só quando existe; montado fora do template para
  // não aninhar literais.
  const apelido = (p) => (p.nickname ? ` (${p.nickname})` : '');
  const label = (p) => `${p.name}${apelido(p)}`;

  // A busca filtra com um passo de atraso: o campo responde à tecla na hora.
  const q = norm(useDeferredValue(query)).trim();
  // Memoizado pela busca: sem isso a lista era refiltrada a cada render do
  // componente, e nao apenas quando o texto digitado muda.
  const encontrados = useMemo(
    () =>
      q
        ? players.filter((p) => norm(p.name).includes(q) || norm(p.nickname).includes(q))
        : players,
    [players, q],
  );
  // Só os primeiros MAX_OPCOES viram linha; o resto, digitando.
  const filtered = encontrados.slice(0, MAX_OPCOES);
  const restantes = encontrados.length - filtered.length;

  // Indice por id, montado uma vez por lista de jogadores.
  //
  // Antes, cada jogador escolhido disparava um `players.find()` -- uma varredura
  // completa do cadastro. Com 800 jogadores e 20 escolhidos isso dava 16 mil
  // comparacoes, refeitas a cada tecla digitada na busca.
  const porId = useMemo(() => new Map(players.map((p) => [p.id, p])), [players]);

  const escolhidos = useMemo(
    () => values.map((id) => porId.get(id) || { id, name: id }),
    [values, porId],
  );

  // Set para o teste de "ja selecionado" que roda uma vez POR LINHA da lista.
  const selecionados = useMemo(() => new Set(values), [values]);

  const alternar = (id) => {
    if (disabled) return;
    onChange(values.includes(id) ? values.filter((v) => v !== id) : [...values, id]);
  };

  return (
    <div className="pms-wrap" ref={wrapRef}>
      {escolhidos.length > 0 && (
        <ul className="pms-chips">
          {escolhidos.map((p) => (
            <li key={p.id} className="pms-chip">
              <span>{label(p)}</span>
              <button
                type="button"
                className="pms-chip-remove"
                aria-label={t('satelliteTickets.bulkRemovePlayer', 'Remover jogador')}
                onClick={() => alternar(p.id)}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}

      <input
        type="text"
        className="pms-input"
        value={query}
        placeholder={loading
          ? t('common.loading', 'Carregando...')
          : t('cashRegister.searchPlayer', 'Buscar jogador...')}
        onFocus={() => setOpen(true)}
        onChange={(e) => { setQuery(e.target.value); setOpen(true); }}
        disabled={loading || disabled}
        autoComplete="off"
        aria-label={t('satelliteTickets.bulkSearchPlayers', 'Buscar jogadores')}
      />

      {open && (
        <ul className="pms-list" role="listbox" aria-multiselectable="true">
          {filtered.length === 0 ? (
            <li className="pms-empty">{t('players.noResults', 'Nenhum jogador encontrado')}</li>
          ) : (
            filtered.map((p) => {
              const marcado = selecionados.has(p.id);
              return (
                <li
                  key={p.id}
                  role="option"
                  aria-selected={marcado}
                  className={`pms-option ${marcado ? 'selected' : ''}`}
                  onMouseDown={() => alternar(p.id)}
                >
                  <span className="pms-check">{marcado ? '✓' : ''}</span>
                  {label(p)}
                </li>
              );
            })
          )}
          {restantes > 0 && (
            <li className="pms-empty" role="presentation">
              {t('players.keepTyping', 'Mais {{count}} jogadores — continue digitando', { count: restantes })}
            </li>
          )}
        </ul>
      )}
    </div>
  );
};

export default PlayerMultiSelect;
