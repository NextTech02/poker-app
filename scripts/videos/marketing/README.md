# Vídeos de marketing

Vídeos verticais (1080x1920, 17 a 19 s) para Reels, Stories, TikTok e Shorts,
montados com trechos das gravações do suporte: um gancho, três trechos reais do
app com título e o cartão final. Os textos e os trechos ficam em `roteiros.json`.

```bash
npm i playwright-core            # fora do repositório, em qualquer pasta
set PLAYWRIGHT=<pasta>/node_modules/playwright-core
node gerar.cjs                   # todos
node gerar.cjs offline es-ES     # um vídeo, um idioma
```

Precisa do `ffmpeg` no PATH, do Chrome e das gravações em `../saida/final`
(`VIDEOS_FINAL` aponta para outra pasta). O resultado vai para `SAIDA`.

- **Sem som de propósito.** A música entra no editor da rede, que tem a licença.
- Em `trecho` fica o segundo em que o corte começa, por idioma: a narração muda
  de tamanho, então o mesmo momento cai em segundos diferentes. Regravou o vídeo
  de suporte, confira os trechos.
- Só prometa o que o sistema faz. O que funciona sem internet está em
  `landing/conteudo/pt/offline.html`.
- Espanhol neutro (tú), sem "planilla" e sem "sangría", como no site.
- O anúncio vende gestão para o clube. Não convide ninguém a jogar, não mostre
  prêmio em dinheiro como promessa: as políticas de Google e Meta tratam isso
  como jogo.
