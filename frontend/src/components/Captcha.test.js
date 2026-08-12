/**
 * Verificação anti-robô das telas de autenticação.
 *
 * Modo INVISÍVEL de propósito: o caixa entra no sistema várias vezes por
 * dia, e clicar em "não sou um robô" a cada vez seria atrito puro. O desafio
 * só aparece quando o hCaptcha desconfia do acesso.
 *
 * Três decisões que os testes travam:
 *
 * - **A chave tem valor padrão embutido**, não só variável de ambiente. Ela
 *   é pública de qualquer forma (vai no pacote do navegador); o padrão é
 *   segurança OPERACIONAL: se o captcha for ligado no Supabase e o build
 *   tiver subido sem a variável, ninguém entraria — nem para corrigir.
 * - **O token é resetado antes de cada uso.** Ele vale uma vez só; sem o
 *   reset, uma segunda tentativa de login reenviaria o token gasto e
 *   falharia sem motivo aparente.
 * - **Há teto de tempo.** Um desafio que não conclui (rede bloqueada,
 *   usuário que fecha a janelinha) deixaria o botão preso em "Entrando..."
 *   para sempre. Falhar com aviso é melhor que travar em silêncio.
 */
import { render } from '@testing-library/react';
import { createRef } from 'react';
import Captcha, { CAPTCHA_SITE_KEY, captchaAtivo } from './Captcha';

// O widget real carrega script de terceiro; aqui ele vira um espião que
// expõe as mesmas funções que o componente chama.
const mockWidget = { execute: jest.fn(), resetCaptcha: jest.fn() };
jest.mock('@hcaptcha/react-hcaptcha', () => {
  const { forwardRef, useImperativeHandle } = require('react');
  return {
    __esModule: true,
    default: forwardRef((props, ref) => {
      useImperativeHandle(ref, () => mockWidget);
      return <div data-testid="hcaptcha" data-sitekey={props.sitekey} data-size={props.size} data-lang={props.languageOverride} />;
    }),
  };
});

const montar = () => {
  const ref = createRef();
  const r = render(<Captcha ref={ref} />);
  return { ref, ...r };
};

beforeEach(() => {
  mockWidget.execute.mockResolvedValue({ response: 'token-valido' });
  mockWidget.resetCaptcha.mockImplementation(() => {});
});

describe('configuração', () => {
  it('tem chave mesmo sem variável de ambiente', () => {
    // Sem o padrão, um build sem a variável travaria TODOS os acessos, e
    // ninguém entraria nem para corrigir.
    expect(CAPTCHA_SITE_KEY).toBeTruthy();
  });

  it('informa às telas que a verificação está ativa', () => {
    expect(captchaAtivo()).toBe(true);
  });

  it('monta em modo invisível', () => {
    // Obrigar o caixa a clicar em "não sou um robô" a cada login seria
    // atrito puro.
    const { getByTestId } = montar();
    expect(getByTestId('hcaptcha')).toHaveAttribute('data-size', 'invisible');
  });

  it('usa a chave configurada', () => {
    const { getByTestId } = montar();
    expect(getByTestId('hcaptcha')).toHaveAttribute('data-sitekey', CAPTCHA_SITE_KEY);
  });

  it('segue o idioma da página', () => {
    // Sem isso o desafio sai sempre em inglês, para um operador que opera em
    // português ou espanhol.
    document.documentElement.lang = 'es-ES';
    const { getByTestId } = montar();
    expect(getByTestId('hcaptcha')).toHaveAttribute('data-lang', 'es');
    document.documentElement.lang = '';
  });

  it('sem idioma na página assume português', () => {
    document.documentElement.lang = '';
    const { getByTestId } = montar();
    expect(getByTestId('hcaptcha')).toHaveAttribute('data-lang', 'pt');
  });
});

describe('obtenção do token', () => {
  it('resolve o desafio e devolve o token', async () => {
    const { ref } = montar();
    await expect(ref.current.getToken()).resolves.toBe('token-valido');
  });

  it('reseta antes de executar', async () => {
    // O token vale uma vez só: sem o reset, a segunda tentativa de login
    // reenviaria o token gasto e falharia sem motivo aparente.
    const { ref } = montar();
    await ref.current.getToken();
    expect(mockWidget.resetCaptcha).toHaveBeenCalled();
  });

  it('reset que falha (widget ainda montando) não impede o uso', async () => {
    mockWidget.resetCaptcha.mockImplementation(() => {
      throw new Error('ainda não montou');
    });
    const { ref } = montar();
    await expect(ref.current.getToken()).resolves.toBe('token-valido');
  });

  it('executa em modo assíncrono', async () => {
    const { ref } = montar();
    await ref.current.getToken();
    expect(mockWidget.execute).toHaveBeenCalledWith({ async: true });
  });

  it('desafio sem token estoura em vez de mandar login incompleto', async () => {
    // Mandar a requisição sem token traria um erro genérico do servidor; o
    // erro nomeado deixa a tela escolher a mensagem.
    mockWidget.execute.mockResolvedValue({ response: null });
    const { ref } = montar();
    await expect(ref.current.getToken()).rejects.toThrow('CAPTCHA_SEM_TOKEN');
  });

  it('resposta vazia também estoura', async () => {
    mockWidget.execute.mockResolvedValue(undefined);
    const { ref } = montar();
    await expect(ref.current.getToken()).rejects.toThrow('CAPTCHA_SEM_TOKEN');
  });

  it('desafio que nunca conclui falha por tempo', async () => {
    // Sem o teto, o botão ficaria preso em "Entrando..." para sempre, sem
    // nenhuma mensagem.
    jest.useFakeTimers();
    mockWidget.execute.mockReturnValue(new Promise(() => {}));
    const { ref } = montar();
    const promessa = ref.current.getToken();
    const esperado = expect(promessa).rejects.toThrow('CAPTCHA_TEMPO_ESGOTADO');
    jest.advanceTimersByTime(90000);
    await esperado;
    jest.useRealTimers();
  });

  it('o teto de tempo é cancelado quando o token chega', async () => {
    // Um timer pendurado dispararia depois do login bem-sucedido.
    jest.useFakeTimers();
    const limpar = jest.spyOn(global, 'clearTimeout');
    const { ref } = montar();
    await ref.current.getToken();
    expect(limpar).toHaveBeenCalled();
    limpar.mockRestore();
    jest.useRealTimers();
  });
});
