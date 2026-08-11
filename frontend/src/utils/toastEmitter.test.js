/**
 * O interceptor do axios roda FORA da árvore React e mesmo assim precisa
 * mostrar o erro na tela. Sem este singleton, a alternativa seria cada
 * chamada tratar o próprio erro — e a maioria não trataria.
 *
 * O ponto que os testes travam é o encadeamento opcional: antes de a
 * aplicação montar (e depois de desmontar, num teste) não há toast
 * registrado. Emitir nesse intervalo não pode derrubar nada — seria uma
 * falha do avisador de falhas.
 */
import { registerToast, emitToastError, emitToastSuccess } from './toastEmitter';

describe('emissor de toast fora do React', () => {
  afterEach(() => registerToast(null));

  it('encaminha o erro para o toast registrado', () => {
    const toast = { error: jest.fn(), success: jest.fn() };
    registerToast(toast);
    emitToastError('Sessão expirada');
    expect(toast.error).toHaveBeenCalledWith('Sessão expirada');
  });

  it('encaminha o sucesso', () => {
    const toast = { error: jest.fn(), success: jest.fn() };
    registerToast(toast);
    emitToastSuccess('Jogador registrado');
    expect(toast.success).toHaveBeenCalledWith('Jogador registrado');
  });

  it('sem toast registrado não estoura', () => {
    expect(() => emitToastError('erro antes de montar')).not.toThrow();
    expect(() => emitToastSuccess('ok antes de montar')).not.toThrow();
  });

  it('o último registro substitui o anterior', () => {
    const antigo = { error: jest.fn() };
    const novo = { error: jest.fn() };
    registerToast(antigo);
    registerToast(novo);
    emitToastError('x');
    expect(antigo.error).not.toHaveBeenCalled();
    expect(novo.error).toHaveBeenCalled();
  });
});
