import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import Sidebar from '../components/Sidebar';
import Button from '../components/Button';
import api from '../config/api';
import { useToast } from '../contexts/ToastContext';
import countries from '../data/countries';
import './Players.css';

const DOC_TYPE_LABELS = {
  national_id: 'Identidade',
  passport: 'Passaporte',
  driver_license: 'CNH',
};

const getInitials = (name = '') =>
  name.trim().split(/\s+/).slice(0, 2).map((w) => w[0]?.toUpperCase() || '').join('');


const EMPTY_FORM = {
  name: '', email: '', phone: '', nationality: '',
  document_type: 'national_id', document_number: '', nickname: '', notes: '',
};

const Players = () => {
  const { toast, confirm } = useToast();
  const { t } = useTranslation();
  const [players, setPlayers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);
  const [editingPlayer, setEditingPlayer] = useState(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [formData, setFormData] = useState(EMPTY_FORM);

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
        toast.success('Jogador atualizado com sucesso!');
      } else {
        await api.post('/players', formData);
        toast.success('Jogador cadastrado com sucesso!');
      }
      setShowModal(false);
      setEditingPlayer(null);
      setFormData(EMPTY_FORM);
      loadPlayers();
    } catch (error) {
      console.error('Erro ao salvar jogador:', error);
      const msg = error.response?.data?.detail || 'Erro ao salvar jogador';
      toast.error(typeof msg === 'string' ? msg : 'Erro ao salvar jogador');
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
    const ok = await confirm('Tem certeza que deseja excluir este jogador?', {
      variant: 'danger', confirmText: 'Excluir',
    });
    if (!ok) return;
    try {
      await api.delete(`/players/${playerId}`);
      loadPlayers();
    } catch {
      toast.error('Erro ao excluir jogador. Ele pode estar vinculado a torneios.');
    }
  };

  const handleChange = (e) =>
    setFormData({ ...formData, [e.target.name]: e.target.value });

  const openNewModal = () => {
    setEditingPlayer(null);
    setFormData(EMPTY_FORM);
    setShowModal(true);
  };

  return (
    <div className="app-layout">
      <Sidebar />
      <main className="main-content">

        {/* ── Page Header ── */}
        <div className="pl-header">
          <div className="pl-header-left">
            <div className="pl-header-icon">
              <svg viewBox="0 0 24 24" fill="currentColor">
                <path d="M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5c-1.66 0-3 1.34-3 3s1.34 3 3 3zm-8 0c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5C6.34 5 5 6.34 5 8s1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5c0-2.33-4.67-3.5-7-3.5zm8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.97 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5z"/>
              </svg>
            </div>
            <div>
              <h1 className="pl-title">Jogadores</h1>
              <p className="pl-subtitle">Gerencie o cadastro de jogadores</p>
            </div>
          </div>
          <button className="pl-btn-new" onClick={openNewModal}>
            <svg viewBox="0 0 24 24" fill="currentColor" width="18" height="18">
              <path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/>
            </svg>
            Novo Jogador
          </button>
        </div>

        {/* ── Search ── */}
        <div className="pl-search-wrap">
          <svg className="pl-search-icon" viewBox="0 0 24 24" fill="currentColor">
            <path d="M15.5 14h-.79l-.28-.27A6.471 6.471 0 0 0 16 9.5 6.5 6.5 0 1 0 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z"/>
          </svg>
          <input
            type="text"
            className="pl-search-input"
            placeholder="Buscar por nome, apelido ou email..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
          />
          {searchTerm && (
            <button className="pl-search-clear" onClick={() => setSearchTerm('')}>
              <svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16">
                <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/>
              </svg>
            </button>
          )}
        </div>

        {/* ── Content ── */}
        {loading ? (
          <div className="pl-loading">Carregando jogadores...</div>
        ) : players.length === 0 ? (
          <div className="pl-empty">
            <div className="pl-empty-icon">
              <svg viewBox="0 0 24 24" fill="currentColor">
                <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/>
              </svg>
            </div>
            <h3>{searchTerm ? 'Nenhum jogador encontrado' : 'Nenhum jogador cadastrado'}</h3>
            <p>{searchTerm ? `Nenhum resultado para "${searchTerm}"` : 'Comece cadastrando o primeiro jogador'}</p>
            {!searchTerm && (
              <button className="pl-btn-new" onClick={openNewModal}>
                <svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16">
                  <path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/>
                </svg>
                Cadastrar Jogador
              </button>
            )}
          </div>
        ) : (
          <div className="pl-table-card">
            <div className="pl-table-header">
              <span className="pl-table-count">
                <strong>{players.length}</strong> jogador{players.length !== 1 ? 'es' : ''}
                {searchTerm && <span className="pl-count-filter"> encontrados</span>}
              </span>
            </div>
            <div className="pl-table-wrap">
              <table className="pl-table">
                <thead>
                  <tr>
                    <th>Jogador</th>
                    <th>Contato</th>
                    <th>Nacionalidade</th>
                    <th>Documento</th>
                    <th className="pl-th-actions">Ações</th>
                  </tr>
                </thead>
                <tbody>
                  {players.map((player) => {
                    const initials = getInitials(player.name);
                    const docLabel = DOC_TYPE_LABELS[player.document_type] || player.document_type || '';
                    return (
                      <tr key={player.id} className="pl-row">
                        <td>
                          <div className="pl-player-cell">
                            <div className="pl-avatar">
                              {initials}
                            </div>
                            <div className="pl-player-info">
                              <span className="pl-player-name">{player.name}</span>
                              {player.nickname && (
                                <span className="pl-player-nick">@{player.nickname}</span>
                              )}
                            </div>
                          </div>
                        </td>
                        <td>
                          <div className="pl-contact-cell">
                            {player.email && (
                              <div className="pl-contact-line">
                                <svg viewBox="0 0 24 24" fill="currentColor" width="12" height="12">
                                  <path d="M20 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 4l-8 5-8-5V6l8 5 8-5v2z"/>
                                </svg>
                                {player.email}
                              </div>
                            )}
                            {player.phone && (
                              <div className="pl-contact-line">
                                <svg viewBox="0 0 24 24" fill="currentColor" width="12" height="12">
                                  <path d="M6.62 10.79c1.44 2.83 3.76 5.14 6.59 6.59l2.2-2.2c.27-.27.67-.36 1.02-.24 1.12.37 2.33.57 3.57.57.55 0 1 .45 1 1V20c0 .55-.45 1-1 1-9.39 0-17-7.61-17-17 0-.55.45-1 1-1h3.5c.55 0 1 .45 1 1 0 1.25.2 2.45.57 3.57.11.35.03.74-.25 1.02l-2.2 2.2z"/>
                                </svg>
                                {player.phone}
                              </div>
                            )}
                          </div>
                        </td>
                        <td>
                          <span className="pl-nationality">{player.nationality || '—'}</span>
                        </td>
                        <td>
                          {player.document_number ? (
                            <div className="pl-doc-cell">
                              <span className="pl-doc-type">{docLabel}</span>
                              <span className="pl-doc-number">{player.document_number}</span>
                            </div>
                          ) : (
                            <span className="pl-empty-val">—</span>
                          )}
                        </td>
                        <td>
                          <div className="pl-actions">
                            <button
                              className="pl-btn-icon pl-btn-edit"
                              onClick={() => handleEdit(player)}
                              title="Editar jogador"
                            >
                              <svg viewBox="0 0 24 24" fill="currentColor" width="15" height="15">
                                <path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/>
                              </svg>
                              Editar
                            </button>
                            <button
                              className="pl-btn-icon pl-btn-delete"
                              onClick={() => handleDelete(player.id)}
                              title="Excluir jogador"
                            >
                              <svg viewBox="0 0 24 24" fill="currentColor" width="15" height="15">
                                <path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/>
                              </svg>
                              Excluir
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* ── Modal ── */}
        {showModal && (
          <div className="pl-modal-overlay" onClick={() => setShowModal(false)}>
            <div className="pl-modal" onClick={(e) => e.stopPropagation()}>
              <div className="pl-modal-header">
                <div className="pl-modal-title-group">
                  <div className="pl-modal-icon">
                    <svg viewBox="0 0 24 24" fill="currentColor">
                      <path d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z"/>
                    </svg>
                  </div>
                  <h2>{editingPlayer ? 'Editar Jogador' : 'Novo Jogador'}</h2>
                </div>
                <button className="pl-modal-close" onClick={() => setShowModal(false)}>
                  <svg viewBox="0 0 24 24" fill="currentColor" width="20" height="20">
                    <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/>
                  </svg>
                </button>
              </div>

              <form onSubmit={handleSubmit} className="pl-modal-form">
                {/* Nome */}
                <div className="pl-field pl-field-full">
                  <label htmlFor="name">Nome Completo <span className="pl-required">*</span></label>
                  <input
                    id="name" name="name" type="text"
                    value={formData.name} onChange={handleChange}
                    required placeholder="Nome completo do jogador"
                  />
                </div>

                {/* Apelido */}
                <div className="pl-field pl-field-full">
                  <label htmlFor="nickname">Apelido / Nick</label>
                  <input
                    id="nickname" name="nickname" type="text"
                    value={formData.nickname} onChange={handleChange}
                    placeholder="Apelido ou nick (opcional)"
                  />
                </div>

                {/* Email + Telefone */}
                <div className="pl-field-row">
                  <div className="pl-field">
                    <label htmlFor="email">Email <span className="pl-required">*</span></label>
                    <input
                      id="email" name="email" type="email"
                      value={formData.email} onChange={handleChange}
                      required placeholder="email@exemplo.com"
                    />
                  </div>
                  <div className="pl-field">
                    <label htmlFor="phone">Telefone <span className="pl-required">*</span></label>
                    <input
                      id="phone" name="phone" type="tel"
                      value={formData.phone} onChange={handleChange}
                      required placeholder="+55 (11) 99999-9999"
                    />
                  </div>
                </div>

                {/* Nacionalidade */}
                <div className="pl-field pl-field-full">
                  <label htmlFor="nationality">Nacionalidade <span className="pl-required">*</span></label>
                  <select
                    id="nationality" name="nationality"
                    value={formData.nationality} onChange={handleChange}
                    required
                  >
                    <option value="">Selecione o país</option>
                    {countries.map((country) => (
                      <option key={country} value={country}>{country}</option>
                    ))}
                  </select>
                </div>

                {/* Documento */}
                <div className="pl-field-row">
                  <div className="pl-field">
                    <label htmlFor="document_type">Tipo de Documento <span className="pl-required">*</span></label>
                    <select
                      id="document_type" name="document_type"
                      value={formData.document_type} onChange={handleChange}
                      required
                    >
                      <option value="national_id">Identidade Nacional</option>
                      <option value="passport">Passaporte</option>
                      <option value="driver_license">Carteira de Motorista</option>
                    </select>
                  </div>
                  <div className="pl-field">
                    <label htmlFor="document_number">Número do Documento <span className="pl-required">*</span></label>
                    <input
                      id="document_number" name="document_number" type="text"
                      value={formData.document_number} onChange={handleChange}
                      required placeholder="Número do documento"
                    />
                  </div>
                </div>

                {/* Observações */}
                <div className="pl-field pl-field-full">
                  <label htmlFor="notes">Observações</label>
                  <textarea
                    id="notes" name="notes"
                    value={formData.notes} onChange={handleChange}
                    rows="3" placeholder="Observações sobre o jogador (opcional)..."
                    className="pl-textarea"
                  />
                </div>

                <div className="pl-modal-footer">
                  <button
                    type="button"
                    className="pl-btn-cancel"
                    onClick={() => setShowModal(false)}
                  >
                    Cancelar
                  </button>
                  <button type="submit" className="pl-btn-submit">
                    <svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16">
                      <path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/>
                    </svg>
                    {editingPlayer ? 'Atualizar' : 'Cadastrar'}
                  </button>
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
