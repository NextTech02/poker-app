/**
 * Bilhete de inscrição no layout do clube (pedido do NSOP): imagem no topo,
 * cidade, torneio, participante, mesa e posição, compra, total de fichas,
 * sede, data, valor, caixa e assinatura.
 */
import { bilheteDoTorneio, bilheteParaApi, brandingFinal, htmlDoBilhete } from './bilhete';

const ALOCACAO = {
  id: 'abc-123',
  tournament_name: 'NSOP - Mistery',
  day_name: 'Día 1E',
  player_name: 'Totocayo Casanova Jorge',
  table_number: 8,
  seat_number: 7,
  created_at: '2026-10-16T21:30:00',
  itens: [{ name: 'Reentrada', amount: 300, chips: 30000 }],
  total_amount: 300,
  total_chips: 30000,
};
const BRANDING = { logoUrl: 'https://x/logo.png', city: 'Chiclayo', venue: 'Salón de eventos NSOP', ornaments: true };
const soles = (v) => `S/ ${Number(v).toFixed(2)}`;

describe('htmlDoBilhete', () => {
  it('monta o bilhete do clube em espanhol', () => {
    const html = htmlDoBilhete({ allocation: ALOCACAO, branding: BRANDING, idioma: 'es-ES', formatarValor: soles, caixa: 'Carlos Pérez' });
    expect(html).toContain('<img class="bt-logo" src="https://x/logo.png"');
    expect(html).toContain('Chiclayo');
    expect(html).toContain('REGISTRO DE TORNEO');
    expect(html).toContain('NSOP - Mistery');
    expect(html).toContain('Día 1E');
    expect(html).toContain('PARTICIPANTE');
    expect(html).toContain('Totocayo Casanova Jorge');
    expect(html).toContain('POSICIÓN');
    expect(html).toMatch(/bt-grande">8</);
    expect(html).toMatch(/bt-grande">7</);
    expect(html).toContain('MODALIDAD:');
    expect(html).toContain('Reentrada');
    expect(html).toContain('TOTAL DE FICHAS:');
    expect(html).toMatch(/30\.000/);
    expect(html).toContain('Salón de eventos NSOP');
    expect(html).toContain('S/ 300.00');
    expect(html).toContain('CAJERO:');
    expect(html).toContain('Carlos Pérez');
    expect(html).toContain('FIRMA DEL JUGADOR');
    expect(html).toContain('bt-enfeite');
    expect(html).toContain('80mm');
    expect(html).toContain('window.print()');
  });

  it('sem imagem, cidade, sede e enfeites o bilhete sai limpo', () => {
    const html = htmlDoBilhete({ allocation: ALOCACAO, branding: {}, idioma: 'pt-BR' });
    expect(html).not.toContain('<img');
    expect(html).not.toContain('<svg class="bt-enfeite"');
    expect(html).not.toContain('class="bt-cidade"');
    expect(html).not.toContain('LOCAL:');
    expect(html).toContain('ASSENTO');
    expect(html).not.toContain('undefined');
  });

  it('vários itens: um por linha e o total', () => {
    const html = htmlDoBilhete({
      allocation: { ...ALOCACAO, itens: [{ name: 'Buy-in', amount: 300, chips: 30000 }, { name: 'Bono Dealer', amount: 20, chips: 50000 }], total_amount: 320, total_chips: 80000 },
      idioma: 'es',
      formatarValor: soles,
    });
    expect(html).toContain('Buy-in:');
    expect(html).toContain('S/ 300.00 / 30.000');
    expect(html).toContain('Bono Dealer:');
    expect(html).toContain('S/ 20.00 / 50.000');
    expect(html).toMatch(/80\.000/);
    expect(html).toContain('S/ 320.00');
  });

  it('alternate não imprime mesa e posição', () => {
    const html = htmlDoBilhete({ allocation: { ...ALOCACAO, is_alternate: true, table_number: null, seat_number: null }, idioma: 'pt' });
    expect(html).toContain('ALTERNATE');
    expect(html).not.toContain('bt-grande">');
  });

  it('nome com HTML é escapado e a prévia não manda imprimir', () => {
    const html = htmlDoBilhete({ allocation: { ...ALOCACAO, player_name: '<b>Ana</b>' }, imprimir: false });
    expect(html).toContain('&lt;b&gt;Ana&lt;/b&gt;');
    expect(html).not.toContain('window.print');
  });
});

describe('o que vale: torneio ou clube', () => {
  it('o torneio troca imagem, cidade e sede; os enfeites são do clube', () => {
    const clube = { ticket_logo_path: 'org/bilhete/clube.png', ticket_city: 'Lima', ticket_venue: 'Club', ticket_ornaments: true };
    expect(brandingFinal(clube, { ticket_logo_path: 'org/bilhete/main.png' }, (p) => `url:${p}`)).toEqual({
      logoUrl: 'url:org/bilhete/main.png', city: 'Lima', venue: 'Club', ornaments: true,
    });
    expect(brandingFinal(null, null)).toEqual({ logoUrl: '', city: '', venue: '', ornaments: false });
  });

  it('formulário: na criação só o preenchido; na edição os três (vazio = do clube)', () => {
    expect(bilheteParaApi({ ticket_city: ' Chiclayo ', ticket_venue: '' })).toEqual({ ticket_city: 'Chiclayo' });
    expect(bilheteParaApi({ ticket_city: '' }, true)).toEqual({ ticket_logo_path: null, ticket_city: null, ticket_venue: null });
    expect(bilheteDoTorneio({ ticket_city: 'Lima' })).toEqual({ ticket_logo_path: '', ticket_city: 'Lima', ticket_venue: '' });
  });
});
