/**
 * A tela do telão, só apresentação: recebe modelo + configurações e desenha.
 * Testa-se o que o salão lê de longe — os sete tiles na ordem do mockup, o
 * anel acompanhando o nível, "100/200 (200)", a pílula do próximo nível, a
 * barra de prêmios — e o que pode ser desligado pela configuração.
 */
import { render, screen, within } from '@testing-library/react';
import TvScreen, { RING_C } from './TvScreen';
import { buildTvSettings } from './tvModel';
import { sampleModel } from './tvSampleData';
import BROADCAST_LABELS from '../../utils/broadcastLabels';
import { TV_ACCENT } from './tvDefaults';

const montar = (props = {}, dia = {}) => {
  const model = { ...sampleModel({ organizationName: 'Zonabet Poker' }), ...(props.model || {}) };
  const settings = buildTvSettings(dia);
  return render(<TvScreen mode="live" {...props} model={model} settings={settings} />);
};

const tiles = () => Array.from(document.querySelectorAll('.tv-tile'));
const tela = () => document.querySelector('.tv-screen');

describe('cabeçalho', () => {
  it('título = torneio + dia (o dia em destaque), logo AceBlind à esquerda', () => {
    montar();
    expect(screen.getByRole('heading')).toHaveTextContent('Main Event - Dia 1A');
    expect(document.querySelector('.tv-title-day')).toHaveTextContent('Dia 1A');
    expect(document.querySelector('.tv-logo-img')).toBeInTheDocument();
  });

  it('o nome do clube NÃO aparece em texto no canto direito (pedido do cliente)', () => {
    montar();
    expect(document.querySelector('.tv-club-name')).toBeNull();
    expect(document.querySelector('.tv-header')).not.toHaveTextContent('Zonabet Poker');
  });

  it('nome personalizado substitui os dois', () => {
    montar({}, { broadcast_display_name: 'FINAL TABLE' });
    expect(screen.getByRole('heading')).toHaveTextContent('FINAL TABLE');
    expect(document.querySelector('.tv-title-day')).toBeNull();
  });

  it('logo do clube só quando o diretor enviou um, com escala', () => {
    montar({}, { broadcast_club_logo_url: 'https://cdn/l.png', broadcast_club_logo_size: 200 });
    expect(document.querySelector('.tv-club-logo-img')).toHaveAttribute('src', 'https://cdn/l.png');
    expect(document.querySelector('.tv-club-logo').style.getPropertyValue('--club-logo-scale')).toBe('2');
    document.body.innerHTML = '';
    montar({}, { broadcast_club_logo_url: 'https://cdn/l.png', broadcast_show_club_logo: false });
    expect(document.querySelector('.tv-club-logo-img')).toBeNull();
  });

  it('sem logo do clube o espaço da direita fica reservado (título segue no centro)', () => {
    montar();
    expect(document.querySelector('.tv-club-logo')).toBeInTheDocument();
    expect(document.querySelector('.tv-club-logo').textContent).toBe('');
  });

  it('logo AceBlind e título podem ser desligados', () => {
    montar({}, { broadcast_show_logo: false, broadcast_show_title: false });
    expect(document.querySelector('.tv-logo')).toBeNull();
    expect(document.querySelector('.tv-title')).toBeNull();
  });
});

describe('tiles', () => {
  it('os sete, na ordem do mockup, com os valores formatados', () => {
    montar();
    const rotulos = tiles().map((t) => t.querySelector('.tv-tile-label').textContent);
    expect(rotulos).toEqual(['NÍVEL', 'JOGADORES', 'ENTRADAS', 'REENTRADAS', 'INTERVALO EM', 'CHIP COUNT', 'MÉDIA']);
    const valores = tiles().map((t) => t.querySelector('.tv-tile-value').textContent);
    expect(valores).toEqual(['5', '45 de 120', '165', '6', '18:32', '1.650.000', '36.667']);
  });

  it('"NÍVEL 5" é o único tile de linha única, como no mockup', () => {
    montar();
    expect(document.querySelector('.tv-tile--level')).toHaveClass('tv-tile--inline');
    expect(document.querySelectorAll('.tv-tile--inline').length).toBe(1);
  });

  it('reentradas nasce ligada e pode ser desligada', () => {
    montar();
    expect(document.querySelector('.tv-tile--reentries')).toBeInTheDocument();
    document.body.innerHTML = '';
    montar({}, { broadcast_show_reentries: false });
    expect(document.querySelector('.tv-tile--reentries')).toBeNull();
  });

  it('entradas e reentradas zeradas continuam na coluna (com 0); chipcount zero e sem intervalo à vista somem', () => {
    // A coluna tem a mesma forma do começo ao fim do torneio — o cliente,
    // com reentradas ligadas e nenhuma recompra ainda, não via o tile.
    montar({ model: { entries: 0, reentries: 0, chipcount: 0, averageStack: 0, breakIn: null } });
    expect(document.querySelector('.tv-tile--entries .tv-tile-value')).toHaveTextContent('0');
    expect(document.querySelector('.tv-tile--reentries .tv-tile-value')).toHaveTextContent('0');
    const kinds = tiles().map((t) => t.className);
    expect(kinds.join(' ')).not.toMatch(/chips|average|break/);
    expect(document.querySelector('.tv-tile--players')).toBeInTheDocument();
  });

  it('chipcount e média são do dia (não existem no legado)', () => {
    montar({ model: { isDayBased: false } });
    expect(document.querySelector('.tv-tile--chips')).toBeNull();
    expect(document.querySelector('.tv-tile--average')).toBeNull();
  });

  it('desligar tudo remove a coluna inteira e o relógio ocupa o centro', () => {
    montar({}, {
      broadcast_show_level: false, broadcast_show_players: false, broadcast_show_reentries: false,
      broadcast_show_interval: false, broadcast_show_chipcount: false, broadcast_show_average: false,
    });
    expect(document.querySelector('.tv-tiles')).toBeNull();
    expect(document.querySelector('.tv-live')).toHaveClass('tv-live--no-tiles');
  });

  it('rótulos seguem o idioma do telão', () => {
    montar({ labels: BROADCAST_LABELS.es });
    expect(tiles()[0]).toHaveTextContent('NIVEL');
    expect(tiles()[1]).toHaveTextContent('JUGADORES');
    expect(document.querySelector('.tv-prizes-label')).toHaveTextContent('PREMIOS');
  });
});

describe('relógio, anel, blinds e próximo nível', () => {
  it('relógio em MM:SS e anel na fração decorrida do nível', () => {
    montar({ model: { timeRemaining: 300, levelDuration: 1200 } });
    expect(document.querySelector('.tv-clock')).toHaveTextContent('05:00');
    const arco = document.querySelector('.tv-ring-progress');
    expect(parseFloat(arco.getAttribute('stroke-dashoffset'))).toBeCloseTo(RING_C * 0.25, 3);
  });

  it('sem duração conhecida o anel fica vazio (nunca NaN)', () => {
    montar({ model: { levelDuration: null } });
    const off = document.querySelector('.tv-ring-progress').getAttribute('stroke-dashoffset');
    expect(parseFloat(off)).toBeCloseTo(RING_C, 3);
  });

  it('tempo além da duração trava o anel em cheio', () => {
    montar({ model: { timeRemaining: 0, levelDuration: 100 } });
    expect(parseFloat(document.querySelector('.tv-ring-progress').getAttribute('stroke-dashoffset'))).toBe(0);
  });

  it('pausado marca o relógio', () => {
    montar({ model: { isPaused: true } });
    expect(document.querySelector('.tv-clock-wrap')).toHaveClass('tv-clock-wrap--paused');
  });

  it('"Ante" acima de 100/200 (200)', () => {
    montar();
    expect(document.querySelector('.tv-blinds-label')).toHaveTextContent('ANTE');
    expect(document.querySelector('.tv-blinds')).toHaveTextContent('100/200');
    expect(document.querySelector('.tv-ante')).toHaveTextContent('(200)');
  });

  it('sem ante o rótulo volta a ser BLINDS e o parêntese some', () => {
    montar({ model: { blinds: { sb: 25, bb: 50, ante: 0 } } });
    expect(document.querySelector('.tv-blinds-label')).toHaveTextContent('BLINDS');
    expect(document.querySelector('.tv-ante')).toBeNull();
  });

  it('ante desligado esconde só o parêntese; blinds desligado esconde só o 100/200', () => {
    montar({}, { broadcast_show_ante: false });
    expect(document.querySelector('.tv-blinds')).toBeInTheDocument();
    expect(document.querySelector('.tv-ante')).toBeNull();
    document.body.innerHTML = '';
    montar({}, { broadcast_show_blinds: false });
    expect(document.querySelector('.tv-blinds')).toBeNull();
    expect(document.querySelector('.tv-ante')).toHaveTextContent('200');
  });

  it('pílula do próximo nível: valor, intervalo ou travessão', () => {
    montar();
    expect(document.querySelector('.tv-next')).toHaveTextContent('PRÓXIMO:');
    expect(document.querySelector('.tv-next-value')).toHaveTextContent('200/400 (400)');
    document.body.innerHTML = '';
    montar({ model: { nextBlind: { level: 6, sb: 1, bb: 2, ante: 0, isBreak: true } } });
    expect(document.querySelector('.tv-next-value')).toHaveTextContent('INTERVALO');
    document.body.innerHTML = '';
    montar({ model: { nextBlind: null } });
    expect(document.querySelector('.tv-next-value')).toHaveTextContent('—');
    document.body.innerHTML = '';
    montar({ model: { nextBlind: { level: 2, sb: 50, bb: 100, ante: 0, isBreak: false } } });
    expect(document.querySelector('.tv-next-value')).toHaveTextContent('50/100');
    expect(document.querySelector('.tv-next-value')).not.toHaveTextContent('(');
  });

  it('relógio e próximo nível podem ser desligados', () => {
    montar({}, { broadcast_show_timer: false, broadcast_show_next_blind: false });
    expect(document.querySelector('.tv-clock')).toBeNull();
    expect(document.querySelector('.tv-ring')).toBeNull();
    expect(document.querySelector('.tv-next')).toBeNull();
  });
});

describe('prêmios', () => {
  it('barra inferior: selo, prize pool primeiro e as faixas na moeda do clube', () => {
    montar({ currency: 'PEN' });
    const barra = document.querySelector('.tv-prizes-bar');
    expect(barra).toHaveTextContent('PREMIAÇÕES');
    expect(document.querySelector('.tv-pool')).toHaveTextContent('PRIZEPOOL');
    // Sol peruano formata como no mockup do cliente: "S/ 15,000.00".
    expect(document.querySelector('.tv-pool-value')).toHaveTextContent('S/ 34,300.00');
    const itens = Array.from(barra.querySelectorAll('.tv-prize-item'));
    expect(itens.length).toBe(5);
    expect(itens[0]).toHaveTextContent('1º Lugar');
    expect(itens[0]).toHaveTextContent('S/ 15,000.00');
    expect(document.querySelector('.tv-prizes-track')).not.toHaveClass('scrolling');
  });

  it('moeda padrão é BRL', () => {
    montar();
    expect(document.querySelector('.tv-pool-value')).toHaveTextContent('R$ 34.300,00');
  });

  it('a faixa só rola quando não cabe (forçado no teste), duplicando a lista', () => {
    montar({ forceScroll: true });
    expect(document.querySelector('.tv-prizes-track')).toHaveClass('scrolling');
    expect(document.querySelectorAll('.tv-prize-item').length).toBe(10);
  });

  it('rola sozinha quando a medição diz que transborda', () => {
    const sw = jest.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockReturnValue(3000);
    const cw = jest.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(1000);
    montar();
    expect(document.querySelector('.tv-prizes-track')).toHaveClass('scrolling');
    sw.mockRestore();
    cw.mockRestore();
  });

  it('prêmio do tipo vaga sem valor mostra VAGA', () => {
    montar({ model: { prizes: [{ position: 1, prize_amount: 0, prize_type: 'vaga' }] } });
    expect(document.querySelector('.tv-prize-val')).toHaveTextContent('VAGA');
  });

  it('layout lateral troca a barra por uma coluna, com o pool no topo', () => {
    montar({}, { broadcast_prizes_layout: 'sidebar' });
    expect(document.querySelector('.tv-prizes-bar')).toBeNull();
    const coluna = document.querySelector('.tv-prizes-sidebar');
    expect(coluna).toBeInTheDocument();
    expect(within(coluna).getByText('PRIZEPOOL')).toBeInTheDocument();
    expect(document.querySelectorAll('.tv-prizes-sidebar-row').length).toBe(5);
    expect(document.querySelector('.tv-prizes-sidebar-list')).not.toHaveClass('scrolling');
    expect(tela()).toHaveClass('tv-screen--with-sidebar');
  });

  it('coluna com mais de 8 faixas rola, com a lista duplicada', () => {
    // Valores distintos: iguais e consecutivos virariam UMA faixa ("1º–10º").
    const muitos = Array.from({ length: 10 }, (_, i) => ({ position: i + 1, prize_amount: 1000 - i * 50 }));
    montar({ model: { prizes: muitos } }, { broadcast_prizes_layout: 'sidebar' });
    expect(document.querySelector('.tv-prizes-sidebar-list')).toHaveClass('scrolling');
    expect(document.querySelectorAll('.tv-prizes-sidebar-row').length).toBe(20);
  });

  it('sem prêmios e sem pool a região some; só pool mantém a barra', () => {
    montar({ model: { prizes: [] } }, { broadcast_show_prizepool: false });
    expect(document.querySelector('.tv-prizes-bar')).toBeNull();
    document.body.innerHTML = '';
    montar({ model: { prizes: [] } });
    expect(document.querySelector('.tv-prizes-bar')).toBeInTheDocument();
    expect(document.querySelector('.tv-prize-item')).toBeNull();
  });

  it('prêmios desligados escondem as faixas mas não o pool', () => {
    montar({}, { broadcast_show_prizes: false });
    expect(document.querySelector('.tv-prize-item')).toBeNull();
    expect(document.querySelector('.tv-pool')).toBeInTheDocument();
  });

  it('no intervalo a região de prêmios sai da tela', () => {
    montar({ mode: 'break' });
    expect(document.querySelector('.tv-prizes-bar')).toBeNull();
    expect(document.querySelector('.tv-pool')).toBeNull();
  });
});

describe('intervalo', () => {
  const noIntervalo = (dia = {}, model = {}) => montar(
    { mode: 'break', model: { isBreak: true, timeRemaining: 305, nextBlind: { level: 5, sb: 800, bb: 1600, ante: 0 }, ...model } },
    dia,
  );

  it('troca a tela: sem relógio grande, com o tempo que falta e o nível seguinte', () => {
    noIntervalo();
    expect(document.querySelector('.tv-clock')).toBeNull();
    expect(document.querySelector('.tv-break')).toHaveClass('split');
    expect(document.querySelector('.tv-break-timer')).toHaveTextContent('05:05');
    expect(document.querySelector('.tv-break-info')).toHaveTextContent('Nível 5: 800/1.600');
    expect(document.querySelector('.tv-break-info')).not.toHaveTextContent('(0)');
  });

  it.each(['split', 'fullscreen', 'overlay'])('layout %s', (layout) => {
    noIntervalo({ broadcast_break_layout: layout });
    expect(document.querySelector('.tv-break')).toHaveClass(layout);
  });

  it('layout desconhecido cai no split', () => {
    noIntervalo({ broadcast_break_layout: 'xyz' });
    expect(document.querySelector('.tv-break')).toHaveClass('split');
  });

  it('vídeo do YouTube embutido, mudo por padrão; sem vídeo fica o placeholder', () => {
    noIntervalo({ broadcast_break_youtube_url: 'https://youtu.be/dQw4w9WgXcQ' });
    const v = document.querySelector('.tv-break-video');
    expect(v.getAttribute('src')).toContain('youtube.com/embed/dQw4w9WgXcQ');
    expect(v.getAttribute('src')).toContain('mute=1');
    document.body.innerHTML = '';
    noIntervalo({ broadcast_break_youtube_url: 'https://exemplo.com/x' });
    expect(document.querySelector('.tv-break-video')).toBeNull();
    expect(document.querySelector('.tv-break-video-placeholder')).toBeInTheDocument();
  });

  it('vídeo com som e nos layouts de fundo', () => {
    noIntervalo({ broadcast_break_youtube_url: 'https://youtu.be/dQw4w9WgXcQ', broadcast_break_video_muted: false, broadcast_break_layout: 'fullscreen' });
    expect(document.querySelector('.tv-break-video-bg').getAttribute('src')).toContain('mute=0');
    document.body.innerHTML = '';
    noIntervalo({ broadcast_break_youtube_url: 'https://youtu.be/dQw4w9WgXcQ', broadcast_break_layout: 'overlay' });
    expect(document.querySelector('.tv-break-video-bg')).toBeInTheDocument();
  });

  it('desligar o vídeo mantém o painel', () => {
    noIntervalo({ broadcast_break_youtube_url: 'https://youtu.be/dQw4w9WgXcQ', broadcast_break_show_video: false });
    expect(document.querySelector('.tv-break-video')).toBeNull();
    expect(document.querySelector('.tv-break-timer')).toBeInTheDocument();
  });

  it('cada informação pode ser desligada', () => {
    noIntervalo({
      broadcast_break_show_next_level: false, broadcast_break_show_players: false,
      broadcast_break_show_chipcount: false, broadcast_break_show_average: false,
    });
    expect(document.querySelectorAll('.tv-break-stat').length).toBe(0);
    document.body.innerHTML = '';
    noIntervalo();
    expect(document.querySelectorAll('.tv-break-stat').length).toBe(4);
  });

  it('fundo do intervalo e opacidade viram estilo do painel', () => {
    noIntervalo({ broadcast_break_bg_image_url: 'https://cdn/b.webp', broadcast_break_overlay_opacity: 50, broadcast_break_font_size: 120 });
    const sec = document.querySelector('.tv-break');
    expect(sec.style.backgroundImage).toBe('url(https://cdn/b.webp)');
    expect(sec.style.getPropertyValue('--tv-break-overlay')).toBe('0.50');
    expect(sec.style.getPropertyValue('--tv-break-fs')).toBe('1.2');
  });
});

describe('encerrado', () => {
  it('mostra o encerramento com o total de jogadores e mantém os prêmios', () => {
    montar({ mode: 'completed', model: { totalPlayers: 2 } });
    expect(document.querySelector('.tv-completed')).toHaveTextContent('ENCERRADO');
    expect(within(document.querySelector('.tv-completed-stats')).getByText('2')).toBeInTheDocument();
    expect(document.querySelector('.tv-prizes-bar')).toBeInTheDocument();
    expect(document.querySelector('.tv-clock')).toBeNull();
  });
});

describe('cores e tamanhos', () => {
  it('as cores salvas viram variáveis; o valor dos tiles é o destaque do tema', () => {
    montar({}, { broadcast_timer_color: '#ff0000', broadcast_sidebar_value_color: '#00ff00' });
    expect(tela().style.getPropertyValue('--tv-c-timer')).toBe('#ff0000');
    expect(tela().style.getPropertyValue('--tv-accent')).toBe('#00ff00');
    expect(tela().style.getPropertyValue('--tv-accent-deep')).toBe('#00d100');
  });

  it('sem cor salva o padrão é o dourado', () => {
    montar();
    expect(tela().style.getPropertyValue('--tv-accent')).toBe(TV_ACCENT);
  });

  it('fonte e escalas de prêmio viram multiplicadores', () => {
    montar({ fontScale: 1.3 }, { broadcast_prize_size: 150, broadcast_prizepool_size: 80, broadcast_title_size: 180 });
    expect(tela().style.getPropertyValue('--tv-font')).toBe('1.3');
    expect(tela().style.getPropertyValue('--tv-title')).toBe('1.8');   // título em separado
    expect(tela().style.getPropertyValue('--tv-prize')).toBe('1.5');
    expect(tela().style.getPropertyValue('--tv-pool')).toBe('0.8');
  });

  it('sem fontScale usa a fonte das configurações', () => {
    montar({}, { broadcast_font_size: 120 });
    expect(tela().style.getPropertyValue('--tv-font')).toBe('1.2');
  });

  it('sem settings usa os padrões e sem labels usa o idioma das settings', () => {
    render(<TvScreen model={sampleModel()} settings={buildTvSettings({ broadcast_language: 'en' })} />);
    expect(tiles()[0]).toHaveTextContent('LEVEL');
  });
});

/**
 * Divulgação na coluna da direita: a coluna que antes só equilibrava o relógio
 * passa a mostrar a peça do clube (imagem, vídeo direto ou YouTube), quando o
 * diretor liga e preenche. Com a premiação na lateral, as duas dividem a coluna.
 */
describe('divulgação (coluna da direita)', () => {
  const YT = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';

  it('imagem: aparece na coluna da direita e a grade ganha o contrapeso', () => {
    montar({}, { broadcast_promo_url: 'https://cdn/flyer.webp' });
    const promo = document.querySelector('.tv-side .tv-promo');
    expect(promo).toHaveClass('tv-promo--image');
    expect(promo.querySelector('img')).toHaveAttribute('src', 'https://cdn/flyer.webp');
    expect(promo.querySelector('img').style.objectFit).toBe('contain');
    expect(tela()).toHaveClass('tv-screen--with-side');
  });

  it('ajuste "cover" preenche a coluna', () => {
    montar({}, { broadcast_promo_url: 'https://cdn/flyer.webp', broadcast_promo_fit: 'cover' });
    expect(document.querySelector('.tv-promo')).toHaveClass('tv-promo--cover');
    expect(document.querySelector('.tv-promo img').style.objectFit).toBe('cover');
  });

  it('vídeo direto toca em loop, mudo e sem controles', () => {
    montar({}, { broadcast_promo_url: 'https://cdn/promo.mp4?v=2' });
    const video = document.querySelector('.tv-promo--video video');
    expect(video).toHaveAttribute('src', 'https://cdn/promo.mp4?v=2');
    expect(video).toHaveAttribute('autoplay');
    expect(video).toHaveAttribute('loop');
    expect(video.muted).toBe(true);
  });

  it('YouTube vira embed em loop e mudo', () => {
    montar({}, { broadcast_promo_url: YT });
    const frame = document.querySelector('.tv-promo--youtube iframe');
    expect(frame.getAttribute('src')).toContain('youtube.com/embed/dQw4w9WgXcQ');
    expect(frame.getAttribute('src')).toContain('mute=1');
    expect(frame.getAttribute('src')).toContain('loop=1');
  });

  it('desligada ou sem URL, a coluna some e a grade volta ao contrapeso vazio', () => {
    montar({}, { broadcast_promo_url: 'https://cdn/flyer.webp', broadcast_show_promo: false });
    expect(document.querySelector('.tv-promo')).toBeNull();
    expect(tela()).not.toHaveClass('tv-screen--with-side');
    document.body.innerHTML = '';
    montar({}, { broadcast_promo_url: '   ' });
    expect(document.querySelector('.tv-promo')).toBeNull();
  });

  it('com a premiação na lateral, as duas dividem a coluna da direita', () => {
    montar({}, { broadcast_promo_url: 'https://cdn/flyer.webp', broadcast_prizes_layout: 'sidebar' });
    const side = document.querySelector('.tv-side');
    expect(side.querySelector('.tv-promo')).toBeInTheDocument();
    expect(side.querySelector('.tv-prizes-sidebar')).toBeInTheDocument();
    expect(document.querySelectorAll('.tv-prizes-sidebar').length).toBe(1);
  });

  it('no intervalo não aparece (a tela de intervalo tem o próprio vídeo)', () => {
    montar({ mode: 'break' }, { broadcast_promo_url: 'https://cdn/flyer.webp' });
    expect(document.querySelector('.tv-promo')).toBeNull();
  });
});

/**
 * Faixas de premiação: o cadastro é uma linha por colocação (cada uma paga a
 * um jogador), mas o telão agrupa as consecutivas de mesmo prêmio — "7º–9º
 * Lugar : S/ 400", não 7º, 8º e 9º repetidos.
 */
describe('faixas de premiação', () => {
  const FAIXAS = [
    { position: 1, prize_amount: 1000 }, { position: 2, prize_amount: 500 },
    { position: 3, prize_amount: 300 }, { position: 4, prize_amount: 300 }, { position: 5, prize_amount: 300 },
    { position: 6, prize_amount: 100 },
  ];

  it('na barra, 3º–5º é um item só', () => {
    montar({ model: { prizes: FAIXAS }, currency: 'PEN' });
    const itens = Array.from(document.querySelectorAll('.tv-prize-item'));
    expect(itens).toHaveLength(4);
    expect(itens[2]).toHaveTextContent('3º–5º Lugar');
    expect(itens[2]).toHaveTextContent('S/ 300.00');
    expect(document.querySelector('.tv-prizes-bar')).not.toHaveTextContent('4º Lugar');
  });

  it('na coluna lateral também', () => {
    montar({ model: { prizes: FAIXAS } }, { broadcast_prizes_layout: 'sidebar' });
    const linhas = Array.from(document.querySelectorAll('.tv-prizes-sidebar-row'));
    expect(linhas).toHaveLength(4);
    expect(linhas[2]).toHaveTextContent('3º–5º Lugar');
  });

  it('em inglês e espanhol a faixa segue o idioma', () => {
    montar({ model: { prizes: FAIXAS }, labels: BROADCAST_LABELS.en });
    expect(document.querySelector('.tv-prizes-bar')).toHaveTextContent('3rd–5th Place');
    document.body.innerHTML = '';
    montar({ model: { prizes: FAIXAS }, labels: BROADCAST_LABELS.es });
    expect(document.querySelector('.tv-prizes-bar')).toHaveTextContent('3º–5º Puesto');
  });
});

/**
 * Meios de entrada abaixo dos blinds: "BUY-IN: 50 · REBUY: 20 · ADD-ON: 50",
 * só quando o diretor liga (nasce desligado) e o torneio tem a lista.
 */
describe('meios de entrada (linha abaixo dos blinds)', () => {
  it('nasce desligado: nada aparece sem o interruptor', () => {
    montar();
    expect(document.querySelector('.tv-buytypes')).toBeNull();
    expect(tela()).not.toHaveClass('tv-screen--with-buytypes');
  });

  it('ligado, lista nome e QUANTIDADE de vendas de cada meio, na ordem (não o valor)', () => {
    montar({}, { broadcast_show_buy_types: true });
    const itens = Array.from(document.querySelectorAll('.tv-buytype'));
    expect(itens.map((i) => i.textContent)).toEqual(['Buy-in:120', 'Rebuy:40', 'Add-on:55']);
    expect(document.querySelector('.tv-buytypes')).not.toHaveTextContent('50');
    expect(tela()).toHaveClass('tv-screen--with-buytypes');
  });

  it('ligado, os tiles "Entradas" e "Reentradas" saem da lateral (é a mesma conta, aberta por meio)', () => {
    montar({}, { broadcast_show_buy_types: true, broadcast_show_entries: true, broadcast_show_reentries: true });
    expect(document.querySelector('.tv-tile--entries')).toBeNull();
    expect(document.querySelector('.tv-tile--reentries')).toBeNull();
    expect(document.querySelector('.tv-tile--players')).toBeInTheDocument();
  });

  it('contagem grande vem com separador de milhar; sem lista a linha some', () => {
    montar({ model: { buyTypes: [{ name: 'Buy-in', count: 1500, amount: 50, category: 'buy_in' }] } }, { broadcast_show_buy_types: true });
    expect(document.querySelector('.tv-buytype-amount')).toHaveTextContent('1.500');
    document.body.innerHTML = '';
    montar({ model: { buyTypes: [] } }, { broadcast_show_buy_types: true });
    expect(document.querySelector('.tv-buytypes')).toBeNull();
  });

  it('no intervalo e no encerrado não aparece', () => {
    montar({ mode: 'break' }, { broadcast_show_buy_types: true });
    expect(document.querySelector('.tv-buytypes')).toBeNull();
    document.body.innerHTML = '';
    montar({ mode: 'completed' }, { broadcast_show_buy_types: true });
    expect(document.querySelector('.tv-buytypes')).toBeNull();
  });

  it('o tile "Entradas" tem interruptor próprio', () => {
    montar({}, { broadcast_show_entries: false });
    expect(document.querySelector('.tv-tile--entries')).toBeNull();
    expect(document.querySelector('.tv-tile--players')).toBeInTheDocument();
  });
});
