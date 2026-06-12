from fastapi import APIRouter, HTTPException, Depends
from typing import List, Optional
from app.models.sponsor import SponsorCreate, SponsorUpdate, Sponsor
from app.services.sponsor_service import SponsorService
from app.auth.jwt import get_current_user

router = APIRouter(prefix="/sponsors", tags=["sponsors"])


@router.post("", response_model=Sponsor)
def create_sponsor(data: SponsorCreate, user=Depends(get_current_user)):
    return SponsorService.create_sponsor(data)


@router.get("", response_model=List[Sponsor])
def get_sponsors(
    search: Optional[str] = None,
    status: Optional[str] = None,
    user=Depends(get_current_user),
):
    return SponsorService.get_sponsors(search=search, status=status)


@router.get("/{sponsor_id}", response_model=Sponsor)
def get_sponsor(sponsor_id: str, user=Depends(get_current_user)):
    sponsor = SponsorService.get_sponsor(sponsor_id)
    if not sponsor:
        raise HTTPException(status_code=404, detail="Patrocinador não encontrado")
    return sponsor


@router.patch("/{sponsor_id}", response_model=Sponsor)
def update_sponsor(sponsor_id: str, data: SponsorUpdate, user=Depends(get_current_user)):
    sponsor = SponsorService.update_sponsor(sponsor_id, data)
    if not sponsor:
        raise HTTPException(status_code=404, detail="Patrocinador não encontrado")
    return sponsor


@router.delete("/{sponsor_id}")
def delete_sponsor(sponsor_id: str, user=Depends(get_current_user)):
    if not SponsorService.delete_sponsor(sponsor_id):
        raise HTTPException(status_code=404, detail="Patrocinador não encontrado")
    return {"message": "Patrocinador removido"}
