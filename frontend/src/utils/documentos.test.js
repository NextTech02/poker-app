/**
 * Testes de mesa dos validadores de documento.
 *
 * POR QUE IMPORTA NA OPERAÇÃO: o documento é o comprovante de quem levou
 * prêmio em dinheiro. O dono do clube cadastrou "um monte de 0" e o sistema
 * aceitou — e existe 1 jogador assim no banco. Ao mesmo tempo, os 11 cadastros
 * antigos (document_type 'national_id') NÃO podem virar erro de tela, senão o
 * balcão trava na hora de vender para um cliente já cadastrado.
 */
import validarDocumento, {
  TIPOS_DOCUMENTO,
  TIPOS_LEGADO,
  TIPOS_ACEITOS,
  opcoesDocumento,
  ehTipoLegado,
  normalizarDocumento,
  formatarDocumento,
  cpfValido,
} from './documentos';

// CPFs reais válidos (dígitos verificadores fecham).
const CPF_VALIDO = '52998224725';
const CPF_VALIDO_2 = '11144477735';

describe('CPF (Brasil)', () => {
  it('aceita CPF válido, com e sem máscara', () => {
    expect(validarDocumento('cpf', CPF_VALIDO).valido).toBe(true);
    expect(validarDocumento('cpf', '529.982.247-25').valido).toBe(true);
    expect(validarDocumento('cpf', CPF_VALIDO_2).valido).toBe(true);
  });

  it('grava só os dígitos, mesmo se digitarem com pontos', () => {
    expect(validarDocumento('cpf', '529.982.247-25').normalizado).toBe(CPF_VALIDO);
  });

  it('recusa CPF com um dígito trocado (erro de digitação no balcão)', () => {
    const r = validarDocumento('cpf', '52998224726');
    expect(r.valido).toBe(false);
    expect(r.codigo).toBe('DIGITO_VERIFICADOR');
    expect(r.motivo).toBe('O CPF informado não é válido — confira os dígitos.');
    expect(r.chaveMotivo).toBe('documents.errorCpfInvalid');
  });

  it('recusa CPF com quantidade errada de dígitos', () => {
    expect(validarDocumento('cpf', '5299822472').codigo).toBe('FORMATO');
    expect(validarDocumento('cpf', '529982247250').codigo).toBe('FORMATO');
  });

  it('cpfValido é o algoritmo puro, sem mensagem', () => {
    expect(cpfValido('529.982.247-25')).toBe(true);
    expect(cpfValido('52998224726')).toBe(false);
    expect(cpfValido('')).toBe(false);
  });
});

describe('regra geral: lixo óbvio', () => {
  // Este é o caso que o dono do clube conseguiu cadastrar de verdade.
  it('recusa "um monte de 0"', () => {
    const r = validarDocumento('cpf', '00000000000');
    expect(r.valido).toBe(false);
    expect(r.codigo).toBe('REPETIDO');
  });

  // 111.111.111-11 PASSA no algoritmo de dígito verificador. Se a checagem de
  // repetidos rodasse depois do DV, este caso continuaria entrando no banco.
  it('recusa 111.111.111-11 mesmo ele fechando o dígito verificador', () => {
    expect(validarDocumento('cpf', '11111111111').codigo).toBe('REPETIDO');
  });

  it('recusa repetido também em DNI e cédula', () => {
    expect(validarDocumento('dni', '00000000').codigo).toBe('REPETIDO');
    expect(validarDocumento('cedula', '9999999').codigo).toBe('REPETIDO');
  });

  it('recusa sequência trivial crescente e decrescente', () => {
    expect(validarDocumento('dni', '12345678').codigo).toBe('SEQUENCIAL');
    expect(validarDocumento('dni', '87654321').codigo).toBe('SEQUENCIAL');
    expect(validarDocumento('cedula', '1234567890').codigo).toBe('SEQUENCIAL');
  });

  it('não confunde documento legítimo com sequência', () => {
    expect(validarDocumento('dni', '10234567').valido).toBe(true);
    expect(validarDocumento('cpf', CPF_VALIDO).valido).toBe(true);
  });

  it('recusa documento vazio ou só com pontuação', () => {
    expect(validarDocumento('cpf', '').codigo).toBe('VAZIO');
    expect(validarDocumento('cpf', '   ').codigo).toBe('VAZIO');
    expect(validarDocumento('cpf', '...-').codigo).toBe('VAZIO');
    expect(validarDocumento('cpf', null).codigo).toBe('VAZIO');
  });
});

describe('DNI (Peru) — 8 dígitos', () => {
  it('aceita 8 dígitos', () => {
    expect(validarDocumento('dni', '46829135').valido).toBe(true);
  });

  it('recusa 7 dígitos', () => {
    const r = validarDocumento('dni', '4682913');
    expect(r.valido).toBe(false);
    expect(r.codigo).toBe('FORMATO');
    expect(r.motivo).toBe('O DNI do Peru deve ter 8 dígitos.');
  });

  it('recusa 9 dígitos', () => {
    expect(validarDocumento('dni', '468291357').valido).toBe(false);
  });

  it('recusa letra (DNI é numérico)', () => {
    // A letra é descartada na limpeza, então sobra 7 dígitos: cai no formato.
    expect(validarDocumento('dni', '4682913A').codigo).toBe('FORMATO');
  });
});

describe('Cédula (Colômbia) — 6 a 10 dígitos', () => {
  it('aceita os limites: 6 e 10 dígitos', () => {
    expect(validarDocumento('cedula', '102030').valido).toBe(true);
    expect(validarDocumento('cedula', '1020304050').valido).toBe(true);
  });

  it('recusa 5 dígitos (abaixo do limite)', () => {
    expect(validarDocumento('cedula', '10203').codigo).toBe('FORMATO');
  });

  it('recusa 11 dígitos (acima do limite)', () => {
    const r = validarDocumento('cedula', '10203040506');
    expect(r.codigo).toBe('FORMATO');
    expect(r.motivo).toBe('A cédula da Colômbia deve ter de 6 a 10 dígitos.');
  });
});

describe('Passaporte — alfanumérico, 6 a 12', () => {
  it('aceita letras junto com números', () => {
    expect(validarDocumento('passport', 'AB123456').valido).toBe(true);
  });

  it('normaliza para maiúsculas (o mesmo passaporte não pode virar dois cadastros)', () => {
    expect(validarDocumento('passport', 'ab123456').normalizado).toBe('AB123456');
  });

  it('aceita os limites 6 e 12', () => {
    expect(validarDocumento('passport', 'A12345').valido).toBe(true);
    expect(validarDocumento('passport', 'AB1234567890').valido).toBe(true);
  });

  it('recusa curto demais e longo demais', () => {
    expect(validarDocumento('passport', 'AB123').codigo).toBe('FORMATO');
    expect(validarDocumento('passport', 'AB12345678901').codigo).toBe('FORMATO');
  });

  it('recusa passaporte com todos os caracteres iguais', () => {
    expect(validarDocumento('passport', 'AAAAAA').codigo).toBe('REPETIDO');
    expect(validarDocumento('passport', '000000').codigo).toBe('REPETIDO');
  });
});

describe('Carteira de motorista — regra básica que já existia', () => {
  it('aceita alfanumérico de 5 a 20', () => {
    expect(validarDocumento('driver_license', '12345678900').valido).toBe(true);
    expect(validarDocumento('driver_license', 'ABC1234').valido).toBe(true);
  });

  it('recusa curto demais', () => {
    expect(validarDocumento('driver_license', 'AB12').codigo).toBe('FORMATO');
  });
});

describe('tipo legado national_id — não pode travar o balcão', () => {
  it('aceita o documento inválido que já está no banco', () => {
    // Um dos 11 cadastros antigos tem dígitos todos iguais. Se isso virasse
    // erro, ninguém conseguiria editar o telefone dele nem vender uma entrada.
    const r = validarDocumento('national_id', '00000000000');
    expect(r.valido).toBe(true);
    expect(r.aviso).toBeTruthy();
  });

  it('aceita qualquer formato antigo (RG com letra, cédula curta)', () => {
    expect(validarDocumento('national_id', '12.345.678-9').valido).toBe(true);
    expect(validarDocumento('national_id', 'X1').valido).toBe(true);
  });

  it('ainda exige que exista algum número', () => {
    expect(validarDocumento('national_id', '').codigo).toBe('VAZIO');
  });

  it('ehTipoLegado marca só o tipo antigo', () => {
    expect(ehTipoLegado('national_id')).toBe(true);
    expect(ehTipoLegado('cpf')).toBe(false);
  });
});

describe('tipo desconhecido', () => {
  it('pede para escolher o tipo em vez de aceitar calado', () => {
    const r = validarDocumento('rg', '123456');
    expect(r.valido).toBe(false);
    expect(r.codigo).toBe('TIPO_DESCONHECIDO');
  });
});

describe('catálogo para os selects das telas', () => {
  it('oferece os cinco tipos novos, com rótulo e país', () => {
    expect(TIPOS_DOCUMENTO.map((tipo) => tipo.valor))
      .toEqual(['cpf', 'dni', 'cedula', 'passport', 'driver_license']);
    TIPOS_DOCUMENTO.forEach((tipo) => {
      expect(tipo.rotulo).toBeTruthy();
      expect(tipo.chaveRotulo).toMatch(/^documents\./);
      expect(tipo.legado).toBe(false);
    });
  });

  it('os rótulos dizem o país onde há mais de um formato', () => {
    const porValor = Object.fromEntries(TIPOS_DOCUMENTO.map((t) => [t.valor, t]));
    expect(porValor.cpf.pais).toBe('BR');
    expect(porValor.dni.pais).toBe('PE');
    expect(porValor.cedula.pais).toBe('CO');
    expect(porValor.passport.pais).toBeNull();
  });

  it('a lista de tipos aceitos é a mesma do backend', () => {
    // O select do navegador não pode mandar um tipo que a API rejeita.
    expect([...TIPOS_ACEITOS].sort()).toEqual(
      ['cedula', 'cpf', 'dni', 'driver_license', 'national_id', 'passport'],
    );
  });

  it('cadastro novo não oferece o tipo antigo', () => {
    expect(opcoesDocumento(null).map((t) => t.valor)).not.toContain('national_id');
    expect(opcoesDocumento('cpf').map((t) => t.valor)).not.toContain('national_id');
  });

  it('ao editar um jogador antigo, o tipo dele continua na lista', () => {
    // Sem isso o select abriria vazio e a tela obrigaria a recadastrar o
    // documento só para salvar outro campo.
    expect(opcoesDocumento('national_id').map((t) => t.valor)).toContain('national_id');
  });

  it('opcoesDocumento devolve cópia (a tela não corrompe o catálogo)', () => {
    const lista = opcoesDocumento('national_id');
    lista.pop();
    expect(TIPOS_DOCUMENTO).toHaveLength(5);
    expect(TIPOS_LEGADO).toHaveLength(1);
  });
});

describe('normalização e máscara', () => {
  it('normaliza documentos numéricos só com dígitos', () => {
    expect(normalizarDocumento('cpf', '529.982.247-25')).toBe(CPF_VALIDO);
    expect(normalizarDocumento('cedula', '1.020.304')).toBe('1020304');
  });

  it('formata CPF completo e devolve o resto como está', () => {
    expect(formatarDocumento('cpf', CPF_VALIDO)).toBe('529.982.247-25');
    expect(formatarDocumento('cpf', '5299')).toBe('5299');
    expect(formatarDocumento('passport', 'ab123456')).toBe('AB123456');
  });
});
