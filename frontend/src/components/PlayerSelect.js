import React, { useEffect, useState, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import api from '../config/api';
import './PlayerSelect.css';

/**
 * Searchable player picker (typeahead). Keeps the same interface as the old
 * <select> — `onChange` is called with a synthetic event
 * `{ target: { name, value: playerId } }` so existing form handlers keep working.
 */
const PlayerSelect = ({ value, onChange, required = false, name = 'player_id' }) => {
  const { t } = useTranslation();
  const [players, setPlayers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [highlight, setHighlight] = useState(0);
  const wrapRef = useRef(null);
  // Ids estaveis para ligar o input (combobox) a lista e a opcao destacada,
  // para o leitor de tela anunciar que a lista abriu e qual jogador esta ativo.
  const idRef = useRef(`player-select-${Math.random().toString(36).slice(2, 9)}`);
  const listId = `${idRef.current}-list`;
  const optionId = (i) => `${idRef.current}-opt-${i}`;

  useEffect(() => {
    loadPlayers();
  }, []);

  // Close dropdown on outside click
  useEffect(() => {
    const handler = (e) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const loadPlayers = async () => {
    try {
      const response = await api.get('/players');
      setPlayers(response.data || []);
    } catch (error) {
      console.error('Erro ao carregar jogadores:', error);
    } finally {
      setLoading(false);
    }
  };

  const norm = (s) => (s || '').toString().toLowerCase();
  const label = (p) => `${p.name}${p.nickname ? ` (${p.nickname})` : ''}`;

  const selected = players.find((p) => p.id === value);
  const q = norm(query).trim();
  const filtered = q
    ? players.filter((p) => norm(p.name).includes(q) || norm(p.nickname).includes(q))
    : players;

  const pick = (id) => {
    onChange({ target: { name, value: id } });
    setOpen(false);
    setQuery('');
  };

  const onKeyDown = (e) => {
    if (!open && (e.key === 'ArrowDown' || e.key === 'Enter')) {
      setOpen(true);
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHighlight((h) => Math.min(h + 1, filtered.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlight((h) => Math.max(h - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (filtered[highlight]) pick(filtered[highlight].id);
    } else if (e.key === 'Escape') {
      setOpen(false);
    }
  };

  const placeholder = loading
    ? t('common.loading', 'Carregando...')
    : t('cashRegister.searchPlayer', 'Buscar jogador...');

  return (
    <div className="player-select-wrap" ref={wrapRef}>
      <input
        type="text"
        className="player-select-input"
        value={open ? query : (selected ? label(selected) : '')}
        placeholder={placeholder}
        onFocus={() => { setOpen(true); setQuery(''); setHighlight(0); }}
        onChange={(e) => { setQuery(e.target.value); setOpen(true); setHighlight(0); }}
        onKeyDown={onKeyDown}
        disabled={loading}
        autoComplete="off"
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={open}
        aria-controls={listId}
        aria-activedescendant={open && filtered[highlight] ? optionId(highlight) : undefined}
        aria-required={required}
      />
      <span className="player-select-caret">▾</span>
      {open && (
        <ul className="player-select-list" role="listbox" id={listId}>
          {filtered.length === 0 ? (
            <li className="player-select-empty">{t('players.noResults', 'Nenhum jogador encontrado')}</li>
          ) : (
            filtered.map((p, i) => (
              <li
                key={p.id}
                id={optionId(i)}
                role="option"
                aria-selected={p.id === value}
                className={`player-select-option ${p.id === value ? 'selected' : ''} ${i === highlight ? 'active' : ''}`}
                onMouseDown={() => pick(p.id)}
                onMouseEnter={() => setHighlight(i)}
              >
                {label(p)}
              </li>
            ))
          )}
        </ul>
      )}
    </div>
  );
};

export default PlayerSelect;
