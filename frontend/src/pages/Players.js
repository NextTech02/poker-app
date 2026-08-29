import React, { useEffect, useState, useMemo, lazy, Suspense } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import Sidebar from '../components/Sidebar';
import Icon from '../components/Icon';
import { SkeletonPlayersTable } from '../components/SkeletonLoader';
import api from '../config/api';
import { cachedGet, invalidateCache } from '../utils/apiCache';
import { useToast } from '../contexts/ToastContext';
import { offlineWrite } from '../offline/apiOffline';
import { applyPlayerCreate } from '../offline/domainRules';
import { uuid, getEntity, putEntity } from '../offline/db';
import countries from '../data/countries';
import { opcoesDocumento, validarDocumento, ehTipoLegado } from '../utils/documentos';
import './Players.css';

// Carregado só quando o usuário importa: puxa o leitor de planilha junto.
const PlayerImportModal = lazy(() => import('../components/PlayerImportModal'));

// Rótulo curto para a coluna da tabela. Os três primeiros já têm tradução no
// arquivo de idioma; os tipos por país entram com o texto padrão inline.
const DOC_TYPE_LABELS = {
  national_id: ['players.docIdentity'],
  passport: ['players.docPassport'],
  driver_license: ['players.docCnh'],
  cpf: ['documents.typeCpfShort', 'CPF'],
  dni: ['documents.typeDniShort', 'DNI'],
  cedula: ['documents.typeCedulaShort', 'Cédula'],
};

const getInitials = (name = '') =>
  name.trim().split(/\s+/).slice(0, 2).map((w) => w[0]?.toUpperCase() || '').join('');

// Nome e sobrenome são campos separados no cadastro, mas `name` continua
// existindo e sendo enviado: 93 arquivos do sistema leem players.name (recibo
// de prêmio, alocação de mesa, tela de TV) e o backend anterior ao deploy
// ainda exige o nome completo — o deploy não é atômico.
const limparNome = (v = '') => String(v || '').replace(/\s+/g, ' ').trim();
const primeiroNome = (nome = '') => limparNome(nome).split(' ')[0] || '';
const sobrenomeDe = (nome = '') => limparNome(nome).split(' ').slice(1).join(' ');
const nomeCompleto = (primeiro, ultimo) => limparNome(`${primeiro || ''} ${ultimo || ''}`);

// O formulário abre em 'cpf' (é a maioria do balcão). Isso é seguro mesmo se
// esta tela subir ANTES da migração dos tipos de documento: quando o CHECK
// antigo do banco recusa o tipo novo, o backend regrava o cadastro com o tipo
// legado em vez de derrubar a venda (backend/app/utils/documentos.py:
// tipo_para_banco_antigo). Não troque este padrão por uma consulta ao servidor:
// seria uma ida a mais no caminho quente e não protegeria a importação nem o
// replay da fila offline, que não passam por esta tela.
const EMPTY_FORM = {
  first_name: '', last_name: '', email: '', phone: '', nationality: '',
  document_type: 'cpf', document_number: '', nickname: '', birth_date: '', notes: '',
};

/** O que mostrar quando o cadastro não grava.
 *
 * O backend recusa duplicidade com um `detail` ESTRUTURADO (`code` + `message`)
 * em vez de uma frase pronta, e aqui a frase é escolhida pelo idioma de quem
 * está na tela: o mesmo erro precisa sair em espanhol num clube colombiano.
 *
 * `message` é a reserva — se um código novo aparecer no backend antes de esta
 * tela conhecê-lo, é melhor mostrar a frase em português do que o texto
 * genérico "não foi possível salvar", que não diz o que fazer.
 */
export const mensagemDoErro = (error, t) => {
  if (error?.userMessage) return error.userMessage;
  const detalhe = error?.response?.data?.detail;

  if (detalhe && typeof detalhe === 'object' && detalhe.code) {
    const nome = detalhe.name;
    const porCodigo = {
      email_duplicado: nome
        ? t('players.errEmailDuplicadoCom', 'Este e-mail já está cadastrado para {{name}}.', { name: nome })
        : t('players.errEmailDuplicado', 'Este e-mail já está cadastrado para outro jogador.'),
      documento_duplicado: nome
        ? t('players.errDocumentoDuplicadoCom', 'Este documento já está cadastrado para {{name}}.', { name: nome })
        : t('players.errDocumentoDuplicado', 'Este documento já está cadastrado para outro jogador.'),
      limite_de_jogadores: t(
        'players.errLimiteDeJogadores',
        'O plano do clube atingiu o limite de jogadores cadastrados. Troque de plano para cadastrar mais.',
      ),
    };
    return porCodigo[detalhe.code] || detalhe.message || t('players.saveError', 'Não foi possível salvar o jogador.');
  }

  return typeof detalhe === 'string' ? detalhe : t('players.saveError', 'Não foi possível salvar o jogador.');
};

const Players = () => {
  const { toast, confirm } = useToast();
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [players, setPlayers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);

  // Acessibilidade: o fundo escuro fecha no clique, mas quem usa só o teclado
  // precisa do Esc para sair do modal.
  useEffect(() => {
    if (!showModal) return undefined;
    const onKeyDown = (ev) => {
      if (ev.key === 'Escape') setShowModal(false);
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [showModal]);

  const [editingPlayer, setEditingPlayer] = useState(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [formData, setFormData] = useState(EMPTY_FORM);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState('');
  const [showImport, setShowImport] = useState(false);

  useEffect(() => {
    loadPlayers();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchTerm]);

  const loadPlayers = async () => {
    try {
      // B3: cache 60s para lista sem filtro; busca não usa cache (query dinâmica)
      let data;
      if (searchTerm) {
        const res = await api.get('/players', { params: { search: searchTerm } });
        data = res.data;
      } else {
        data = await cachedGet(api, '/players', 60000);
      }
      setPlayers(data);
    } catch (error) {
      console.error('Erro ao carregar jogadores:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setFormError('');

    const primeiro = limparNome(formData.first_name);
    const ultimo = limparNome(formData.last_name);
    if (!primeiro) {
      setFormError(t('players.firstNameRequired', 'Informe o nome do jogador.'));
      return;
    }

    // O documento é o comprovante de quem recebeu prêmio em dinheiro: barrar
    // aqui evita a ida ao servidor, mas quem VALE é o backend (a mesma API
    // atende a importação e o replay da fila offline).
    const doc = validarDocumento(formData.document_type, formData.document_number);
    if (!doc.valido) {
      setFormError(t(doc.chaveMotivo, doc.motivo));
      return;
    }

    // `name` vai junto de propósito: 93 telas leem players.name e o backend
    // anterior ao deploy ainda o exige.
    const dados = {
      ...formData,
      first_name: primeiro,
      last_name: ultimo,
      name: nomeCompleto(primeiro, ultimo),
      document_number: doc.normalizado,
    };

    setSubmitting(true);
    try {
      if (editingPlayer) {
        const upd = await offlineWrite({
          kind: 'player-update', method: 'patch', url: `/players/${editingPlayer.id}`,
          body: { player_id: editingPlayer.id, ...dados },
          clientMutationId: uuid(), meta: { kind: 'player-update', name: dados.name },
          synthetic: { ...editingPlayer, ...dados },
          applyLocal: async () => {
            const p = await getEntity('players', editingPlayer.id);
            await putEntity('players', { ...p, ...dados, id: editingPlayer.id });
          },
        });
        toast.success(upd.offline ? t('offline.savedOffline', 'Salvo offline — será enviado ao sincronizar') : t('players.updatedSuccess'));
      } else {
        const cid = uuid();
        const body = { ...dados, client_id: cid };
        const cr = await offlineWrite({
          kind: 'player-create', method: 'post', url: '/players', body,
          clientEntityIds: { players: cid }, clientMutationId: uuid(),
          meta: { kind: 'player-create', name: dados.name },
          synthetic: { id: cid, ...dados },
          applyLocal: () => applyPlayerCreate(body),
        });
        toast.success(cr.offline ? t('offline.savedOffline', 'Salvo offline — será enviado ao sincronizar') : t('players.createdSuccess'));
      }
      invalidateCache('/players'); // B3: invalida cache após mutação
      setShowModal(false);
      setEditingPlayer(null);
      setFormData(EMPTY_FORM);
      loadPlayers();
    } catch (error) {
      setFormError(mensagemDoErro(error, t));
    } finally {
      setSubmitting(false);
    }
  };

  const handleEdit = (player) => {
    setEditingPlayer(player);
    setFormData({
      // Cadastro antigo (ou banco ainda sem a migração) só tem o nome
      // completo: divide no primeiro espaço para o formulário abrir cheio, em
      // vez de obrigar o operador a redigitar o nome para salvar o telefone.
      first_name: player.first_name || primeiroNome(player.name),
      last_name: player.last_name || sobrenomeDe(player.name),
      email: player.email || '',
      phone: player.phone || '',
      nationality: player.nationality || '',
      document_type: player.document_type || EMPTY_FORM.document_type,
      document_number: player.document_number || '',
      nickname: player.nickname || '',
      birth_date: player.birth_date || '',
      notes: player.notes || '',
    });
    setFormError('');
    setShowModal(true);
  };

  // B5: useMemo evita re-computar a lista inteira em cada render
  const sortedPlayers = useMemo(
    () => [...players].sort((a, b) => a.name.localeCompare(b.name)),
    [players]
  );

  const handleDelete = async (playerId) => {
    const ok = await confirm(t('players.confirmDelete'), {
      variant: 'danger', confirmText: t('common.delete', 'Excluir'),
    });
    if (!ok) return;
    try {
      await api.delete(`/players/${playerId}`);
      loadPlayers();
    } catch {
      toast.error(t('players.deleteError'));
    }
  };

  const handleChange = (e) =>
    setFormData({ ...formData, [e.target.name]: e.target.value });

  const openNewModal = () => {
    setEditingPlayer(null);
    setFormData(EMPTY_FORM);
    setFormError('');
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
              <Icon name="users" />
            </div>
            <div>
              <h1 className="pl-title">{t('players.title')}</h1>
              <p className="pl-subtitle">{t('players.subtitle')}</p>
            </div>
          </div>
          <div className="pl-head-actions">
            <button type="button" className="pl-btn-import" onClick={() => setShowImport(true)}
                    title={t('playerImport.buttonHint', 'Trazer a base de jogadores de outro sistema')}>
              <svg viewBox="0 0 24 24" fill="currentColor" width="18" height="18">
                <path d="M19 12v7H5v-7H3v7c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2v-7h-2zm-6 .67 2.59-2.58L17 11.5l-5 5-5-5 1.41-1.41L11 12.67V3h2v9.67z"/>
              </svg>
              {t('playerImport.button', 'Importar')}
            </button>
            <button type="button" className="pl-btn-new" onClick={openNewModal}>
              <svg viewBox="0 0 24 24" fill="currentColor" width="18" height="18">
                <path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/>
              </svg>
              {t('players.newPlayer')}
            </button>
          </div>
        </div>

        {/* ── Search ── */}
        <div className="pl-search-wrap">
          <svg className="pl-search-icon" viewBox="0 0 24 24" fill="currentColor">
            <path d="M15.5 14h-.79l-.28-.27A6.471 6.471 0 0 0 16 9.5 6.5 6.5 0 1 0 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z"/>
          </svg>
          <input
            type="text"
            className="pl-search-input"
            placeholder={t('players.searchPlaceholder')}
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
          />
          {searchTerm && (
            <button type="button" className="pl-search-clear" onClick={() => setSearchTerm('')}>
              <svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16">
                <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/>
              </svg>
            </button>
          )}
        </div>

        {/* ── Content ── */}
        {loading ? (
          <SkeletonPlayersTable rows={6} />
        ) : players.length === 0 ? (
          <div className="pl-empty">
            <div className="pl-empty-icon">
              <svg viewBox="0 0 24 24" fill="currentColor">
                <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/>
              </svg>
            </div>
            <h3>{searchTerm ? t('players.noResults') : t('players.noPlayers')}</h3>
            <p>{searchTerm ? `${t('players.noResultsHint')} "${searchTerm}"` : t('players.noPlayersHint')}</p>
            {!searchTerm && (
              <button type="button" className="pl-btn-new" onClick={openNewModal}>
                <svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16">
                  <path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/>
                </svg>
                {t('players.register')}
              </button>
            )}
          </div>
        ) : (
          <div className="pl-table-card">
            <div className="pl-table-header">
              <span className="pl-table-count">
                <strong>{players.length}</strong>{' '}
                {players.length === 1 ? t('players.countSingular', 'jogador') : t('players.countPlural', 'jogadores')}
                {searchTerm && (
                  <span className="pl-count-filter">
                    {' '}{players.length !== 1 ? t('common.found_plural', 'encontrados') : t('common.found_singular', 'encontrado')}
                  </span>
                )}
              </span>
            </div>
            <div className="pl-table-wrap">
              <table className="pl-table">
                <thead>
                  <tr>
                    <th>{t('players.columnPlayer')}</th>
                    <th>{t('players.columnContact')}</th>
                    <th>{t('players.columnNationality')}</th>
                    <th>{t('players.columnDocument')}</th>
                    <th className="pl-th-actions">{t('players.columnActions')}</th>
                  </tr>
                </thead>
                <tbody>
                  {sortedPlayers.map((player) => {
                    const initials = getInitials(player.name);
                    const docLabel = DOC_TYPE_LABELS[player.document_type]
                      ? t(...DOC_TYPE_LABELS[player.document_type])
                      : (player.document_type || '');
                    return (
                      <tr key={player.id} className="pl-row">
                        <td className="pl-cell-player">
                          <div
                            className="pl-player-cell pl-player-cell-link"
                            role="button"
                            tabIndex={0}
                            onClick={() => navigate(`/jogadores/${player.id}`)}
                            onKeyDown={(e) => { if (e.key === 'Enter') navigate(`/jogadores/${player.id}`); }}
                            title={t('players.viewHistory', 'Ver histórico')}
                          >
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
                        <td data-label={t('players.columnContact')}>
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
                        <td data-label={t('players.columnNationality')}>
                          <span className="pl-nationality">{player.nationality || '—'}</span>
                        </td>
                        <td data-label={t('players.columnDocument')}>
                          {player.document_number ? (
                            <div className="pl-doc-cell">
                              <span className="pl-doc-type">{docLabel}</span>
                              <span className="pl-doc-number">{player.document_number}</span>
                            </div>
                          ) : (
                            <span className="pl-empty-val">—</span>
                          )}
                        </td>
                        <td className="pl-cell-actions">
                          <div className="pl-actions">
                            <button
                              type="button"
                              className="pl-btn-icon pl-btn-history"
                              onClick={() => navigate(`/jogadores/${player.id}`)}
                              title={t('players.viewHistory', 'Ver histórico')}
                            >
                              <svg viewBox="0 0 24 24" fill="currentColor" width="15" height="15">
                                <path d="M13 3a9 9 0 0 0-9 9H1l4 4 4-4H6a7 7 0 1 1 7 7 6.97 6.97 0 0 1-4.95-2.05l-1.42 1.42A9 9 0 1 0 13 3zm-1 5v5l4.28 2.54.72-1.21-3.5-2.08V8H12z"/>
                              </svg>
                              {t('players.history', 'Histórico')}
                            </button>
                            <button
                              type="button"
                              className="pl-btn-icon pl-btn-edit"
                              onClick={() => handleEdit(player)}
                              title={t('players.editPlayer')}
                            >
                              <svg viewBox="0 0 24 24" fill="currentColor" width="15" height="15">
                                <path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/>
                              </svg>
                              {t('common.edit', 'Editar')}
                            </button>
                            <button
                              type="button"
                              className="pl-btn-icon pl-btn-delete"
                              onClick={() => handleDelete(player.id)}
                              title={t('players.deletePlayer')}
                            >
                              <svg viewBox="0 0 24 24" fill="currentColor" width="15" height="15">
                                <path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/>
                              </svg>
                              {t('common.delete', 'Excluir')}
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
          <div
            className="pl-modal-overlay"
            role="presentation"
            onClick={(e) => { if (e.target === e.currentTarget) setShowModal(false); }}
          >
            <div className="pl-modal" role="dialog" aria-modal="true">
              <div className="pl-modal-header">
                <div className="pl-modal-title-group">
                  <div className="pl-modal-icon">
                    <svg viewBox="0 0 24 24" fill="currentColor">
                      <path d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z"/>
                    </svg>
                  </div>
                  <h2>{editingPlayer ? t('players.editPlayer') : t('players.newPlayer')}</h2>
                </div>
                <button type="button" className="pl-modal-close" onClick={() => setShowModal(false)}>
                  <svg viewBox="0 0 24 24" fill="currentColor" width="20" height="20">
                    <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/>
                  </svg>
                </button>
              </div>

              <form onSubmit={handleSubmit} className="pl-modal-form">
                {/* Nome e sobrenome — campos separados (pedido do dono do clube).
                    O nome completo continua sendo montado e enviado no submit. */}
                <div className="pl-field-row">
                  <div className="pl-field">
                    <label htmlFor="first_name">
                      {t('players.firstName', 'Nome')} <span className="pl-required">*</span>
                    </label>
                    <input
                      id="first_name" name="first_name" type="text"
                      value={formData.first_name} onChange={handleChange}
                      required placeholder={t('players.firstNamePlaceholder', 'Maria')}
                    />
                  </div>
                  <div className="pl-field">
                    <label htmlFor="last_name">{t('players.lastName', 'Sobrenome')}</label>
                    <input
                      id="last_name" name="last_name" type="text"
                      value={formData.last_name} onChange={handleChange}
                      placeholder={t('players.lastNamePlaceholder', 'Silva Costa')}
                    />
                  </div>
                </div>

                {/* Apelido */}
                <div className="pl-field pl-field-full">
                  <label htmlFor="nickname">{t('players.nicknameLabel')}</label>
                  <input
                    id="nickname" name="nickname" type="text"
                    value={formData.nickname} onChange={handleChange}
                    placeholder={t('players.nicknamePlaceholder')}
                  />
                </div>

                <div className="pl-field pl-field-full">
                  <label htmlFor="birth_date">{t('players.birthDate', 'Data de nascimento')}</label>
                  <input
                    id="birth_date" name="birth_date" type="date"
                    value={formData.birth_date} onChange={handleChange}
                  />
                </div>

                {/* Email + Telefone */}
                <div className="pl-field-row">
                  <div className="pl-field">
                    <label htmlFor="email">{t('players.email')} <span className="pl-required">*</span></label>
                    <input
                      id="email" name="email" type="email"
                      value={formData.email} onChange={handleChange}
                      required placeholder={t('players.emailPlaceholder')}
                    />
                  </div>
                  <div className="pl-field">
                    <label htmlFor="phone">{t('players.phone')} <span className="pl-required">*</span></label>
                    <input
                      id="phone" name="phone" type="tel"
                      value={formData.phone} onChange={handleChange}
                      required placeholder={t('players.phonePlaceholder')}
                    />
                  </div>
                </div>

                {/* Nacionalidade */}
                <div className="pl-field pl-field-full">
                  <label htmlFor="nationality">{t('players.nationality')} <span className="pl-required">*</span></label>
                  <select
                    id="nationality" name="nationality"
                    value={formData.nationality} onChange={handleChange}
                    required
                  >
                    <option value="">{t('players.selectCountry')}</option>
                    {countries.map((country) => (
                      <option key={country} value={country}>{country}</option>
                    ))}
                  </select>
                </div>

                {/* Documento */}
                <div className="pl-field-row">
                  <div className="pl-field">
                    <label htmlFor="document_type">{t('players.documentType')} <span className="pl-required">*</span></label>
                    {/* Tipos por país (o clube opera em Brasil, Peru e
                        Colômbia). O tipo antigo só aparece quando já é o do
                        cadastro sendo editado — senão o select abriria vazio
                        num jogador legado e travaria o balcão. */}
                    <select
                      id="document_type" name="document_type"
                      value={formData.document_type} onChange={handleChange}
                      required
                    >
                      {opcoesDocumento(formData.document_type).map((opcao) => (
                        <option key={opcao.valor} value={opcao.valor}>
                          {t(opcao.chaveRotulo, opcao.rotulo)}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="pl-field">
                    <label htmlFor="document_number">{t('players.documentNumber')} <span className="pl-required">*</span></label>
                    <input
                      id="document_number" name="document_number" type="text"
                      value={formData.document_number} onChange={handleChange}
                      required placeholder={t('players.documentNumberPlaceholder')}
                    />
                  </div>
                </div>

                {/* Cadastro antigo: avisa, mas não obriga — trocar o tipo é
                    tarefa para quando der, não para a fila do caixa. */}
                {ehTipoLegado(formData.document_type) && (
                  <p className="pl-field-hint">
                    {t('players.legacyDocHint',
                      'Cadastro antigo: escolha o tipo de documento do país quando puder.')}
                  </p>
                )}

                {/* Observações */}
                <div className="pl-field pl-field-full">
                  <label htmlFor="notes">{t('players.notes')}</label>
                  <textarea
                    id="notes" name="notes"
                    value={formData.notes} onChange={handleChange}
                    rows="3" placeholder={t('players.notesPlaceholder')}
                    className="pl-textarea"
                  />
                </div>

                {/* A7: Erro inline acima dos botões */}
                {formError && (
                  <div className="pl-form-error">
                    <svg viewBox="0 0 20 20" fill="currentColor" width="16" height="16">
                      <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z" clipRule="evenodd" />
                    </svg>
                    {formError}
                  </div>
                )}

                <div className="pl-modal-footer">
                  <button
                    type="button"
                    className="pl-btn-cancel"
                    onClick={() => { setShowModal(false); setFormError(''); }}
                    disabled={submitting}
                  >
                    {t('common.cancel')}
                  </button>
                  {/* A7: Spinner durante submit */}
                  <button type="submit" className="pl-btn-submit" disabled={submitting}>
                    {submitting ? (
                      <>
                        <svg className="pl-spinner" viewBox="0 0 24 24" fill="none" width="16" height="16">
                          <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" strokeDasharray="30 70" />
                        </svg>
                        {t('common.saving')}
                      </>
                    ) : (
                      <>
                        <svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16">
                          <path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/>
                        </svg>
                        {editingPlayer ? t('players.update') : t('players.register')}
                      </>
                    )}
                  </button>
                </div>
              </form>
            </div>
          </div>
        )}

        {showImport && (
          <Suspense fallback={null}>
            <PlayerImportModal
              onClose={() => setShowImport(false)}
              onImported={() => { invalidateCache('/players'); loadPlayers(); }}
            />
          </Suspense>
        )}
      </main>
    </div>
  );
};

export default Players;
