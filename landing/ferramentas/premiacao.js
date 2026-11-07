/* Calculadora de premiação. O cálculo está em calculos.js. */
(function(){
  var alvo = document.getElementById('ferramenta');
  if(!alvo) return;
  var C = window.ACEBLIND_CALC, U = window.ACEBLIND_UI;

  var T = {
    pt: {
      entradas: 'Entradas', entradasDica: 'Buy-ins mais recompras', buyin: 'Valor do buy-in', taxa: 'Parte da casa (%)',
      taxaDica: 'Rake ou taxa sobre o buy-in', garantido: 'Garantido da casa', garantidoDica: 'Somado ao que os jogadores pagaram', arredondar: 'Arredondar para',
      arrecadado: 'Arrecadado', casa: 'Parte da casa', premio: 'Prize pool', pagos: 'Lugares pagos',
      lugar: 'Lugar', percentual: '% do prêmio', valor: 'Prêmio', baixar: 'Baixar planilha', imprimir: 'Imprimir',
      arquivo: 'premiacao-torneio.csv'
    },
    es: {
      entradas: 'Entradas', entradasDica: 'Buy-ins más rebuys', buyin: 'Valor del buy-in', taxa: 'Parte de la casa (%)',
      taxaDica: 'Rake o tarifa sobre el buy-in', garantido: 'Garantizado de la casa', garantidoDica: 'Se suma a lo que pagaron los jugadores', arredondar: 'Redondear a',
      arrecadado: 'Recaudado', casa: 'Parte de la casa', premio: 'Prize pool', pagos: 'Puestos pagados',
      lugar: 'Puesto', percentual: '% del premio', valor: 'Premio', baixar: 'Descargar hoja de cálculo', imprimir: 'Imprimir',
      arquivo: 'premios-torneo.csv'
    },
    en: {
      entradas: 'Entries', entradasDica: 'Buy-ins plus rebuys', buyin: 'Buy-in amount', taxa: 'House share (%)',
      taxaDica: 'Rake or fee on the buy-in', garantido: 'House guarantee', garantidoDica: 'Added to what players paid in', arredondar: 'Round to',
      arrecadado: 'Collected', casa: 'House share', premio: 'Prize pool', pagos: 'Places paid',
      lugar: 'Place', percentual: '% of pool', valor: 'Prize', baixar: 'Download spreadsheet', imprimir: 'Print',
      arquivo: 'tournament-payouts.csv'
    }
  }[U.idioma];

  alvo.innerHTML =
    '<form class="fer-form" id="ferForm">' +
      U.campo({ nome: 'entradas', rotulo: T.entradas, dica: T.entradasDica, valor: 45, min: 2, max: 2000, passo: 1 }) +
      U.campo({ nome: 'buyin', rotulo: T.buyin, valor: 200, min: 1 }) +
      U.campo({ nome: 'taxa', rotulo: T.taxa, dica: T.taxaDica, valor: 10, min: 0, max: 100 }) +
      U.campo({ nome: 'garantido', rotulo: T.garantido, dica: T.garantidoDica, valor: 0, min: 0 }) +
      U.campo({ nome: 'arredondar', rotulo: T.arredondar, valor: 10, opcoes: [1, 5, 10, 50, 100] }) +
    '</form>' +
    '<div class="fer-resumo" id="ferResumo" aria-live="polite"></div>' +
    '<div class="fer-tabela"><table><thead><tr><th>' + T.lugar + '</th><th>' + T.percentual + '</th><th>' + T.valor + '</th></tr></thead><tbody id="ferLinhas"></tbody></table></div>' +
    '<div class="fer-acoes"><button type="button" class="btn btn--outline btn--sm" id="ferBaixar">' + T.baixar + '</button>' +
    '<button type="button" class="btn btn--outline btn--sm" id="ferImprimir">' + T.imprimir + '</button></div>';

  var form = document.getElementById('ferForm');
  var atual = null;

  function destaque(rotulo, valor){ return '<div><small>' + rotulo + '</small><b>' + valor + '</b></div>'; }

  function calcular(){
    atual = C.calcularPremiacao({
      entradas: Math.min(2000, Math.max(2, Math.round(U.ler(form, 'entradas')))),
      buyin: U.ler(form, 'buyin'),
      taxaPct: Math.min(100, U.ler(form, 'taxa')),
      garantido: U.ler(form, 'garantido'),
      arredondar: Number(form.elements.arredondar.value)
    });
    document.getElementById('ferResumo').innerHTML =
      destaque(T.arrecadado, U.numero(atual.bruto)) +
      destaque(T.casa, U.numero(atual.rake)) +
      destaque(T.premio, U.numero(atual.premio)) +
      destaque(T.pagos, atual.pagos);
    document.getElementById('ferLinhas').innerHTML = atual.lugares.map(function(l){
      return '<tr><td>' + l.posicao + 'º</td><td>' + U.numero(l.percentual, 3) + '%</td><td>' + U.numero(l.valor) + '</td></tr>';
    }).join('');
  }

  form.addEventListener('input', calcular);
  form.addEventListener('submit', function(e){ e.preventDefault(); });
  document.getElementById('ferImprimir').addEventListener('click', function(){ window.print(); });
  document.getElementById('ferBaixar').addEventListener('click', function(){
    var linhas = [[T.lugar, T.percentual, T.valor]].concat(atual.lugares.map(function(l){
      return [l.posicao, U.numero(l.percentual, 3), U.numero(l.valor)];
    }));
    U.baixar(T.arquivo, C.paraCsv(linhas));
  });
  calcular();
})();
