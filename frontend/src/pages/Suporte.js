import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router-dom';
import Sidebar from '../components/Sidebar';
import EmptyState from '../components/EmptyState';
import Icon from '../components/Icon';
import { SkeletonBlock } from '../components/SkeletonLoader';
import { useAuth } from '../contexts/AuthContext';
import { useEscapeKey } from '../hooks/useEscapeKey';
import {
  capituloEm,
  gravarProgresso,
  lerProgresso,
  pontoDeRetomada,
  situacaoDoVideo,
  videosEmAndamento,
  zerarPosicao,
} from '../utils/progressoDosVideos';
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
/** De quanto em quanto tempo o ponto é guardado com o vídeo tocando. */
const INTERVALO_DE_GRAVACAO_MS = 3000;
const MAXIMO_EM_ANDAMENTO = 4;

const CartaoDeVideo = ({ video, idioma, destaque, registro, aoAbrir }) => {
  const { t } = useTranslation();
  const { capa } = arquivosDoVideo(video, idioma);
  const idiomaReal = idiomaDoVideo(video, idioma);
  const segundos = video.duracao?.[idiomaReal];
  const duracao = formatarDuracao(segundos);
  const { parouEm, fracao, assistido } = situacaoDoVideo(registro, idiomaReal, segundos);
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
        {fracao > 0 && (
          <span className="suporte-progresso" aria-hidden="true">
            <span style={{ width: `${Math.max(2, fracao * 100)}%` }} />
          </span>
        )}
      </span>
      <span className="suporte-texto">
        <span className="suporte-titulo">{titulo}</span>
        {parouEm > 0 && (
          <span className="suporte-parou">
            {t('support.stoppedAt', 'Você parou em {{time}}', { time: formatarDuracao(parouEm) })}
          </span>
        )}
        {assistido && parouEm === 0 && (
          <span className="suporte-assistido">
            <Icon name="check" size={14} /> {t('support.watched', 'Assistido')}
          </span>
        )}
        <span className="suporte-descricao">{textoNoIdioma(video.descricao, idioma)}</span>
      </span>
    </button>
  );
};

/**
 * O vídeo aberto. Retoma de onde a pessoa parou e guarda o ponto enquanto toca,
 * ao pausar e ao sair por qualquer caminho (X, Esc, voltar do navegador).
 */
const PlayerDeVideo = ({ video, idioma, usuario, aoMudarProgresso, aoFechar }) => {
  const { t } = useTranslation();
  const arquivos = arquivosDoVideo(video, idioma);
  const idiomaReal = idiomaDoVideo(video, idioma);
  const titulo = textoNoIdioma(video.titulo, idioma);
  // O treinamento passa de uma hora: os capítulos são o índice dele.
  const capitulos = video.capitulos?.[idiomaReal] || [];

  const elemento = useRef(null);
  const ponto = useRef(null);
  const gravadoEm = useRef(0);
  // Arrastar a barra de tempo e soltar fora do player vira um clique no fundo.
  const apertouNoFundo = useRef(false);
  const [capituloAtual, setCapituloAtual] = useState(-1);
  const [retomouEm, setRetomouEm] = useState(0);
  const [falhou, setFalhou] = useState(false);
  const [tentativa, setTentativa] = useState(0);

  const guardar = (extra) => {
    if (!ponto.current) return null;
    gravadoEm.current = Date.now();
    return gravarProgresso(usuario, video.id, { ...ponto.current, idioma: idiomaReal, ...extra });
  };
  const guardarEMostrar = (extra) => {
    const novo = guardar(extra);
    if (novo) aoMudarProgresso(novo);
  };

  // Ao desmontar o <video> já saiu da tela; por isso o ponto fica num ref. O
  // ref da função dá à limpeza a versão mais nova dela.
  const aoSair = useRef(guardarEMostrar);
  aoSair.current = guardarEMostrar;
  useEffect(() => () => aoSair.current(), []);

  const aoCarregar = (e) => {
    const inicio = pontoDeRetomada(lerProgresso(usuario)[video.id], idiomaReal, e.currentTarget.duration);
    if (inicio > 0) {
      e.currentTarget.currentTime = inicio;
      setRetomouEm(inicio);
    }
  };
  const aoTocar = (e) => {
    const { currentTime, duration } = e.currentTarget;
    ponto.current = { posicao: currentTime, duracao: duration };
    if (capitulos.length > 0) setCapituloAtual(capituloEm(capitulos, currentTime));
    if (Date.now() - gravadoEm.current >= INTERVALO_DE_GRAVACAO_MS) guardar();
  };
  const aoTerminar = () => {
    guardarEMostrar({ terminou: true });
    ponto.current = null;
  };

  const irPara = (inicio) => {
    const alvo = elemento.current;
    if (!alvo) return;
    alvo.currentTime = inicio;
    const tocando = alvo.play?.();
    if (tocando?.catch) tocando.catch(() => {});
  };
  const doInicio = () => {
    setRetomouEm(0);
    ponto.current = null;
    aoMudarProgresso(zerarPosicao(usuario, video.id));
    irPara(0);
  };
  const tentarDeNovo = () => {
    setFalhou(false);
    setTentativa((n) => n + 1);
  };

  return (
    <div
      className="modal-overlay"
      onMouseDown={(e) => { apertouNoFundo.current = e.target === e.currentTarget; }}
      onClick={(e) => { if (e.target === e.currentTarget && apertouNoFundo.current) aoFechar(); }}
    >
      <div className="modal suporte-player" role="dialog" aria-modal="true" aria-label={titulo}>
        <div className="modal-header">
          <h2>{titulo}</h2>
          <button
            type="button"
            className="close-btn"
            onClick={aoFechar}
            aria-label={t('support.close', 'Fechar')}
          >
            <span className="close-icon"></span>
          </button>
        </div>
        {/* `key` troca o elemento ao tentar de novo: só trocar o `src` do
            <source> não faz o navegador recarregar. */}
        <video
          key={tentativa}
          ref={elemento}
          className={`suporte-video${capitulos.length ? ' suporte-video--com-capitulos' : ''}`}
          controls
          autoPlay
          playsInline
          preload="metadata"
          poster={arquivos.capa}
          crossOrigin="anonymous"
          onLoadedMetadata={aoCarregar}
          onTimeUpdate={aoTocar}
          onPause={() => guardarEMostrar()}
          onEnded={aoTerminar}
          onError={() => setFalhou(true)}
        >
          {/* Com <source>, o erro de rede chega nele, e não no <video>. */}
          <source src={arquivos.video} type="video/mp4" onError={() => setFalhou(true)} />
          <track
            kind="subtitles"
            src={arquivos.legenda}
            srcLang={idiomaReal}
            label={t('support.subtitles', 'Legendas')}
          />
        </video>
        {falhou && (
          <div className="suporte-aviso" role="alert">
            <span>{t('support.loadError', 'Não foi possível carregar o vídeo. Confira a internet e tente de novo.')}</span>
            <button type="button" className="btn btn-secondary btn-small" onClick={tentarDeNovo}>
              {t('support.retry', 'Tentar de novo')}
            </button>
          </div>
        )}
        {retomouEm > 0 && !falhou && (
          <div className="suporte-aviso">
            <span>{t('support.resumedFrom', 'Continuando de {{time}}', { time: formatarDuracao(retomouEm) })}</span>
            <button type="button" className="btn btn-secondary btn-small" onClick={doInicio}>
              {t('support.startOver', 'Começar do início')}
            </button>
          </div>
        )}
        {capitulos.length > 0 && (
          <nav className="suporte-capitulos" aria-label={t('support.chapters', 'Capítulos')}>
            {capitulos.map((capitulo, i) => (
              <button
                key={capitulo.inicio}
                type="button"
                className={`suporte-capitulo${i === capituloAtual ? ' suporte-capitulo--atual' : ''}`}
                aria-current={i === capituloAtual ? 'true' : undefined}
                onClick={() => irPara(capitulo.inicio)}
              >
                <span className="suporte-capitulo-tempo">{formatarDuracao(capitulo.inicio)}</span>
                <span>{capitulo.titulo}</span>
              </button>
            ))}
          </nav>
        )}
      </div>
    </div>
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

  const { user } = useAuth();
  const usuario = user?.id;
  const [progresso, setProgresso] = useState({});
  useEffect(() => { setProgresso(lerProgresso(usuario)); }, [usuario]);

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

  const emAndamento = useMemo(
    () => videosEmAndamento(videos, progresso).slice(0, MAXIMO_EM_ANDAMENTO),
    [videos, progresso],
  );

  const aberto = videos.find((v) => v.id === params.get('video')) || null;
  const abrir = (id) => setParams({ video: id });

  const fechar = () => setParams({});
  useEscapeKey(!!aberto, fechar);

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

        {emAndamento.length > 0 && (
          <section className="suporte-secao">
            <h2>{t('support.continueWatching', 'Continuar assistindo')}</h2>
            <div className="suporte-grade">
              {emAndamento.map((video) => (
                <CartaoDeVideo
                  key={video.id}
                  video={video}
                  idioma={idioma}
                  registro={progresso[video.id]}
                  aoAbrir={abrir}
                />
              ))}
            </div>
          </section>
        )}

        {treinamentos.length > 0 && (
          <section className="suporte-secao">
            <h2>{t('support.training', 'Treinamento completo')}</h2>
            <div className="suporte-treinamentos">
              {treinamentos.map((video) => (
                <CartaoDeVideo
                  key={video.id}
                  video={video}
                  idioma={idioma}
                  destaque
                  registro={progresso[video.id]}
                  aoAbrir={abrir}
                />
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
                className="suporte-busca"
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
                  <CartaoDeVideo
                    key={video.id}
                    video={video}
                    idioma={idioma}
                    registro={progresso[video.id]}
                    aoAbrir={abrir}
                  />
                ))}
              </div>
            )}
          </section>
        )}

        {aberto && (
          <PlayerDeVideo
            key={`${aberto.id}-${idiomaDoVideo(aberto, idioma)}`}
            video={aberto}
            idioma={idioma}
            usuario={usuario}
            aoMudarProgresso={setProgresso}
            aoFechar={fechar}
          />
        )}
      </main>
    </div>
  );
};

export default Suporte;
