/**
 * Bilhete do CLUBE: imagem, cidade, sede e enfeites, gravados em app_settings
 * (a linha do clube), com prévia do bilhete como ele sai na térmica.
 */
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import BilheteConfigModal from './BilheteConfigModal';
import { supabase } from '../../config/supabase';
import { lerBilheteDoClube } from '../../hooks/useBrandingDoBilhete';

jest.mock('../../config/supabase', () => ({ supabase: { from: jest.fn() } }));
jest.mock('../../hooks/useBrandingDoBilhete', () => ({
  lerBilheteDoClube: jest.fn(),
  invalidarBrandingDoBilhete: jest.fn(),
  publicUrlFor: (p) => `https://cdn/${p}`,
  enviarImagemDoBilhete: jest.fn(),
  TIPOS_DE_IMAGEM: ['image/png'],
}));
jest.mock('../../contexts/CurrencyContext', () => ({ useCurrency: () => ({ formatCurrency: (v) => `S/ ${v}` }) }));
jest.mock('react-i18next', () => {
  const t = (chave, segundo) => (typeof segundo === 'string' ? segundo : chave);
  return { useTranslation: () => ({ t, i18n: { language: 'es-ES' } }) };
});

it('carrega o do clube, mostra a prévia e grava na linha do clube', async () => {
  lerBilheteDoClube.mockResolvedValue({ id: 20, ticket_logo_path: 'org/bilhete/l.png', ticket_city: 'Chiclayo', ticket_venue: '', ticket_ornaments: false });
  const eq = jest.fn().mockResolvedValue({ error: null });
  const update = jest.fn(() => ({ eq }));
  supabase.from.mockReturnValue({ update });
  const onFechar = jest.fn();
  render(<BilheteConfigModal onFechar={onFechar} />);

  expect(await screen.findByDisplayValue('Chiclayo')).toBeInTheDocument();
  expect(screen.getByTitle('Prévia do bilhete').getAttribute('srcdoc')).toContain('https://cdn/org/bilhete/l.png');
  await userEvent.type(screen.getByLabelText('Sede / local'), 'Salón NSOP');
  await userEvent.click(screen.getByLabelText('Enfeites geométricos nos cantos'));
  await userEvent.click(screen.getByRole('button', { name: 'Salvar' }));

  await waitFor(() => expect(update).toHaveBeenCalledWith({
    ticket_logo_path: 'org/bilhete/l.png', ticket_city: 'Chiclayo', ticket_venue: 'Salón NSOP', ticket_ornaments: true,
  }));
  expect(eq).toHaveBeenCalledWith('id', 20);
  expect(onFechar).toHaveBeenCalledWith(true);
});

it('falha ao gravar (banco sem a migração) avisa e não fecha', async () => {
  lerBilheteDoClube.mockResolvedValue({ id: 20 });
  supabase.from.mockReturnValue({ update: () => ({ eq: () => Promise.resolve({ error: { message: 'column' } }) }) });
  const onFechar = jest.fn();
  render(<BilheteConfigModal onFechar={onFechar} />);
  await screen.findByLabelText('Sede / local');
  await userEvent.click(screen.getByRole('button', { name: 'Salvar' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Não foi possível salvar o bilhete');
  expect(onFechar).not.toHaveBeenCalled();
});
