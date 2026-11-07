# Site público — aceblind.net

HTML estático em três idiomas: a home (`aceblind.net/`, `/es/` e `/en/`), as
páginas de funcionalidade, as ferramentas grátis e os guias. A home nasceu do
protótipo do marketing (`aceblind-landing.html`), com os números conferidos
contra o banco e os textos que não podiam ir ao ar como estavam.

```
landing/
├── index.html      a home (HTML + CSS + JS), em português — a fonte do markup
├── i18n.js         a home em inglês e espanhol, e título/descrição de cada idioma
├── conteudo/       as páginas internas: pt/, es/, en/, a moldura e o CSS delas
├── ferramentas/    o JavaScript do timer, do gerador de blinds e da premiação
├── testes/         os testes dos cálculos das ferramentas (npm test)
├── build.mjs       gera dist/: todas as páginas, sitemap e dados estruturados
├── nginx.conf      como é servida (+ seguranca.conf, os cabeçalhos)
├── Dockerfile      build em Node, serve com nginx:alpine (~10 MB)
├── scripts/        gerar-og.mjs, que refaz as imagens de compartilhamento
└── public/         robots.txt, 404.html, ícones, fontes e imagens
```

## Idiomas e SEO

A página é escrita em **português no HTML**, e inglês e espanhol vivem em
`i18n.js`. O `build.mjs` aplica as traduções e gera **um HTML por idioma**, com
o texto já traduzido, título, descrição, canonical e `hreflang` próprios:

| URL | Idioma |
|---|---|
| `aceblind.net/` | português (também o `x-default`) |
| `aceblind.net/es/` | espanhol |
| `aceblind.net/en/` | inglês |

Antes, os três idiomas viviam na mesma URL e o JavaScript trocava o texto no
navegador. Para o Google era uma página só — e, como o robô renderiza com o
navegador em inglês, ele podia até ler a home em inglês. Por isso o idioma
agora é decidido **só pela URL**: nada de detectar pelo navegador nem lembrar a
escolha. O seletor de idioma são links para as três URLs.

Os links antigos com `?lang=es` / `?lang=en` continuam funcionando: o nginx
manda (301) para `/es/` ou `/en/`.

O build também gera:

- `sitemap.xml` com todas as URLs, ligadas por `hreflang` onde há tradução;
- os **dados estruturados** (JSON-LD) de cada página — `Organization`,
  `SoftwareApplication` com os planos e `FAQPage` com as perguntas —, lidos do
  próprio texto já traduzido. Mudou uma pergunta ou um preço no HTML, o JSON-LD
  acompanha;
- o link `wa.me` dos botões de WhatsApp já no HTML, com a mensagem no idioma da
  página.

**Ao acrescentar texto novo**, marque no HTML e adicione a chave nos dois
idiomas de `i18n.js`:

```html
<p data-i18n="minha.chave">Texto em português</p>
<input data-i18n-ph="minha.chavePh" placeholder="Dica do campo">
<nav data-i18n-aria="minha.chaveAria" aria-label="Seções">
```

Chave faltando não quebra a página — o trecho fica em português — e o build
avisa no log quais faltaram.

## Páginas internas

Cada página é um arquivo em `conteudo/<pt|es|en>/`, com um cabeçalho e o HTML do
corpo. O build põe a moldura em volta: menu, migalhas, formulário, rodapé e dados
estruturados. Página nova **não** exige mexer no nginx nem no sitemap.

```html
---
id: timer                       # o mesmo id em pt/, es/ e en/ liga o hreflang
secao: ferramentas              # produto | ferramentas | guias
slug: ferramentas/timer-de-poker
ferramenta: timer               # só nas ferramentas: inclui ferramentas/timer.js
titulo: Timer de Poker Online Grátis para Torneio | AceBlind
descricao: até ~155 caracteres
h1: Timer de poker online grátis
lead: frase abaixo do título (opcional)
rotulo: Timer de poker          # nome curto: rodapé, cartões e migalhas
resumo: uma linha para os cartões
atualizado: 2026-11-06          # vai para o sitemap: mude quando mudar o texto
ordem: 10
relacionados: blinds, premiacao # ids das páginas sugeridas no fim
---
<h2>...</h2>
```

Cada idioma tem o seu `slug`, porque quem busca em espanhol digita "reloj de
póker". Uma página pode existir em um idioma só: sem tradução, ela não declara
`hreflang`, e o seletor leva à home do outro idioma.

Perguntas frequentes em `<details class="pergunta"><summary>…</summary><div><p>…</p></div></details>`
viram `FAQPage` nos dados estruturados. O Google hoje quase não mostra esse
resultado para sites comerciais; ele fica por ajudar buscadores e respostas de IA.

**O build para com erro** em link interno quebrado, âncora inexistente, slug,
título ou descrição repetidos, campo faltando e página sem exatamente um `<h1>`.
Título ou descrição longos só avisam.

**Antes de publicar uma afirmação sobre o produto, confira no código.** A home já
teve "roda localmente na máquina", "check-in" e "o único sistema da categoria".
Nenhuma se sustentava. O que funciona sem internet está em `conteudo/pt/offline.html`,
e essa lista precisa acompanhar o código.

## Ferramentas grátis

`calculos.js` tem as contas, sem nenhum acesso à tela; `comum.js`, o que as três
fazem igual; `timer.js`, `blinds.js` e `premiacao.js`, a parte visual, nos três
idiomas. Tudo roda no navegador, sem backend e sem cadastro, e o JavaScript vai
dentro da página.

A **premiação usa a mesma tabela do sistema**, copiada de
`frontend/src/utils/payoutStructure.js` até 2.000 entradas, e soma o garantido ao
prêmio dos jogadores, como faz `prize_allocation_service.py`. Mudou a tabela lá,
mude em `calculos.js`: o `npm test` reprova se as duas divergirem.

```bash
npm test
```

## De onde vêm os leads

O formulário guarda a **primeira** origem da pessoa (90 dias, no navegador) e a
envia no campo `source` do lead:

```
landing|org:google|/ferramentas/timer-de-poker/    busca orgânica
landing|utm:instagram|/                            link com utm_source
landing|ref:cbth.org.br|/es/                       outro site
landing|direto|/                                   endereço digitado ou sem origem
```

O limite do campo é **60 caracteres**, e acima disso a API recusa o lead inteiro;
o JavaScript corta antes de enviar. Campo novo no corpo do POST não adianta: o
backend descarta o que não conhece.

```sql
-- leads por canal
SELECT split_part(source, '|', 2) AS canal, count(*)
  FROM leads WHERE created_at > now() - interval '90 days'
 GROUP BY 1 ORDER BY 2 DESC;

-- as páginas de entrada que mais trazem lead do orgânico
SELECT split_part(source, '|', 3) AS pagina, count(*)
  FROM leads WHERE source LIKE 'landing|org:%'
 GROUP BY 1 ORDER BY 2 DESC;
```

Clique no WhatsApp **não** passa por aqui: quem chama direto não tem origem
registrada.

## Editar o texto

`index.html` (português) e `i18n.js` (inglês e espanhol). Título e descrição
de cada idioma, para o Google e para o link compartilhado, ficam em
`ACEBLIND_META`, no fim de `i18n.js`. As páginas internas ficam em `conteudo/`.

Para ver o resultado antes de subir:

```bash
cd landing
npm install          # uma vez
npm run build        # gera dist/
npx serve dist       # ou qualquer servidor estático
```

Abrir o `index.html` direto no navegador também funciona, mas só em português.

Os dois valores de configuração ficam juntos, no bloco `CONFIGURAÇÃO DA PÁGINA`
no fim do `index.html`:

```js
window.ACEBLIND_API = 'https://api.aceblind.net';
window.ACEBLIND_WHATSAPP = '556233001244';   // só dígitos, com DDI
```

O número já está configurado (**+55 62 3300-1244**). A conversa abre com a
mensagem **já escrita no idioma da página** — quem leu em espanhol não precisa
redigir em português para pedir informação. Os três textos ficam em `i18n.js`,
em `ACEBLIND_META`.

Se um dia `ACEBLIND_WHATSAPP` ficar vazio, os botões passam a levar ao
formulário em vez de abrir uma conversa quebrada.

## O formulário

Manda `POST /public/leads` para a API. O lead é **gravado na tabela `leads`
antes** de qualquer tentativa de e-mail — notificação falha, e um formulário que
só manda e-mail perde o cliente em silêncio.

Para receber o aviso por e-mail, o `.env` do backend precisa de:

```
RESEND_API_KEY=re_...
LEADS_EMAIL_TO=voce@nexthubco.com          # vários, separados por vírgula
LEADS_EMAIL_FROM=AceBlind <noreply@aceblind.net>
LANDING_URL=https://aceblind.net           # sem isto o CORS barra o formulário
```

A mesma `RESEND_API_KEY` também manda os e-mails do app (convite de clube e de
funcionário, redefinição de senha), redigidos pelo backend no idioma da tela de
quem pediu. O "esqueci minha senha" ainda precisa de:

```
HCAPTCHA_SECRET=0x...   # secret da site key do hCaptcha (a mesma do Supabase → Auth → Attack protection)
```

Sem ele o fluxo funciona, mas sem verificação de captcha — só em desenvolvimento.

Sem `RESEND_API_KEY` nada quebra: o lead continua sendo gravado, e você o vê no
banco. Quem ficou sem aviso é fácil de achar:

```sql
SELECT * FROM leads WHERE notified_at IS NULL AND status = 'new'
 ORDER BY created_at DESC;
```

## Deploy

O `docker-compose.yml` já traz o serviço `landing` na porta 3003. O build
(tradução, sitemap, JSON-LD) roda dentro do `docker compose build`; não é
preciso Node no VPS.

```bash
docker compose build landing
docker compose up -d landing
```

### A mudança de domínio (uma vez só)

A landing assume a **raiz** (`aceblind.net`) e o sistema passa para
`app.aceblind.net`. São quatro coisas, e a ordem importa — o passo 3 é o que
quebra o convite por e-mail se for esquecido.

1. **Cloudflare Tunnel** — três rotas:

   | Hostname | Serviço |
   |---|---|
   | `aceblind.net` | `http://torneios-landing:80` |
   | `app.aceblind.net` | `http://torneios-frontend:3000` |
   | `api.aceblind.net` | `http://torneios-backend:8000` |

   Mantenha `aceblind.net` → frontend por alguns dias como redirect para
   `app.aceblind.net`, para quem tem o endereço salvo no navegador.

2. **`.env` do VPS**:
   ```
   FRONTEND_URL=https://app.aceblind.net
   LANDING_URL=https://aceblind.net
   REACT_APP_API_URL=https://api.aceblind.net   (não muda)
   ```
   `FRONTEND_URL` entra no CORS **e** é a origem que o backend usa para montar
   link. `LANDING_URL` entra só no CORS, para o formulário público passar.

3. **Supabase → Authentication → URL Configuration** ⚠️

   `Site URL` e `Redirect URLs` precisam apontar para `https://app.aceblind.net`.
   **Sem isso, o link de convite e o de recuperação de senha continuam levando
   para o endereço antigo** — e quem clicar cai na landing, não na tela de criar
   senha. É o passo que dá problema silencioso: o e-mail sai normalmente, e só o
   destinatário descobre que não funciona.

4. **Recrie só o backend** para ele reler o `.env`:
   ```bash
   docker compose up -d backend
   ```

   O frontend **não** precisa de rebuild: nenhuma das três `REACT_APP_*` que
   entram no bundle muda com a troca de domínio (a API continua em
   `api.aceblind.net`), e o `redirectTo` do "esqueci minha senha" usa
   `window.location.origin`, que se ajusta sozinho.

## O que ainda falta (não dá para eu resolver sozinho)

- **FAQ "a equipe precisa de treinamento?"** — a pergunta foi removida porque
  eu não tenho como saber se existe onboarding, se é incluso e quantas horas.
  Me diga e eu devolvo a pergunta com a resposta certa.
- **Gotham** — a página usa Montserrat como fallback. O bloco `@font-face` está
  pronto e comentado no topo do `index.html`; quando os arquivos chegarem, é
  colocá-los em `public/fonts/` e descomentar. **O pacote precisa incluir os
  itálicos**: a página usa itálico como marca em todos os títulos, e sem o
  arquivo real o navegador inclina a fonte na força bruta.
