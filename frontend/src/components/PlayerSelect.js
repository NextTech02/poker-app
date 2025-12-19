import React, { useEffect, useState } from 'react';
import api from '../config/api';
import './PlayerSelect.css';

const PlayerSelect = ({ value, onChange, required = false, name = "player_id" }) => {
  const [players, setPlayers] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadPlayers();
  }, []);

  const loadPlayers = async () => {
    try {
      const response = await api.get('/players');
      setPlayers(response.data);
    } catch (error) {
      console.error('Erro ao carregar jogadores:', error);
    } finally {
      setLoading(false);
    }
  };

  return (
    <select
      name={name}
      value={value}
      onChange={onChange}
      required={required}
      className="player-select"
      disabled={loading}
    >
      <option value="">
        {loading ? 'Carregando jogadores...' : 'Selecione um jogador'}
      </option>
      {players.map((player) => (
        <option key={player.id} value={player.id}>
          {player.name}{player.nickname ? ` (${player.nickname})` : ''}
        </option>
      ))}
    </select>
  );
};

export default PlayerSelect;
