/**
 * Peças de multi-organização: OrgSwitcher e OrgScopeBanner.
 *
 * O risco que as duas endereçam é o mesmo, por ângulos opostos: **operar no
 * clube errado sem perceber**.
 *
 * - O seletor só aparece com 2+ organizações — quem tem uma só não precisa
 *   ver o controle, e mostrá-lo criaria a dúvida de "em qual eu estou?".
 * - A faixa do admin da plataforma é permanente: escopado num cliente, o app
 *   fica IDÊNTICO ao normal, e cadastrar torneio ou mexer no caixa grava na
 *   organização do cliente.
 *
 * A organização ativa vem sempre do TOKEN (`currentOrgId`), nunca de um
 * campo da resposta: o RLS decide pelo claim assinado, e mostrar outra coisa
 * na tela seria mentir sobre o que o servidor vai fazer.
 */
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import OrgSwitcher from './OrgSwitcher';
import OrgScopeBanner from './OrgScopeBanner';
import api from '../config/api';
import { useToast } from '../contexts/ToastContext';
import { currentOrgId, isPlatformAdminToken, enterOrg } from '../utils/orgScope';

jest.mock('../config/api', () => ({ __esModule: true, default: { get: jest.fn() } }));
jest.mock('../contexts/ToastContext', () => ({ useToast: jest.fn() }));
jest.mock('../utils/orgScope', () => ({
  currentOrgId: jest.fn(),
  isPlatformAdminToken: jest.fn(),
  enterOrg: jest.fn(),
}));
jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (chave, padrao) => padrao || chave }),
}));

const ORG_A = { id: 'org-a', name: 'Clube A' };
const ORG_B = { id: 'org-b', name: 'Clube B' };

let erroToast;

beforeEach(() => {
  erroToast = jest.fn();
  useToast.mockReturnValue({ toast: { error: erroToast } });
  currentOrgId.mockReturnValue('org-a');
  isPlatformAdminToken.mockReturnValue(false);
  enterOrg.mockResolvedValue(undefined);
  api.get.mockResolvedValue({ data: [] });
});

describe('OrgSwitcher', () => {
  const responder = (minhas) =>
    api.get.mockImplementation((url) =>
      url === '/organizations/mine'
        ? Promise.resolve({ data: minhas })
        : Promise.resolve({ data: [] })
    );

  it('com uma organização só não aparece', async () => {
    // Mostrar o controle criaria a dúvida de "em qual eu estou?" para quem
    // nunca vai trocar.
    responder([ORG_A]);
    const { container } = render(<OrgSwitcher />);
    await waitFor(() => expect(api.get).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it('sem organização nenhuma não aparece', async () => {
    responder([]);
    const { container } = render(<OrgSwitcher />);
    await waitFor(() => expect(api.get).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it('com duas organizações lista as duas', async () => {
    responder([ORG_A, ORG_B]);
    render(<OrgSwitcher />);
    expect(await screen.findByRole('combobox')).toBeInTheDocument();
    expect(screen.getAllByRole('option')).toHaveLength(2);
  });

  it('a organização ativa vem do TOKEN', async () => {
    // Mostrar outra coisa seria mentir sobre o que o servidor vai fazer: o
    // RLS decide pelo claim assinado.
    responder([ORG_A, ORG_B]);
    currentOrgId.mockReturnValue('org-b');
    render(<OrgSwitcher />);
    expect(await screen.findByRole('combobox')).toHaveValue('org-b');
  });

  it('sem organização no token cai na marcada como ativa', async () => {
    responder([ORG_A, { ...ORG_B, is_active_org: true }]);
    currentOrgId.mockReturnValue(null);
    render(<OrgSwitcher />);
    expect(await screen.findByRole('combobox')).toHaveValue('org-b');
  });

  it('sem pista nenhuma cai na primeira da lista', async () => {
    responder([ORG_A, ORG_B]);
    currentOrgId.mockReturnValue(null);
    render(<OrgSwitcher />);
    expect(await screen.findByRole('combobox')).toHaveValue('org-a');
  });

  it('trocar entra na organização escolhida', async () => {
    responder([ORG_A, ORG_B]);
    render(<OrgSwitcher />);
    const seletor = await screen.findByRole('combobox');
    await userEvent.selectOptions(seletor, 'org-b');
    expect(enterOrg).toHaveBeenCalledWith('org-b');
  });

  it('escolher a mesma organização não faz nada', async () => {
    // Recarregar a aplicação à toa perderia o estado das telas abertas.
    responder([ORG_A, ORG_B]);
    render(<OrgSwitcher />);
    const seletor = await screen.findByRole('combobox');
    await userEvent.selectOptions(seletor, 'org-a');
    expect(enterOrg).not.toHaveBeenCalled();
  });

  it('falha ao trocar avisa e libera o seletor de novo', async () => {
    // Sem religar o controle, o operador ficaria preso sem entender por quê.
    responder([ORG_A, ORG_B]);
    enterOrg.mockRejectedValue({ userMessage: 'sem vínculo' });
    render(<OrgSwitcher />);
    const seletor = await screen.findByRole('combobox');
    await userEvent.selectOptions(seletor, 'org-b');
    await waitFor(() => expect(erroToast).toHaveBeenCalledWith('sem vínculo'));
    await waitFor(() => expect(seletor).not.toBeDisabled());
  });

  it('falha sem mensagem usa um texto padrão', async () => {
    responder([ORG_A, ORG_B]);
    enterOrg.mockRejectedValue(new Error('boom'));
    render(<OrgSwitcher />);
    await userEvent.selectOptions(await screen.findByRole('combobox'), 'org-b');
    await waitFor(() =>
      expect(erroToast).toHaveBeenCalledWith(
        expect.stringContaining('Não foi possível trocar')
      )
    );
  });

  it('falha ao carregar não quebra a barra lateral', async () => {
    api.get.mockRejectedValue(new Error('sem rede'));
    const { container } = render(<OrgSwitcher />);
    await waitFor(() => expect(api.get).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it('esconde o rótulo com a barra recolhida', async () => {
    responder([ORG_A, ORG_B]);
    render(<OrgSwitcher collapsed />);
    await screen.findByRole('combobox');
    expect(screen.queryByText('Organização')).toBeNull();
  });
});

describe('OrgScopeBanner', () => {
  const responder = ({ minhas = [], todas = [] }) =>
    api.get.mockImplementation((url) =>
      url === '/organizations/mine'
        ? Promise.resolve({ data: minhas })
        : Promise.resolve({ data: todas })
    );

  it('usuário comum nunca vê a faixa', async () => {
    isPlatformAdminToken.mockReturnValue(false);
    const { container } = render(<OrgScopeBanner />);
    await waitFor(() => expect(container).toBeEmptyDOMElement());
    expect(api.get).not.toHaveBeenCalled();
  });

  it('admin na PRÓPRIA organização não vê a faixa', async () => {
    // Nada de anormal acontecendo: a faixa só existe para avisar do escopo
    // emprestado.
    isPlatformAdminToken.mockReturnValue(true);
    responder({ minhas: [ORG_A], todas: [ORG_A, ORG_B] });
    const { container } = render(<OrgScopeBanner />);
    await waitFor(() => expect(api.get).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it('admin dentro do clube de um cliente vê o nome do clube', async () => {
    // Escopado, o app fica idêntico ao normal: sem aviso permanente é fácil
    // mexer no caixa do cliente achando que é o próprio.
    isPlatformAdminToken.mockReturnValue(true);
    currentOrgId.mockReturnValue('org-b');
    responder({ minhas: [ORG_A], todas: [ORG_A, ORG_B] });
    render(<OrgScopeBanner />);
    expect(await screen.findByRole('status')).toHaveTextContent('Clube B');
  });

  it('organização desconhecida ainda gera o aviso', async () => {
    // O aviso importa mais que o nome: sem ele, o admin opera às cegas.
    isPlatformAdminToken.mockReturnValue(true);
    currentOrgId.mockReturnValue('org-desconhecida');
    responder({ minhas: [ORG_A], todas: [] });
    render(<OrgScopeBanner />);
    expect(await screen.findByRole('status')).toHaveTextContent('outra organização');
  });

  it('sem organização no token não avisa', async () => {
    isPlatformAdminToken.mockReturnValue(true);
    currentOrgId.mockReturnValue(null);
    const { container } = render(<OrgScopeBanner />);
    await waitFor(() => expect(container).toBeEmptyDOMElement());
    expect(api.get).not.toHaveBeenCalled();
  });

  it('sair volta para a organização do próprio admin', async () => {
    isPlatformAdminToken.mockReturnValue(true);
    currentOrgId.mockReturnValue('org-b');
    responder({ minhas: [ORG_A], todas: [ORG_A, ORG_B] });
    render(<OrgScopeBanner />);
    await userEvent.click(await screen.findByRole('button', { name: 'Sair' }));
    expect(enterOrg).toHaveBeenCalledWith('org-a', '/organizacoes');
  });

  it('admin sem organização própria não ganha botão de sair', async () => {
    // Um botão que não teria para onde voltar.
    isPlatformAdminToken.mockReturnValue(true);
    currentOrgId.mockReturnValue('org-b');
    responder({ minhas: [], todas: [ORG_B] });
    render(<OrgScopeBanner />);
    await screen.findByRole('status');
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('falha ao sair avisa e libera o botão', async () => {
    isPlatformAdminToken.mockReturnValue(true);
    currentOrgId.mockReturnValue('org-b');
    responder({ minhas: [ORG_A], todas: [ORG_A, ORG_B] });
    enterOrg.mockRejectedValue({ userMessage: 'falhou' });
    render(<OrgScopeBanner />);
    const botao = await screen.findByRole('button', { name: 'Sair' });
    await userEvent.click(botao);
    await waitFor(() => expect(erroToast).toHaveBeenCalledWith('falhou'));
    await waitFor(() => expect(botao).not.toBeDisabled());
  });

  it('falha ao consultar não atrapalha a operação', async () => {
    // Sem permissão ou offline: a faixa some, o app segue.
    isPlatformAdminToken.mockReturnValue(true);
    currentOrgId.mockReturnValue('org-b');
    api.get.mockRejectedValue(new Error('403'));
    const { container } = render(<OrgScopeBanner />);
    await waitFor(() => expect(api.get).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });
});
