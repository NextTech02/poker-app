/**
 * Exportação de relatórios. A regra central é a distinção entre valor CRU e
 * valor FORMATADO:
 *
 * - Excel e CSV recebem NÚMERO de verdade. É o que permite ao contador somar
 *   a coluna. Mandar "R$ 1.234,56" transformaria a coluna em texto e o
 *   somatório daria zero.
 * - O PDF recebe valor formatado, porque ninguém soma um PDF — ele é lido.
 *
 * O outro ponto é o CSV: precisa de BOM (senão o Excel abre "Joao" no lugar
 * de "João") e de aspas escapadas (uma vírgula no nome de um jogador
 * quebraria a coluna e deslocaria o resto da linha).
 */
import { exportSections, sectionColumns } from './reportExport';

const moeda = (n) => `R$ ${Number(n).toFixed(2)}`;

// As libs pesadas são carregadas sob demanda (import dinâmico) para não
// entrarem no bundle de quem nunca exporta. Aqui elas viram espiões: o que se
// testa é o CONTEÚDO entregue a elas, não o arquivo binário que produzem.
const espiaoXlsx = { abas: [] };
jest.mock('xlsx', () => ({
  utils: {
    book_new: () => ({ SheetNames: [], Sheets: {} }),
    aoa_to_sheet: (aoa) => ({ aoa }),
    book_append_sheet: (wb, ws, nome) =>
      espiaoXlsx.abas.push({ nome, aoa: ws.aoa, larguras: ws['!cols'] }),
  },
  writeFile: jest.fn(),
}));

const espiaoPdf = { tabelas: [], salvo: null };
jest.mock('jspdf', () => ({
  jsPDF: class {
    constructor() {
      this.internal = {
        pageSize: { getWidth: () => 595, getHeight: () => 842 },
        getNumberOfPages: () => 1,
      };
      this.lastAutoTable = { finalY: 200 };
    }
    // Comandos de desenho do jsPDF: o teste verifica o CONTEÚDO exportado
    // (via autoTable e `save`), não os traços na página — então estes só
    // precisam existir para a chamada não estourar.
    setFillColor = () => this;
    rect = () => this;
    setTextColor = () => this;
    setFont = () => this;
    setFontSize = () => this;
    text = () => this;
    addPage = () => this;
    setPage = () => this;
    save(nome) {
      espiaoPdf.salvo = nome;
    }
  },
}));
jest.mock('jspdf-autotable', () => ({
  __esModule: true,
  default: (doc, opcoes) => espiaoPdf.tabelas.push(opcoes),
}));

// Captura o conteúdo do arquivo baixado sem tocar em disco.
function capturarDownload() {
  const capturado = {};
  const blobOriginal = global.Blob;

  global.Blob = class {
    constructor(partes, opcoes) {
      capturado.conteudo = partes.join('');
      capturado.tipo = opcoes?.type;
    }
  };
  global.URL.createObjectURL = jest.fn(() => 'blob:fake');
  global.URL.revokeObjectURL = jest.fn();

  const clique = jest
    .spyOn(HTMLAnchorElement.prototype, 'click')
    .mockImplementation(function () {
      capturado.nome = this.download;
    });

  capturado.restaurar = () => {
    global.Blob = blobOriginal;
    clique.mockRestore();
  };
  return capturado;
}

const SECAO_TABELA = {
  kind: 'table',
  title: 'Jogadores',
  columns: [
    { key: 'name', label: 'Nome', type: 'text' },
    { key: 'entries', label: 'Entradas', type: 'int' },
    { key: 'spent', label: 'Gasto', type: 'currency' },
  ],
  rows: [
    { name: 'Fulano', entries: 3, spent: 900 },
    { name: 'Beltrano', entries: 1, spent: 300.5 },
  ],
};

const SECAO_RESUMO = {
  kind: 'keyvalue',
  title: 'Resumo',
  keyLabel: 'Indicador',
  valueLabel: 'Valor',
  rows: [
    { label: 'Receita', value: 1200, type: 'currency' },
    { label: 'Rake', value: 20, type: 'percent' },
    { label: 'Etapa', value: 'Rio', type: 'text' },
  ],
};

describe('colunas de uma seção', () => {
  it('tabela usa as próprias colunas', () => {
    expect(sectionColumns(SECAO_TABELA)).toBe(SECAO_TABELA.columns);
  });

  it('chave-valor vira duas colunas com os rótulos informados', () => {
    expect(sectionColumns(SECAO_RESUMO).map((c) => c.label)).toEqual([
      'Indicador',
      'Valor',
    ]);
  });

  it('chave-valor sem rótulos usa os padrões', () => {
    expect(sectionColumns({ kind: 'keyvalue', rows: [] }).map((c) => c.label)).toEqual([
      'Item',
      'Valor',
    ]);
  });
});

describe('CSV', () => {
  let baixado;
  beforeEach(() => {
    baixado = capturarDownload();
  });
  afterEach(() => baixado.restaurar());

  it('começa com BOM para o Excel entender acento', async () => {
    // Sem o BOM, "João" abre como "JoÃ£o" no Excel do cliente.
    await exportSections([SECAO_TABELA], { format: 'csv', filename: 'rel' });
    expect(baixado.conteudo.charCodeAt(0)).toBe(0xfeff);
  });

  it('usa a extensão e o tipo certos', async () => {
    await exportSections([SECAO_TABELA], { format: 'csv', filename: 'relatorio' });
    expect(baixado.nome).toBe('relatorio.csv');
    expect(baixado.tipo).toContain('text/csv');
  });

  it('escreve o título, o cabeçalho e as linhas', async () => {
    await exportSections([SECAO_TABELA], { format: 'csv', filename: 'rel' });
    const linhas = baixado.conteudo.replace('﻿', '').split('\r\n');
    expect(linhas[0]).toBe('### Jogadores');
    expect(linhas[1]).toBe('Nome,Entradas,Gasto');
    expect(linhas[2]).toBe('Fulano,3,900');
  });

  it('valor de moeda sai como NÚMERO, não formatado', async () => {
    // É o que permite somar a coluna na planilha do contador.
    await exportSections([SECAO_TABELA], {
      format: 'csv',
      filename: 'rel',
      formatCurrency: moeda,
    });
    expect(baixado.conteudo).toContain('300.5');
    expect(baixado.conteudo).not.toContain('R$');
  });

  it('vírgula no dado é protegida por aspas', async () => {
    // Um jogador cadastrado como "Silva, João" deslocaria todas as colunas
    // seguintes da linha.
    await exportSections(
      [{ ...SECAO_TABELA, rows: [{ name: 'Silva, João', entries: 1, spent: 0 }] }],
      { format: 'csv', filename: 'rel' }
    );
    expect(baixado.conteudo).toContain('"Silva, João"');
  });

  it('aspas dentro do dado são duplicadas', async () => {
    await exportSections(
      [{ ...SECAO_TABELA, rows: [{ name: 'O "Rei"', entries: 1, spent: 0 }] }],
      { format: 'csv', filename: 'rel' }
    );
    expect(baixado.conteudo).toContain('"O ""Rei"""');
  });

  it('quebra de linha no dado é protegida', async () => {
    await exportSections(
      [{ ...SECAO_TABELA, rows: [{ name: 'linha1\nlinha2', entries: 1, spent: 0 }] }],
      { format: 'csv', filename: 'rel' }
    );
    expect(baixado.conteudo).toContain('"linha1\nlinha2"');
  });

  it('seção chave-valor vira duas colunas', async () => {
    await exportSections([SECAO_RESUMO], { format: 'csv', filename: 'rel' });
    const linhas = baixado.conteudo.replace('﻿', '').split('\r\n');
    expect(linhas[1]).toBe('Indicador,Valor');
    expect(linhas[2]).toBe('Receita,1200');
  });

  it('várias seções ficam empilhadas com linha em branco entre elas', async () => {
    await exportSections([SECAO_RESUMO, SECAO_TABELA], {
      format: 'csv',
      filename: 'rel',
    });
    expect(baixado.conteudo).toContain('### Resumo');
    expect(baixado.conteudo).toContain('### Jogadores');
    expect(baixado.conteudo).toContain('\r\n\r\n');
  });

  it('valor nulo vira célula vazia, não "null"', async () => {
    await exportSections(
      [{ ...SECAO_TABELA, rows: [{ name: null, entries: null, spent: null }] }],
      { format: 'csv', filename: 'rel' }
    );
    const linhas = baixado.conteudo.replace('﻿', '').split('\r\n');
    expect(linhas[2]).toBe(',,');
  });

  it('valor não numérico numa coluna numérica vira vazio', async () => {
    // "—" ou "N/A" digitado numa coluna de dinheiro quebraria a soma da
    // planilha; melhor a célula vazia.
    await exportSections(
      [{ ...SECAO_TABELA, rows: [{ name: 'X', entries: 'N/A', spent: 'sem valor' }] }],
      { format: 'csv', filename: 'rel' }
    );
    expect(baixado.conteudo.replace('﻿', '').split('\r\n')[2]).toBe('X,,');
  });

  it('data é formatada como texto legível', async () => {
    await exportSections(
      [
        {
          kind: 'table',
          title: 'Datas',
          columns: [{ key: 'quando', label: 'Quando', type: 'date' }],
          rows: [{ quando: '2026-06-08T12:00:00Z' }],
        },
      ],
      { format: 'csv', filename: 'rel' }
    );
    expect(baixado.conteudo).toMatch(/2026/);
  });

  it('data inválida sai como veio, sem "Invalid Date"', async () => {
    await exportSections(
      [
        {
          kind: 'table',
          title: 'Datas',
          columns: [{ key: 'quando', label: 'Quando', type: 'date' }],
          rows: [{ quando: 'nao-e-data' }],
        },
      ],
      { format: 'csv', filename: 'rel' }
    );
    expect(baixado.conteudo).toContain('nao-e-data');
    expect(baixado.conteudo).not.toContain('Invalid Date');
  });

  it('data vazia vira célula vazia', async () => {
    await exportSections(
      [
        {
          kind: 'table',
          title: 'Datas',
          columns: [{ key: 'quando', label: 'Quando', type: 'date' }],
          rows: [{ quando: null }],
        },
      ],
      { format: 'csv', filename: 'rel' }
    );
    expect(baixado.conteudo.replace('﻿', '').split('\r\n')[2]).toBe('');
  });
});

describe('escolha de formato', () => {
  it('sem seção nenhuma é recusado', async () => {
    // A tela usa esse erro para dizer "não há nada para exportar" em vez de
    // baixar um arquivo vazio que o cliente acha que está corrompido.
    await expect(exportSections([], { format: 'csv', filename: 'x' })).rejects.toThrow(
      'no-sections'
    );
  });

  it('lista só com valores falsos também é recusada', async () => {
    await expect(
      exportSections([null, undefined, false], { format: 'csv', filename: 'x' })
    ).rejects.toThrow('no-sections');
  });

  it('lista ausente é recusada', async () => {
    await expect(exportSections(null, { format: 'csv', filename: 'x' })).rejects.toThrow(
      'no-sections'
    );
  });

  it('formato desconhecido é recusado com o nome do formato', async () => {
    await expect(
      exportSections([SECAO_TABELA], { format: 'docx', filename: 'x' })
    ).rejects.toThrow('unknown-format:docx');
  });
});


describe('Excel', () => {
  beforeEach(() => {
    espiaoXlsx.abas.length = 0;
  });

  it('gera uma aba por seção com os valores crus', async () => {
    await exportSections([SECAO_RESUMO, SECAO_TABELA], {
      format: 'xlsx',
      filename: 'rel',
      meta: { title: 'Relatório' },
    });
    expect(espiaoXlsx.abas.map((a) => a.nome)).toEqual(['Resumo', 'Jogadores']);
    expect(espiaoXlsx.abas[1].aoa[0]).toEqual(['Nome', 'Entradas', 'Gasto']);
    // números de verdade, não texto formatado
    expect(espiaoXlsx.abas[1].aoa[1]).toEqual(['Fulano', 3, 900]);
  });

  it('a largura das colunas acompanha o conteúdo', async () => {
    await exportSections([SECAO_TABELA], { format: 'xlsx', filename: 'rel' });
    expect(espiaoXlsx.abas[0].larguras).toHaveLength(3);
    expect(espiaoXlsx.abas[0].larguras[0].wch).toBeGreaterThan(0);
  });

  it('títulos repetidos viram abas com nomes distintos', async () => {
    // O Excel recusa o arquivo INTEIRO se duas abas tiverem o mesmo nome.
    await exportSections([SECAO_RESUMO, { ...SECAO_RESUMO }, { ...SECAO_RESUMO }], {
      format: 'xlsx',
      filename: 'rel',
    });
    const nomes = espiaoXlsx.abas.map((a) => a.nome);
    expect(new Set(nomes).size).toBe(3);
  });

  it('caracteres proibidos e nome longo são tratados', async () => {
    await exportSections([{ kind: 'keyvalue', title: 'a/b:c*'.repeat(20), rows: [] }], {
      format: 'xlsx',
      filename: 'rel',
    });
    const nome = espiaoXlsx.abas[0].nome;
    expect(nome.length).toBeLessThanOrEqual(31);
    expect(nome).not.toMatch(/[:\/?*[\]]/);
  });

  it('seção sem título ainda vira uma aba nomeada', async () => {
    await exportSections([{ kind: 'keyvalue', title: '', rows: [] }], {
      format: 'xlsx',
      filename: 'rel',
    });
    expect(espiaoXlsx.abas[0].nome).toBe('Aba');
  });
});

describe('PDF', () => {
  beforeEach(() => {
    espiaoPdf.tabelas.length = 0;
    espiaoPdf.salvo = null;
  });

  it('formata moeda e percentual para LEITURA', async () => {
    // Ninguém soma um PDF; ele precisa estar legível.
    await exportSections([SECAO_RESUMO], {
      format: 'pdf',
      filename: 'rel',
      meta: { title: 'Fechamento', subtitle: 'Etapa Rio', footer: 'AceBlind' },
      formatCurrency: moeda,
    });
    const corpo = espiaoPdf.tabelas[0].body;
    expect(corpo[0]).toEqual(['Receita', 'R$ 1200.00']);
    expect(corpo[1]).toEqual(['Rake', '20.0%']);
    expect(espiaoPdf.salvo).toBe('rel.pdf');
  });

  it('sem formatador de moeda ainda gera o arquivo', async () => {
    await exportSections([SECAO_RESUMO], { format: 'pdf', filename: 'rel' });
    expect(espiaoPdf.salvo).toBe('rel.pdf');
  });

  it('sem metadados usa o título padrão e gera a tabela', async () => {
    await exportSections([SECAO_RESUMO], { format: 'pdf', filename: 'rel' });
    expect(espiaoPdf.tabelas).toHaveLength(1);
  });

  it('valor ausente vira travessão em vez de vazio', async () => {
    // Célula vazia num PDF parece defeito de geração; o travessão diz
    // "não há dado".
    await exportSections(
      [
        {
          kind: 'keyvalue',
          title: 'X',
          rows: [{ label: 'Sem dado', value: null, type: 'currency' }],
        },
      ],
      { format: 'pdf', filename: 'rel', formatCurrency: moeda }
    );
    expect(espiaoPdf.tabelas[0].body[0][1]).toBe('—');
  });

  it('inteiro é arredondado e número grande recebe separador', async () => {
    await exportSections(
      [
        {
          kind: 'keyvalue',
          title: 'X',
          rows: [
            { label: 'Jogadores', value: 12.7, type: 'int' },
            { label: 'Fichas', value: 1234567, type: 'number' },
          ],
        },
      ],
      { format: 'pdf', filename: 'rel', formatCurrency: moeda }
    );
    expect(espiaoPdf.tabelas[0].body[0][1]).toBe('13');
    expect(espiaoPdf.tabelas[0].body[1][1]).toBe((1234567).toLocaleString());
  });

  it('texto no lugar de número sai como está', async () => {
    await exportSections(
      [
        {
          kind: 'keyvalue',
          title: 'X',
          rows: [
            { label: 'A', value: 'n/d', type: 'currency' },
            { label: 'B', value: 'n/d', type: 'percent' },
            { label: 'C', value: 'n/d', type: 'int' },
            { label: 'D', value: 'n/d', type: 'number' },
          ],
        },
      ],
      { format: 'pdf', filename: 'rel', formatCurrency: moeda }
    );
    expect(espiaoPdf.tabelas[0].body.map((l) => l[1])).toEqual(['n/d', 'n/d', 'n/d', 'n/d']);
  });

  it('seção de tabela vira cabeçalho e corpo', async () => {
    await exportSections([SECAO_TABELA], {
      format: 'pdf',
      filename: 'rel',
      formatCurrency: moeda,
    });
    expect(espiaoPdf.tabelas[0].head).toEqual([['Nome', 'Entradas', 'Gasto']]);
    expect(espiaoPdf.tabelas[0].body[0]).toEqual(['Fulano', '3', 'R$ 900.00']);
  });

  it('muitas seções continuam gerando uma tabela cada', async () => {
    // Exercita a quebra de página: o cursor passa do fim da folha e o
    // documento precisa continuar na página seguinte.
    const secoes = Array.from({ length: 6 }, (_, i) => ({
      ...SECAO_RESUMO,
      title: `Seção ${i}`,
    }));
    await exportSections(secoes, { format: 'pdf', filename: 'rel', formatCurrency: moeda });
    expect(espiaoPdf.tabelas).toHaveLength(6);
  });
});
