import React, { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router-dom';
import Sidebar from '../components/Sidebar';
import EmptyState from '../components/EmptyState';
import Icon from '../components/Icon';
import { SkeletonBlock } from '../components/SkeletonLoader';
import { useEscapeKey } from '../hooks/useEscapeKey';
import {
  arquivosDoVideo,
  carregarCatalogo,
  filtrarVideos,
  formatarDuracao,
  idiomaDoVideo,
  idiomaDosVideos,
  textoNoIdioma,
} from '../utils/suporte';
import './Suporte.css';

const TIPO_TREINAMENTO = 'treinamento';

const CartaoDeVideo = ({ video, idioma, destaque, aoAbrir }) => {
  const { capa } = arquivosDoVideo(video, idioma);
  const duracao = formatarDuracao(video.duracao?.[idiomaDoVideo(video, idioma)]);
  const titulo = textoNoIdioma(video.titulo, idioma);
  return (
    <button
      type="button"
      className={`suporte-cartao${destaque ? ' suporte-cartao--destaque' : ''}`}
      onClick={() => aoAbrir(video.id)}
    >
      <span className="suporte-capa">
        <img src={capa} alt="" loading="lazy" />
        {duracao && <span className="suporte-duracao">{duracao}</span>}
      </span>
      <span className="suporte-texto">
        <span className="suporte-titulo">{titulo}</span>
        <span className="suporte-descricao">{textoNoIdioma(video.descricao, idioma)}</span>
      </span>
    </button>
  );
};

/**
 * SUPORTE — treinamento completo e vídeos curtos, no idioma do app.
 *
 * Sem permissão e sem módulo, como Segurança: quem tem o menor acesso do
 * sistema é justamente quem mais precisa de ajuda. O vídeo aberto fica na URL
 * (`?video=<id>`) para o suporte poder mandar o link direto para alguém.
 */
const Suporte = () => {
  const { t, i18n } = useTranslation();
  const idioma = idiomaDosVideos(i18n?.language);
  const [params, setParams] = useSearchParams();

  const [catalogo, setCatalogo] = useState(null);
  const [carregando, setCarregando] = useState(true);
  const [busca, setBusca] = useState('');
  const [area, setArea] = useState('');

  useEffect(() => {
    let ativo = true;
    carregarCatalogo().then((dados) => {
      if (!ativo) return;
      setCatalogo(dados);
      setCarregando(false);
    });
    return () => { ativo = false; };
  }, []);

  const videos = useMemo(() => catalogo?.videos || [], [catalogo]);
  const treinamentos = useMemo(() => videos.filter((v) => v.tipo === TIPO_TREINAMENTO), [videos]);
  const curtos = useMemo(() => videos.filter((v) => v.tipo !== TIPO_TREINAMENTO), [videos]);
  const visiveis = useMemo(
    () => filtrarVideos(curtos, { area, busca }, idioma),
    [curtos, area, busca, idioma],
  );

  const aberto = videos.find((v) => v.id === params.get('video')) || null;
  const abrir = (id) => setParams({ video: id });
  const fechar = () => setParams({});
  useEscapeKey(!!aberto, fechar);

  const arquivos = aberto ? arquivosDoVideo(aberto, idioma) : null;
  const idiomaAberto = aberto ? idiomaDoVideo(aberto, idioma) : idioma;

  return (
    <div className="app-container">
      <Sidebar />
      <main className="main-content">
        <div className="page-header">
          <div>
            <h1>{t('support.title', 'Suporte')}</h1>
            <p className="subtitle">
              {t('support.subtitle', 'Aprenda a usar o sistema com vídeos curtos e um treinamento completo.')}
            </p>
          </div>
        </div>

        {carregando && <SkeletonBlock height={220} />}

        {!carregando && videos.length === 0 && (
          <EmptyState
            icon={<Icon name="help" size={32} />}
            title={t('support.emptyTitle', 'Os vídeos estão a caminho')}
            subtitle={t('support.emptySubtitle', 'Em breve você encontra aqui os vídeos de treinamento do sistema.')}
          />
        )}

        {treinamentos.length > 0 && (
          <section className="suporte-secao">
            <h2>{t('support.training', 'Treinamento completo')}</h2>
            <div className="suporte-treinamentos">
              {treinamentos.map((video) => (
                <CartaoDeVideo key={video.id} video={video} idioma={idioma} destaque aoAbrir={abrir} />
              ))}
            </div>
          </section>
        )}

        {curtos.length > 0 && (
          <section className="suporte-secao">
            <h2>{t('support.shortVideos', 'Vídeos curtos')}</h2>
            <div className="suporte-filtros">
              <input
                type="search"
                className="form-input suporte-busca"
                value={busca}
                onChange={(e) => setBusca(e.target.value)}
                placeholder={t('support.searchPlaceholder', 'Buscar por assunto')}
                aria-label={t('support.searchPlaceholder', 'Buscar por assunto')}
              />
              <div className="suporte-areas">
                <button
                  type="button"
                  className={`suporte-area${area === '' ? ' ativa' : ''}`}
                  aria-pressed={area === ''}
                  onClick={() => setArea('')}
                >
                  {t('support.allAreas', 'Todos')}
                </button>
                {(catalogo?.areas || []).map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    className={`suporte-area${area === item.id ? ' ativa' : ''}`}
                    aria-pressed={area === item.id}
                    onClick={() => setArea(item.id)}
                  >
                    {textoNoIdioma(item.titulo, idioma)}
                  </button>
                ))}
              </div>
            </div>

            {visiveis.length === 0 ? (
              <p className="suporte-vazio">{t('support.noResults', 'Nenhum vídeo encontrado para essa busca.')}</p>
            ) : (
              <div className="suporte-grade">
                {visiveis.map((video) => (
                  <CartaoDeVideo key={video.id} video={video} idioma={idioma} aoAbrir={abrir} />
                ))}
              </div>
            )}
          </section>
        )}

        {aberto && (
          <div
            className="modal-overlay"
            onClick={(e) => { if (e.target === e.currentTarget) fechar(); }}
          >
            <div
              className="modal suporte-player"
              role="dialog"
              aria-modal="true"
              aria-label={textoNoIdioma(aberto.titulo, idioma)}
            >
              <div className="modal-header">
                <h2>{textoNoIdioma(aberto.titulo, idioma)}</h2>
                <button
                  type="button"
                  className="suporte-fechar"
                  onClick={fechar}
                  aria-label={t('support.close', 'Fechar')}
                >
                  <Icon name="x" size={20} />
                </button>
              </div>
              {/* `key` troca o elemento ao mudar de vídeo: só trocar o `src` do
                  <source> não faz o navegador recarregar. */}
              <video
                key={`${aberto.id}-${idiomaAberto}`}
                className="suporte-video"
                controls
                autoPlay
                playsInline
                preload="metadata"
                poster={arquivos.capa}
                crossOrigin="anonymous"
              >
                <source src={arquivos.video} type="video/mp4" />
                <track
                  kind="subtitles"
                  src={arquivos.legenda}
                  srcLang={idiomaAberto}
                  label={t('support.subtitles', 'Legendas')}
                />
              </video>
            </div>
          </div>
        )}
      </main>
    </div>
  );
};

export default Suporte;
