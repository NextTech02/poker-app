/* ============================================================================
   CÁLCULOS DAS FERRAMENTAS GRÁTIS
   ============================================================================
   Sem nenhum acesso à tela: as mesmas funções rodam na página e nos testes
   (npm test). A parte visual fica em timer.js, blinds.js e premiacao.js.
   ============================================================================ */
(function(raiz){
  /* Os valores que um big blind costuma ter: 1, 1,2, 1,5, 2, 2,5, 3, 4, 5, 6, 8
     e os mesmos vezes 10, 100... Ninguém joga com big blind de 1.370. */
  var MANTISSAS = [10, 12, 15, 20, 25, 30, 40, 50, 60, 80];

  /* O big blind tem de ser múltiplo de 2× a menor ficha, senão o small blind
     (a metade) não dá para pagar com as fichas da mesa. */
  function valoresDeBlind(menorFicha, limite){
    var lista = [];
    for(var escala = 0.1; escala <= limite * 10; escala *= 10){
      for(var i = 0; i < MANTISSAS.length; i++){
        var v = Math.round(MANTISSAS[i] * escala);
        if(v >= 2 * menorFicha && v % (2 * menorFicha) === 0 && lista.indexOf(v) < 0) lista.push(v);
      }
    }
    return lista.sort(function(a, b){ return a - b; });
  }

  function maisProximo(lista, alvo){
    var melhor = lista[0];
    for(var i = 1; i < lista.length; i++){
      /* Comparação em escala logarítmica: de 100 para 120 é o mesmo salto que de
         1.000 para 1.200, e é essa proporção que o jogador sente. */
      if(Math.abs(Math.log(lista[i] / alvo)) < Math.abs(Math.log(melhor / alvo))) melhor = lista[i];
    }
    return melhor;
  }

  /* Quantos níveis cabem no tempo pedido, descontando as pausas. */
  function niveisQueCabem(totalMinutos, minutosNivel, pausaCada, pausaMinutos){
    var n = 0, t = 0;
    for(;;){
      t += minutosNivel;
      if(t > totalMinutos) break;
      n++;
      if(pausaCada && n % pausaCada === 0) t += pausaMinutos;
    }
    return n;
  }

  /* Estrutura de blinds para um torneio de duração desejada.

     O crescimento é geométrico: cada nível sobe a mesma proporção, do blind
     inicial até um blind final em que, no heads-up, o stack médio seja de
     BB_NO_HEADS_UP big blinds. Depois cada valor é arredondado para um número
     de ficha de verdade. */
  var BB_NO_HEADS_UP = 20;

  function gerarEstrutura(o){
    var menor = o.menorFicha || 25;
    var minutos = o.minutosNivel;
    var pausaCada = o.pausaCada || 0;
    var pausaMinutos = pausaCada ? (o.pausaMinutos || 0) : 0;
    var totalFichas = o.jogadores * o.stack;

    var n = Math.max(3, niveisQueCabem(o.horas * 60, minutos, pausaCada, pausaMinutos));
    var bbInicial = o.stack / (o.bbIniciais || 100);
    var bbFinal = Math.max(totalFichas / (2 * BB_NO_HEADS_UP), bbInicial * 2);
    var razao = Math.pow(bbFinal / bbInicial, 1 / (n - 1));
    var valores = valoresDeBlind(menor, bbFinal * 4);

    var etapas = [];
    var ultimo = 0, nivel = 0;
    for(var i = 0; i < n; i++){
      var bb = maisProximo(valores, bbInicial * Math.pow(razao, i));
      /* Dois níveis não podem repetir o blind: em estruturas lentas o
         arredondamento levaria valores vizinhos ao mesmo número. */
      if(bb <= ultimo){
        var maior = valores.filter(function(v){ return v > ultimo; })[0];
        if(!maior) break;
        bb = maior;
      }
      ultimo = bb;
      nivel++;
      etapas.push({
        tipo: 'nivel', nivel: nivel, sb: bb / 2, bb: bb,
        ante: o.anteDesde && nivel >= o.anteDesde ? bb : 0,
        minutos: minutos
      });
      if(pausaCada && nivel % pausaCada === 0 && i < n - 1){
        etapas.push({ tipo: 'pausa', minutos: pausaMinutos });
      }
    }

    var duracao = etapas.reduce(function(s, e){ return s + e.minutos; }, 0);
    var primeiro = etapas[0];
    return {
      etapas: etapas,
      niveis: nivel,
      duracaoMinutos: duracao,
      totalFichas: totalFichas,
      bbIniciaisReais: Math.round(o.stack / primeiro.bb),
      bbFinal: ultimo
    };
  }

  /* Tabela de premiação: a MESMA do sistema (frontend/src/utils/payoutStructure.js),
     para a calculadora grátis dar o resultado que o clube vai ver no AceBlind. O
     teste "mesma tabela do sistema" reprova se as duas divergirem.

     Formato: [de, até, lugares pagos, [[do lugar, ao lugar, % de cada um], ...]] */
  var TABELA = [
    [1,5,2,[[1,1,65.0],[2,2,35.0]]],
    [6,17,3,[[1,1,50.0],[2,2,30.0],[3,3,20.0]]],
    [18,26,4,[[1,1,44.0],[2,2,28.0],[3,3,18.0],[4,4,10.0]]],
    [27,35,5,[[1,1,36.0],[2,2,26.0],[3,3,19.0],[4,4,12.0],[5,5,7.0]]],
    [36,53,7,[[1,1,31.5],[2,2,21.0],[3,3,15.0],[4,4,11.5],[5,5,9.0],[6,6,7.0],[7,7,5.0]]],
    [54,62,9,[[1,1,29.0],[2,2,19.0],[3,3,14.0],[4,4,10.0],[5,5,8.0],[6,6,6.5],[7,7,5.5],[8,8,4.5],[9,9,3.5]]],
    [63,80,11,[[1,1,26.0],[2,2,18.5],[3,3,13.5],[4,4,9.5],[5,5,7.8],[6,6,6.3],[7,7,5.0],[8,8,4.1],[9,9,3.5],[10,11,2.9]]],
    [81,98,13,[[1,1,25.5],[2,2,18.3],[3,3,13.2],[4,4,9.0],[5,5,7.0],[6,6,5.5],[7,7,4.5],[8,8,3.8],[9,9,3.2],[10,11,2.7],[12,13,2.3]]],
    [99,107,15,[[1,1,24.5],[2,2,17.2],[3,3,12.5],[4,4,8.6],[5,5,6.4],[6,6,5.3],[7,7,4.5],[8,8,3.8],[9,9,3.2],[10,11,2.7],[12,13,2.3],[14,15,2.0]]],
    [108,134,17,[[1,1,24.0],[2,2,17.0],[3,3,12.3],[4,4,8.5],[5,5,6.3],[6,6,5.1],[7,7,4.2],[8,8,3.4],[9,9,2.8],[10,11,2.45],[12,13,2.15],[14,15,1.9],[16,17,1.7]]],
    [135,161,21,[[1,1,23.3],[2,2,16.0],[3,3,11.5],[4,4,8.1],[5,5,6.0],[6,6,5.0],[7,7,4.0],[8,8,3.2],[9,9,2.6],[10,11,2.2],[12,13,1.9],[14,15,1.7],[16,17,1.55],[18,21,1.4]]],
    [162,197,26,[[1,1,22.55],[2,2,15.2],[3,3,10.9],[4,4,7.9],[5,5,5.7],[6,6,4.4],[7,7,3.5],[8,8,2.8],[9,9,2.4],[10,11,2.1],[12,13,1.85],[14,15,1.6],[16,17,1.4],[18,21,1.25],[22,26,1.15]]],
    [198,242,35,[[1,1,21.4],[2,2,14.2],[3,3,10.0],[4,4,7.3],[5,5,5.2],[6,6,4.0],[7,7,3.0],[8,8,2.42],[9,9,2.05],[10,11,1.85],[12,13,1.65],[14,15,1.45],[16,17,1.3],[18,21,1.15],[22,26,1.0],[27,35,0.93]]],
    [243,305,44,[[1,1,21.0],[2,2,13.9],[3,3,9.5],[4,4,7.0],[5,5,5.0],[6,6,4.0],[7,7,2.9],[8,8,2.3],[9,9,1.9],[10,11,1.6],[12,13,1.4],[14,15,1.2],[16,17,1.05],[18,21,0.95],[22,26,0.85],[27,35,0.8],[36,44,0.75]]],
    [306,368,53,[[1,1,20.72],[2,2,13.0],[3,3,9.3],[4,4,6.5],[5,5,4.8],[6,6,3.8],[7,7,2.8],[8,8,2.15],[9,9,1.8],[10,11,1.5],[12,13,1.32],[14,15,1.15],[16,17,1.02],[18,21,0.9],[22,26,0.8],[27,35,0.7],[36,44,0.65],[45,53,0.6]]],
    [369,431,62,[[1,1,20.5],[2,2,12.7],[3,3,8.9],[4,4,6.0],[5,5,4.5],[6,6,3.5],[7,7,2.6],[8,8,2.0],[9,9,1.7],[10,11,1.45],[12,13,1.28],[14,15,1.12],[16,17,0.98],[18,21,0.85],[22,26,0.75],[27,35,0.66],[36,44,0.6],[45,53,0.55],[54,62,0.5]]],
    [432,485,71,[[1,1,20.3],[2,2,12.5],[3,3,8.7],[4,4,5.8],[5,5,4.3],[6,6,3.2],[7,7,2.4],[8,8,1.95],[9,9,1.7],[10,11,1.45],[12,13,1.27],[14,15,1.1],[16,17,0.93],[18,21,0.8],[22,26,0.7],[27,35,0.61],[36,44,0.55],[45,53,0.5],[54,62,0.46],[63,71,0.43]]],
    [486,548,80,[[1,1,19.8],[2,2,12.2],[3,3,8.3],[4,4,5.5],[5,5,4.02],[6,6,3.0],[7,7,2.35],[8,8,1.9],[9,9,1.6],[10,11,1.38],[12,13,1.2],[14,15,1.04],[16,17,0.89],[18,21,0.75],[22,26,0.66],[27,35,0.6],[36,44,0.54],[45,53,0.49],[54,62,0.45],[63,71,0.42],[72,80,0.39]]],
    [549,611,89,[[1,1,19.0],[2,2,12.1],[3,3,8.0],[4,4,5.3],[5,5,3.9],[6,6,2.94],[7,7,2.3],[8,8,1.85],[9,9,1.58],[10,11,1.38],[12,13,1.18],[14,15,0.99],[16,17,0.84],[18,21,0.73],[22,26,0.65],[27,35,0.59],[36,44,0.53],[45,53,0.48],[54,62,0.43],[63,71,0.39],[72,80,0.36],[81,89,0.34]]],
    [612,701,98,[[1,1,18.8],[2,2,11.89],[3,3,7.7],[4,4,5.2],[5,5,3.7],[6,6,2.8],[7,7,2.2],[8,8,1.84],[9,9,1.56],[10,11,1.3],[12,13,1.1],[14,15,0.95],[16,17,0.8],[18,21,0.71],[22,26,0.64],[27,35,0.57],[36,44,0.51],[45,53,0.46],[54,62,0.42],[63,71,0.38],[72,80,0.35],[81,89,0.33],[90,98,0.31]]],
    [702,809,116,[[1,1,18.2],[2,2,11.36],[3,3,7.2],[4,4,4.8],[5,5,3.45],[6,6,2.6],[7,7,2.1],[8,8,1.765],[9,9,1.485],[10,11,1.23],[12,13,1.03],[14,15,0.9],[16,17,0.78],[18,21,0.685],[22,26,0.615],[27,35,0.545],[36,44,0.49],[45,53,0.45],[54,62,0.41],[63,71,0.37],[72,80,0.33],[81,89,0.3],[90,98,0.28],[99,116,0.265]]],
    [810,926,134,[[1,1,17.8],[2,2,11.025],[3,3,6.9],[4,4,4.6],[5,5,3.4],[6,6,2.4],[7,7,2.05],[8,8,1.7],[9,9,1.41],[10,11,1.19],[12,13,1.01],[14,15,0.87],[16,17,0.75],[18,21,0.66],[22,26,0.595],[27,35,0.535],[36,44,0.48],[45,53,0.425],[54,62,0.375],[63,71,0.335],[72,80,0.3],[81,89,0.28],[90,98,0.26],[99,116,0.245],[117,134,0.23]]],
    [927,1043,152,[[1,1,17.5],[2,2,11.0],[3,3,6.4],[4,4,4.3],[5,5,3.2],[6,6,2.37],[7,7,1.94],[8,8,1.62],[9,9,1.3],[10,11,1.12],[12,13,0.98],[14,15,0.84],[16,17,0.74],[18,21,0.65],[22,26,0.585],[27,35,0.52],[36,44,0.46],[45,53,0.4],[54,62,0.36],[63,71,0.32],[72,80,0.295],[81,89,0.27],[90,98,0.25],[99,116,0.23],[117,134,0.215],[135,152,0.2]]],
    [1044,1160,170,[[1,1,17.425],[2,2,10.6],[3,3,6.35],[4,4,4.25],[5,5,3.1],[6,6,2.3],[7,7,1.9],[8,8,1.56],[9,9,1.28],[10,11,1.1],[12,13,0.96],[14,15,0.83],[16,17,0.72],[18,21,0.63],[22,26,0.55],[27,35,0.48],[36,44,0.42],[45,53,0.38],[54,62,0.345],[63,71,0.315],[72,80,0.285],[81,89,0.26],[90,98,0.24],[99,116,0.22],[117,134,0.2],[135,152,0.19],[153,170,0.18]]],
    [1161,1304,188,[[1,1,17.4],[2,2,10.42],[3,3,6.2],[4,4,4.15],[5,5,2.9],[6,6,2.25],[7,7,1.87],[8,8,1.54],[9,9,1.27],[10,11,1.08],[12,13,0.93],[14,15,0.81],[16,17,0.7],[18,21,0.61],[22,26,0.53],[27,35,0.46],[36,44,0.4],[45,53,0.36],[54,62,0.33],[63,71,0.3],[72,80,0.27],[81,89,0.25],[90,98,0.23],[99,116,0.21],[117,134,0.195],[135,152,0.18],[153,170,0.17],[171,188,0.16]]],
    [1305,1484,215,[[1,1,17.388],[2,2,10.15],[3,3,5.9],[4,4,3.9],[5,5,2.7],[6,6,2.1],[7,7,1.7],[8,8,1.4],[9,9,1.21],[10,11,1.05],[12,13,0.9],[14,15,0.77],[16,17,0.66],[18,21,0.58],[22,26,0.51],[27,35,0.45],[36,44,0.39],[45,53,0.355],[54,62,0.32],[63,71,0.29],[72,80,0.26],[81,89,0.23],[90,98,0.21],[99,116,0.195],[117,134,0.18],[135,152,0.17],[153,170,0.161],[171,188,0.153],[189,215,0.145]]],
    [1485,1655,242,[[1,1,17.3],[2,2,10.0],[3,3,5.7],[4,4,3.79],[5,5,2.6],[6,6,2.0],[7,7,1.6],[8,8,1.35],[9,9,1.175],[10,11,1.0],[12,13,0.86],[14,15,0.74],[16,17,0.64],[18,21,0.565],[22,26,0.5],[27,35,0.435],[36,44,0.375],[45,53,0.335],[54,62,0.3],[63,71,0.275],[72,80,0.25],[81,89,0.23],[90,98,0.21],[99,116,0.19],[117,134,0.175],[135,152,0.16],[153,170,0.15],[171,188,0.14],[189,215,0.13],[216,242,0.125]]],
    [1656,1835,269,[[1,1,17.25],[2,2,9.8],[3,3,5.5],[4,4,3.7],[5,5,2.5],[6,6,1.8],[7,7,1.5],[8,8,1.31],[9,9,1.13],[10,11,0.95],[12,13,0.81],[14,15,0.7],[16,17,0.61],[18,21,0.54],[22,26,0.478],[27,35,0.419],[36,44,0.365],[45,53,0.325],[54,62,0.293],[63,71,0.265],[72,80,0.24],[81,89,0.218],[90,98,0.2],[99,116,0.183],[117,134,0.168],[135,152,0.155],[153,170,0.145],[171,188,0.135],[189,215,0.127],[216,242,0.12],[243,269,0.114]]],
    [1836,2000,305,[[1,1,17.08],[2,2,9.53],[3,3,5.24],[4,4,3.54],[5,5,2.35],[6,6,1.68],[7,7,1.42],[8,8,1.24],[9,9,1.05],[10,11,0.87],[12,13,0.76],[14,15,0.68],[16,17,0.6],[18,21,0.53],[22,26,0.47],[27,35,0.41],[36,44,0.36],[45,53,0.32],[54,62,0.285],[63,71,0.25],[72,80,0.23],[81,89,0.21],[90,98,0.192],[99,116,0.177],[117,134,0.163],[135,152,0.15],[153,170,0.14],[171,188,0.131],[189,215,0.121],[216,242,0.111],[243,269,0.104],[270,305,0.097]]]
  ];

  function linhaDaTabela(entradas){
    for(var i = 0; i < TABELA.length; i++){
      if(entradas >= TABELA[i][0] && entradas <= TABELA[i][1]) return TABELA[i];
    }
    return TABELA[TABELA.length - 1];
  }

  function calcularPremiacao(o){
    var bruto = o.entradas * o.buyin;
    var rake = bruto * (o.taxaPct || 0) / 100;
    var liquido = bruto - rake;
    /* Garantido SOMA ao que os jogadores pagaram: é a regra do sistema
       (prize_allocation_service.py), decidida assim de propósito. Não é o maior
       dos dois. */
    var premio = liquido + (o.garantido || 0);
    var unidade = o.arredondar || 1;
    /* Sem unidade, arredonda como o sistema. Com unidade, sempre para baixo: para
       cima, a soma estouraria o prêmio e o campeão pagaria a diferença. */
    var ajustar = unidade === 1 ? Math.round : Math.floor;

    var lugares = [];
    linhaDaTabela(o.entradas)[3].forEach(function(faixa){
      for(var posicao = faixa[0]; posicao <= faixa[1]; posicao++){
        lugares.push({ posicao: posicao, percentual: faixa[2], valor: ajustar(premio * faixa[2] / 100 / unidade) * unidade });
      }
    });
    /* Quem arredondou para zero sai da lista: lugar pago com prêmio zero é só
       discussão na mesa final. */
    lugares = lugares.filter(function(l, i){ return i === 0 || l.valor > 0; });

    /* O que sobrou do arredondamento vai para o campeão: a soma fecha sempre
       com o prêmio, centavo por centavo. */
    var distribuido = lugares.reduce(function(s, l){ return s + l.valor; }, 0);
    lugares[0].valor = Math.round((lugares[0].valor + premio - distribuido) * 100) / 100;

    return { bruto: bruto, rake: rake, liquido: liquido, premio: premio, pagos: lugares.length, lugares: lugares };
  }

  /* 1205 → "20:05"; passa de uma hora → "1:05:00". */
  function formatarTempo(segundos){
    var s = Math.max(0, Math.ceil(segundos));
    var h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), r = s % 60;
    var dois = function(v){ return (v < 10 ? '0' : '') + v; };
    return h ? h + ':' + dois(m) + ':' + dois(r) : dois(m) + ':' + dois(r);
  }

  /* A planilha sai com ponto e vírgula e BOM: é o que o Excel em português e em
     espanhol abre direto em colunas, com acento no lugar. */
  function paraCsv(linhas){
    var celula = function(v){
      var s = String(v == null ? '' : v);
      return /[";\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    return '﻿' + linhas.map(function(l){ return l.map(celula).join(';'); }).join('\r\n') + '\r\n';
  }

  raiz.ACEBLIND_CALC = {
    valoresDeBlind: valoresDeBlind,
    gerarEstrutura: gerarEstrutura,
    linhaDaTabela: linhaDaTabela,
    calcularPremiacao: calcularPremiacao,
    formatarTempo: formatarTempo,
    paraCsv: paraCsv
  };
})(typeof window !== 'undefined' ? window : globalThis);
