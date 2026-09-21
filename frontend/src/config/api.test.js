/**
 * Cliente HTTP: interceptores de requisição e resposta.
 *
 * Três responsabilidades, todas com consequência visível:
 *
 * 1. **Token e etapa em toda chamada.** O `X-Stage-ID` é o que escopa a
 *    visão; esquecê-lo faria a tela mostrar dados de todas as etapas
 *    misturados.
 * 2. **Cache de leitura escopado por USUÁRIO + ORGANIZAÇÃO.** É o que permite
 *    a tela abrir sem internet. A chave PRECISA carregar o escopo: dois
 *    clubes no mesmo computador (comum em suporte) veriam os dados um do
 *    outro.
 * 3. **Achatar o `detail` do FastAPI.** Erro 422 vem como uma LISTA de
 *    objetos; renderizar isso direto quebra a tela inteira com "Objects are
 *    not valid as a React child" — no lugar de mostrar qual campo está errado.
 */
import MockAdapter from 'axios-mock-adapter';
import i18n from 'i18next';
import api from './api';
import { getSelectedStageId } from '../utils/stageUtils';
import { emitToastError } from '../utils/toastEmitter';
import { putGetCache, getGetCache } from '../offline/db';
import { markOffline, markOnline } from '../offline/connectivity';

jest.mock('../utils/stageUtils', () => ({ getSelectedStageId: jest.fn() }));
jest.mock('../utils/toastEmitter', () => ({ emitToastError: jest.fn() }));
jest.mock('../offline/db', () => ({ putGetCache: jest.fn(), getGetCache: jest.fn() }));
jest.mock('../offline/connectivity', () => ({
  markOffline: jest.fn(),
  markOnline: jest.fn(),
}));
jest.mock('i18next', () => ({
  t: (chave, padrao) => padrao || chave,
  language: 'pt-BR',
  resolvedLanguage: 'pt-BR',
}));

let mock;

/** JWT de mentira: só o payload importa (nunca é verificado no cliente). */
const tokenCom = (payload) => `x.${btoa(JSON.stringify(payload))}.y`;

beforeEach(() => {
  mock = new MockAdapter(api);
  localStorage.clear();
  getSelectedStageId.mockReturnValue(null);
  getGetCache.mockResolvedValue(null);
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  mock.restore();
  console.error.mockRestore();
});

describe('interceptor de requisição', () => {
  it('anexa o token quando há sessão', async () => {
    localStorage.setItem('supabase_token', 'token-abc');
    mock.onGet('/players').reply(200, []);
    await api.get('/players');
    expect(mock.history.get[0].headers.Authorization).toBe('Bearer token-abc');
  });

  it('sem sessão não manda cabeçalho de autorização', async () => {
    mock.onGet('/players').reply(200, []);
    await api.get('/players');
    expect(mock.history.get[0].headers.Authorization).toBeUndefined();
  });

  it('anexa a etapa selecionada', async () => {
    // Sem o header, a tela mostraria os dados de todas as etapas juntos.
    getSelectedStageId.mockReturnValue('etapa-1');
    mock.onGet('/tournaments').reply(200, []);
    await api.get('/tournaments');
    expect(mock.history.get[0].headers['X-Stage-ID']).toBe('etapa-1');
  });

  it('sem etapa selecionada não manda o header', async () => {
    mock.onGet('/tournaments').reply(200, []);
    await api.get('/tournaments');
    expect(mock.history.get[0].headers['X-Stage-ID']).toBeUndefined();
  });

  it('anexa o idioma da interface', async () => {
    // O backend redige nele os e-mails que a ação dispara (convite,
    // redefinição de senha): quem convida em espanhol manda convite em espanhol.
    mock.onPost('/staff').reply(200, {});
    await api.post('/staff', { email: 'a@b.com' });
    expect(mock.history.post[0].headers['X-Language']).toBe('pt-BR');
  });

  it('manda o idioma que a tela de fato mostra, não o pedido pelo navegador', async () => {
    // Navegador em "es" puro: `language` diz "es", mas a interface renderiza
    // o idioma resolvido. O e-mail precisa acompanhar o que a pessoa vê.
    const antes = [i18n.language, i18n.resolvedLanguage];
    i18n.language = 'es';
    i18n.resolvedLanguage = 'es-ES';
    try {
      mock.onGet('/players').reply(200, []);
      await api.get('/players');
      expect(mock.history.get[0].headers['X-Language']).toBe('es-ES');
    } finally {
      [i18n.language, i18n.resolvedLanguage] = antes;
    }
  });

  it('sem idioma resolvido não manda o header', async () => {
    const antes = [i18n.language, i18n.resolvedLanguage];
    i18n.language = undefined;
    i18n.resolvedLanguage = undefined;
    try {
      mock.onGet('/players').reply(200, []);
      await api.get('/players');
      expect(mock.history.get[0].headers['X-Language']).toBeUndefined();
    } finally {
      [i18n.language, i18n.resolvedLanguage] = antes;
    }
  });
});

describe('cache de leitura', () => {
  it('guarda a resposta de um GET', async () => {
    mock.onGet('/players').reply(200, [{ id: 'p1' }]);
    await api.get('/players');
    expect(putGetCache).toHaveBeenCalledWith(expect.any(String), [{ id: 'p1' }]);
  });

  it('confirma a conectividade num GET bem-sucedido', async () => {
    mock.onGet('/players').reply(200, []);
    await api.get('/players');
    expect(markOnline).toHaveBeenCalled();
  });

  it('não guarda escritas', async () => {
    // Cachear um POST devolveria a resposta de um registro anterior como se
    // fosse a do novo.
    mock.onPost('/players').reply(201, { id: 'p1' });
    await api.post('/players', {});
    expect(putGetCache).not.toHaveBeenCalled();
  });

  it.each(['/tournament-days/1/timer/status', '/health', '/sync/batch', '/x/broadcast-code'])(
    'não guarda %s (volátil ou com lógica própria)',
    async (url) => {
      mock.onGet(url).reply(200, {});
      await api.get(url);
      expect(putGetCache).not.toHaveBeenCalled();
    }
  );

  it('a chave separa usuários e organizações diferentes', async () => {
    // Dois clubes no mesmo computador (situação comum em suporte) veriam os
    // dados um do outro se a chave não carregasse o escopo.
    mock.onGet('/players').reply(200, []);

    localStorage.setItem('supabase_token', tokenCom({ sub: 'u1', organization_id: 'orgA' }));
    await api.get('/players');
    const chaveA = putGetCache.mock.calls[0][0];

    localStorage.setItem('supabase_token', tokenCom({ sub: 'u2', organization_id: 'orgB' }));
    await api.get('/players');
    const chaveB = putGetCache.mock.calls[1][0];

    expect(chaveA).not.toBe(chaveB);
    expect(chaveA).toContain('u1');
    expect(chaveB).toContain('orgB');
  });

  it('a chave separa etapas diferentes', async () => {
    mock.onGet('/tournaments').reply(200, []);
    getSelectedStageId.mockReturnValue('etapa-1');
    await api.get('/tournaments');
    getSelectedStageId.mockReturnValue('etapa-2');
    await api.get('/tournaments');
    expect(putGetCache.mock.calls[0][0]).not.toBe(putGetCache.mock.calls[1][0]);
  });

  it('a chave separa filtros diferentes', async () => {
    mock.onGet('/players').reply(200, []);
    await api.get('/players', { params: { search: 'ana' } });
    await api.get('/players', { params: { search: 'beto' } });
    expect(putGetCache.mock.calls[0][0]).not.toBe(putGetCache.mock.calls[1][0]);
  });

  it('token malformado ainda produz uma chave utilizável', async () => {
    localStorage.setItem('supabase_token', 'nao-e-jwt');
    mock.onGet('/players').reply(200, []);
    await api.get('/players');
    expect(putGetCache.mock.calls[0][0]).toContain('anon:noorg');
  });
});

describe('leitura offline', () => {
  it('erro de rede serve o cache em vez de falhar', async () => {
    // É o que faz as telas carregarem sem internet, com os últimos dados
    // vistos.
    getGetCache.mockResolvedValue([{ id: 'do-cache' }]);
    mock.onGet('/players').networkError();
    const r = await api.get('/players');
    expect(r.data).toEqual([{ id: 'do-cache' }]);
    expect(r._fromCache).toBe(true);
    expect(markOffline).toHaveBeenCalled();
  });

  it('sem cache o erro de rede sobe normalmente', async () => {
    getGetCache.mockResolvedValue(null);
    mock.onGet('/players').networkError();
    await expect(api.get('/players')).rejects.toBeTruthy();
  });

  it('cache vazio (lista) é servido — não confundir com ausência', async () => {
    // Uma lista vazia é uma resposta legítima; tratá-la como "sem cache"
    // faria a tela dar erro em vez de mostrar "nenhum registro".
    getGetCache.mockResolvedValue([]);
    mock.onGet('/players').networkError();
    expect((await api.get('/players')).data).toEqual([]);
  });

  it('erro do SERVIDOR não é substituído pelo cache', async () => {
    // 403 é perda de acesso; servir o cache esconderia isso do operador.
    getGetCache.mockResolvedValue([{ id: 'velho' }]);
    mock.onGet('/players').reply(403, { detail: 'sem permissão' });
    await expect(api.get('/players')).rejects.toBeTruthy();
  });

  it('escrita que falha por rede não busca cache', async () => {
    mock.onPost('/players').networkError();
    await expect(api.post('/players', {})).rejects.toBeTruthy();
    expect(getGetCache).not.toHaveBeenCalled();
  });
});

describe('mensagem de erro para a tela', () => {
  it('detalhe em texto passa direto', async () => {
    mock.onPost('/players').reply(400, { detail: 'Jogador já inscrito' });
    await expect(api.post('/players', {})).rejects.toMatchObject({
      userMessage: 'Jogador já inscrito',
    });
  });

  it('erro 422 do FastAPI vira frase legível com o campo', async () => {
    // Sem achatar, renderizar `detail` direto quebra a tela com "Objects are
    // not valid as a React child" — e o operador não descobre qual campo
    // está errado.
    mock.onPost('/players').reply(422, {
      detail: [
        { type: 'missing', loc: ['body', 'email'], msg: 'Field required' },
        { type: 'value_error', loc: ['body', 'phone'], msg: 'inválido' },
      ],
    });
    await expect(api.post('/players', {})).rejects.toMatchObject({
      userMessage: 'email: Field required · phone: inválido',
    });
  });

  it('lista de textos simples é juntada', async () => {
    mock.onPost('/players').reply(422, { detail: ['erro um', 'erro dois'] });
    await expect(api.post('/players', {})).rejects.toMatchObject({
      userMessage: 'erro um · erro dois',
    });
  });

  it('recusa com CÓDIGO sai traduzida', async () => {
    /* O servidor manda `{code, message}` justamente para NÃO decidir o idioma:
       o sistema atende clubes no Brasil, no Peru e na Colômbia. A frase é
       escolhida aqui, por `errors.<code>`. */
    mock.onPost('/players').reply(409, {
      detail: { code: 'caixa_fechado', message: 'Abra o seu caixa antes de vender.' },
    });
    await expect(api.post('/players', {})).rejects.toMatchObject({
      userMessage: 'Abra o seu caixa antes de vender.',
    });
  });

  it('os dados do erro entram na frase', async () => {
    // O motivo que o admin escreveu é a parte que resolve a dúvida do jogador
    // no balcão — precisa aparecer, mesmo com a frase montada aqui.
    mock.onPost('/players').reply(400, {
      detail: {
        code: 'vendas_bloqueadas_dia',
        message: 'Vendas bloqueadas para este dia: registro tardio encerrado',
        motivo: 'registro tardio encerrado',
      },
    });
    const erro = await api.post('/players', {}).catch((e) => e);
    expect(erro.userMessage).toContain('registro tardio encerrado');
  });

  it('código que a tela ainda não conhece cai na frase do servidor', async () => {
    /* Degradação prevista: um código novo no backend aparece em português, e
       não como "erro desconhecido". É o que permite converter o backend aos
       poucos sem quebrar tela nenhuma. */
    mock.onPost('/players').reply(400, {
      detail: { code: 'codigo_que_nao_existe_na_tela', message: 'Frase vinda do servidor.' },
    });
    await expect(api.post('/players', {})).rejects.toMatchObject({
      userMessage: 'Frase vinda do servidor.',
    });
  });

  it('detalhe em objeto usa a mensagem interna', async () => {
    mock.onPost('/players').reply(400, { detail: { msg: 'algo deu errado' } });
    await expect(api.post('/players', {})).rejects.toMatchObject({
      userMessage: 'algo deu errado',
    });
  });

  it('sem detalhe nenhum cai na mensagem do axios', async () => {
    mock.onPost('/players').reply(500, {});
    await expect(api.post('/players', {})).rejects.toMatchObject({
      userMessage: expect.any(String),
    });
  });
});

describe('aviso automático', () => {
  it('erro 5xx vira toast', async () => {
    // A maioria das chamadas não trata erro; sem o aviso automático a ação
    // simplesmente não acontece e o operador não sabe por quê.
    mock.onGet('/dashboard/stats').reply(500, { detail: 'boom' });
    await expect(api.get('/dashboard/stats')).rejects.toBeTruthy();
    expect(emitToastError).toHaveBeenCalled();
  });

  it('erro 4xx NÃO vira toast', async () => {
    // A tela trata erro de validação no próprio formulário, junto do campo.
    mock.onPost('/players').reply(400, { detail: 'inválido' });
    await expect(api.post('/players', {})).rejects.toBeTruthy();
    expect(emitToastError).not.toHaveBeenCalled();
  });

  it('chamada marcada como silenciosa não avisa nem loga', async () => {
    // Usada na checagem de permissões, que falha de propósito para quem
    // ainda não tem vínculo.
    mock.onGet('/staff/me/permissions').reply(500, { detail: 'boom' });
    await expect(
      api.get('/staff/me/permissions', { _silentError: true })
    ).rejects.toBeTruthy();
    expect(emitToastError).not.toHaveBeenCalled();
    expect(console.error).not.toHaveBeenCalled();
  });

  it('erro não silencioso é registrado no console', async () => {
    mock.onGet('/players').reply(404, { detail: 'não encontrado' });
    await expect(api.get('/players')).rejects.toBeTruthy();
    expect(console.error).toHaveBeenCalledWith('[API Error]', expect.any(Object));
  });
});
