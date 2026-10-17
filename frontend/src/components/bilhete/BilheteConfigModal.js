import React, { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { supabase } from '../../config/supabase';
import { useCurrency } from '../../contexts/CurrencyContext';
import { useEscapeKey } from '../../hooks/useEscapeKey';
import {
  invalidarBrandingDoBilhete, lerBilheteDoClube, publicUrlFor,
} from '../../hooks/useBrandingDoBilhete';
import { brandingFinal, htmlDoBilhete } from '../../utils/bilhete';
import ImagemDoBilheteCampo from './ImagemDoBilheteCampo';
import './Bilhete.css';

// Dados de exemplo da prévia (nunca impressos).
const exemplo = (t) => ({
  id: 'a1b2c3d4-0000-0000-0000-000000000000',
  player_name: t('ticket.samplePlayer', 'Jogador de Exemplo'),
  tournament_name: 'Main Event',
  day_name: t('ticket.sampleDay', 'Dia 1A'),
  table_number: 8,
  seat_number: 7,
  created_at: '2026-10-16T21:30:00',
  itens: [{ name: t('ticket.sampleEntry', 'Reentrada'), amount: 300, chips: 30000 }],
  total_amount: 300,
  total_chips: 30000,
});

/**
 * Bilhete de inscrição do CLUBE: a imagem do topo, a cidade, a sede e os
 * enfeites dos cantos. Cada torneio pode trocar imagem, cidade e sede no
 * próprio cadastro. Com prévia do bilhete como ele sai na térmica.
 */
const BilheteConfigModal = ({ onFechar }) => {
  const { t, i18n } = useTranslation();
  const { formatCurrency = (v) => String(v) } = useCurrency() || {};
  useEscapeKey(true, onFechar);
  const [form, setForm] = useState(null);
  const [linhaId, setLinhaId] = useState(null);
  const [salvando, setSalvando] = useState(false);
  const [erro, setErro] = useState('');

  useEffect(() => {
    let vivo = true;
    invalidarBrandingDoBilhete();
    lerBilheteDoClube().then((dados) => {
      if (!vivo) return;
      setLinhaId(dados.id ?? null);
      setForm({
        ticket_logo_path: dados.ticket_logo_path || '',
        ticket_city: dados.ticket_city || '',
        ticket_venue: dados.ticket_venue || '',
        ticket_ornaments: !!dados.ticket_ornaments,
      });
    });
    return () => { vivo = false; };
  }, []);

  const previa = useMemo(() => (form ? htmlDoBilhete({
    allocation: exemplo(t),
    branding: brandingFinal(form, {}, publicUrlFor),
    idioma: i18n?.language,
    formatarValor: formatCurrency,
    caixa: 'Carlos',
    imprimir: false,
  }) : ''), [form, i18n?.language, formatCurrency, t]);

  const mudar = (campo, valor) => setForm((atual) => ({ ...atual, [campo]: valor }));

  const salvar = async () => {
    setSalvando(true);
    setErro('');
    try {
      if (linhaId == null) throw new Error('sem linha');
      const { error } = await supabase.from('app_settings').update({
        ticket_logo_path: form.ticket_logo_path || null,
        ticket_city: form.ticket_city.trim() || null,
        ticket_venue: form.ticket_venue.trim() || null,
        ticket_ornaments: !!form.ticket_ornaments,
      }).eq('id', linhaId);
      if (error) throw error;
      invalidarBrandingDoBilhete();
      onFechar(true);
    } catch (_) {
      setErro(t('ticket.saveError', 'Não foi possível salvar o bilhete. Tente de novo.'));
    } finally {
      setSalvando(false);
    }
  };

  return (
    <div className="bt-overlay" role="presentation" onClick={(e) => { if (e.target === e.currentTarget && !salvando) onFechar(); }}>
      <div className="bt-modal" role="dialog" aria-modal="true" aria-label={t('ticket.title', 'Bilhete de inscrição')}>
        <div className="bt-modal-header">
          <h3>{t('ticket.title', 'Bilhete de inscrição')}</h3>
          <button type="button" className="bt-fechar" onClick={() => onFechar()} aria-label={t('common.close', 'Fechar')}>✕</button>
        </div>
        {!form ? (
          <div className="loading">{t('common.loading')}</div>
        ) : (
          <div className="bt-modal-corpo">
            <div className="bt-modal-campos">
              <p className="bt-dica">
                {t('ticket.clubHint', 'Padrão do clube para o bilhete impresso no Caixa. Cada torneio pode trocar a imagem, a cidade e a sede no próprio cadastro.')}
              </p>
              <label className="bt-rotulo-campo" htmlFor="bt-clube-imagem">{t('ticket.logo', 'Imagem do topo')}</label>
              <ImagemDoBilheteCampo
                id="bt-clube-imagem"
                valor={form.ticket_logo_path}
                onChange={(v) => mudar('ticket_logo_path', v)}
                disabled={salvando}
              />
              <label className="bt-rotulo-campo" htmlFor="bt-clube-cidade">{t('ticket.city', 'Cidade (abaixo da imagem)')}</label>
              <input id="bt-clube-cidade" className="bt-input" maxLength={80} value={form.ticket_city}
                onChange={(e) => mudar('ticket_city', e.target.value)} disabled={salvando} />
              <label className="bt-rotulo-campo" htmlFor="bt-clube-sede">{t('ticket.venue', 'Sede / local')}</label>
              <input id="bt-clube-sede" className="bt-input" maxLength={120} value={form.ticket_venue}
                onChange={(e) => mudar('ticket_venue', e.target.value)} disabled={salvando} />
              <label className="bt-check">
                <input type="checkbox" checked={form.ticket_ornaments}
                  onChange={(e) => mudar('ticket_ornaments', e.target.checked)} disabled={salvando} />
                {t('ticket.ornaments', 'Enfeites geométricos nos cantos')}
              </label>
              {erro && <div className="bt-erro" role="alert">{erro}</div>}
            </div>
            <div className="bt-modal-previa">
              <iframe title={t('ticket.preview', 'Prévia do bilhete')} srcDoc={previa} className="bt-iframe" />
            </div>
          </div>
        )}
        <div className="bt-modal-rodape">
          <button type="button" className="bt-botao bt-botao--secundario" onClick={() => onFechar()} disabled={salvando}>
            {t('common.cancel', 'Cancelar')}
          </button>
          <button type="button" className="bt-botao" onClick={salvar} disabled={salvando || !form}>
            {t('common.save', 'Salvar')}
          </button>
        </div>
      </div>
    </div>
  );
};

export default BilheteConfigModal;
