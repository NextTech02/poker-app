/* Gerador de estrutura de blinds. O cálculo está em calculos.js. O botão "Abrir
   no timer" guarda a estrutura no navegador; o endereço do timer no idioma da
   página vem de data-timer, no HTML. */
(function(){
  var alvo = document.getElementById('ferramenta');
  if(!alvo) return;
  var C = window.ACEBLIND_CALC, U = window.ACEBLIND_UI;

  var T = {
    pt: {
      jogadores: 'Jogadores', jogadoresDica: 'Entradas esperadas', stack: 'Stack inicial', horas: 'Duração desejada (horas)',
      minutos: 'Minutos por nível', ficha: 'Menor ficha', fichaDica: 'Define o menor small blind', pausa: 'Pausa a cada (níveis)',
      pausaDica: '0 para não ter pausa', pausaMin: 'Minutos de pausa', ante: 'Ante a partir do nível', anteDica: 'Big blind ante; 0 para não usar',
      niveis: 'Níveis', duracao: 'Duração', fichas: 'Fichas em jogo', inicio: 'Stack inicial em BB',
      nivel: 'Nível', sb: 'Small blind', bb: 'Big blind', anteCol: 'Ante', tempo: 'Minutos', comeca: 'Começa em', intervalo: 'Pausa',
      timer: 'Abrir no timer', baixar: 'Baixar planilha', imprimir: 'Imprimir', arquivo: 'estrutura-de-blinds.csv'
    },
    es: {
      jogadores: 'Jugadores', jogadoresDica: 'Entradas esperadas', stack: 'Stack inicial', horas: 'Duración deseada (horas)',
      minutos: 'Minutos por nivel', ficha: 'Ficha más pequeña', fichaDica: 'Define la ciega chica mínima', pausa: 'Pausa cada (niveles)',
      pausaDica: '0 para no tener pausa', pausaMin: 'Minutos de pausa', ante: 'Ante desde el nivel', anteDica: 'Big blind ante; 0 para no usar',
      niveis: 'Niveles', duracao: 'Duración', fichas: 'Fichas en juego', inicio: 'Stack inicial en BB',
      nivel: 'Nivel', sb: 'Ciega chica', bb: 'Ciega grande', anteCol: 'Ante', tempo: 'Minutos', comeca: 'Empieza en', intervalo: 'Pausa',
      timer: 'Abrir en el reloj', baixar: 'Descargar hoja de cálculo', imprimir: 'Imprimir', arquivo: 'estructura-de-ciegas.csv'
    },
    en: {
      jogadores: 'Players', jogadoresDica: 'Expected entries', stack: 'Starting stack', horas: 'Target length (hours)',
      minutos: 'Minutes per level', ficha: 'Smallest chip', fichaDica: 'Sets the lowest small blind', pausa: 'Break every (levels)',
      pausaDica: '0 for no breaks', pausaMin: 'Break minutes', ante: 'Ante from level', anteDica: 'Big blind ante; 0 for none',
      niveis: 'Levels', duracao: 'Length', fichas: 'Chips in play', inicio: 'Starting stack in BB',
      nivel: 'Level', sb: 'Small blind', bb: 'Big blind', anteCol: 'Ante', tempo: 'Minutes', comeca: 'Starts at', intervalo: 'Break',
      timer: 'Open in the timer', baixar: 'Download spreadsheet', imprimir: 'Print', arquivo: 'blind-structure.csv'
    }
  }[U.idioma];

  alvo.innerHTML =
    '<form class="fer-form" id="ferForm">' +
      U.campo({ nome: 'jogadores', rotulo: T.jogadores, dica: T.jogadoresDica, valor: 40, min: 2, max: 5000, passo: 1 }) +
      U.campo({ nome: 'stack', rotulo: T.stack, valor: 20000, min: 100, passo: 1 }) +
      U.campo({ nome: 'horas', rotulo: T.horas, valor: 5, min: 1, max: 24 }) +
      U.campo({ nome: 'minutos', rotulo: T.minutos, valor: 20, min: 3, max: 120, passo: 1 }) +
      U.campo({ nome: 'ficha', rotulo: T.ficha, dica: T.fichaDica, valor: 25, opcoes: [1, 5, 25, 100, 500] }) +
      U.campo({ nome: 'pausaCada', rotulo: T.pausa, dica: T.pausaDica, valor: 4, min: 0, passo: 1 }) +
      U.campo({ nome: 'pausaMin', rotulo: T.pausaMin, valor: 10, min: 0, passo: 1 }) +
      U.campo({ nome: 'ante', rotulo: T.ante, dica: T.anteDica, valor: 5, min: 0, passo: 1 }) +
    '</form>' +
    '<div class="fer-resumo" id="ferResumo" aria-live="polite"></div>' +
    '<div class="fer-tabela"><table><thead><tr><th>' + T.nivel + '</th><th>' + T.sb + '</th><th>' + T.bb + '</th><th>' + T.anteCol + '</th><th>' + T.tempo + '</th><th>' + T.comeca + '</th></tr></thead><tbody id="ferLinhas"></tbody></table></div>' +
    '<div class="fer-acoes"><button type="button" class="btn btn--primary btn--sm" id="ferTimer">' + T.timer + '</button>' +
    '<button type="button" class="btn btn--outline btn--sm" id="ferBaixar">' + T.baixar + '</button>' +
    '<button type="button" class="btn btn--outline btn--sm" id="ferImprimir">' + T.imprimir + '</button></div>';

  var form = document.getElementById('ferForm');
  var atual = null;

  function destaque(rotulo, valor){ return '<div><small>' + rotulo + '</small><b>' + valor + '</b></div>'; }

  /* Linhas da tabela já com o horário em que cada etapa começa. */
  function linhas(){
    var decorrido = 0;
    return atual.etapas.map(function(e){
      var linha = { etapa: e, comeca: Math.floor(decorrido / 60) + 'h' + ('0' + decorrido % 60).slice(-2) };
      decorrido += e.minutos;
      return linha;
    });
  }

  function calcular(){
    var pausaCada = Math.round(U.ler(form, 'pausaCada'));
    atual = C.gerarEstrutura({
      jogadores: Math.max(2, Math.round(U.ler(form, 'jogadores'))),
      stack: Math.max(100, U.ler(form, 'stack')),
      horas: Math.max(1, U.ler(form, 'horas')),
      minutosNivel: Math.max(3, Math.round(U.ler(form, 'minutos'))),
      menorFicha: Number(form.elements.ficha.value),
      pausaCada: pausaCada,
      pausaMinutos: Math.round(U.ler(form, 'pausaMin')),
      anteDesde: Math.round(U.ler(form, 'ante'))
    });
    var h = Math.floor(atual.duracaoMinutos / 60), m = atual.duracaoMinutos % 60;
    document.getElementById('ferResumo').innerHTML =
      destaque(T.niveis, atual.niveis) +
      destaque(T.duracao, h + 'h' + ('0' + m).slice(-2)) +
      destaque(T.fichas, U.numero(atual.totalFichas)) +
      destaque(T.inicio, atual.bbIniciaisReais);
    document.getElementById('ferLinhas').innerHTML = linhas().map(function(l){
      var e = l.etapa;
      return e.tipo === 'pausa'
        ? '<tr class="fer-pausa"><td colspan="4">' + T.intervalo + '</td><td>' + e.minutos + '</td><td>' + l.comeca + '</td></tr>'
        : '<tr><td>' + e.nivel + '</td><td>' + U.numero(e.sb) + '</td><td>' + U.numero(e.bb) + '</td><td>' + (e.ante ? U.numero(e.ante) : '—') + '</td><td>' + e.minutos + '</td><td>' + l.comeca + '</td></tr>';
    }).join('');
  }

  form.addEventListener('input', calcular);
  form.addEventListener('submit', function(e){ e.preventDefault(); });
  document.getElementById('ferImprimir').addEventListener('click', function(){ window.print(); });
  document.getElementById('ferBaixar').addEventListener('click', function(){
    var saida = [[T.nivel, T.sb, T.bb, T.anteCol, T.tempo, T.comeca]].concat(linhas().map(function(l){
      var e = l.etapa;
      return e.tipo === 'pausa' ? [T.intervalo, '', '', '', e.minutos, l.comeca] : [e.nivel, e.sb, e.bb, e.ante, e.minutos, l.comeca];
    }));
    U.baixar(T.arquivo, C.paraCsv(saida));
  });
  document.getElementById('ferTimer').addEventListener('click', function(){
    U.guardar('aceblind.timer.estrutura', atual.etapas);
    /* Estrutura nova começa do nível 1, e não do ponto em que o timer parou. */
    U.guardar('aceblind.timer.estado', null);
    window.location.href = alvo.getAttribute('data-timer');
  });
  calcular();
})();
