import React, { useEffect, useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import Sidebar from '../components/Sidebar';
import Card from '../components/Card';
import Button from '../components/Button';
import EmptyState from '../components/EmptyState';
import { getConflicts, removeConflict, removeMutation } from '../offline/db';
import { notifyQueueChanged } from '../offline/queue';

/**
 * Revisão de conflitos de sincronização: operações feitas offline que o servidor
 * REJEITOU no replay (regra de negócio — dia cheio, jogador duplicado, saldo
 * insuficiente, limite de rebuy, etc.). O operador vê o motivo e descarta.
 */
const kindLabel = (k) => ({
  register: 'Registro', rebuy: 'Rebuy', addon: 'Add-on',
  eliminate: 'Eliminação', restore: 'Reativação', sangria: 'Sangria', timer: 'Timer',
}[k] || k);

const SyncConflicts = () => {
  const { t } = useTranslation();
  const [conflicts, setConflicts] = useState([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try { setConflicts(await getConflicts()); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  const discard = async (c) => {
    await removeConflict(c.id);
    await removeMutation(c.id); // remove também da fila
    notifyQueueChanged();
    load();
  };

  return (
    <div className="app-container">
      <Sidebar />
      <main className="main-content">
        <div className="page-header">
          <div>
            <h1>{t('offline.conflictsTitle', 'Conflitos de Sincronização')}</h1>
            <p className="subtitle">
              {t('offline.conflictsSubtitle', 'Operações feitas offline que o servidor rejeitou ao sincronizar.')}
            </p>
          </div>
        </div>

        {loading ? (
          <div className="loading">{t('common.loading', 'Carregando...')}</div>
        ) : conflicts.length === 0 ? (
          <EmptyState
            title={t('offline.noConflicts', 'Nenhum conflito')}
            subtitle={t('offline.noConflictsDesc', 'Todas as operações offline foram sincronizadas com sucesso.')}
          />
        ) : (
          conflicts
            .slice()
            .sort((a, b) => (b.at || 0) - (a.at || 0))
            .map((c) => {
              const m = c.mutation || {};
              const meta = m.meta || {};
              return (
                <Card key={c.id} className="conflict-card" style={{ marginBottom: 12 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16, alignItems: 'flex-start', flexWrap: 'wrap' }}>
                    <div>
                      <strong>{kindLabel(m.kind)}</strong>
                      {meta.name ? ` — ${meta.name}` : ''}
                      <div style={{ color: '#f59e0b', marginTop: 4, fontSize: '0.9rem' }}>
                        {c.reason || t('offline.conflictGeneric', 'Rejeitado pelo servidor')}
                      </div>
                      <div style={{ color: '#6b7280', marginTop: 4, fontSize: '0.8rem' }}>
                        {m.method?.toUpperCase()} {m.url}
                        {c.at ? ` · ${new Date(c.at).toLocaleString()}` : ''}
                      </div>
                    </div>
                    <Button variant="danger" size="small" onClick={() => discard(c)}>
                      {t('offline.discard', 'Descartar')}
                    </Button>
                  </div>
                </Card>
              );
            })
        )}
      </main>
    </div>
  );
};

export default SyncConflicts;
