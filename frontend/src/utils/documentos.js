/**
 * VALIDAÇÃO DE DOCUMENTO — regra compartilhada com o backend
 * (espelho de backend/app/utils/documentos.py — mudou aqui, mude lá).
 *
 * POR QUE ISSO EXISTE (operação, não estilo): o documento é o que identifica
 * quem recebeu prêmio em dinheiro — é o comprovante do clube. O dono cadastrou
 * "um monte de 0" e o sistema aceitou; na hora de prestar contas, o recibo não
 * vale nada. Esta validação avisa CEDO, no formulário. A do backend é a que
 * vale (ninguém confia só no navegador).
 *
 * ------------------------------------------------------------------------
 * INTERFACE PÚBLICA (é o que as telas devem usar)
 * ------------------------------------------------------------------------
 * validarDocumento(tipo, numero) -> {
 *     valido:      boolean,
 *     codigo:      string|null,   // ex.: 'DIGITO_VERIFICADOR' (para lógica/teste)
 *     chaveMotivo: string|null,   // chave i18n, ex.: 'documents.errorCpfInvalid'
 *     motivo:      string|null,   // texto pt-BR pronto de tela
 *     normalizado: string,        // valor limpo, o que deve ir para o banco
 *     aviso:       string|null,   // não bloqueia; ex.: cadastro antigo
 *   }
 *   Na tela:  const r = validarDocumento(tipo, numero);
 *             if (!r.valido) setErro(t(r.chaveMotivo, r.motivo));
 *
 * TIPOS_DOCUMENTO       — lista dos tipos oferecidos no cadastro novo,
 *                         cada um com { valor, pais, chaveRotulo, rotulo,
 *                         exemplo, legado }. Use para montar os selects.
 * TIPOS_LEGADO          — tipos antigos que ainda existem no banco.
 * TIPOS_ACEITOS         — todos os valores válidos de document_type
 *                         (novos + legado), iguais aos do backend.
 * opcoesDocumento(tipoAtual)
 *                       — lista para o select: os tipos novos + o legado
 *                         SOMENTE quando é o tipo do cadastro sendo editado
 *                         (senão o select abre vazio ao carregar um jogador
 *                         antigo e o balcão trava).
 * ehTipoLegado(tipo)    — true para tipo antigo, sem validação estrita.
 * normalizarDocumento(tipo, numero) — limpeza (o que gravar).
 * formatarDocumento(tipo, numero)   — máscara de EXIBIÇÃO (opcional; use se
 *                         ajudar. Nunca grave o formatado, grave o normalizado).
 *
 * ------------------------------------------------------------------------
 * REGRAS POR TIPO
 * ------------------------------------------------------------------------
 *   cpf            (Brasil)   11 dígitos + os dois dígitos verificadores reais
 *   dni            (Peru)     exatamente 8 dígitos
 *   cedula         (Colômbia) 6 a 10 dígitos
 *   passport       (qualquer) alfanumérico, 6 a 12
 *   driver_license (qualquer) regra básica que já existia: alfanumérico 5 a 20
 *
 * REGRA GERAL, ANTES DE QUALQUER OUTRA: recusa dígitos todos iguais
 * (00000000000, 11111111111) e sequência trivial (12345678, 1234567890).
 * A ORDEM IMPORTA: 111.111.111-11 PASSA no algoritmo de dígito verificador do
 * CPF. Se a checagem de repetidos viesse depois, o caso do cliente continuaria
 * entrando.
 *
 * ------------------------------------------------------------------------
 * LEGADO — por que 'national_id' não é validado
 * ------------------------------------------------------------------------
 * Existem 11 jogadores gravados com document_type 'national_id' (tipo genérico
 * demais: cobria CPF, DNI e cédula ao mesmo tempo) e um deles tem documento
 * inválido. Se validássemos 'national_id' com qualquer regra estrita, abrir
 * esse jogador para corrigir o telefone — ou vender uma entrada para ele —
 * passaria a dar erro, e o clube travava no balcão por causa de cadastro
 * antigo. Então: 'national_id' é aceito como LEGADO, só exige não-vazio, e
 * devolve `aviso` para a tela sugerir (sem obrigar) escolher o tipo do país.
 * Ele não aparece no select de cadastro novo — só quando já é o valor atual.
 */

// --- catálogo de tipos ------------------------------------------------------

export const TIPOS_DOCUMENTO = [
  {
    valor: 'cpf',
    pais: 'BR',
    chaveRotulo: 'documents.typeCpf',
    rotulo: 'CPF (Brasil)',
    exemplo: '123.456.789-09',
    legado: false,
  },
  {
    valor: 'dni',
    pais: 'PE',
    chaveRotulo: 'documents.typeDni',
    rotulo: 'DNI (Peru)',
    exemplo: '12345678',
    legado: false,
  },
  {
    valor: 'cedula',
    pais: 'CO',
    chaveRotulo: 'documents.typeCedula',
    rotulo: 'Cédula de Ciudadanía (Colômbia)',
    exemplo: '1020304050',
    legado: false,
  },
  {
    valor: 'passport',
    pais: null,
    chaveRotulo: 'documents.typePassport',
    rotulo: 'Passaporte',
    exemplo: 'AB123456',
    legado: false,
  },
  {
    valor: 'driver_license',
    pais: null,
    chaveRotulo: 'documents.typeDriverLicense',
    rotulo: 'Carteira de motorista',
    exemplo: '12345678900',
    legado: false,
  },
];

export const TIPOS_LEGADO = [
  {
    valor: 'national_id',
    pais: null,
    chaveRotulo: 'documents.typeLegacyNationalId',
    rotulo: 'Documento de identidade (cadastro antigo)',
    exemplo: '',
    legado: true,
  },
];

export const ehTipoLegado = (tipo) => TIPOS_LEGADO.some((item) => item.valor === tipo);

// O select do cadastro novo não oferece o tipo antigo; ao EDITAR um jogador que
// já está com ele, a opção precisa existir, senão o select abre vazio e a tela
// obriga a recadastrar o documento só para salvar outro campo.
export const opcoesDocumento = (tipoAtual) => {
  const legado = TIPOS_LEGADO.find((item) => item.valor === tipoAtual);
  return legado ? [...TIPOS_DOCUMENTO, legado] : [...TIPOS_DOCUMENTO];
};

// --- limpeza / normalização -------------------------------------------------

const somenteDigitos = (v) => String(v === null || v === undefined ? '' : v).replace(/\D/g, '');

const alfanumerico = (v) => String(v === null || v === undefined ? '' : v)
  .toUpperCase()
  .replace(/[^0-9A-Z]/g, '');

const TIPOS_NUMERICOS = new Set(['cpf', 'dni', 'cedula']);

export const normalizarDocumento = (tipo, numero) => (
  TIPOS_NUMERICOS.has(tipo) ? somenteDigitos(numero) : alfanumerico(numero)
);

// --- regra geral: lixo óbvio ------------------------------------------------

// Todos os caracteres iguais: 00000000000, 11111111111, AAAAAA.
const todosIguais = (v) => v.length > 1 && new Set(v.split('')).size === 1;

// Sequência trivial: 12345678, 87654321, 1234567890 (o zero fecha a volta).
const sequenciaTrivial = (v) => {
  if (v.length < 4 || !/^\d+$/.test(v)) return false;
  const passo = (a, b) => (Number(b) - Number(a) + 10) % 10;
  const primeiro = passo(v[0], v[1]);
  if (primeiro !== 1 && primeiro !== 9) return false;
  for (let i = 1; i < v.length - 1; i += 1) {
    if (passo(v[i], v[i + 1]) !== primeiro) return false;
  }
  return true;
};

// --- CPF: dígitos verificadores de verdade ----------------------------------

const digitoCpf = (base) => {
  const peso = base.length + 1;
  const soma = base.split('').reduce((acc, d, i) => acc + Number(d) * (peso - i), 0);
  const resto = (soma * 10) % 11;
  return resto === 10 ? 0 : resto;
};

export const cpfValido = (numero) => {
  const d = somenteDigitos(numero);
  if (d.length !== 11) return false;
  if (todosIguais(d)) return false;
  return digitoCpf(d.slice(0, 9)) === Number(d[9])
    && digitoCpf(d.slice(0, 10)) === Number(d[10]);
};

// --- montagem do resultado --------------------------------------------------

const ok = (normalizado, aviso = null) => ({
  valido: true,
  codigo: null,
  chaveMotivo: null,
  motivo: null,
  normalizado,
  aviso,
});

const erro = (codigo, chaveMotivo, motivo, normalizado) => ({
  valido: false,
  codigo,
  chaveMotivo,
  motivo,
  normalizado,
  aviso: null,
});

const AVISO_LEGADO = 'Cadastro antigo: escolha o tipo de documento do país quando puder.';

const REGRAS = {
  cpf: (v) => {
    if (v.length !== 11) {
      return ['FORMATO', 'documents.errorCpfLength', 'O CPF deve ter 11 dígitos.'];
    }
    if (!cpfValido(v)) {
      return ['DIGITO_VERIFICADOR', 'documents.errorCpfInvalid',
        'O CPF informado não é válido — confira os dígitos.'];
    }
    return null;
  },
  dni: (v) => (v.length !== 8
    ? ['FORMATO', 'documents.errorDniLength', 'O DNI do Peru deve ter 8 dígitos.']
    : null),
  cedula: (v) => ((v.length < 6 || v.length > 10)
    ? ['FORMATO', 'documents.errorCedulaLength',
      'A cédula da Colômbia deve ter de 6 a 10 dígitos.']
    : null),
  passport: (v) => ((v.length < 6 || v.length > 12)
    ? ['FORMATO', 'documents.errorPassportLength',
      'O passaporte deve ter de 6 a 12 caracteres (letras e números).']
    : null),
  driver_license: (v) => ((v.length < 5 || v.length > 20)
    ? ['FORMATO', 'documents.errorDriverLicenseLength',
      'A carteira de motorista deve ter de 5 a 20 caracteres.']
    : null),
};

// Tudo que a API aceita em document_type (mesmo nome no backend: TIPOS_ACEITOS).
export const TIPOS_ACEITOS = [...Object.keys(REGRAS), ...TIPOS_LEGADO.map((item) => item.valor)];

/**
 * Valida um documento. Ver contrato no topo do arquivo.
 * @param {string} tipo   valor de TIPOS_DOCUMENTO (ou o legado 'national_id')
 * @param {string} numero como o usuário digitou (aceita máscara)
 */
export const validarDocumento = (tipo, numero) => {
  const normalizado = normalizarDocumento(tipo, numero);

  if (!normalizado) {
    return erro('VAZIO', 'documents.errorRequired', 'Informe o número do documento.', '');
  }

  // Tipo antigo e genérico: não bloqueia nada (ver bloco LEGADO no topo).
  if (ehTipoLegado(tipo)) return ok(normalizado, AVISO_LEGADO);

  const regra = REGRAS[tipo];
  if (!regra) {
    return erro('TIPO_DESCONHECIDO', 'documents.errorUnknownType',
      'Selecione o tipo de documento.', normalizado);
  }

  // ORDEM PROPOSITAL: lixo óbvio ANTES do dígito verificador, senão
  // 111.111.111-11 passaria (ele fecha a conta do DV).
  if (todosIguais(normalizado)) {
    return erro('REPETIDO', 'documents.errorRepeated',
      'Documento com todos os caracteres iguais não é aceito — confira o número.',
      normalizado);
  }
  if (sequenciaTrivial(normalizado)) {
    return erro('SEQUENCIAL', 'documents.errorSequential',
      'Documento em sequência (12345678) não é aceito — confira o número.',
      normalizado);
  }

  const falha = regra(normalizado);
  if (falha) return erro(falha[0], falha[1], falha[2], normalizado);

  return ok(normalizado);
};

// --- máscara de exibição (opcional) -----------------------------------------

// Só formata quando o valor está completo; caso contrário devolve o normalizado,
// para não atrapalhar quem ainda está digitando.
export const formatarDocumento = (tipo, numero) => {
  const normalizado = normalizarDocumento(tipo, numero);
  if (tipo === 'cpf' && normalizado.length === 11) {
    return `${normalizado.slice(0, 3)}.${normalizado.slice(3, 6)}.${normalizado.slice(6, 9)}-${normalizado.slice(9)}`;
  }
  return normalizado;
};

export default validarDocumento;
