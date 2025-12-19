import React, { useEffect, useState } from 'react';
import Sidebar from '../components/Sidebar';
import Card from '../components/Card';
import Button from '../components/Button';
import api from '../config/api';
import countries from '../data/countries';
import './Players.css';

const Players = () => {
  const [players, setPlayers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);
  const [editingPlayer, setEditingPlayer] = useState(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [formData, setFormData] = useState({
    name: '',
    email: '',
    phone: '',
    nationality: '',
    document_type: 'national_id',
    document_number: '',
    nickname: '',
    notes: '',
  });

  useEffect(() => {
    loadPlayers();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchTerm]);

  const loadPlayers = async () => {
    try {
      const params = searchTerm ? { search: searchTerm } : {};
      const response = await api.get('/players', { params });
      setPlayers(response.data);
    } catch (error) {
      console.error('Erro ao carregar jogadores:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    try {
      if (editingPlayer) {
        await api.patch(`/players/${editingPlayer.id}`, formData);
      } else {
        await api.post('/players', formData);
      }
      setShowModal(false);
      setEditingPlayer(null);
      setFormData({
        name: '',
        email: '',
        phone: '',
        nationality: '',
        document_type: 'national_id',
        document_number: '',
        nickname: '',
        notes: '',
      });
      loadPlayers();
    } catch (error) {
      console.error('Erro ao salvar jogador:', error);
      const errorMessage = error.response?.data?.detail || 'Erro ao salvar jogador';
      alert(errorMessage);
    }
  };

  const handleEdit = (player) => {
    setEditingPlayer(player);
    setFormData({
      name: player.name,
      email: player.email || '',
      phone: player.phone || '',
      nationality: player.nationality || '',
      document_type: player.document_type || 'national_id',
      document_number: player.document_number || '',
      nickname: player.nickname || '',
      notes: player.notes || '',
    });
    setShowModal(true);
  };

  const handleDelete = async (playerId) => {
    if (window.confirm('Tem certeza que deseja excluir este jogador?')) {
      try {
        await api.delete(`/players/${playerId}`);
        loadPlayers();
      } catch (error) {
        console.error('Erro ao excluir jogador:', error);
        alert('Erro ao excluir jogador. Ele pode estar vinculado a torneios.');
      }
    }
  };

  const handleChange = (e) => {
    setFormData({
      ...formData,
      [e.target.name]: e.target.value,
    });
  };

  const openNewModal = () => {
    setEditingPlayer(null);
    setFormData({
      name: '',
      email: '',
      phone: '',
      nationality: '',
      document_type: 'national_id',
      document_number: '',
      nickname: '',
      notes: '',
    });
    setShowModal(true);
  };

  return (
    <div className="app-container">
      <Sidebar />
      <main className="main-content">
        <div className="page-header">
          <div>
            <h1>Jogadores</h1>
            <p className="subtitle">Gerenciar cadastro de jogadores</p>
          </div>
          <Button onClick={openNewModal}>
            Novo Jogador
          </Button>
        </div>

        <Card>
          <div className="search-bar">
            <input
              type="text"
              placeholder="Buscar por nome ou apelido..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="search-input"
            />
          </div>
        </Card>

        {loading ? (
          <div className="loading">Carregando jogadores...</div>
        ) : players.length === 0 ? (
          <Card>
            <div className="empty-state">
              <p>Nenhum jogador encontrado</p>
              <Button onClick={openNewModal}>Cadastrar Primeiro Jogador</Button>
            </div>
          </Card>
        ) : (
          <Card title={`${players.length} Jogador(es)`}>
            <div className="table-container">
              <table className="players-table">
                <thead>
                  <tr>
                    <th>Nome</th>
                    <th>Apelido</th>
                    <th>Email</th>
                    <th>Telefone</th>
                    <th>Nacionalidade</th>
                    <th>Documento</th>
                    <th>Ações</th>
                  </tr>
                </thead>
                <tbody>
                  {players.map((player) => (
                    <tr key={player.id}>
                      <td className="player-name">{player.name}</td>
                      <td>{player.nickname || '-'}</td>
                      <td>{player.email}</td>
                      <td>{player.phone}</td>
                      <td>{player.nationality}</td>
                      <td>
                        {player.document_number}
                      </td>
                      <td>
                        <div className="action-buttons">
                          <button
                            className="btn-edit"
                            onClick={() => handleEdit(player)}
                            title="Editar"
                          >
                            Editar
                          </button>
                          <button
                            className="btn-delete"
                            onClick={() => handleDelete(player.id)}
                            title="Excluir"
                          >
                            Excluir
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        )}

        {showModal && (
          <div className="modal-overlay" onClick={() => setShowModal(false)}>
            <div className="modal" onClick={(e) => e.stopPropagation()}>
              <div className="modal-header">
                <h2>{editingPlayer ? 'Editar Jogador' : 'Novo Jogador'}</h2>
                <button className="close-btn" onClick={() => setShowModal(false)}>
                  ✕
                </button>
              </div>
              <form onSubmit={handleSubmit}>
                <div className="form-group">
                  <label htmlFor="name">Nome Completo *</label>
                  <input
                    id="name"
                    name="name"
                    type="text"
                    value={formData.name}
                    onChange={handleChange}
                    required
                    placeholder="Nome completo do jogador"
                  />
                </div>

                <div className="form-row">
                  <div className="form-group">
                    <label htmlFor="email">Email *</label>
                    <input
                      id="email"
                      name="email"
                      type="email"
                      value={formData.email}
                      onChange={handleChange}
                      required
                      placeholder="email@exemplo.com"
                    />
                  </div>

                  <div className="form-group">
                    <label htmlFor="phone">Telefone *</label>
                    <input
                      id="phone"
                      name="phone"
                      type="tel"
                      value={formData.phone}
                      onChange={handleChange}
                      required
                      placeholder="+55 (11) 99999-9999"
                    />
                  </div>
                </div>

                <div className="form-group">
                  <label htmlFor="nationality">Nacionalidade *</label>
                  <select
                    id="nationality"
                    name="nationality"
                    value={formData.nationality}
                    onChange={handleChange}
                    required
                  >
                    <option value="">Selecione o país</option>
                    {countries.map((country) => (
                      <option key={country} value={country}>
                        {country}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="form-row">
                  <div className="form-group">
                    <label htmlFor="document_type">Tipo de Documento *</label>
                    <select
                      id="document_type"
                      name="document_type"
                      value={formData.document_type}
                      onChange={handleChange}
                      required
                    >
                      <option value="national_id">Identidade Nacional</option>
                      <option value="passport">Passaporte</option>
                      <option value="driver_license">Carteira de Motorista</option>
                    </select>
                  </div>

                  <div className="form-group">
                    <label htmlFor="document_number">Número do Documento *</label>
                    <input
                      id="document_number"
                      name="document_number"
                      type="text"
                      value={formData.document_number}
                      onChange={handleChange}
                      required
                      placeholder="Número do documento"
                    />
                  </div>
                </div>

                <div className="form-group">
                  <label htmlFor="nickname">Apelido</label>
                  <input
                    id="nickname"
                    name="nickname"
                    type="text"
                    value={formData.nickname}
                    onChange={handleChange}
                    placeholder="Apelido ou nick (opcional)"
                  />
                </div>

                <div className="form-group">
                  <label htmlFor="notes">Observações</label>
                  <textarea
                    id="notes"
                    name="notes"
                    value={formData.notes}
                    onChange={handleChange}
                    rows="3"
                    placeholder="Observações sobre o jogador (opcional)..."
                  />
                </div>

                <div className="modal-actions">
                  <Button type="button" variant="secondary" onClick={() => setShowModal(false)}>
                    Cancelar
                  </Button>
                  <Button type="submit">
                    {editingPlayer ? 'Atualizar' : 'Cadastrar'}
                  </Button>
                </div>
              </form>
            </div>
          </div>
        )}
      </main>
    </div>
  );
};

export default Players;
