/**
 * "Quem eliminou X?" — a pergunta que transforma a eliminação em prêmio KO.
 * Um marcado = leva o bounty; mais de um = pote dividido; "sem eliminador"
 * guarda o bounty para o campeão.
 */
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import EliminadorModal from './EliminadorModal';

jest.mock('react-i18next', () => {
  const t = (chave, vars) =>
    vars && typeof vars === 'object' ? `${chave}:${Object.values(vars).join(',')}` : chave;
  const traducao = { t, i18n: { language: 'pt-BR' } };
  return { useTranslation: () => traducao };
});

const CANDIDATOS = [
  { id: 'a', nome: 'Ana', mesa: 3 },
  { id: 'b', nome: 'Bruno', mesa: 3 },
  { id: 'c', nome: 'Carla', mesa: 1 },
];

const abrir = (props = {}) => {
  const onConfirmar = jest.fn();
  const onFechar = jest.fn();
  render(
    <EliminadorModal vitima="Zeca" candidatos={CANDIDATOS} formato="pko" mesaDaVitima={3}
      onConfirmar={onConfirmar} onFechar={onFechar} {...props} />,
  );
  return { onConfirmar, onFechar };
};

it('sem ninguém marcado não confirma', async () => {
  const { onConfirmar } = abrir();
  const botao = screen.getByRole('button', { name: 'ko.confirmEliminate' });
  expect(botao).toBeDisabled();
  await userEvent.click(botao);
  expect(onConfirmar).not.toHaveBeenCalled();
});

it('um eliminador: manda quem foi', async () => {
  const { onConfirmar } = abrir();
  await userEvent.click(screen.getByRole('checkbox', { name: /Ana/ }));
  await userEvent.click(screen.getByRole('button', { name: 'ko.confirmEliminate' }));
  expect(onConfirmar).toHaveBeenCalledWith({ eliminated_by: ['a'], no_eliminator: false });
});

it('dois marcados avisam o pote dividido', async () => {
  const { onConfirmar } = abrir();
  await userEvent.click(screen.getByRole('checkbox', { name: /Ana/ }));
  await userEvent.click(screen.getByRole('checkbox', { name: /Carla/ }));
  expect(screen.getByText(/ko.splitPot/)).toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: 'ko.confirmEliminate' }));
  expect(onConfirmar).toHaveBeenCalledWith({ eliminated_by: ['a', 'c'], no_eliminator: false });
});

it('"sem eliminador" desmarca os outros e manda no_eliminator', async () => {
  const { onConfirmar } = abrir();
  await userEvent.click(screen.getByRole('checkbox', { name: /Ana/ }));
  await userEvent.click(screen.getByRole('checkbox', { name: /ko.noEliminator/ }));
  expect(screen.getByRole('checkbox', { name: /Ana/ })).not.toBeChecked();
  await userEvent.click(screen.getByRole('button', { name: 'ko.confirmEliminate' }));
  expect(onConfirmar).toHaveBeenCalledWith({ eliminated_by: [], no_eliminator: true });
});

it('a busca filtra pelo nome e a mesma mesa da vítima fica em destaque', async () => {
  abrir();
  expect(document.querySelectorAll('.ko-candidato-mesa.mesma')).toHaveLength(2);
  await userEvent.type(screen.getByRole('searchbox'), 'car');
  expect(screen.queryByText('Ana')).toBeNull();
  expect(screen.getByText('Carla')).toBeInTheDocument();
});

it('a dica muda com o formato', () => {
  abrir({ formato: 'mystery' });
  expect(screen.getByText('ko.hintMystery')).toBeInTheDocument();
  // No Mystery, sem eliminador quem fica com o valor é o ENVELOPE, não um bounty.
  expect(screen.getByText('ko.noEliminatorMystery')).toBeInTheDocument();
});

it('Esc e Cancelar fecham; enviando trava tudo', async () => {
  const { onFechar } = abrir();
  await userEvent.keyboard('{Escape}');
  expect(onFechar).toHaveBeenCalledTimes(1);
  await userEvent.click(screen.getByRole('button', { name: 'common.cancel' }));
  expect(onFechar).toHaveBeenCalledTimes(2);
});

it('na correção, começa com os eliminadores já gravados', async () => {
  const { onConfirmar } = abrir({ inicial: ['b'], textoConfirmar: 'Salvar' });
  expect(screen.getByRole('checkbox', { name: /Bruno/ })).toBeChecked();
  await userEvent.click(screen.getByRole('button', { name: 'Salvar' }));
  expect(onConfirmar).toHaveBeenCalledWith({ eliminated_by: ['b'], no_eliminator: false });
});
