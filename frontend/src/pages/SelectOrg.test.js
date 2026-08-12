/**
 * Escolha da organização logo após o login.
 *
 * O risco que ela evita é concreto: quem trabalha em dois clubes começaria a
 * operar no errado — registrar um buy-in na organização de outro cliente.
 *
 * Duas decisões seguem daí:
 *
 * - **Quem tem uma organização só nunca vê esta tela.** Ela é um passo a
 *   mais no login; sem escolha a fazer, seria só atrito.
 * - **Entrar exige TOKEN NOVO** — o RLS decide pelo claim assinado. A
 *   exceção é a organização que JÁ está no token: aí basta recarregar, e
 *   emitir outro token seria uma volta inútil ao servidor.
 */
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import SelectOrg from './SelectOrg';
import api from '../config/api';
import { enterOrg } from '../utils/orgScope';
import { useAuth } from '../contexts/AuthContext';

jest.mock('../config/api', () => ({ __esModule: true, default: { get: jest.fn() } }));
jest.mock('../utils/orgScope', () => ({ enterOrg: jest.fn() }));
jest.mock('../contexts/AuthContext', () => ({ useAuth: jest.fn() }));
jest.mock('../components/LanguageSelector', () => () => <div data-testid="idiomas" />);
jest.mock('../assets/aceblind-logo-white.png', () => 'logo.png');

const mockNavegar = jest.fn();
let mockEstado = {};
jest.mock('react-router-dom', () => ({
  ...jest.requireActual('react-router-dom'),
  useNavigate: () => mockNavegar,
  useLocation: () => ({ state: mockEstado }),
}));

jest.mock('react-i18next', () => {
  const t = (chave, padrao) => (typeof padrao === 'string' ? padrao : chave);
  const traducao = { t, i18n: { language: 'pt-BR' } };
  return { useTranslation: () => traducao };
});

const ORG_A = { id: 'org-a', name: 'Clube Alfa', group_name: 'Administrador' };
const ORG_B = { id: 'org-b', name: 'Beta Poker', is_active_org: true };

let sair;

const montar = () => render(<MemoryRouter><SelectOrg /></MemoryRouter>);

beforeEach(() => {
  mockNavegar.mockClear();
  mockEstado = {};
  sair = jest.fn().mockResolvedValue({});
  useAuth.mockReturnValue({ signOut: sair });
  enterOrg.mockResolvedValue(undefined);
  api.get.mockResolvedValue({ data: [ORG_A, ORG_B] });
  delete window.location;
  window.location = { href: '' };
});

describe('carga da lista', () => {
  it('usa a lista que veio do login sem consultar de novo', async () => {
    // Uma segunda chamada ao mesmo endpoint atrasaria a entrada sem motivo.
    mockEstado = { orgs: [ORG_A, ORG_B] };
    montar();
    expect(await screen.findByText('Clube Alfa')).toBeInTheDocument();
    expect(api.get).not.toHaveBeenCalled();
  });

  it('sem a lista, busca no servidor', async () => {
    montar();
    expect(await screen.findByText('Clube Alfa')).toBeInTheDocument();
    expect(api.get).toHaveBeenCalledWith('/organizations/mine', expect.any(Object));
  });

  it('com uma organização só entra direto, sem mostrar a tela', async () => {
    // Sem escolha a fazer, a tela seria só atrito no login.
    api.get.mockResolvedValue({ data: [ORG_A] });
    montar();
    await waitFor(() =>
      expect(mockNavegar).toHaveBeenCalledWith('/', { replace: true })
    );
  });

  it('sem organização nenhuma também segue para o app', async () => {
    api.get.mockResolvedValue({ data: [] });
    montar();
    await waitFor(() =>
      expect(mockNavegar).toHaveBeenCalledWith('/', { replace: true })
    );
  });

  it('falha ao consultar não prende o operador na tela', async () => {
    api.get.mockRejectedValue(new Error('500'));
    montar();
    await waitFor(() =>
      expect(mockNavegar).toHaveBeenCalledWith('/', { replace: true })
    );
  });

  it('mostra o carregamento enquanto busca', () => {
    api.get.mockReturnValue(new Promise(() => {}));
    montar();
    expect(screen.getByText('Carregando...')).toBeInTheDocument();
  });
});

describe('lista de organizações', () => {
  beforeEach(() => {
    mockEstado = { orgs: [ORG_A, ORG_B] };
  });

  it('mostra o nome e o papel em cada clube', async () => {
    // A pessoa pode ser admin num e caixa em outro.
    montar();
    expect(await screen.findByText('Clube Alfa')).toBeInTheDocument();
    expect(screen.getByText('Administrador')).toBeInTheDocument();
  });

  it('sem grupo de permissão diz isso', async () => {
    montar();
    expect(await screen.findByText('Sem grupo')).toBeInTheDocument();
  });

  it('marca a organização usada por último', async () => {
    // É o atalho para quem sempre entra no mesmo clube.
    montar();
    expect(await screen.findByText('Última usada')).toBeInTheDocument();
  });

  it('a inicial do nome vira avatar', async () => {
    montar();
    await screen.findByText('Clube Alfa');
    const avatares = Array.from(document.querySelectorAll('.so-avatar')).map(
      (a) => a.textContent
    );
    expect(avatares).toEqual(['C', 'B']);
  });

  it('organização sem nome não quebra o avatar', async () => {
    mockEstado = { orgs: [{ id: 'x', name: null }, ORG_B] };
    montar();
    await waitFor(() => expect(document.querySelector('.so-avatar')).toBeTruthy());
    expect(document.querySelector('.so-avatar').textContent).toBe('?');
  });
});

describe('entrada', () => {
  beforeEach(() => {
    mockEstado = { orgs: [ORG_A, ORG_B] };
  });

  it('organização diferente emite token novo', async () => {
    // O RLS decide pelo claim assinado; sem token novo o operador entraria
    // vendo os dados do clube anterior.
    montar();
    await userEvent.click(await screen.findByText('Clube Alfa'));
    await waitFor(() => expect(enterOrg).toHaveBeenCalledWith('org-a'));
  });

  it('a organização JÁ ativa no token só recarrega', async () => {
    // Emitir outro token seria uma volta inútil ao servidor.
    montar();
    await userEvent.click(await screen.findByText('Beta Poker'));
    await waitFor(() => expect(window.location.href).toBe('/'));
    expect(enterOrg).not.toHaveBeenCalled();
  });

  it('enquanto entra, os outros botões travam', async () => {
    // Dois cliques em clubes diferentes deixariam o token e a tela em
    // desacordo.
    enterOrg.mockReturnValue(new Promise(() => {}));
    montar();
    await userEvent.click(await screen.findByText('Clube Alfa'));
    await waitFor(() =>
      expect(screen.getByText('Beta Poker').closest('button')).toBeDisabled()
    );
  });

  it('falha ao entrar avisa e libera a lista de novo', async () => {
    enterOrg.mockRejectedValue({ userMessage: 'Você não pertence a esta organização.' });
    montar();
    await userEvent.click(await screen.findByText('Clube Alfa'));
    expect(
      await screen.findByText('Você não pertence a esta organização.')
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByText('Clube Alfa').closest('button')).not.toBeDisabled()
    );
  });

  it('falha sem mensagem usa um texto padrão', async () => {
    enterOrg.mockRejectedValue(new Error('boom'));
    montar();
    await userEvent.click(await screen.findByText('Clube Alfa'));
    expect(
      await screen.findByText(/Não foi possível entrar nesta organização/)
    ).toBeInTheDocument();
  });
});

describe('sair', () => {
  it('encerra a sessão e volta ao login', async () => {
    // É a saída para quem abriu a tela por engano com a conta errada.
    mockEstado = { orgs: [ORG_A, ORG_B] };
    montar();
    await userEvent.click(await screen.findByRole('button', { name: 'Sair' }));
    await waitFor(() => expect(sair).toHaveBeenCalled());
    expect(mockNavegar).toHaveBeenCalledWith('/login', { replace: true });
  });

  it('sair fica travado enquanto uma entrada está em curso', async () => {
    enterOrg.mockReturnValue(new Promise(() => {}));
    mockEstado = { orgs: [ORG_A, ORG_B] };
    montar();
    await userEvent.click(await screen.findByText('Clube Alfa'));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Sair' })).toBeDisabled()
    );
  });
});
