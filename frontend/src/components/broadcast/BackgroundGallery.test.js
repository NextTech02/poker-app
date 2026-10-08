/**
 * Seletor de fundo: um campo só com quatro formas (nenhuma, preset, imagem
 * da biblioteca, URL colada). O que o operador faz aqui vai direto para o
 * `onChange`; a biblioteca em si (upload/remoção) é do hook, mockado.
 */
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import BackgroundGallery from './BackgroundGallery';
import { useToast } from '../../contexts/ToastContext';

jest.mock('../../contexts/ToastContext', () => ({ useToast: jest.fn() }));
jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (chave, fallback) => (typeof fallback === 'string' ? fallback : chave) }),
}));

const ITEM = { id: 'b1', path: 'org-1/a.webp', name: 'salao.webp', url: 'https://cdn/org-1/a.webp' };

let toast;
let confirmar;
let library;
let onChange;
let onOverlayChange;
let onItemRemoved;

beforeEach(() => {
  toast = { success: jest.fn(), error: jest.fn(), warning: jest.fn() };
  confirmar = jest.fn().mockResolvedValue(true);
  useToast.mockReturnValue({ toast, confirm: confirmar });
  library = {
    items: [ITEM], loading: false, uploading: false, error: null,
    upload: jest.fn(async () => ({ ...ITEM, id: 'b2', url: 'https://cdn/org-1/novo.webp' })),
    remove: jest.fn(async () => {}),
  };
  onChange = jest.fn();
  onOverlayChange = jest.fn();
  onItemRemoved = jest.fn();
});

const montar = (props = {}) => render(
  <BackgroundGallery
    value={props.value ?? ''}
    onChange={onChange}
    library={library}
    bgColor="#0b1020"
    overlay={props.overlay ?? 45}
    onOverlayChange={onOverlayChange}
    showOverlay={props.showOverlay ?? true}
    onItemRemoved={onItemRemoved}
    idPrefix="bg"
  />,
);

const tiles = () => Array.from(document.querySelectorAll('.bg-tile'));

describe('escolha', () => {
  it('mostra nenhuma, os quatro presets, a biblioteca e o envio', () => {
    montar();
    expect(document.querySelector('.bg-tile--none')).toBeInTheDocument();
    expect(document.querySelectorAll('.bg-tile--preset').length).toBe(4);
    expect(screen.getByRole('img', { name: 'salao.webp' })).toHaveAttribute('src', ITEM.url);
    expect(document.querySelector('.bg-tile--upload')).toBeInTheDocument();
    expect(tiles().length).toBe(7);
  });

  it('preset grava preset:<nome>; "nenhuma" grava vazio; imagem grava a URL', async () => {
    montar();
    await userEvent.click(document.querySelector('[data-preset="navy"]'));
    expect(onChange).toHaveBeenLastCalledWith('preset:navy');
    await userEvent.click(document.querySelector('.bg-tile--none'));
    expect(onChange).toHaveBeenLastCalledWith('');
    await userEvent.click(screen.getByRole('button', { name: 'salao.webp' }));
    expect(onChange).toHaveBeenLastCalledWith(ITEM.url);
  });

  it('o valor atual aparece selecionado', () => {
    montar({ value: 'preset:felt' });
    expect(document.querySelector('[data-preset="felt"]')).toHaveClass('is-selected');
    expect(document.querySelector('.bg-tile--none')).not.toHaveClass('is-selected');
  });

  it('imagem antiga em base64 aparece como tile selecionado', () => {
    montar({ value: 'data:image/png;base64,AAAA' });
    const legado = document.querySelector('.bg-tile--legacy');
    expect(legado).toHaveClass('is-selected');
    expect(legado.querySelector('img')).toHaveAttribute('src', 'data:image/png;base64,AAAA');
  });

  it('URL externa aparece no campo de texto; URL da biblioteca e preset não', () => {
    montar({ value: 'https://outro.com/x.jpg' });
    expect(screen.getByTestId('bg-url-input')).toHaveValue('https://outro.com/x.jpg');
    document.body.innerHTML = '';
    montar({ value: ITEM.url });
    expect(screen.getByTestId('bg-url-input')).toHaveValue('');
    document.body.innerHTML = '';
    montar({ value: 'preset:navy' });
    expect(screen.getByTestId('bg-url-input')).toHaveValue('');
  });

  it('digitar uma URL grava o texto', () => {
    montar();
    fireEvent.change(screen.getByTestId('bg-url-input'), { target: { value: 'https://x.com/a.png' } });
    expect(onChange).toHaveBeenCalledWith('https://x.com/a.png');
  });

  it('biblioteca vazia avisa; erro de carga avisa', () => {
    library.items = [];
    montar();
    expect(document.querySelector('.bg-gallery-empty')).toBeInTheDocument();
    library.error = new Error('x');
    document.body.innerHTML = '';
    montar();
    expect(document.querySelector('.bg-gallery-error')).toBeInTheDocument();
  });
});

describe('envio', () => {
  const arquivo = () => new File(['x'], 'nova.png', { type: 'image/png' });

  it('sobe pela biblioteca, seleciona a nova imagem e avisa', async () => {
    montar();
    await userEvent.upload(screen.getByTestId('bg-upload-input'), arquivo());
    await waitFor(() => expect(library.upload).toHaveBeenCalled());
    await waitFor(() => expect(onChange).toHaveBeenCalledWith('https://cdn/org-1/novo.webp'));
    expect(toast.success).toHaveBeenCalledWith('Imagem enviada.');
  });

  it('recusa com código vira aviso traduzido', async () => {
    library.upload = jest.fn(async () => { const e = new Error('bgUploadInvalidType'); e.code = 'bgUploadInvalidType'; throw e; });
    montar();
    await userEvent.upload(screen.getByTestId('bg-upload-input'), arquivo());
    await waitFor(() => expect(toast.warning).toHaveBeenCalledWith('Use JPG, PNG ou WebP.'));
    expect(onChange).not.toHaveBeenCalled();
  });

  it('erro sem código cai na mensagem genérica', async () => {
    library.upload = jest.fn(async () => { throw new Error('rede'); });
    montar();
    await userEvent.upload(screen.getByTestId('bg-upload-input'), arquivo());
    await waitFor(() => expect(toast.warning).toHaveBeenCalledWith('Não foi possível enviar a imagem.'));
  });

  it('enquanto envia, o tile fica ocupado', () => {
    library.uploading = true;
    montar();
    expect(document.querySelector('.bg-tile--upload')).toHaveClass('is-busy');
    expect(screen.getByTestId('bg-upload-input')).toBeDisabled();
    expect(document.querySelector('.bg-tile--upload')).toHaveTextContent('Enviando…');
  });
});

describe('exclusão', () => {
  const excluir = () => userEvent.click(screen.getByRole('button', { name: 'Excluir salao.webp' }));

  it('pede confirmação, remove, limpa o campo se era a selecionada e avisa o pai', async () => {
    montar({ value: ITEM.url });
    await excluir();
    expect(confirmar).toHaveBeenCalled();
    await waitFor(() => expect(library.remove).toHaveBeenCalledWith(ITEM));
    expect(onChange).toHaveBeenCalledWith('');
    expect(onItemRemoved).toHaveBeenCalledWith(ITEM.url);
    expect(toast.success).toHaveBeenCalledWith('Imagem excluída.');
  });

  it('não era a selecionada: o campo não muda', async () => {
    montar({ value: 'preset:navy' });
    await excluir();
    await waitFor(() => expect(library.remove).toHaveBeenCalled());
    expect(onChange).not.toHaveBeenCalled();
  });

  it('cancelar a confirmação não remove', async () => {
    confirmar.mockResolvedValue(false);
    montar();
    await excluir();
    expect(library.remove).not.toHaveBeenCalled();
  });

  it('falha ao remover vira erro na tela', async () => {
    library.remove = jest.fn(async () => { throw new Error('x'); });
    montar();
    await excluir();
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Não foi possível excluir a imagem.'));
  });
});

describe('escurecimento', () => {
  it('o slider grava o valor e mostra a porcentagem', () => {
    montar({ overlay: 30 });
    expect(screen.getByText('30%')).toBeInTheDocument();
    fireEvent.change(screen.getByTestId('bg-overlay-input'), { target: { value: '60' } });
    expect(onOverlayChange).toHaveBeenCalledWith(60);
  });

  it('sem showOverlay não há slider (fundo do intervalo)', () => {
    montar({ showOverlay: false });
    expect(screen.queryByTestId('bg-overlay-input')).toBeNull();
  });

  it('lixo no valor vira o padrão de 45%', () => {
    montar({ overlay: 'abc' });
    expect(screen.getByText('45%')).toBeInTheDocument();
  });
});
