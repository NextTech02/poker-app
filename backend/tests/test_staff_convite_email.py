"""O e-mail de convite do funcionário, agora redigido pelo app.

Antes o backend chamava `/auth/v1/invite` e o Supabase mandava o template
global do painel — em inglês, para todo mundo, e ANTES de a linha em `staff`
existir. O que estes testes travam:

1. O link vem de `admin/generate_link` (que NÃO envia) e o e-mail sai pelo
   Resend, no idioma da tela do admin.
2. O e-mail é o único passo irreversível, então vem por ÚLTIMO: se o insert
   falhar, nenhum convite chega à caixa de ninguém.
3. E-mail que não sai não derruba o cadastro: o vínculo existe e a resposta
   diz `invite_sent=False` para a tela avisar e o admin reenviar.
4. O reenvio gera link de RECUPERAÇÃO (a conta já existe) mas manda o e-mail
   de CONVITE — antes ia um "Reset password" que ninguém entendia.
"""
import pytest

from app.models.staff import StaffCreate
from app.services import staff_service
from app.services.staff_service import StaffService
from tests import test_staff as ts

ORG, AUTH, STAFF = ts.ORG, ts.AUTH, ts.STAFF
LINK = "https://xyz.supabase.co/auth/v1/verify?token=abc&type=invite&redirect_to=x"


class _Resp:
    def __init__(self, status, corpo=None, text=""):
        self.status_code = status
        self._corpo = corpo or {}
        self.text = text

    def json(self):
        return self._corpo


@pytest.fixture
def com_resend(monkeypatch):
    """Sem chave o envio nem é tentado — e metade dos testes ficaria cega."""
    monkeypatch.setattr(staff_service.settings, "resend_api_key", "re_teste", raising=False)
    monkeypatch.setattr(staff_service.settings, "leads_email_from", "AceBlind <n@x.com>", raising=False)


def _finge_auth_e_email(monkeypatch, *, status_link=200, corpo_link=None, status_email=200,
                        contas=None, ao_enviar=None):
    """Um `httpx.post` que distingue gerar-o-link de enviar-o-e-mail, e um
    `httpx.get` com a lista de contas (para o caminho 'já existe')."""
    import httpx

    chamadas = []

    def _post(url, **kw):
        chamadas.append((url, kw))
        if "resend.com" in url:
            if ao_enviar:
                ao_enviar()
            return _Resp(status_email, {"id": "email-1"})
        corpo = corpo_link if corpo_link is not None else {"id": "conta-nova", "action_link": LINK}
        return _Resp(status_link, corpo)

    def _get(url, **kw):
        return _Resp(200, {"users": contas or []})

    monkeypatch.setattr(httpx, "post", _post)
    monkeypatch.setattr(httpx, "get", _get)
    return chamadas


def _convida(idioma="pt-BR", email="novo@clube.com"):
    return StaffService.create_staff(
        StaffCreate(email=email), created_by=AUTH, organization_id=ORG, idioma=idioma
    )


def _links(chamadas):
    return [kw for url, kw in chamadas if "generate_link" in url]


def _emails(chamadas):
    return [kw for url, kw in chamadas if "resend.com" in url]


class TestConvitePorEmail:
    def test_usa_generate_link_e_nao_o_invite_do_supabase(self, monkeypatch, com_resend):
        """`/invite` faria o Supabase enviar o template global (inglês) na
        hora; `generate_link` só devolve o link, e quem redige é o app."""
        chamadas = _finge_auth_e_email(monkeypatch)
        ts._monta(monkeypatch)
        _convida()
        assert not any("/auth/v1/invite" in url for url, _ in chamadas)
        (link,) = _links(chamadas)
        assert link["json"]["type"] == "invite"
        assert link["json"]["email"] == "novo@clube.com"
        assert link["json"]["data"] == {"organization_name": "NextHub"}
        assert link["json"]["redirect_to"].endswith("/definir-senha")

    def test_email_sai_no_idioma_da_tela_do_admin(self, monkeypatch, com_resend):
        chamadas = _finge_auth_e_email(monkeypatch)
        ts._monta(monkeypatch)
        r = _convida(idioma="es-ES")
        (email,) = _emails(chamadas)
        assert email["json"]["to"] == ["novo@clube.com"]
        assert email["json"]["subject"] == "Fue invitado al equipo de NextHub"
        assert LINK.replace("&", "&amp;") in email["json"]["html"]
        assert LINK in email["json"]["text"]
        assert r.invite_sent is True
        assert r.invite_error is None

    def test_sem_idioma_vai_em_portugues(self, monkeypatch, com_resend):
        chamadas = _finge_auth_e_email(monkeypatch)
        ts._monta(monkeypatch)
        StaffService.create_staff(StaffCreate(email="novo@clube.com"), created_by=AUTH, organization_id=ORG)
        assert _emails(chamadas)[0]["json"]["subject"] == "Você foi convidado para a equipe do NextHub"

    def test_o_email_so_sai_DEPOIS_de_a_linha_existir(self, monkeypatch, com_resend):
        """O e-mail é o único passo irreversível, então é o último."""
        fake = ts._monta(monkeypatch)
        visto = {}

        def _ao_enviar():
            visto["linhas_no_envio"] = len(fake.store["staff"])

        _finge_auth_e_email(monkeypatch, ao_enviar=_ao_enviar)
        _convida()
        assert visto["linhas_no_envio"] == 1

    def test_insert_falho_nao_manda_email_e_desfaz_a_conta(self, monkeypatch, com_resend):
        """Antes o Supabase já tinha enviado o convite quando o insert
        falhava: a pessoa recebia um link para uma conta que o rollback
        apagava em seguida."""
        import httpx

        chamadas = _finge_auth_e_email(monkeypatch)
        apagados = []
        monkeypatch.setattr(httpx, "delete", lambda url, **k: apagados.append(url) or _Resp(200))
        fake = ts._monta(monkeypatch)

        class _TabelaQueRecusa:
            def __init__(self, original):
                self._original = original

            def __call__(self, nome):
                q = self._original(nome)
                if nome == "staff":
                    def _insert(payload):
                        raise Exception("connection reset")
                    q.insert = _insert
                return q

        fake.table = _TabelaQueRecusa(fake.table)
        with pytest.raises(ValueError):
            _convida()
        assert _emails(chamadas) == []
        assert any("conta-nova" in u for u in apagados)

    def test_resposta_sem_link_cria_o_vinculo_e_avisa(self, monkeypatch, com_resend):
        """Payload inesperado do auth: o vínculo vale, mas não há o que mandar."""
        chamadas = _finge_auth_e_email(monkeypatch, corpo_link={"id": "conta-nova"})
        fake = ts._monta(monkeypatch)
        r = _convida()
        assert fake.store["staff"][0]["invite_status"] == "awaiting_signup"
        assert r.invite_sent is False
        assert r.invite_error == "sem_link"
        assert _emails(chamadas) == []

    def test_recusa_do_resend_nao_derruba_o_cadastro(self, monkeypatch, com_resend):
        _finge_auth_e_email(monkeypatch, status_email=500)
        fake = ts._monta(monkeypatch)
        r = _convida()
        assert len(fake.store["staff"]) == 1
        assert r.invite_sent is False
        assert r.invite_error == "recusado"

    def test_sem_chave_do_resend_o_cadastro_vale_e_o_motivo_volta(self, monkeypatch):
        monkeypatch.setattr(staff_service.settings, "resend_api_key", "", raising=False)
        chamadas = _finge_auth_e_email(monkeypatch)
        ts._monta(monkeypatch)
        r = _convida()
        assert r.invite_sent is False
        assert r.invite_error == "sem_chave"
        assert _emails(chamadas) == []

    def test_conta_que_ja_existe_nao_recebe_email(self, monkeypatch, com_resend):
        """Quem já tem conta entra com a própria senha (ou responde ao convite
        dentro do sistema). Nenhum e-mail era esperado: `invite_sent` é None,
        não False — a tela não deve avisar de falha."""
        chamadas = _finge_auth_e_email(
            monkeypatch, status_link=422, corpo_link={"msg": "já existe"},
            contas=[{"id": AUTH, "email": "orfa@nexthub.com"}],
        )
        ts._monta(monkeypatch)
        r = _convida(email="orfa@nexthub.com")
        assert r.invite_status == "accepted"
        assert r.invite_sent is None
        assert _emails(chamadas) == []


class TestReenvioPorEmail:
    def _com_pendente(self, monkeypatch, status="awaiting_signup"):
        return ts._monta(monkeypatch, {"staff": [ts._funcionario(status=status, ativo=status != "pending")]})

    def test_gera_link_de_recuperacao_e_manda_o_email_de_convite(self, monkeypatch, com_resend):
        chamadas = _finge_auth_e_email(
            monkeypatch, corpo_link={"id": AUTH, "action_link": LINK.replace("invite", "recovery")}
        )
        self._com_pendente(monkeypatch)
        r = StaffService.resend_invite(STAFF, ORG, idioma="en-US")
        assert r == {"sent": True, "email": "fulano@clube.com"}
        (link,) = _links(chamadas)
        assert link["json"]["type"] == "recovery"
        assert not any("/auth/v1/recover" in url for url, _ in chamadas)
        (email,) = _emails(chamadas)
        assert email["json"]["subject"] == "You've been invited to join NextHub"
        assert "type=recovery" in email["json"]["text"]

    def test_quem_e_de_outro_clube_tambem_recebe(self, monkeypatch, com_resend):
        chamadas = _finge_auth_e_email(monkeypatch, corpo_link={"id": AUTH, "action_link": LINK})
        self._com_pendente(monkeypatch, status="pending")
        StaffService.resend_invite(STAFF, ORG)
        assert len(_emails(chamadas)) == 1

    def test_conta_que_sumiu_tem_codigo_proprio(self, monkeypatch, com_resend):
        from app.utils.erros import ErroDeNegocio

        _finge_auth_e_email(monkeypatch, status_link=404, corpo_link={"msg": "User not found"})
        self._com_pendente(monkeypatch)
        with pytest.raises(ErroDeNegocio) as exc:
            StaffService.resend_invite(STAFF, ORG)
        assert exc.value.code == "conta_do_convidado_nao_encontrada"
        assert exc.value.status == 409

    def test_limite_do_auth_tem_codigo_proprio(self, monkeypatch, com_resend):
        from app.utils.erros import ErroDeNegocio

        _finge_auth_e_email(monkeypatch, status_link=429, corpo_link={})
        self._com_pendente(monkeypatch)
        with pytest.raises(ErroDeNegocio) as exc:
            StaffService.resend_invite(STAFF, ORG)
        assert exc.value.code == "limite_de_envio_de_email"

    def test_falha_do_resend_vira_erro_com_motivo(self, monkeypatch, com_resend):
        from app.utils.erros import ErroDeNegocio

        _finge_auth_e_email(monkeypatch, corpo_link={"id": AUTH, "action_link": LINK}, status_email=500)
        self._com_pendente(monkeypatch)
        with pytest.raises(ErroDeNegocio) as exc:
            StaffService.resend_invite(STAFF, ORG)
        assert exc.value.code == "falha_ao_reenviar_convite"
        assert exc.value.dados == {"motivo": "recusado"}

    def test_servico_de_auth_fora_do_ar(self, monkeypatch, com_resend):
        import httpx
        from app.utils.erros import ErroDeNegocio

        def _cai(url, **k):
            raise RuntimeError("connect timeout to https://xyz.supabase.co")

        monkeypatch.setattr(httpx, "post", _cai)
        self._com_pendente(monkeypatch)
        with pytest.raises(ErroDeNegocio) as exc:
            StaffService.resend_invite(STAFF, ORG)
        assert exc.value.code == "servico_de_email_indisponivel"
        assert "xyz.supabase.co" not in exc.value.message
