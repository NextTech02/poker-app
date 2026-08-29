from fastapi import APIRouter, Depends
from typing import List
from app.models.staff import (
    PermissionGroupCreate,
    PermissionGroupUpdate,
    PermissionGroupResponse,
    StaffCreate,
    StaffUpdate,
    StaffResponse,
    MyPermissions,
)
from app.services.staff_service import StaffService
from app.auth.jwt import get_current_user
from app.auth.permissions import require_permission
from app.utils.erros import da_excecao, nao_encontrado

router = APIRouter(prefix="/staff", tags=["staff"])

# Managing staff and permission groups is itself a privileged action: without
# this gate any authenticated user could create a group with all permissions and
# attach themselves to it, self-escalating to super-admin. Mutations require the
# 'employees' permission (super-admins bypass via require_permission).
_manage_staff = Depends(require_permission("employees"))


# ── My Permissions ──

@router.get("/me/permissions", response_model=MyPermissions)
def get_my_permissions(user=Depends(get_current_user)):
    perms = StaffService.get_my_permissions(user.get("sub"))
    # O claim vem assinado pelo servidor de auth — não dá para o cliente forjar.
    perms.is_platform_admin = user.get("platform_admin") is True
    return perms


# ── Permission Groups ──

@router.post("/groups", response_model=PermissionGroupResponse)
def create_group(data: PermissionGroupCreate, user=_manage_staff):
    try:
        return StaffService.create_group(data)
    except Exception as e:
        raise da_excecao(e, "falha_ao_criar_grupo")


@router.get("/groups", response_model=List[PermissionGroupResponse])
def get_groups(user=Depends(get_current_user)):
    return StaffService.get_groups()


@router.get("/groups/{group_id}", response_model=PermissionGroupResponse)
def get_group(group_id: str, user=Depends(get_current_user)):
    group = StaffService.get_group(group_id)
    if not group:
        raise nao_encontrado("grupo_nao_encontrado", "Grupo não encontrado")
    return group


@router.patch("/groups/{group_id}", response_model=PermissionGroupResponse)
def update_group(group_id: str, data: PermissionGroupUpdate, user=_manage_staff):
    try:
        result = StaffService.update_group(group_id, data)
        if not result:
            raise nao_encontrado("grupo_nao_encontrado", "Grupo não encontrado")
        return result
    except ValueError as e:
        raise da_excecao(e)


@router.delete("/groups/{group_id}")
def delete_group(group_id: str, user=_manage_staff):
    if not StaffService.delete_group(group_id):
        raise nao_encontrado("grupo_nao_encontrado", "Grupo não encontrado")
    return {"message": "Grupo removido"}


# ── Staff ──

@router.post("", response_model=StaffResponse)
def create_staff(data: StaffCreate, user=_manage_staff):
    """Convida o funcionário por e-mail — ele define o próprio nome e senha."""
    try:
        return StaffService.create_staff(
            data, user.get("sub"), user.get("organization_id")
        )
    except ValueError as e:
        raise da_excecao(e)


@router.delete("/{staff_id}/remove")
def remove_staff(staff_id: str, user=_manage_staff):
    """Exclui o funcionário do clube (e a conta, se ele não estiver em outro).

    Rota separada do DELETE /{staff_id}, que apenas desativa: são intenções
    diferentes e o desfazer de uma não serve para a outra.
    """
    try:
        return StaffService.remove_from_org(staff_id, user.get("organization_id"))
    except ValueError as e:
        raise da_excecao(e)


@router.delete("/{staff_id}/invite")
def cancel_invite(staff_id: str, user=_manage_staff):
    """Cancela o convite: o vínculo some e o e-mail volta a poder ser convidado.

    Rota própria porque a tela chamava o DELETE /{staff_id}, que apenas
    DESATIVA. Um convite já nasce inativo, então aquele clique não mudava nada
    visível e a pessoa ficava presa em "convite pendente" para sempre.
    """
    try:
        return StaffService.cancel_invite(staff_id, user.get("organization_id"))
    except ValueError as e:
        raise da_excecao(e)


@router.post(
    "/{staff_id}/confirm-invite",
    response_model=StaffResponse,
    responses={
        409: {
            "description": (
                "Convite não pôde ser efetivado. Acontece quando: a pessoa já é "
                "membro aceito deste clube (`ja_e_membro_do_clube`); o convite "
                "ainda está em 'awaiting_signup' — ela não definiu a senha e o "
                "caminho é reenviar (`convite_aguardando_cadastro`); ou o plano "
                "atual não permite mais usuários ativos "
                "(`limite_de_usuarios_do_plano`). O código vem em `detail.code`."
            )
        },
        404: {
            "description": (
                "O vínculo foi efetivado, mas a releitura do funcionário não "
                "encontrou o registro (ele deixou de existir nesse intervalo)."
            )
        },
    },
)
def confirm_invite(staff_id: str, user=_manage_staff):
    """Efetiva o convite pendente sem esperar a pessoa responder.

    Um convite para quem JÁ tem conta só virava 'accepted' se a própria pessoa
    entrasse no sistema e clicasse. Quem nunca entrava ficava presa, e o admin
    não tinha saída pela tela. Quem efetiva é o admin do clube, que já cadastra
    funcionário do zero — não há poder novo aqui.
    """
    try:
        result = StaffService.confirm_invite(staff_id, user.get("organization_id"))
    except ValueError as e:
        raise da_excecao(e)
    if not result:
        raise nao_encontrado("funcionario_nao_encontrado", "Funcionário não encontrado")
    return result


@router.post("/{staff_id}/resend-invite")
def resend_invite(staff_id: str, user=_manage_staff):
    """Manda outro link para quem ainda não concluiu o cadastro.

    Os links do e-mail expiram; sem reenvio, quem demorou para clicar ficava
    travado e só o suporte resolvia.
    """
    try:
        return StaffService.resend_invite(staff_id, user.get("organization_id"))
    except ValueError as e:
        raise da_excecao(e)


@router.get("", response_model=List[StaffResponse])
def get_staff_list(user=Depends(get_current_user)):
    return StaffService.get_staff_list()


@router.get("/{staff_id}", response_model=StaffResponse)
def get_staff(staff_id: str, user=Depends(get_current_user)):
    staff = StaffService.get_staff(staff_id)
    if not staff:
        raise nao_encontrado("funcionario_nao_encontrado", "Funcionário não encontrado")
    return staff


@router.patch("/{staff_id}", response_model=StaffResponse)
def update_staff(staff_id: str, data: StaffUpdate, user=_manage_staff):
    try:
        result = StaffService.update_staff(staff_id, data)
        if not result:
            raise nao_encontrado("funcionario_nao_encontrado", "Funcionário não encontrado")
        return result
    except ValueError as e:
        raise da_excecao(e)


@router.delete(
    "/{staff_id}",
    responses={
        409: {
            "description": (
                "Desativação recusada porque o funcionário está com caixa "
                "aberto (`funcionario_com_caixa_aberto`) — `detail.saldo` traz o "
                "saldo atual; é preciso fechar o caixa antes. Também cobre a "
                "falha ao cancelar um convite ainda pendente (a rota cancela em "
                "vez de desativar nesse caso)."
            )
        },
        404: {
            "description": (
                "Nenhum funcionário com esse id foi desativado — o registro não "
                "existe (ou já não está mais acessível)."
            )
        },
    },
)
def delete_staff(staff_id: str, user=_manage_staff):
    try:
        ok = StaffService.delete_staff(staff_id)
    except ValueError as e:
        raise da_excecao(e)
    if not ok:
        raise nao_encontrado("funcionario_nao_encontrado", "Funcionário não encontrado")
    return {"message": "Funcionário desativado"}
