# Vídeos de suporte

Grava o app, narra e legenda a partir de um roteiro único para os três idiomas.
Quando uma tela muda, basta rodar o roteiro de novo. Os vídeos aparecem em
`/suporte` no app, lidos do bucket `videos-suporte`.

## Preparar

```bash
python -m venv .venv
.venv/Scripts/pip install -r requirements.txt
.venv/Scripts/python -m playwright install chromium
```

Precisa do `ffmpeg` no PATH. As chaves ficam fora do repositório, num arquivo
apontado por `VIDEOS_ENV`:

```
AZURE_SPEECH_KEY=...
AZURE_SPEECH_REGION=...
SUPABASE_SERVICE_KEY=...   # projeto de São Paulo, nunca o de Oregon
```

## Produzir

```bash
python clube_demo.py --criar --semear                          # uma vez só
python produzir.py roteiros/caixa-registrar-venda.yaml         # os 3 idiomas
python produzir.py roteiros/caixa-registrar-venda.yaml --idioma en-US
python publicar.py                                             # só mostra o que subiria
python publicar.py --enviar
```

Sem `AZURE_SPEECH_KEY`, a voz sai pelo edge-tts e o vídeo vai para
`saida/rascunho/`. Esse serviço não é licenciado para publicação, e o
`publicar.py` só envia `saida/final/`.

## Escrever um roteiro

Cada passo tem uma `fala` por idioma e as `acoes` que acontecem durante ela. O
passo dura o tempo da fala, ou mais, se os gestos demorarem.

| Ação | Exemplo |
|---|---|
| `ir` | `ir: /caixa` |
| `clicar` | `clicar: {papel: button, t: cashRegister.newTransaction}` |
| `digitar` | `digitar: {css: "#nome", valor: "{jogador}"}` |
| `escolher` | `escolher: {css: "#payment_method", opcao: "pix"}` |
| `destacar` | `destacar: {css: ".cx-sale-totals"}` |
| `esperar` | `esperar: {t: cashRegister.title}` |
| `pausa` | `pausa: 1.5` |

Prefira `t:` (chave de tradução do app) a texto fixo: o mesmo passo acha o botão
nos três idiomas. Em `pronuncia.json` (opcional) entram termos que a voz lê
errado, por idioma: `{"pt-BR": {"rake": "reique"}}`. A legenda continua com o
texto original.

## Cuidados

- O clube fictício fica em produção e cada venda gravada é real nele. Nunca
  aponte estes scripts para outro clube.
- Sem e-mail de jogador e sem CPF: os documentos são passaportes `DEMO...`.
- O vídeo sai em 1536x864 de propósito. Em 1920 a interface fica pequena demais
  num player embutido.
- Arquivos acima do limite global do Storage são recusados, mesmo com o limite
  do bucket mais alto (Dashboard > Storage > Settings).
