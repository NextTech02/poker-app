import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import api from '../config/api';
import TvStage from '../components/broadcast/TvStage';
import { buildTvSettings } from '../components/broadcast/tvModel';
import { resolveBackground } from '../components/broadcast/tvBackgrounds';
import { labelsForLanguage } from '../utils/broadcastLabels';
import { ordenarAssentos, paginarAssentos } from '../utils/quadroDeMesas';
import '../components/broadcast/TvScreen.css';
import './TvMesas.css';

// O sorteio muda pouco depois de feito; 20 s acompanham troca de mesa e
// eliminação sem pesar no servidor (cada TV é um request).
const ATUALIZAR_MS = 20000;
// Com mais jogadores do que cabe numa tela, as páginas se alternam.
const TROCAR_PAGINA_MS = 12000;

/**
 * Telão PÚBLICO de MESAS E ASSENTOS (pedido do NSOP para o dia final): numa TV
 * do salão, pelo mesmo código do relógio do dia, a lista em ordem alfabética
 * de quem senta em que mesa e assento — e as fichas com que cada um se
 * classificou. Independe do telão de blinds: cada TV abre a sua tela.
 */
const TvMesas = () => {
  const { t } = useTranslation();
  const { code } = useParams();
  const [quadro, setQuadro] = useState(null);
  const [erro, setErro] = useState(null); // 'invalido' | 'rede'
  const [dia, setDia] = useState(null);
  const [pagina, setPagina] = useState(0);

  const carregar = useCallback(async () => {
    try {
      // Sem token: a TV não faz login, e o código é a credencial.
      const r = await api.get(`/public/tv/${encodeURIComponent(code || '')}/seating`, {
        _public: true, _silentError: true,
      });
      setQuadro(r.data);
      setErro(null);
    } catch (e) {
      // Só o 404 é "código inválido"; queda de rede mantém a última lista.
      setErro(e?.response?.status === 404 ? 'invalido' : 'rede');
    }
  }, [code]);

  useEffect(() => {
    carregar();
    const id = setInterval(carregar, ATUALIZAR_MS);
    return () => clearInterval(id);
  }, [carregar]);

  // Fundo e cor de destaque das Configurações do telão do dia (decorativo).
  const dayId = quadro?.day_id;
  useEffect(() => {
    if (!dayId) return undefined;
    let vivo = true;
    api.get(`/tournament-days/${dayId}`, { _public: true, _silentError: true })
      .then((r) => { if (vivo) setDia(r?.data || null); })
      .catch(() => {});
    return () => { vivo = false; };
  }, [dayId]);

  const L = labelsForLanguage(quadro?.language);
  const { colunas, paginas } = useMemo(
    () => paginarAssentos(ordenarAssentos(quadro?.seats, quadro?.language)),
    [quadro],
  );
  const totalPaginas = paginas.length;

  useEffect(() => {
    setPagina(0);
    if (totalPaginas <= 1) return undefined;
    const id = setInterval(() => setPagina((p) => (p + 1) % totalPaginas), TROCAR_PAGINA_MS);
    return () => clearInterval(id);
  }, [totalPaginas]);

  if (!quadro) {
    return (
      <div className="tvm-aviso">
        {erro === 'invalido' && (
          <>
            <p>{t('tv.invalid', 'Código inválido. Confira e tente de novo.')}</p>
            <Link to="/tv">{t('tv.backToCode', 'Digitar outro código')}</Link>
          </>
        )}
        {erro === 'rede' && <p>{t('tv.unreachable', 'Não foi possível conectar ao sistema. Verifique a internet e tente de novo.')}</p>}
        {!erro && <p>{t('tv.loading', 'Abrindo…')}</p>}
      </div>
    );
  }

  const settings = buildTvSettings(dia);
  const background = resolveBackground(settings.bgValue, settings.bgColor, settings.bgOverlay);
  const atual = paginas[Math.min(pagina, Math.max(0, totalPaginas - 1))] || [];
  const temFichas = (quadro.seats || []).some((s) => Number(s.chips) > 0);
  const fichas = (n) => Number(n || 0).toLocaleString(L.numberLocale || 'en-US');

  return (
    <TvStage fit="viewport" background={background}>
      <div
        className={`tvm tvm--${colunas}col ${temFichas ? 'tvm--fichas' : ''}`}
        style={{ '--tvm-accent': settings.colors?.sidebarValue || '#d4af37' }}
      >
        <header className="tvm-head">
          <div className="tvm-head-text">
            {quadro.organization_name && <div className="tvm-org">{quadro.organization_name}</div>}
            <h1 className="tvm-title">{quadro.tournament_name}</h1>
            <div className="tvm-sub">
              {quadro.day_name && <span>{quadro.day_name}</span>}
              <span className="tvm-sub-label">{L.seatingTitle}</span>
            </div>
          </div>
          <div className="tvm-meta">
            <span className="tvm-count">
              <strong>{(quadro.seats || []).length}</strong> {L.players}
            </span>
            {totalPaginas > 1 && (
              <span className="tvm-page">{L.seatingPage} {Math.min(pagina, totalPaginas - 1) + 1}/{totalPaginas}</span>
            )}
          </div>
        </header>

        {totalPaginas === 0 ? (
          <div className="tvm-vazio">{L.seatingEmpty}</div>
        ) : (
          <div className="tvm-grid" style={{ gridTemplateColumns: `repeat(${colunas}, minmax(0, 1fr))` }}>
            {atual.map((coluna, i) => (
              <div className="tvm-col" key={`${pagina}-${i}`}>
                <div className="tvm-row tvm-row--head">
                  <span className="tvm-name">{L.seatingPlayer}</span>
                  <span className="tvm-num">{L.seatingTable}</span>
                  <span className="tvm-num">{L.seatingSeat}</span>
                  {temFichas && <span className="tvm-chips">{L.seatingChips}</span>}
                </div>
                {coluna.map((s) => (
                  <div className="tvm-row" key={`${s.name}-${s.table_number}-${s.seat_number}`}>
                    <span className="tvm-name">{s.name}</span>
                    <span className="tvm-num tvm-mesa">{s.table_number}</span>
                    <span className="tvm-num">{s.seat_number}</span>
                    {temFichas && <span className="tvm-chips">{s.chips ? fichas(s.chips) : ''}</span>}
                  </div>
                ))}
              </div>
            ))}
          </div>
        )}

        {erro === 'rede' && <div className="tvm-offline">{L.seatingOffline}</div>}
      </div>
    </TvStage>
  );
};

export default TvMesas;
