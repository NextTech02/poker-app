/* Timer de torneio grátis. Roda inteiro no navegador: depois de aberto, segue
   contando sem internet.

   O tempo é medido pelo relógio do aparelho, e não contando "ticks": aba em
   segundo plano dispara o setInterval bem menos vezes, e um contador simples
   atrasaria o torneio. */
(function(){
  var alvo = document.getElementById('ferramenta');
  if(!alvo) return;
  var C = window.ACEBLIND_CALC, U = window.ACEBLIND_UI;

  var T = {
    pt: {
      nivel: 'Nível', pausa: 'Pausa', ante: 'Ante', proximo: 'Próximo', fim: 'Fim da estrutura', iniciar: 'Iniciar', parar: 'Pausar',
      anterior: 'Nível anterior', seguinte: 'Próximo nível', mais: '+1 min', menos: '−1 min', tela: 'Tela cheia', somOn: 'Som ligado', somOff: 'Som desligado',
      editar: 'Editar estrutura', tipo: 'Etapa', sb: 'SB', bb: 'BB', minutos: 'Min', remover: 'Remover', addNivel: 'Adicionar nível',
      addPausa: 'Adicionar pausa', padrao: 'Voltar à estrutura padrão', atalhos: 'Atalhos: espaço inicia e pausa; setas trocam de nível.', mudou: 'Agora:'
    },
    es: {
      nivel: 'Nivel', pausa: 'Pausa', ante: 'Ante', proximo: 'Siguiente', fim: 'Fin de la estructura', iniciar: 'Iniciar', parar: 'Pausar',
      anterior: 'Nivel anterior', seguinte: 'Siguiente nivel', mais: '+1 min', menos: '−1 min', tela: 'Pantalla completa', somOn: 'Sonido activado', somOff: 'Sonido desactivado',
      editar: 'Editar estructura', tipo: 'Etapa', sb: 'SB', bb: 'BB', minutos: 'Min', remover: 'Quitar', addNivel: 'Agregar nivel',
      addPausa: 'Agregar pausa', padrao: 'Volver a la estructura estándar', atalhos: 'Atajos: la barra espaciadora inicia y pausa; las flechas cambian de nivel.', mudou: 'Ahora:'
    },
    en: {
      nivel: 'Level', pausa: 'Break', ante: 'Ante', proximo: 'Next', fim: 'End of structure', iniciar: 'Start', parar: 'Pause',
      anterior: 'Previous level', seguinte: 'Next level', mais: '+1 min', menos: '−1 min', tela: 'Full screen', somOn: 'Sound on', somOff: 'Sound off',
      editar: 'Edit structure', tipo: 'Step', sb: 'SB', bb: 'BB', minutos: 'Min', remover: 'Remove', addNivel: 'Add level',
      addPausa: 'Add break', padrao: 'Back to the default structure', atalhos: 'Shortcuts: space starts and pauses; arrow keys change level.', mudou: 'Now:'
    }
  }[U.idioma];

  var CHAVE_ESTRUTURA = 'aceblind.timer.estrutura';
  var CHAVE_ESTADO = 'aceblind.timer.estado';

  function estruturaPadrao(){
    return C.gerarEstrutura({ jogadores: 30, stack: 20000, horas: 5, minutosNivel: 20, menorFicha: 25, pausaCada: 4, pausaMinutos: 10, anteDesde: 5 }).etapas;
  }

  function valida(lista){
    return Array.isArray(lista) && lista.length > 0 && lista.every(function(e){ return e && e.minutos > 0; });
  }

  var guardada = U.recuperar(CHAVE_ESTRUTURA);
  var etapas = valida(guardada) ? guardada : estruturaPadrao();
  var estado = U.recuperar(CHAVE_ESTADO) || {};
  var indice = estado.indice < etapas.length ? estado.indice : 0;
  var restante = estado.restante > 0 ? estado.restante : etapas[indice].minutos * 60;
  var fim = 0;          /* instante em que a etapa acaba, enquanto o relógio roda */
  var rodando = false;
  var somLigado = true;
  var audio = null;
  var trava = null;

  alvo.innerHTML =
    '<div class="tm" id="tm">' +
      '<div class="tm__etapa" id="tmEtapa"></div>' +
      '<div class="tm__relogio" id="tmRelogio" role="timer"></div>' +
      '<div class="tm__blinds" id="tmBlinds"></div>' +
      '<div class="tm__ante" id="tmAnte"></div>' +
      '<div class="tm__prox" id="tmProx"></div>' +
      '<div class="tm__acoes">' +
        '<button type="button" class="btn btn--primary" id="tmPlay"></button>' +
        '<button type="button" class="btn btn--ghost btn--sm" id="tmAnt">' + T.anterior + '</button>' +
        '<button type="button" class="btn btn--ghost btn--sm" id="tmSeg">' + T.seguinte + '</button>' +
        '<button type="button" class="btn btn--ghost btn--sm" id="tmMenos">' + T.menos + '</button>' +
        '<button type="button" class="btn btn--ghost btn--sm" id="tmMais">' + T.mais + '</button>' +
        '<button type="button" class="btn btn--ghost btn--sm" id="tmSom"></button>' +
        '<button type="button" class="btn btn--ghost btn--sm" id="tmTela">' + T.tela + '</button>' +
      '</div>' +
      '<p class="fer-sr" id="tmAviso" role="status"></p>' +
    '</div>' +
    '<p class="fer-nota">' + T.atalhos + '</p>' +
    '<details class="fer-editor"><summary>' + T.editar + '</summary>' +
      '<div class="fer-tabela"><table><thead><tr><th>' + T.tipo + '</th><th>' + T.sb + '</th><th>' + T.bb + '</th><th>' + T.ante + '</th><th>' + T.minutos + '</th><th></th></tr></thead><tbody id="tmLinhas"></tbody></table></div>' +
      '<div class="fer-acoes">' +
        '<button type="button" class="btn btn--outline btn--sm" id="tmAddNivel">' + T.addNivel + '</button>' +
        '<button type="button" class="btn btn--outline btn--sm" id="tmAddPausa">' + T.addPausa + '</button>' +
        '<button type="button" class="btn btn--outline btn--sm" id="tmPadrao">' + T.padrao + '</button>' +
      '</div>' +
    '</details>';

  function el(id){ return document.getElementById(id); }

  function numeroDoNivel(i){
    var n = 0;
    for(var k = 0; k <= i; k++) if(etapas[k].tipo !== 'pausa') n++;
    return n;
  }

  function rotulo(e, i){
    return e.tipo === 'pausa' ? T.pausa : T.nivel + ' ' + numeroDoNivel(i);
  }

  function blinds(e){ return U.numero(e.sb) + ' / ' + U.numero(e.bb); }

  function pintar(){
    var e = etapas[indice], seguinte = etapas[indice + 1];
    el('tmEtapa').textContent = rotulo(e, indice);
    el('tmRelogio').textContent = C.formatarTempo(restante);
    el('tmBlinds').textContent = e.tipo === 'pausa' ? '—' : blinds(e);
    el('tmAnte').textContent = e.tipo !== 'pausa' && e.ante ? T.ante + ' ' + U.numero(e.ante) : '';
    el('tmProx').textContent = !seguinte ? T.fim
      : T.proximo + ': ' + (seguinte.tipo === 'pausa' ? T.pausa + ' · ' + seguinte.minutos + ' min' : blinds(seguinte));
    el('tmPlay').textContent = rodando ? T.parar : T.iniciar;
    el('tmSom').textContent = somLigado ? T.somOn : T.somOff;
    el('tm').classList.toggle('tm--pausa', e.tipo === 'pausa');
  }

  function guardarEstado(){ U.guardar(CHAVE_ESTADO, { indice: indice, restante: Math.ceil(restante) }); }

  /* O navegador só libera som depois de um clique; por isso o contexto de áudio
     nasce no botão Iniciar. */
  function bip(duracao, frequencia){
    if(!somLigado || !audio) return;
    var osc = audio.createOscillator(), ganho = audio.createGain();
    osc.frequency.value = frequencia;
    ganho.gain.value = 0.25;
    osc.connect(ganho);
    ganho.connect(audio.destination);
    osc.start();
    osc.stop(audio.currentTime + duracao);
  }

  /* Tela apagando no meio do nível é o defeito clássico de timer em notebook. */
  function manterTelaLigada(ligar){
    if(!('wakeLock' in navigator)) return;
    if(ligar && !trava){
      navigator.wakeLock.request('screen').then(function(t){ trava = t; }).catch(function(){ /* sem permissão, segue */ });
    } else if(!ligar && trava){
      trava.release().catch(function(){ /* já liberada */ });
      trava = null;
    }
  }

  function irPara(i, sobra){
    indice = Math.max(0, Math.min(i, etapas.length - 1));
    restante = etapas[indice].minutos * 60 - (sobra || 0);
    fim = Date.now() + restante * 1000;
    el('tmAviso').textContent = T.mudou + ' ' + rotulo(etapas[indice], indice);
    guardarEstado();
    pintar();
  }

  function alternar(){
    if(!audio && (window.AudioContext || window.webkitAudioContext)){
      audio = new (window.AudioContext || window.webkitAudioContext)();
    }
    rodando = !rodando;
    if(rodando) fim = Date.now() + restante * 1000;
    manterTelaLigada(rodando);
    guardarEstado();
    pintar();
  }

  var ultimoSegundo = null;
  function tique(){
    if(!rodando) return;
    restante = (fim - Date.now()) / 1000;

    if(restante <= 0){
      if(indice + 1 < etapas.length){
        bip(0.7, 660);
        irPara(indice + 1, -restante);
      } else {
        restante = 0;
        rodando = false;
        manterTelaLigada(false);
        bip(1.2, 440);
        pintar();
      }
      return;
    }

    var segundo = Math.ceil(restante);
    if(segundo !== ultimoSegundo){
      ultimoSegundo = segundo;
      if(segundo <= 10) bip(0.12, 880);
      if(segundo % 5 === 0) guardarEstado();
      pintar();
    }
  }

  function ajustar(segundos){
    restante = Math.max(1, restante + segundos);
    fim = Date.now() + restante * 1000;
    guardarEstado();
    pintar();
  }

  function salvarEstrutura(){
    U.guardar(CHAVE_ESTRUTURA, etapas);
    if(indice >= etapas.length) irPara(etapas.length - 1);
    pintar();
  }

  function campoNumero(i, nome, valor){
    return '<input type="number" min="0" inputmode="numeric" aria-label="' + nome + '" data-i="' + i + '" data-campo="' + nome + '" value="' + valor + '">';
  }

  function pintarEditor(){
    el('tmLinhas').innerHTML = etapas.map(function(e, i){
      var pausa = e.tipo === 'pausa';
      return '<tr' + (pausa ? ' class="fer-pausa"' : '') + '><td>' + rotulo(e, i) + '</td>' +
        '<td>' + (pausa ? '' : campoNumero(i, 'sb', e.sb)) + '</td>' +
        '<td>' + (pausa ? '' : campoNumero(i, 'bb', e.bb)) + '</td>' +
        '<td>' + (pausa ? '' : campoNumero(i, 'ante', e.ante || 0)) + '</td>' +
        '<td>' + campoNumero(i, 'minutos', e.minutos) + '</td>' +
        '<td><button type="button" class="fer-remover" data-remover="' + i + '" aria-label="' + T.remover + ' ' + rotulo(e, i) + '">×</button></td></tr>';
    }).join('');
  }

  el('tmLinhas').addEventListener('change', function(ev){
    var campo = ev.target.getAttribute('data-campo');
    if(!campo) return;
    var etapa = etapas[Number(ev.target.getAttribute('data-i'))];
    var v = Math.max(0, parseFloat(ev.target.value) || 0);
    etapa[campo] = campo === 'minutos' ? Math.max(1, v) : v;
    salvarEstrutura();
  });
  el('tmLinhas').addEventListener('click', function(ev){
    var i = ev.target.getAttribute('data-remover');
    if(i === null || etapas.length === 1) return;
    etapas.splice(Number(i), 1);
    salvarEstrutura();
    pintarEditor();
  });
  el('tmAddNivel').addEventListener('click', function(){
    var ultimos = etapas.filter(function(e){ return e.tipo !== 'pausa'; });
    var u = ultimos[ultimos.length - 1] || { bb: 100, ante: 0, minutos: 20 };
    etapas.push({ tipo: 'nivel', sb: u.bb, bb: u.bb * 2, ante: u.ante ? u.bb * 2 : 0, minutos: u.minutos });
    salvarEstrutura();
    pintarEditor();
  });
  el('tmAddPausa').addEventListener('click', function(){
    etapas.push({ tipo: 'pausa', minutos: 10 });
    salvarEstrutura();
    pintarEditor();
  });
  el('tmPadrao').addEventListener('click', function(){
    etapas = estruturaPadrao();
    salvarEstrutura();
    irPara(0);
    pintarEditor();
  });

  el('tmPlay').addEventListener('click', alternar);
  el('tmAnt').addEventListener('click', function(){ irPara(indice - 1); });
  el('tmSeg').addEventListener('click', function(){ irPara(indice + 1); });
  el('tmMais').addEventListener('click', function(){ ajustar(60); });
  el('tmMenos').addEventListener('click', function(){ ajustar(-60); });
  el('tmSom').addEventListener('click', function(){ somLigado = !somLigado; pintar(); });
  el('tmTela').addEventListener('click', function(){
    var tm = el('tm');
    if(document.fullscreenElement) document.exitFullscreen();
    else if(tm.requestFullscreen) tm.requestFullscreen();
  });

  document.addEventListener('keydown', function(ev){
    if(/INPUT|SELECT|TEXTAREA|BUTTON|SUMMARY/.test(ev.target.tagName)) return;
    if(ev.code === 'Space'){ ev.preventDefault(); alternar(); }
    if(ev.code === 'ArrowRight') irPara(indice + 1);
    if(ev.code === 'ArrowLeft') irPara(indice - 1);
  });

  /* O bloqueio de tela cai quando a aba sai de vista; volta com ela. */
  document.addEventListener('visibilitychange', function(){
    if(document.visibilityState === 'visible' && rodando){ trava = null; manterTelaLigada(true); }
  });

  pintarEditor();
  pintar();
  setInterval(tique, 200);
})();
