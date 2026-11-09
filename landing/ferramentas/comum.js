/* O que as três ferramentas fazem igual: idioma da página, número no formato
   local, leitura de formulário, download da planilha e guardar a escolha. */
(function(){
  var idioma = (document.documentElement.lang || 'pt').slice(0, 2);
  var local = { pt: 'pt-BR', es: 'es', en: 'en-US' }[idioma] || 'pt-BR';

  function numero(v, casas){
    /* useGrouping: o `es` do navegador só separa milhar a partir de 5 dígitos, e
       os guias escrevem 2.580. */
    return Number(v).toLocaleString(local, { maximumFractionDigits: casas == null ? 2 : casas, useGrouping: 'always' });
  }

  /* Campo vazio ou inválido vira o mínimo do próprio campo: a ferramenta nunca
     mostra NaN para quem apagou o número para digitar outro. */
  function ler(form, nome){
    var campo = form.elements[nome];
    var v = parseFloat(campo.value);
    var minimo = campo.min === '' ? 0 : parseFloat(campo.min);
    return isNaN(v) || v < minimo ? minimo : v;
  }

  function campo(c){
    return '<label class="fer-campo"><span>' + c.rotulo + '</span>' +
      (c.opcoes
        ? '<select name="' + c.nome + '">' + c.opcoes.map(function(o){
            return '<option value="' + o + '"' + (o === c.valor ? ' selected' : '') + '>' + numero(o) + '</option>';
          }).join('') + '</select>'
        : '<input type="number" inputmode="decimal" name="' + c.nome + '" value="' + c.valor + '" min="' + (c.min == null ? 0 : c.min) + '"' + (c.max ? ' max="' + c.max + '"' : '') + ' step="' + (c.passo || 'any') + '">') +
      (c.dica ? '<small>' + c.dica + '</small>' : '') +
      '</label>';
  }

  function baixar(nome, conteudo){
    var url = URL.createObjectURL(new Blob([conteudo], { type: 'text/csv;charset=utf-8' }));
    var a = document.createElement('a');
    a.href = url;
    a.download = nome;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function(){ URL.revokeObjectURL(url); }, 1000);
  }

  /* Navegação privada e armazenamento bloqueado não podem quebrar a ferramenta. */
  function guardar(chave, valor){
    try { localStorage.setItem(chave, JSON.stringify(valor)); } catch(e){ /* segue sem guardar */ }
  }
  function recuperar(chave){
    try { return JSON.parse(localStorage.getItem(chave)); } catch(e){ return null; }
  }

  window.ACEBLIND_UI = { idioma: idioma, numero: numero, ler: ler, campo: campo, baixar: baixar, guardar: guardar, recuperar: recuperar };
})();
