"""Textos dos e-mails transacionais, nos três idiomas do produto.

Só strings, de propósito: quem quiser revisar uma frase abre este arquivo e
não precisa entender o layout nem o envio (`email_service.py`).

Cada tipo tem, por idioma: `assunto`, `titulo`, `paragrafos` (dois), `cta`
(rótulo do botão), `aviso` (caixa destacada) e `rodape` (o "se você não
esperava este e-mail"). Os marcadores `{nome}`, `{org}` e `{email}` são
preenchidos pelo `renderizar`; o link NÃO tem marcador — ele vai no botão e na
linha "copie e cole", que são do layout. O `**negrito**` vira <strong> no HTML
e some no texto puro.

Espanhol no tratamento formal ("usted"), como o convite de organização sempre
foi: é o primeiro contato de um clube com o produto.
"""

# Frases que todo e-mail tem, independentemente do tipo.
COMUNS = {
    "pt-BR": {
        "se_nao_funcionar": "Se o botão não funcionar, copie e cole este endereço no navegador:",
        "marca": "AceBlind · aceblind.net",
    },
    "en-US": {
        "se_nao_funcionar": "If the button doesn't work, copy and paste this address into your browser:",
        "marca": "AceBlind · aceblind.net",
    },
    "es-ES": {
        "se_nao_funcionar": "Si el botón no funciona, copie y pegue esta dirección en su navegador:",
        "marca": "AceBlind · aceblind.net",
    },
}

_AVISO_CONVITE = {
    "pt-BR": "Este link é **pessoal e de uso único**: depois que você criar sua senha, ele deixa de funcionar.",
    "en-US": "This link is **personal and single-use**: once you create your password, it stops working.",
    "es-ES": "Este enlace es **personal y de un solo uso**: después de crear su contraseña, deja de funcionar.",
}

_RODAPE_CONVITE = {
    "pt-BR": "Não esperava este convite? Pode ignorar este e-mail — sem a sua senha, ninguém acessa a conta.",
    "en-US": "Weren't expecting this invite? You can safely ignore this email — without your password, no one can access the account.",
    "es-ES": "¿No esperaba esta invitación? Puede ignorar este correo — sin su contraseña, nadie accede a la cuenta.",
}

TEXTOS = {
    # Dono do clube, convidado pelo admin da plataforma ao criar a organização.
    "convite_organizacao": {
        "pt-BR": {
            "assunto": "Seu acesso ao {org}",
            "titulo": "Olá, {nome}. Seu acesso está pronto.",
            "paragrafos": [
                "Você foi convidado para administrar o clube **{org}** no AceBlind.",
                "Para começar, crie sua senha. Leva menos de um minuto.",
            ],
            "cta": "Criar minha senha",
            "aviso": _AVISO_CONVITE["pt-BR"],
            "rodape": _RODAPE_CONVITE["pt-BR"],
        },
        "en-US": {
            "assunto": "Your access to {org}",
            "titulo": "Hi {nome}, your access is ready.",
            "paragrafos": [
                "You've been invited to manage **{org}** on AceBlind.",
                "To get started, create your password. It takes less than a minute.",
            ],
            "cta": "Create my password",
            "aviso": _AVISO_CONVITE["en-US"],
            "rodape": _RODAPE_CONVITE["en-US"],
        },
        "es-ES": {
            "assunto": "Su acceso a {org}",
            "titulo": "Hola, {nome}. Su acceso está listo.",
            "paragrafos": [
                "Fue invitado a administrar el club **{org}** en AceBlind.",
                "Para empezar, cree su contraseña. Toma menos de un minuto.",
            ],
            "cta": "Crear mi contraseña",
            "aviso": _AVISO_CONVITE["es-ES"],
            "rodape": _RODAPE_CONVITE["es-ES"],
        },
    },
    # Funcionário convidado pelo admin do clube (e o reenvio do mesmo convite).
    # Sem {nome}: quem informa o nome é a própria pessoa, ao aceitar.
    "convite_funcionario": {
        "pt-BR": {
            "assunto": "Você foi convidado para a equipe do {org}",
            "titulo": "Você foi convidado para o {org}.",
            "paragrafos": [
                "O administrador do clube **{org}** convidou você para a equipe no AceBlind.",
                "Para entrar, defina sua senha. Leva menos de um minuto.",
            ],
            "cta": "Definir minha senha",
            "aviso": _AVISO_CONVITE["pt-BR"],
            "rodape": _RODAPE_CONVITE["pt-BR"],
        },
        "en-US": {
            "assunto": "You've been invited to join {org}",
            "titulo": "You've been invited to {org}.",
            "paragrafos": [
                "The administrator of **{org}** has invited you to join the team on AceBlind.",
                "To get in, set your password. It takes less than a minute.",
            ],
            "cta": "Set my password",
            "aviso": _AVISO_CONVITE["en-US"],
            "rodape": _RODAPE_CONVITE["en-US"],
        },
        "es-ES": {
            "assunto": "Fue invitado al equipo de {org}",
            "titulo": "Fue invitado a {org}.",
            "paragrafos": [
                "El administrador del club **{org}** lo invitó a formar parte del equipo en AceBlind.",
                "Para entrar, defina su contraseña. Toma menos de un minuto.",
            ],
            "cta": "Definir mi contraseña",
            "aviso": _AVISO_CONVITE["es-ES"],
            "rodape": _RODAPE_CONVITE["es-ES"],
        },
    },
    # "Esqueci minha senha", pedido pela própria pessoa na tela de login.
    "redefinir_senha": {
        "pt-BR": {
            "assunto": "Redefina sua senha do AceBlind",
            "titulo": "Redefinir sua senha",
            "paragrafos": [
                "Recebemos um pedido para redefinir a senha de **{email}**.",
                "Clique no botão abaixo para escolher uma nova.",
            ],
            "cta": "Escolher nova senha",
            "aviso": "Este link é **de uso único e expira em pouco tempo**. Sua senha atual continua valendo até você escolher outra.",
            "rodape": "Não pediu para redefinir a senha? Pode ignorar este e-mail — sua senha não será alterada.",
        },
        "en-US": {
            "assunto": "Reset your AceBlind password",
            "titulo": "Reset your password",
            "paragrafos": [
                "We received a request to reset the password for **{email}**.",
                "Click the button below to choose a new one.",
            ],
            "cta": "Choose a new password",
            "aviso": "This link is **single-use and expires shortly**. Your current password stays active until you choose a new one.",
            "rodape": "Didn't request this? You can safely ignore this email — your password will not change.",
        },
        "es-ES": {
            "assunto": "Restablezca su contraseña de AceBlind",
            "titulo": "Restablecer su contraseña",
            "paragrafos": [
                "Recibimos una solicitud para restablecer la contraseña de **{email}**.",
                "Haga clic en el botón de abajo para elegir una nueva.",
            ],
            "cta": "Elegir nueva contraseña",
            "aviso": "Este enlace es **de un solo uso y caduca en poco tiempo**. Su contraseña actual sigue siendo válida hasta que elija otra.",
            "rodape": "¿No pidió restablecer la contraseña? Puede ignorar este correo — su contraseña no cambiará.",
        },
    },
    # Jogador recém-cadastrado: pedido de autorização para contatos futuros
    # (LGPD). O botão leva à página pública onde ele AUTORIZA ou RECUSA — o
    # e-mail em si não decide nada, e ignorá-lo equivale a não autorizar.
    "consentimento_contato": {
        "pt-BR": {
            "assunto": "{org}: podemos falar com você?",
            "titulo": "Olá, {nome}. Seu cadastro no {org} está feito.",
            "paragrafos": [
                "O clube **{org}** gostaria de enviar a você novidades, programação de torneios, promoções e avisos por e-mail, WhatsApp ou telefone.",
                "Para isso, precisamos da sua **autorização**. Responda pelo botão abaixo — você pode autorizar ou recusar.",
            ],
            "cta": "Responder ao pedido",
            "aviso": "Sem a sua resposta, **nenhum contato promocional** será feito. Você pode mudar de ideia quando quiser, pedindo ao clube.",
            "rodape": "Não se cadastrou neste clube? Pode ignorar este e-mail — sem resposta, nada é autorizado.",
        },
        "en-US": {
            "assunto": "{org}: may we contact you?",
            "titulo": "Hi {nome}, your registration at {org} is complete.",
            "paragrafos": [
                "**{org}** would like to send you news, tournament schedules, promotions and notices by email, WhatsApp or phone.",
                "For that, we need your **permission**. Reply using the button below — you can allow or decline.",
            ],
            "cta": "Reply to the request",
            "aviso": "Without your answer, **no promotional contact** will be made. You can change your mind at any time by asking the club.",
            "rodape": "Didn't register at this club? You can ignore this email — without a reply, nothing is authorized.",
        },
        "es-ES": {
            "assunto": "{org}: ¿podemos contactarlo?",
            "titulo": "Hola, {nome}. Su registro en {org} está listo.",
            "paragrafos": [
                "El club **{org}** quisiera enviarle novedades, programación de torneos, promociones y avisos por correo, WhatsApp o teléfono.",
                "Para ello, necesitamos su **autorización**. Responda con el botón de abajo — puede autorizar o rechazar.",
            ],
            "cta": "Responder a la solicitud",
            "aviso": "Sin su respuesta, **no se hará ningún contacto promocional**. Puede cambiar de opinión cuando quiera, solicitándolo al club.",
            "rodape": "¿No se registró en este club? Puede ignorar este correo — sin respuesta, nada queda autorizado.",
        },
    },
}
