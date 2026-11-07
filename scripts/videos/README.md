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
python revisar.py caixa-registrar-venda --idioma en-US         # folhas de quadros
python publicar.py                                             # só mostra o que subiria
python publicar.py --enviar
```

Sem `AZURE_SPEECH_KEY`, a voz sai pelo edge-tts e o vídeo vai para
`saida/rascunho/`. Esse serviço não é licenciado para publicação, e o
`publicar.py` só envia `saida/final/`.

Cada idioma grava no próprio clube fictício (`CLUBES` em `clube_demo.py`), com
moeda e nomes locais. Quando um passo falha, o print da tela vai para
`cache/erros/`.

## Escrever um roteiro

Cada passo tem uma `fala` por idioma e as `acoes` que acontecem durante ela. O
passo dura o tempo da fala, ou mais, se os gestos demorarem.

| Ação | Exemplo |
|---|---|
| `ir` | `ir: /blinds/{dia}` |
| `clicar` | `clicar: {papel: button, t: cashRegister.newTransaction}` |
| `digitar` | `digitar: {css: "#nome", valor: "{jogador}", limpar: true}` |
| `preencher` | `preencher: {css: "#data", valor: "2026-12-01"}` (campo de data) |
| `escolher` | `escolher: {css: "#payment_method", opcao: {pt-BR: "pix", en-US: "card"}}` |
| `destacar` | `destacar: {css: ".cx-sale-totals"}` com `segundos: 2.5` ao lado |
| `passar` | `passar: {css: ".linha"}` (cursor sobre o item) |
| `rolar` | `rolar: {css: ".rodape"}` |
| `tecla` | `tecla: Escape` |
| `esperar` | `esperar: {t: cashRegister.title}` |
| `pausa` | `pausa: 1.5` |

Alvos: `t` (chave de tradução do app, preferida: acha o botão nos três idiomas),
`texto` (por idioma), `css`, `papel` e `rotulo`, com `n` para escolher entre
vários. `css` com `t` ou `texto` filtra pelo conteúdo.

Variáveis entre chaves: `{dia}`, `{torneio}`, `{etapa}` e `{org}` vêm do clube, e
`{jogador}` traz alguém que ainda não entrou no torneio. O campo `preparar:
cash:mesa_com_jogadores` chama essa função de `sementes/cash.py` antes de
gravar; ela recebe `(idioma, api)`, deixa o clube no estado certo e devolve
outras variáveis. Devolvendo `etapa_selecionada`, o vídeo grava naquela etapa.

Em `pronuncia.json` (opcional) entram termos que a voz lê errado, por idioma:
`{"pt-BR": {"rake": "reique"}}`. A legenda continua com o texto original.

## Cuidados

- Os clubes fictícios ficam em produção e cada venda gravada é real neles. Nunca
  aponte estes scripts para outro clube.
- Nenhum vídeo pode enviar e-mail: não conclua convite nem "esqueci a senha", e
  jogador não tem e-mail. Não ative 2FA no usuário das gravações.
- Sem CPF: os documentos são passaportes `DEMO...`.
- O F0 do Azure dá 500 mil caracteres por mês e 20 pedidos por minuto. O limite
  de pedidos é respeitado entre processos, e `narracao.py` para antes de esgotar
  a cota. O áudio fica em cache: só texto novo gasta caracteres.
- O vídeo sai em 1536x864 de propósito. Em 1920 a interface fica pequena demais
  num player embutido.
- Arquivos acima do limite global do Storage são recusados, mesmo com o limite
  do bucket mais alto (Dashboard > Storage > Settings).
