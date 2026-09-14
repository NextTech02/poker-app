"""Códigos de recuperação do segundo fator.

O que estes testes travam, e por quê:

1. **Gerar códigos exige `aal2`.** É a trava que decide se o 2FA protege algo:
   sem ela, quem roubou só a senha gera um código e desliga o segundo fator.
2. **O texto puro nunca vai para o banco.** Só o hash.
3. **Um código serve uma vez.**
4. **Gerar de novo mata os antigos** — senão um papel velho continua abrindo a
   conta.
5. **Usar um código REMOVE o fator.** Ele não promove a sessão: só o
   `mfa.verify` do Supabase faz isso, e ele exige o aparelho que a pessoa
   perdeu.
"""
import pytest
from fastapi import HTTPException

from app.services import mfa_service
from app.services.mfa_service import MfaService, _hash

from tests.conftest import FakeSupabase

USUARIO = "11111111-1111-1111-1111-111111111111"


@pytest.fixture
def banco(monkeypatch):
    fake = FakeSupabase({"mfa_recovery_codes": []})
    monkeypatch.setattr(mfa_service, "supabase_admin", fake)
    return fake


def _com_fator(monkeypatch, fatores=(("f1", "Celular"),)):
    monkeypatch.setattr(
        MfaService, "_fatores_verificados",
        staticmethod(lambda uid: [{"id": i, "friendly_name": n,
                                   "factor_type": "totp", "status": "verified"}
                                  for i, n in fatores]),
    )


def _sem_fator(monkeypatch):
    monkeypatch.setattr(MfaService, "_fatores_verificados", staticmethod(lambda uid: []))


class TestGerarCodigos:

    def test_so_com_senha_e_recusado(self, banco, monkeypatch):
        """A TRAVA QUE SUSTENTA O 2FA INTEIRO.

        Um código de recuperação REMOVE o segundo fator. Se alguém com apenas a
        senha pudesse gerar um, ele desligaria o 2FA sozinho — e o segundo fator
        não protegeria absolutamente nada.
        """
        _com_fator(monkeypatch)
        with pytest.raises(HTTPException) as e:
            MfaService.gerar_codigos(USUARIO, aal="aal1")
        assert e.value.status_code == 403
        assert e.value.detail["code"] == "segundo_fator_necessario"
        assert banco.store["mfa_recovery_codes"] == []

    def test_sem_token_nenhum_tambem_e_recusado(self, banco, monkeypatch):
        _com_fator(monkeypatch)
        with pytest.raises(HTTPException):
            MfaService.gerar_codigos(USUARIO, aal=None)

    def test_quem_nao_tem_2fa_nao_gera_codigo(self, banco, monkeypatch):
        """Código de recuperação sem fator para recuperar é só uma chave a mais
        para perder."""
        _sem_fator(monkeypatch)
        with pytest.raises(HTTPException) as e:
            MfaService.gerar_codigos(USUARIO, aal="aal2")
        assert e.value.detail["code"] == "sem_segundo_fator"

    def test_gera_oito_codigos(self, banco, monkeypatch):
        _com_fator(monkeypatch)
        codigos = MfaService.gerar_codigos(USUARIO, aal="aal2")
        assert len(codigos) == 8
        assert len(set(codigos)) == 8          # nenhum repetido
        assert len(banco.store["mfa_recovery_codes"]) == 8

    def test_o_banco_NUNCA_ve_o_codigo_em_texto(self, banco, monkeypatch):
        """O texto puro existe uma vez, na resposta. Guardá-lo tornaria um
        vazamento do banco equivalente a ter o celular de todo mundo."""
        _com_fator(monkeypatch)
        codigos = MfaService.gerar_codigos(USUARIO, aal="aal2")
        guardado = str(banco.store["mfa_recovery_codes"])
        for c in codigos:
            assert c not in guardado
            assert _hash(c) in guardado

    def test_gerar_de_novo_mata_os_antigos(self, banco, monkeypatch):
        """Um papel velho não pode continuar abrindo a conta."""
        _com_fator(monkeypatch)
        antigos = MfaService.gerar_codigos(USUARIO, aal="aal2")
        MfaService.gerar_codigos(USUARIO, aal="aal2")

        assert len(banco.store["mfa_recovery_codes"]) == 8
        hashes = {l["code_hash"] for l in banco.store["mfa_recovery_codes"]}
        assert all(_hash(c) not in hashes for c in antigos)

    def test_codigo_e_legivel_de_um_papel(self, banco, monkeypatch):
        """Sem 0/O/1/I/L: estes códigos são lidos à mão, por quem está com
        pressa, e confundir zero com O gastaria uma das poucas tentativas."""
        _com_fator(monkeypatch)
        for c in MfaService.gerar_codigos(USUARIO, aal="aal2"):
            assert "-" in c
            assert not set(c.replace("-", "")) & set("01OIL")


class TestUsarCodigo:

    def _preparar(self, banco, monkeypatch):
        _com_fator(monkeypatch)
        return MfaService.gerar_codigos(USUARIO, aal="aal2")

    def test_codigo_valido_remove_o_segundo_fator(self, banco, monkeypatch):
        """É o que o código FAZ. Ele não promove a sessão para aal2 — só o
        `mfa.verify` do Supabase faz isso, e exige o aparelho perdido."""
        codigos = self._preparar(banco, monkeypatch)
        removidos = []
        monkeypatch.setattr(MfaService, "_remover_fatores",
                            staticmethod(lambda uid: removidos.append(uid) or 1))

        r = MfaService.recuperar(USUARIO, codigos[0], ip="1.2.3.4")
        assert r["removed_factors"] == 1
        assert removidos == [USUARIO]

    def test_o_mesmo_codigo_nao_serve_duas_vezes(self, banco, monkeypatch):
        codigos = self._preparar(banco, monkeypatch)
        monkeypatch.setattr(MfaService, "_remover_fatores", staticmethod(lambda uid: 1))

        MfaService.recuperar(USUARIO, codigos[0])
        with pytest.raises(HTTPException) as e:
            MfaService.recuperar(USUARIO, codigos[0])
        assert e.value.detail["code"] == "codigo_de_recuperacao_invalido"

    def test_codigo_errado_e_recusado(self, banco, monkeypatch):
        self._preparar(banco, monkeypatch)
        with pytest.raises(HTTPException) as e:
            MfaService.recuperar(USUARIO, "ZZZZZ-ZZZZZ")
        assert e.value.detail["code"] == "codigo_de_recuperacao_invalido"

    def test_maiusculas_minusculas_e_hifen_nao_importam(self, banco, monkeypatch):
        """Quem digita de um papel não vai reproduzir a formatação. Recusar por
        isso seria trancar a pessoa fora com o código certo na mão."""
        codigos = self._preparar(banco, monkeypatch)
        monkeypatch.setattr(MfaService, "_remover_fatores", staticmethod(lambda uid: 1))

        bagunçado = codigos[0].lower().replace("-", " ").strip().replace(" ", "")
        assert MfaService.recuperar(USUARIO, bagunçado)["removed_factors"] == 1

    def test_conta_sem_codigos_diz_o_que_fazer(self, banco, monkeypatch):
        """Beco sem saída é o pior resultado possível aqui — a mensagem precisa
        apontar a porta."""
        _com_fator(monkeypatch)
        with pytest.raises(HTTPException) as e:
            MfaService.recuperar(USUARIO, "ABCDE-FGHIJ")
        assert e.value.detail["code"] == "sem_codigos_de_recuperacao"
        assert "administrador" in e.value.detail["message"]

    def test_o_uso_fica_registrado_com_ip(self, banco, monkeypatch):
        """Desligar o 2FA de uma conta é o tipo de evento que se audita depois."""
        codigos = self._preparar(banco, monkeypatch)
        monkeypatch.setattr(MfaService, "_remover_fatores", staticmethod(lambda uid: 1))
        MfaService.recuperar(USUARIO, codigos[0], ip="203.0.113.9")

        usada = [l for l in banco.store["mfa_recovery_codes"] if l.get("used_at")]
        assert len(usada) == 1
        assert usada[0]["used_ip"] == "203.0.113.9"

    def test_falha_ao_remover_nao_devolve_o_codigo(self, banco, monkeypatch):
        """O código é marcado ANTES da remoção, de propósito.

        O contrário — remover o fator e não conseguir marcar — deixaria um
        código válido depois de já ter sido usado. Gastar um código à toa custa
        um dos oito; um código que vale duas vezes custa a conta.
        """
        codigos = self._preparar(banco, monkeypatch)

        def _falha(uid):
            raise HTTPException(status_code=503, detail={"code": "x", "message": "y"})
        monkeypatch.setattr(MfaService, "_remover_fatores", staticmethod(_falha))

        with pytest.raises(HTTPException):
            MfaService.recuperar(USUARIO, codigos[0])

        usada = [l for l in banco.store["mfa_recovery_codes"] if l.get("used_at")]
        assert len(usada) == 1
