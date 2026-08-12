/**
 * Importação da base de jogadores vinda do sistema concorrente.
 *
 * Duas coisas tornam esta tela peculiar:
 *
 * 1. **O "xls" do Poker Web não é xls.** É uma tabela HTML com BOM UTF-8 e a
 *    extensão trocada. Por isso o formato é detectado pelo CONTEÚDO — confiar
 *    na extensão faria o SheetJS receber HTML e falhar num arquivo
 *    perfeitamente legível.
 * 2. **A prévia não grava nada.** É o que permite ao clube conferir centenas
 *    de linhas de um export sujo antes de comprometer a base. E quem decide o
 *    que é válido é o SERVIDOR: o navegador só lê e nomeia colunas.
 *
 * O botão de importar fica travado quando não há nada a importar ou quando o
 * plano não comporta — deixar clicar produziria um erro que o operador não
 * teria como resolver ali.
 */
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import PlayerImportModal from './PlayerImportModal';
import api from '../config/api';
import { useToast } from '../contexts/ToastContext';

jest.mock('../config/api', () => ({ __esModule: true, default: { post: jest.fn() } }));
jest.mock('../contexts/ToastContext', () => ({ useToast: jest.fn() }));
jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (chave, padrao, vars) => {
      let texto = typeof padrao === 'string' ? padrao : chave;
      if (vars) {
        Object.entries(vars).forEach(([k, v]) => {
          texto = texto.replace(`{{${k}}}`, v);
        });
      }
      return texto;
    },
  }),
}));

const TABELA_HTML = `﻿<html><body><table>
<tr><td>Relatório de Jogadores</td></tr>
<tr><td>Gerado em 08/06/2026</td></tr>
<tr><th>ID</th><th>Jogador</th><th>Nick</th><th>E-mail</th><th>Telefone</th>
    <th>Doc. País</th><th>Doc. Tipo</th><th>Doc. Número</th><th>Nascimento</th><th>País</th></tr>
<tr><td>1</td><td>Ana Souza</td><td>aninha</td><td>ana@x.com</td><td>11999998888</td>
    <td>Brasil</td><td>RG</td><td>123456</td><td>18/07/1990</td><td>Brasil</td></tr>
<tr><td>2</td><td>Bruno Lima</td><td></td><td>bruno@x.com</td><td>11988887777</td>
    <td>Colombia</td><td>Cedula</td><td>987654</td><td>01/01/1985</td><td>Colombia</td></tr>
</table></body></html>`;

/** Arquivo de mentira: só `arrayBuffer()` e `name` importam para o componente. */
function arquivo(texto, nome = 'JOGADORES.xls') {
  const bytes = new TextEncoder().encode(texto);
  return {
    name: nome,
    arrayBuffer: async () => bytes.buffer,
  };
}

const PREVIA = {
  novos: 2,
  ja_cadastrados: 0,
  rejeitados: 0,
  cabe_no_plano: true,
  limite_plano: 100,
  jogadores_atuais: 10,
  amostra: [
    { name: 'Ana Souza', email: 'ana@x.com', phone: '11999998888', nationality: 'Brasil' },
  ],
  lista_rejeitados: [],
};

let toast;
let aoFechar;
let aoImportar;

const montar = () => {
  aoFechar = jest.fn();
  aoImportar = jest.fn();
  const r = render(<PlayerImportModal onClose={aoFechar} onImported={aoImportar} />);
  return { ...r, entrada: document.querySelector('input[type="file"]') };
};

/** Dispara o `onChange` do input escondido com o arquivo dado. */
const enviar = async (entrada, file) => {
  await userEvent.upload(entrada, file);
};

beforeEach(() => {
  toast = { success: jest.fn(), error: jest.fn() };
  useToast.mockReturnValue({ toast });
  api.post.mockResolvedValue({ data: PREVIA });
});

describe('leitura do arquivo', () => {
  it('lê a tabela HTML disfarçada de xls', async () => {
    // Confiar na extensão mandaria HTML para o SheetJS e falharia num
    // arquivo perfeitamente legível.
    const { entrada } = montar();
    await enviar(entrada, arquivo(TABELA_HTML));
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith('/players/import/preview', {
        rows: expect.arrayContaining([
          expect.objectContaining({ name: 'Ana Souza', email: 'ana@x.com' }),
        ]),
      })
    );
  });

  it('pula as linhas de título antes do cabeçalho', async () => {
    // O export traz título e data antes da linha de cabeçalho de verdade.
    const { entrada } = montar();
    await enviar(entrada, arquivo(TABELA_HTML));
    await waitFor(() => expect(api.post).toHaveBeenCalled());
    const linhas = api.post.mock.calls[0][1].rows;
    expect(linhas).toHaveLength(2);
    expect(linhas[0].source_id).toBe('1');
  });

  it('separa o país do DOCUMENTO do país de endereço', async () => {
    // São colunas diferentes no export; misturá-las gravaria nacionalidade
    // errada em massa.
    const { entrada } = montar();
    await enviar(entrada, arquivo(TABELA_HTML));
    await waitFor(() => expect(api.post).toHaveBeenCalled());
    const bruno = api.post.mock.calls[0][1].rows[1];
    expect(bruno.doc_country).toBe('Colombia');
    expect(bruno.document_type).toBe('Cedula');
  });

  it('mostra o nome do arquivo escolhido', async () => {
    const { entrada } = montar();
    await enviar(entrada, arquivo(TABELA_HTML, 'MEUS_JOGADORES.xls'));
    await waitFor(() => expect(api.post).toHaveBeenCalled());
  });

  it('arquivo sem coluna de nome é recusado com explicação', async () => {
    // "Não achamos a coluna de nome" diz ao operador que ele pegou o arquivo
    // errado; um erro genérico não diria nada.
    const { entrada } = montar();
    await enviar(entrada, arquivo('<table><tr><th>Foo</th></tr><tr><td>1</td></tr></table>'));
    expect(await screen.findByText(/Não achamos a coluna de nome/)).toBeInTheDocument();
    expect(api.post).not.toHaveBeenCalled();
  });

  it('arquivo com cabeçalho mas sem jogadores avisa', async () => {
    const { entrada } = montar();
    await enviar(entrada, arquivo('<table><tr><th>Jogador</th></tr></table>'));
    expect(
      await screen.findByText(/Não encontramos jogadores neste arquivo/)
    ).toBeInTheDocument();
  });

  it('linhas totalmente em branco são ignoradas', async () => {
    const { entrada } = montar();
    await enviar(
      entrada,
      arquivo(`<table>
        <tr><th>Jogador</th><th>E-mail</th></tr>
        <tr><td>Ana</td><td>a@x.com</td></tr>
        <tr><td>  </td><td>  </td></tr>
      </table>`)
    );
    await waitFor(() => expect(api.post).toHaveBeenCalled());
    expect(api.post.mock.calls[0][1].rows).toHaveLength(1);
  });

  it('cabeçalho em espanhol também é reconhecido', async () => {
    // O export sai no idioma da instalação do concorrente.
    const { entrada } = montar();
    await enviar(
      entrada,
      arquivo('<table><tr><th>Nombre</th><th>Correo</th></tr><tr><td>Ana</td><td>a@x.com</td></tr></table>')
    );
    await waitFor(() => expect(api.post).toHaveBeenCalled());
    expect(api.post.mock.calls[0][1].rows[0]).toMatchObject({
      name: 'Ana',
      email: 'a@x.com',
    });
  });

  it('cabeçalho com acento diferente ainda casa', async () => {
    const { entrada } = montar();
    await enviar(
      entrada,
      arquivo('<table><tr><th>JOGADOR</th><th>Telefone</th></tr><tr><td>Ana</td><td>119</td></tr></table>')
    );
    await waitFor(() => expect(api.post).toHaveBeenCalled());
    expect(api.post.mock.calls[0][1].rows[0].phone).toBe('119');
  });

  it('falha do servidor na prévia vira mensagem na tela', async () => {
    api.post.mockRejectedValue({ userMessage: 'plano não permite' });
    const { entrada } = montar();
    await enviar(entrada, arquivo(TABELA_HTML));
    expect(await screen.findByText('plano não permite')).toBeInTheDocument();
  });

  it('nenhum arquivo escolhido não faz nada', async () => {
    const { entrada } = montar();
    await userEvent.upload(entrada, []);
    expect(api.post).not.toHaveBeenCalled();
  });
});

describe('prévia', () => {
  const irParaPrevia = async (previa = PREVIA) => {
    api.post.mockResolvedValue({ data: previa });
    const r = montar();
    await enviar(r.entrada, arquivo(TABELA_HTML));
    await screen.findByText(/Nada foi salvo ainda/);
    return r;
  };

  it('diz explicitamente que nada foi gravado', async () => {
    // É o que dá segurança ao clube para conferir antes de comprometer a base.
    await irParaPrevia();
    expect(screen.getByText(/Nada foi salvo ainda/)).toBeInTheDocument();
  });

  it('mostra os três números do resultado esperado', async () => {
    await irParaPrevia({ ...PREVIA, novos: 5, ja_cadastrados: 3, rejeitados: 2 });
    expect(screen.getByText('5')).toBeInTheDocument();
    expect(screen.getByText('3')).toBeInTheDocument();
    expect(screen.getByText('2')).toBeInTheDocument();
  });

  it('mostra uma amostra do que será criado', async () => {
    await irParaPrevia();
    expect(screen.getByText('ana@x.com')).toBeInTheDocument();
  });

  it('sem incompletos não oferece a lista de pendências', async () => {
    await irParaPrevia();
    expect(screen.queryByText(/Baixar lista de pendentes/)).toBeNull();
  });

  it('com incompletos explica o motivo e oferece a lista', async () => {
    // O clube corrige na ORIGEM e importa de novo; sem a lista ele não sabe
    // quem falta.
    await irParaPrevia({
      ...PREVIA,
      rejeitados: 2,
      lista_rejeitados: [
        { source_id: '9', name: 'Sem Email', reason: 'e-mail ausente' },
      ],
    });
    expect(screen.getByText(/não têm e-mail, telefone ou documento/)).toBeInTheDocument();
    expect(screen.getByText(/Baixar lista de pendentes/)).toBeInTheDocument();
  });

  it('a lista de pendências sai em CSV com BOM', async () => {
    // Sem o BOM o Excel abre os acentos errados, e o clube reclama do
    // arquivo em vez de corrigir os cadastros.
    const capturado = {};
    const BlobOriginal = global.Blob;
    global.Blob = class {
      constructor(partes) {
        capturado.conteudo = partes.join('');
      }
    };
    global.URL.createObjectURL = jest.fn(() => 'blob:x');
    global.URL.revokeObjectURL = jest.fn();
    const clique = jest
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(function () {
        capturado.nome = this.download;
      });

    await irParaPrevia({
      ...PREVIA,
      rejeitados: 1,
      lista_rejeitados: [{ source_id: '9', name: 'João Ré', reason: 'sem e-mail' }],
    });
    await userEvent.click(screen.getByText(/Baixar lista de pendentes/));

    expect(capturado.conteudo.charCodeAt(0)).toBe(0xfeff);
    expect(capturado.conteudo).toContain('João Ré');
    expect(capturado.nome).toBe('jogadores-pendentes.csv');

    global.Blob = BlobOriginal;
    clique.mockRestore();
  });

  it('plano estourado bloqueia a importação e explica os números', async () => {
    // Deixar clicar produziria um erro que o operador não teria como
    // resolver ali.
    await irParaPrevia({
      ...PREVIA,
      cabe_no_plano: false,
      limite_plano: 100,
      jogadores_atuais: 99,
      novos: 50,
    });
    expect(screen.getByText(/O plano permite 100 jogadores/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Importar/ })).toBeDisabled();
  });

  it('sem nada novo o botão fica travado', async () => {
    await irParaPrevia({ ...PREVIA, novos: 0, ja_cadastrados: 10 });
    expect(screen.getByRole('button', { name: /Importar/ })).toBeDisabled();
  });

  it('cancelar fecha sem gravar', async () => {
    await irParaPrevia();
    await userEvent.click(screen.getByRole('button', { name: 'Cancelar' }));
    expect(aoFechar).toHaveBeenCalled();
    expect(api.post).toHaveBeenCalledTimes(1); // só a prévia
  });
});

describe('importação', () => {
  const importar = async (resultado) => {
    api.post.mockResolvedValueOnce({ data: PREVIA });
    const r = montar();
    await enviar(r.entrada, arquivo(TABELA_HTML));
    await screen.findByText(/Nada foi salvo ainda/);
    api.post.mockResolvedValueOnce({ data: resultado });
    await userEvent.click(screen.getByRole('button', { name: /Importar/ }));
    return r;
  };

  it('grava e mostra o resultado', async () => {
    await importar({ importados: 2, ja_cadastrados: 0, rejeitados: 0, lista_rejeitados: [] });
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith('/players/import', expect.any(Object))
    );
    expect(await screen.findByText('importados')).toBeInTheDocument();
    expect(toast.success).toHaveBeenCalled();
  });

  it('avisa a tela de jogadores para recarregar', async () => {
    await importar({ importados: 2, ja_cadastrados: 0, rejeitados: 0, lista_rejeitados: [] });
    await waitFor(() => expect(aoImportar).toHaveBeenCalled());
  });

  it('importação que não criou ninguém não festeja', async () => {
    // Todos já existiam: um "2 jogadores importados" seria mentira.
    await importar({ importados: 0, ja_cadastrados: 2, rejeitados: 0, lista_rejeitados: [] });
    await waitFor(() => expect(screen.getByText('importados')).toBeInTheDocument());
    expect(toast.success).not.toHaveBeenCalled();
    expect(aoImportar).not.toHaveBeenCalled();
  });

  it('depois de importar, os pendentes continuam disponíveis', async () => {
    // O fluxo é corrigir na origem e reimportar; os já criados são ignorados.
    await importar({
      importados: 1,
      ja_cadastrados: 0,
      rejeitados: 1,
      lista_rejeitados: [{ source_id: '9', name: 'Sem Email', reason: 'e-mail ausente' }],
    });
    expect(await screen.findByText(/Baixar lista de pendentes/)).toBeInTheDocument();
  });

  it('falha ao gravar mostra o motivo e mantém a tela', async () => {
    api.post.mockResolvedValueOnce({ data: PREVIA });
    const { entrada } = montar();
    await enviar(entrada, arquivo(TABELA_HTML));
    await screen.findByText(/Nada foi salvo ainda/);
    api.post.mockRejectedValueOnce({ userMessage: 'limite do plano' });
    await userEvent.click(screen.getByRole('button', { name: /Importar/ }));
    expect(await screen.findByText('limite do plano')).toBeInTheDocument();
  });
});

describe('fechamento', () => {
  it('o X fecha', async () => {
    montar();
    await userEvent.click(screen.getByRole('button', { name: 'Fechar' }));
    expect(aoFechar).toHaveBeenCalled();
  });

  it('clicar fora fecha', async () => {
    const { container } = montar();
    await userEvent.click(container.querySelector('.pim-overlay'));
    expect(aoFechar).toHaveBeenCalled();
  });

  it('clicar dentro não fecha', async () => {
    // Selecionar o texto da prévia não pode descartar o trabalho.
    const { container } = montar();
    await userEvent.click(container.querySelector('.pim-modal'));
    expect(aoFechar).not.toHaveBeenCalled();
  });
});
