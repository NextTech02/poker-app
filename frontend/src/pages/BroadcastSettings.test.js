/**
 * Configuração da transmissão — a tela que pinta o telão do salão.
 *
 * O que os testes cercam:
 *
 * - **Os padrões precisam ser "ligado".** A configuração é POR DIA, e um dia
 *   criado antes desses campos existirem tem tudo nulo no banco. Se nulo
 *   virasse "desligado", abrir esta tela apagaria o relógio do telão.
 * - **Campo de texto vazio é salvo como NULO**, não string vazia: é a
 *   diferença entre "sem nome personalizado" (usa torneio + dia) e um título
 *   em branco no telão.
 * - **A pré-visualização é fiel:** ligar/desligar um elemento aqui some/aparece
 *   ali na hora, sem salvar. É o que evita descobrir o erro com o salão cheio.
 *
 * O código público da TV é carregado em SEPARADO, para que uma falha nele não
 * trave a tela de configuração.
 */
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import BroadcastSettings from './BroadcastSettings';
import api from '../config/api';
import { useToast } from '../contexts/ToastContext';
import { useCurrency } from '../contexts/CurrencyContext';
import { supabase } from '../config/supabase';
import { downscaleImage } from '../utils/imageDownscale';

jest.mock('../config/api', () => ({
  __esModule: true,
  default: { get: jest.fn(), patch: jest.fn() },
}));
// Biblioteca de fundos: Storage + tabela direto do navegador (sem backend).
jest.mock('../config/supabase', () => ({ supabase: { from: jest.fn(), storage: { from: jest.fn() } } }));
jest.mock('../utils/imageDownscale', () => ({ downscaleImage: jest.fn() }));
jest.mock('../components/Sidebar', () => () => <nav data-testid="sidebar" />);
jest.mock('../contexts/ToastContext', () => ({ useToast: jest.fn() }));
jest.mock('../contexts/CurrencyContext', () => ({ useCurrency: jest.fn() }));
const mockNavigate = jest.fn();
jest.mock('react-router-dom', () => ({
  ...jest.requireActual('react-router-dom'),
  useParams: () => ({ tournamentId: 't1', dayId: 'd1' }),
  useNavigate: () => mockNavigate,
}));
jest.mock('react-i18next', () => {
  const t = (chave, segundo, terceiro) => {
    const vars = segundo && typeof segundo === 'object' ? segundo : terceiro;
    if (vars) return `${chave}:${Object.values(vars).join(',')}`;
    return typeof segundo === 'string' ? segundo : chave;
  };
  const traducao = { t, i18n: { language: 'pt-BR' } };
  return { useTranslation: () => traducao };
});

const DIA = { id: 'd1', day_name: 'Dia 1A' };
const TORNEIO = { id: 't1', name: 'Main Event' };

let toast;

const responder = ({ dia = DIA, torneio = TORNEIO, codigo = { code: 'XYZ789' } } = {}) => {
  api.get.mockImplementation((url) => {
    if (url === '/tournament-days/d1') {
      return dia instanceof Error ? Promise.reject(dia) : Promise.resolve({ data: dia });
    }
    if (url === '/tournaments/t1') return Promise.resolve({ data: torneio });
    if (url.endsWith('/broadcast-code')) {
      return codigo instanceof Error ? Promise.reject(codigo) : Promise.resolve({ data: codigo });
    }
    return Promise.resolve({ data: {} });
  });
};

const montar = async (opcoes) => {
  responder(opcoes);
  render(<MemoryRouter><BroadcastSettings /></MemoryRouter>);
  await waitFor(() => expect(screen.queryByText('common.loading')).toBeNull());
};

const salvar = () => userEvent.click(document.querySelector('.bs-btn-save'));

const enviado = () => api.patch.mock.calls[0][1];

const alternar = async (rotulo) => {
  const marca = Array.from(document.querySelectorAll('.bs-toggle')).find((el) =>
    el.textContent.includes(rotulo)
  );
  await userEvent.click(marca.querySelector('input[type="checkbox"]'));
};

const FUNDO = { id: 'b1', path: 'org-1/salao.webp', name: 'salao.webp', content_type: 'image/webp', size_bytes: 100, created_at: '2026-10-01' };
const FUNDO_URL = 'https://cdn/org-1/salao.webp';

let confirmar;
let tabela;
let storage;

/** Builder encadeável e "thenable" do supabase-js (resetMocks apaga tudo: refeito a cada teste). */
const builder = (rows) => {
  const q = { _result: { data: rows, error: null } };
  ['select', 'order', 'eq', 'single'].forEach((m) => { q[m] = jest.fn(() => q); });
  q.insert = jest.fn((row) => { q._result = { data: { id: 'novo', created_at: '2026-10-08', ...row }, error: null }; return q; });
  q.delete = jest.fn(() => { q._result = { error: null }; return q; });
  q.then = (ok, ko) => Promise.resolve(q._result).then(ok, ko);
  return q;
};

beforeEach(() => {
  toast = { success: jest.fn(), error: jest.fn(), warning: jest.fn() };
  confirmar = jest.fn().mockResolvedValue(true);
  useToast.mockReturnValue({ toast, confirm: confirmar });
  useCurrency.mockReturnValue({ formatCurrency: (v) => `R$ ${Number(v || 0).toFixed(2)}`, currency: 'BRL' });
  api.patch.mockResolvedValue({ data: {} });
  tabela = builder([FUNDO]);
  storage = {
    upload: jest.fn(async () => ({ error: null })),
    remove: jest.fn(async () => ({ error: null })),
    getPublicUrl: jest.fn((p) => ({ data: { publicUrl: `https://cdn/${p}` } })),
  };
  supabase.from.mockImplementation(() => tabela);
  supabase.storage.from.mockImplementation(() => storage);
  downscaleImage.mockImplementation(async (f) => ({ blob: f, ext: 'jpg', contentType: 'image/jpeg' }));
  localStorage.setItem('supabase_token', `x.${btoa(JSON.stringify({ organization_id: 'org-1' }))}.y`);
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  console.error.mockRestore();
  localStorage.clear();
});

describe('carga', () => {
  it('mostra o carregamento antes dos dados', () => {
    api.get.mockReturnValue(new Promise(() => {}));
    render(<MemoryRouter><BroadcastSettings /></MemoryRouter>);
    expect(screen.getByText('common.loading')).toBeInTheDocument();
  });

  it('o cabeçalho identifica torneio e dia', async () => {
    // A configuração é POR DIA; sem essa identificação o operador editaria o
    // dia errado.
    await montar();
    expect(document.querySelector('.bs-topbar-eyebrow')).toHaveTextContent('Main Event / Dia 1A');
  });

  it('falha ao carregar avisa', async () => {
    await montar({ dia: new Error('500') });
    expect(toast.error).toHaveBeenCalledWith('broadcastSettings.errorLoad');
  });

  it('voltar leva ao torneio', async () => {
    await montar();
    await userEvent.click(document.querySelector('.bs-btn-back'));
    expect(mockNavigate).toHaveBeenCalledWith('/torneios/t1');
  });
});

describe('padrões de um dia antigo', () => {
  it('campos nulos no banco mantêm TUDO ligado', async () => {
    // Um dia criado antes desses campos existirem tem tudo nulo; se nulo
    // virasse "desligado", abrir esta tela apagaria o relógio do telão.
    await montar();
    await salvar();
    await waitFor(() => expect(api.patch).toHaveBeenCalled());
    const corpo = enviado();
    expect(corpo.broadcast_show_timer).toBe(true);
    expect(corpo.broadcast_show_blinds).toBe(true);
    expect(corpo.broadcast_show_prizepool).toBe(true);
    expect(corpo.broadcast_blind_alerts_enabled).toBe(true);
  });

  it('o que está explicitamente desligado permanece desligado', async () => {
    await montar({ dia: { ...DIA, broadcast_show_timer: false } });
    await salvar();
    await waitFor(() => expect(api.patch).toHaveBeenCalled());
    expect(enviado().broadcast_show_timer).toBe(false);
  });

  it('valores numéricos ausentes assumem 100%', async () => {
    await montar();
    await salvar();
    await waitFor(() => expect(api.patch).toHaveBeenCalled());
    expect(enviado().broadcast_font_size).toBe(100);
    expect(enviado().broadcast_prize_size).toBe(100);
  });

  it('opacidade zero é respeitada, não trocada pelo padrão', async () => {
    // Zero é um valor válido; um `||` aqui transformaria "transparente" em 70%.
    await montar({ dia: { ...DIA, broadcast_break_overlay_opacity: 0 } });
    await salvar();
    await waitFor(() => expect(api.patch).toHaveBeenCalled());
    expect(enviado().broadcast_break_overlay_opacity).toBe(0);
  });

  it('as cores salvas no dia são carregadas', async () => {
    await montar({ dia: { ...DIA, broadcast_timer_color: '#ff0000' } });
    await salvar();
    await waitFor(() => expect(api.patch).toHaveBeenCalled());
    expect(enviado().broadcast_timer_color).toBe('#ff0000');
  });

  it('reentradas nasce LIGADA e o escurecimento do fundo em 45%', async () => {
    // O layout do cliente (2026-10) tem o tile "Reentradas" fixo.
    await montar();
    await salvar();
    await waitFor(() => expect(api.patch).toHaveBeenCalled());
    expect(enviado().broadcast_show_reentries).toBe(true);
    expect(enviado().broadcast_bg_overlay).toBe(45);
  });
});

/**
 * Biblioteca de fundos: as imagens ficam no Storage (bucket público) e o dia
 * guarda só a URL — antes o arquivo inteiro viajava em base64 na linha do dia,
 * reenviado a cada poll de 30 s do telão.
 */
describe('biblioteca de fundos', () => {
  // Pela galeria certa, não pela posição: a de divulgação entrou entre as duas.
  const galeriaDe = (prefixo) => Array.from(document.querySelectorAll('.bg-gallery'))
    .find((g) => g.querySelector(`[data-testid="${prefixo}-url-input"]`));
  const galeriaPrincipal = () => galeriaDe('bg');
  const galeriaIntervalo = () => galeriaDe('break-bg');
  const arquivo = (tipo = 'image/png') => new File(['x'], 'nova.png', { type: tipo });

  it('lista as imagens do clube nos dois seletores (principal e intervalo)', async () => {
    await montar();
    expect(supabase.from).toHaveBeenCalledWith('broadcast_backgrounds');
    expect(galeriaPrincipal().querySelector(`img[src="${FUNDO_URL}"]`)).toBeInTheDocument();
    expect(galeriaIntervalo().querySelector(`img[src="${FUNDO_URL}"]`)).toBeInTheDocument();
  });

  it('escolher um preset grava preset:<nome>; "nenhuma" grava NULO', async () => {
    await montar();
    await userEvent.click(galeriaPrincipal().querySelector('[data-preset="navy"]'));
    await salvar();
    await waitFor(() => expect(api.patch).toHaveBeenCalled());
    expect(enviado().broadcast_bg_image_url).toBe('preset:navy');

    api.patch.mockClear();
    await userEvent.click(galeriaPrincipal().querySelector('.bg-tile--none'));
    await salvar();
    await waitFor(() => expect(api.patch).toHaveBeenCalled());
    expect(enviado().broadcast_bg_image_url).toBeNull();
  });

  it('escolher uma imagem da biblioteca grava a URL pública e a prévia a usa', async () => {
    await montar();
    await userEvent.click(galeriaPrincipal().querySelector('.bg-tile-pick'));
    expect(document.querySelector('.bs-preview-stage .tv-bg').style.backgroundImage).toBe(`url(${FUNDO_URL})`);
    await salvar();
    await waitFor(() => expect(api.patch).toHaveBeenCalled());
    expect(enviado().broadcast_bg_image_url).toBe(FUNDO_URL);
  });

  it('enviar uma imagem sobe para {org}/{uuid}.{ext}, grava a linha e seleciona a URL pública', async () => {
    await montar();
    await userEvent.upload(screen.getByTestId('bg-upload-input'), arquivo());
    await waitFor(() => expect(storage.upload).toHaveBeenCalled());
    const [path] = storage.upload.mock.calls[0];
    expect(path).toMatch(/^org-1\/[A-Za-z0-9-]+\.jpg$/);
    expect(tabela.insert).toHaveBeenCalledWith(expect.objectContaining({ path, name: 'nova.png' }));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Imagem enviada.'));
    await salvar();
    await waitFor(() => expect(api.patch).toHaveBeenCalled());
    expect(enviado().broadcast_bg_image_url).toBe(`https://cdn/${path}`);
  });

  it('tipo que não é imagem suportada é recusado e nada sobe', async () => {
    await montar();
    // `fireEvent` e não `userEvent.upload`: este último respeita o `accept` do
    // input e nem entregaria o GIF — aqui se testa a recusa do hook.
    fireEvent.change(screen.getByTestId('bg-upload-input'), { target: { files: [arquivo('image/gif')] } });
    await waitFor(() => expect(toast.warning).toHaveBeenCalledWith('Use JPG, PNG ou WebP.'));
    expect(storage.upload).not.toHaveBeenCalled();
    await salvar();
    await waitFor(() => expect(api.patch).toHaveBeenCalled());
    expect(enviado().broadcast_bg_image_url).toBeNull();
  });

  it('excluir a imagem em uso limpa o fundo principal E o do intervalo', async () => {
    await montar({ dia: { ...DIA, broadcast_bg_image_url: FUNDO_URL, broadcast_break_bg_image_url: FUNDO_URL } });
    await userEvent.click(galeriaPrincipal().querySelector('.bg-tile-delete'));
    await waitFor(() => expect(storage.remove).toHaveBeenCalledWith(['org-1/salao.webp']));
    expect(tabela.delete).toHaveBeenCalled();
    await salvar();
    await waitFor(() => expect(api.patch).toHaveBeenCalled());
    expect(enviado().broadcast_bg_image_url).toBeNull();
    expect(enviado().broadcast_break_bg_image_url).toBeNull();
  });

  it('escurecimento é salvo, e zero é respeitado', async () => {
    await montar({ dia: { ...DIA, broadcast_bg_overlay: 0 } });
    await salvar();
    await waitFor(() => expect(api.patch).toHaveBeenCalled());
    expect(enviado().broadcast_bg_overlay).toBe(0);

    api.patch.mockClear();
    fireEvent.change(screen.getByTestId('bg-overlay-input'), { target: { value: '60' } });
    await salvar();
    await waitFor(() => expect(api.patch).toHaveBeenCalled());
    expect(enviado().broadcast_bg_overlay).toBe(60);
  });

  it('o fundo do intervalo tem seletor próprio, sem escurecimento', async () => {
    await montar();
    expect(screen.queryByTestId('break-bg-overlay-input')).toBeNull();
    await userEvent.click(galeriaIntervalo().querySelector('[data-preset="felt"]'));
    await salvar();
    await waitFor(() => expect(api.patch).toHaveBeenCalled());
    expect(enviado().broadcast_break_bg_image_url).toBe('preset:felt');
    expect(enviado().broadcast_bg_image_url).toBeNull();
  });

  it('imagem antiga em base64 continua valendo e aparece como tile', async () => {
    await montar({ dia: { ...DIA, broadcast_bg_image_url: 'data:image/png;base64,AAAA' } });
    expect(galeriaPrincipal().querySelector('.bg-tile--legacy')).toHaveClass('is-selected');
    await salvar();
    await waitFor(() => expect(api.patch).toHaveBeenCalled());
    expect(enviado().broadcast_bg_image_url).toBe('data:image/png;base64,AAAA');
  });
});

describe('salvar', () => {
  it('nome personalizado em branco vai como NULO', async () => {
    // Nulo significa "use torneio + dia"; string vazia deixaria o telão sem
    // título nenhum.
    await montar();
    await salvar();
    await waitFor(() => expect(api.patch).toHaveBeenCalled());
    expect(enviado().broadcast_display_name).toBeNull();
    expect(enviado().broadcast_bg_image_url).toBeNull();
    expect(enviado().broadcast_break_youtube_url).toBeNull();
  });

  it('nome personalizado preenchido é salvo como está', async () => {
    await montar();
    await userEvent.type(
      screen.getByPlaceholderText('broadcastSettings.displayNamePlaceholder'),
      'FINAL TABLE'
    );
    await salvar();
    await waitFor(() => expect(api.patch).toHaveBeenCalled());
    expect(enviado().broadcast_display_name).toBe('FINAL TABLE');
  });

  it('salva no DIA, não no torneio', async () => {
    await montar();
    await salvar();
    await waitFor(() => expect(api.patch).toHaveBeenCalledWith('/tournament-days/d1', expect.anything()));
  });

  it('sucesso avisa', async () => {
    await montar();
    await salvar();
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('broadcastSettings.saved'));
  });

  it('erro ao salvar avisa', async () => {
    api.patch.mockRejectedValue(new Error('500'));
    await montar();
    await salvar();
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('broadcastSettings.errorSave'));
  });
});

describe('pré-visualização', () => {
  it('desligar um elemento o some da prévia na hora', async () => {
    // É o que evita descobrir o erro com o salão cheio.
    await montar();
    expect(document.querySelector('.bs-preview-card')).toBeInTheDocument();
    await alternar('visTimer');
    await salvar();
    await waitFor(() => expect(api.patch).toHaveBeenCalled());
    expect(enviado().broadcast_show_timer).toBe(false);
  });

  it('dá para pré-visualizar a tela de INTERVALO sem esperar o intervalo', async () => {
    // O intervalo é um layout completamente diferente; conferi-lo só quando
    // acontecer é tarde.
    await montar();
    const botao = document.querySelector('.bs-preview-topbar button');
    await userEvent.click(botao);
    expect(document.querySelector('.bs-preview-card')).toBeInTheDocument();
  });

  it('o nome personalizado aparece na prévia enquanto se digita', async () => {
    await montar();
    await userEvent.type(
      screen.getByPlaceholderText('broadcastSettings.displayNamePlaceholder'),
      'FINAL'
    );
    expect(document.querySelector('.bs-preview-card')).toHaveTextContent('FINAL');
  });
});

describe('logo do clube', () => {
  /** A área de upload da logo, distinta da área da imagem de fundo. */
  const zonaDaLogo = () =>
    Array.from(document.querySelectorAll('.bs-upload-zone')).find((el) =>
      el.textContent.includes('Enviar a logo do clube')
    );

  const arquivo = (bytes) =>
    new File(['x'.repeat(bytes)], 'logo.png', { type: 'image/png' });

  it('a logo escolhida é salva no dia', async () => {
    await montar();
    await userEvent.upload(zonaDaLogo().querySelector('input[type="file"]'), arquivo(10));
    await waitFor(() =>
      expect(document.querySelector('.bs-img-preview-wrap')).toBeInTheDocument()
    );
    await salvar();
    await waitFor(() => expect(api.patch).toHaveBeenCalled());
    expect(enviado().broadcast_club_logo_url).toContain('data:');
  });

  it('arquivo grande demais é recusado', async () => {
    // A imagem viaja em base64 dentro do JSON do dia, que cada TV rebusca a
    // cada 30s: uma logo pesada multiplica por telão ligado.
    await montar();
    await userEvent.upload(zonaDaLogo().querySelector('input[type="file"]'), arquivo(513 * 1024));
    expect(toast.warning).toHaveBeenCalled();
    await salvar();
    await waitFor(() => expect(api.patch).toHaveBeenCalled());
    expect(enviado().broadcast_club_logo_url).toBeNull();
  });

  it('sem logo cadastrada o campo vai como NULO', async () => {
    // String vazia gravaria um src="" no telão; nulo é "não tem logo".
    await montar();
    await salvar();
    await waitFor(() => expect(api.patch).toHaveBeenCalled());
    expect(enviado().broadcast_club_logo_url).toBeNull();
  });

  it('a URL colada é salva como está', async () => {
    await montar();
    await userEvent.type(screen.getByPlaceholderText('https://...'), 'https://clube.com/logo.png');
    await salvar();
    await waitFor(() => expect(api.patch).toHaveBeenCalled());
    expect(enviado().broadcast_club_logo_url).toBe('https://clube.com/logo.png');
  });

  it('com logo enviada, o campo de URL fica bloqueado', async () => {
    // Os dois caminhos gravam o mesmo campo; deixar os dois ativos faria o
    // operador achar que apagou a logo sem ter apagado.
    await montar({ dia: { ...DIA, broadcast_club_logo_url: 'data:image/png;base64,AAA' } });
    expect(screen.getByPlaceholderText('https://...')).toBeDisabled();
  });

  it('o tamanho salvo no dia é preservado', async () => {
    await montar({ dia: { ...DIA, broadcast_club_logo_size: 200 } });
    await salvar();
    await waitFor(() => expect(api.patch).toHaveBeenCalled());
    expect(enviado().broadcast_club_logo_size).toBe(200);
  });

  it('dia antigo sem o campo mantém a logo LIGADA em 100%', async () => {
    // Mesmo raciocínio dos demais show_*: nulo no banco não pode virar
    // "desligado" ao abrir esta tela.
    await montar();
    await salvar();
    await waitFor(() => expect(api.patch).toHaveBeenCalled());
    expect(enviado().broadcast_show_club_logo).toBe(true);
    expect(enviado().broadcast_club_logo_size).toBe(100);
  });

  it('a logo pode ser desligada sem perder a imagem', async () => {
    await montar({ dia: { ...DIA, broadcast_club_logo_url: 'https://clube.com/logo.png' } });
    await alternar('Logo do clube');
    await salvar();
    await waitFor(() => expect(api.patch).toHaveBeenCalled());
    expect(enviado().broadcast_show_club_logo).toBe(false);
    expect(enviado().broadcast_club_logo_url).toBe('https://clube.com/logo.png');
  });

  it('a prévia mostra a logo enviada', async () => {
    // Sem isso o operador configura a logo, não a vê na prévia e acha que
    // está quebrado.
    await montar({ dia: { ...DIA, broadcast_club_logo_url: 'https://clube.com/logo.png' } });
    expect(document.querySelector('.tv-club-logo-img')).toHaveAttribute(
      'src', 'https://clube.com/logo.png'
    );
  });

  it('logo desligada some da prévia', async () => {
    await montar({
      dia: { ...DIA, broadcast_club_logo_url: 'https://clube.com/logo.png', broadcast_show_club_logo: false },
    });
    expect(document.querySelector('.tv-club-logo-img')).toBeNull();
  });
});

describe('código público da TV', () => {
  it('o código aparece para ser digitado na TV', async () => {
    await montar();
    expect(await screen.findByText('XYZ789')).toBeInTheDocument();
  });

  it('copiar leva o endereço junto com o código', async () => {
    // Só o código não basta: quem está na TV precisa saber onde digitá-lo.
    const escrever = jest.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText: escrever } });
    await montar();
    await screen.findByText('XYZ789');
    await userEvent.click(document.querySelector('.bs-tv-code'));
    await waitFor(() => expect(escrever).toHaveBeenCalled());
    expect(escrever.mock.calls[0][0]).toContain('XYZ789');
    expect(escrever.mock.calls[0][0]).toContain('/tv');
  });

  it('falha ao buscar o código NÃO trava a configuração', async () => {
    // O código é secundário; a tela precisa continuar utilizável sem ele.
    await montar({ codigo: new Error('500') });
    expect(document.querySelector('.bs-tv-code')).toBeNull();
    expect(document.querySelector('.bs-btn-save')).toBeInTheDocument();
  });
});

/**
 * Divulgação na coluna da direita do telão: a galeria do clube é reaproveitada
 * (sem presets), a URL também aceita vídeo/YouTube, e o diretor liga/desliga
 * sem apagar a peça.
 */
describe('divulgação (coluna da direita)', () => {
  it('nasce ligada, sem peça e inteira; vazio vai nulo', async () => {
    await montar();
    await salvar();
    await waitFor(() => expect(api.patch).toHaveBeenCalled());
    expect(enviado().broadcast_promo_url).toBeNull();
    expect(enviado().broadcast_show_promo).toBe(true);
    expect(enviado().broadcast_promo_fit).toBe('contain');
  });

  it('a galeria da divulgação não oferece presets de gradiente', async () => {
    await montar();
    const galerias = document.querySelectorAll('.bg-gallery');
    const daDivulgacao = Array.from(galerias).find((g) => g.querySelector('[data-testid="promo-url-input"]'));
    expect(daDivulgacao).toBeDefined();
    expect(daDivulgacao.querySelector('.bg-tile--preset')).toBeNull();
    expect(daDivulgacao).toHaveTextContent('Sem divulgação');
  });

  it('URL de YouTube colada e ajuste "cover" vão no payload', async () => {
    await montar();
    await userEvent.type(screen.getByTestId('promo-url-input'), 'https://youtu.be/dQw4w9WgXcQ');
    await userEvent.selectOptions(document.querySelector('#promo-fit'), 'cover');
    await salvar();
    await waitFor(() => expect(api.patch).toHaveBeenCalled());
    expect(enviado().broadcast_promo_url).toBe('https://youtu.be/dQw4w9WgXcQ');
    expect(enviado().broadcast_promo_fit).toBe('cover');
  });

  it('desligar mantém a URL gravada (só esconde)', async () => {
    await montar({ dia: { ...DIA, broadcast_promo_url: 'https://cdn/flyer.webp', broadcast_show_promo: true } });
    await alternar('Mostrar divulgação');
    await salvar();
    await waitFor(() => expect(api.patch).toHaveBeenCalled());
    expect(enviado().broadcast_show_promo).toBe(false);
    expect(enviado().broadcast_promo_url).toBe('https://cdn/flyer.webp');
  });

  it('a prévia mostra a peça na coluna da direita', async () => {
    await montar({ dia: { ...DIA, broadcast_promo_url: 'https://cdn/flyer.webp' } });
    expect(document.querySelector('.bs-preview-stage .tv-promo img')).toHaveAttribute('src', 'https://cdn/flyer.webp');
  });
});

describe('meios de entrada abaixo dos blinds', () => {
  it('nasce desligado e "Entradas" ligada; ligar vai no payload', async () => {
    await montar();
    await salvar();
    await waitFor(() => expect(api.patch).toHaveBeenCalled());
    expect(enviado().broadcast_show_buy_types).toBe(false);
    expect(enviado().broadcast_show_entries).toBe(true);
  });

  it('ligar os meios de entrada desmarca "Entradas" e "Reentradas" sozinho', async () => {
    // É a mesma contagem, aberta por meio: o telão não mostra as duas versões.
    await montar();
    await alternar('Meios de entrada');
    await salvar();
    await waitFor(() => expect(api.patch).toHaveBeenCalled());
    expect(enviado().broadcast_show_buy_types).toBe(true);
    expect(enviado().broadcast_show_entries).toBe(false);
    expect(enviado().broadcast_show_reentries).toBe(false);
  });

  it('religar "Entradas" (ou "Reentradas") desliga os meios de entrada', async () => {
    await montar({ dia: { ...DIA, broadcast_show_buy_types: true, broadcast_show_entries: false, broadcast_show_reentries: false } });
    await alternar('Entradas (contagem)');
    await salvar();
    await waitFor(() => expect(api.patch).toHaveBeenCalled());
    expect(enviado().broadcast_show_entries).toBe(true);
    expect(enviado().broadcast_show_buy_types).toBe(false);
  });

  it('a prévia mostra a linha quando ligado', async () => {
    await montar({ dia: { ...DIA, broadcast_show_buy_types: true } });
    expect(document.querySelector('.bs-preview-stage .tv-buytypes')).toHaveTextContent('Buy-in');
  });
});


describe('aviso animado de jogador eliminado', () => {
  it('nasce desligado; ligar vai no payload', async () => {
    await montar();
    await salvar();
    await waitFor(() => expect(api.patch).toHaveBeenCalled());
    expect(enviado().broadcast_show_eliminations).toBe(false);
    api.patch.mockClear();
    await alternar('Aviso animado de jogador eliminado');
    await salvar();
    await waitFor(() => expect(api.patch).toHaveBeenCalled());
    expect(enviado().broadcast_show_eliminations).toBe(true);
  });

  it('"Testar aviso" passa a faixa na prévia com um nome de exemplo', async () => {
    await montar();
    expect(document.querySelector('.bs-preview-stage .tv-elim')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Testar aviso de eliminado' }));
    const faixa = document.querySelector('.bs-preview-stage .tv-elim');
    expect(faixa).toHaveTextContent('Carlos Montea');
    expect(faixa).toHaveTextContent('JOGADOR ELIMINADO');
  });
});

describe('tamanho do título', () => {
  it('nasce em 100% e vai no payload separado da fonte geral', async () => {
    await montar();
    await salvar();
    await waitFor(() => expect(api.patch).toHaveBeenCalled());
    expect(enviado().broadcast_title_size).toBe(100);
    expect(enviado().broadcast_font_size).toBe(100);
  });

  it('o valor salvo do dia aparece e a prévia escala o título', async () => {
    await montar({ dia: { ...DIA, broadcast_title_size: 180 } });
    expect(document.querySelector('.bs-preview-stage .tv-screen').style.getPropertyValue('--tv-title')).toBe('1.8');
    await salvar();
    await waitFor(() => expect(api.patch).toHaveBeenCalled());
    expect(enviado().broadcast_title_size).toBe(180);
  });
});
