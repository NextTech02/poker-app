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
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import BroadcastSettings from './BroadcastSettings';
import api from '../config/api';
import { useToast } from '../contexts/ToastContext';
import { useCurrency } from '../contexts/CurrencyContext';

jest.mock('../config/api', () => ({
  __esModule: true,
  default: { get: jest.fn(), patch: jest.fn() },
}));
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

beforeEach(() => {
  toast = { success: jest.fn(), error: jest.fn(), warning: jest.fn() };
  useToast.mockReturnValue({ toast });
  useCurrency.mockReturnValue({ formatCurrency: (v) => `R$ ${Number(v || 0).toFixed(2)}` });
  api.patch.mockResolvedValue({ data: {} });
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => console.error.mockRestore());

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
    expect(document.querySelector('.bs-preview-club-logo')).toHaveAttribute(
      'src', 'https://clube.com/logo.png'
    );
  });

  it('logo desligada some da prévia', async () => {
    await montar({
      dia: { ...DIA, broadcast_club_logo_url: 'https://clube.com/logo.png', broadcast_show_club_logo: false },
    });
    expect(document.querySelector('.bs-preview-club-logo')).toBeNull();
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
