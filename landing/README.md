# Landing page — aceblind.net

Página única, HTML estático, em três idiomas — cada um com a sua URL:
`aceblind.net/` (português), `/es/` e `/en/`. Baseada no protótipo do
marketing (`aceblind-landing.html`), com os números conferidos contra o banco e
os textos que não podiam ir ao ar como estavam.

```
landing/
├── index.html      a página (HTML + CSS + JS), em português — a fonte do markup
├── i18n.js         as traduções para inglês e espanhol, e título/descrição de cada idioma
├── build.mjs       gera dist/: uma página por idioma, sitemap e dados estruturados
├── nginx.conf      como é servida (+ seguranca.conf, os cabeçalhos)
├── Dockerfile      build em Node, serve com nginx:alpine (~10 MB)
└── public/         robots.txt, 404.html — e og.png, quando existir
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

- `sitemap.xml` com as três URLs ligadas por `hreflang`;
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

## Editar o texto

`index.html` (português) e `i18n.js` (inglês e espanhol). Título e descrição
de cada idioma, para o Google e para o link compartilhado, ficam em
`ACEBLIND_META`, no fim de `i18n.js`.

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

- **`public/og.png`** — imagem 1200×630 para o link no WhatsApp/Instagram. A
  meta tag já aponta para ela; sem o arquivo, o link aparece sem imagem.
- **FAQ "a equipe precisa de treinamento?"** — a pergunta foi removida porque
  eu não tenho como saber se existe onboarding, se é incluso e quantas horas.
  Me diga e eu devolvo a pergunta com a resposta certa.
- **Gotham** — a página usa Montserrat como fallback. O bloco `@font-face` está
  pronto e comentado no topo do `index.html`; quando os arquivos chegarem, é
  colocá-los em `public/fonts/` e descomentar. **O pacote precisa incluir os
  itálicos**: a página usa itálico como marca em todos os títulos, e sem o
  arquivo real o navegador inclina a fonte na força bruta.
