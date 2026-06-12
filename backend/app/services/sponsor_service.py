from typing import List, Optional
from app.database import supabase
from app.models.sponsor import SponsorCreate, SponsorUpdate, Sponsor


class SponsorService:
    @staticmethod
    def create_sponsor(data: SponsorCreate) -> Sponsor:
        response = supabase.table("sponsors").insert(data.model_dump()).execute()
        return Sponsor(**response.data[0])

    @staticmethod
    def get_sponsors(search: Optional[str] = None, status: Optional[str] = None) -> List[Sponsor]:
        query = supabase.table("sponsors").select("*")
        if status:
            query = query.eq("status", status)
        query = query.order("name")
        response = query.execute()

        results = response.data or []
        if search:
            search_lower = search.lower()
            results = [s for s in results if search_lower in s["name"].lower()]

        return [Sponsor(**item) for item in results]

    @staticmethod
    def get_sponsor(sponsor_id: str) -> Optional[Sponsor]:
        response = supabase.table("sponsors").select("*").eq("id", sponsor_id).execute()
        if response.data:
            return Sponsor(**response.data[0])
        return None

    @staticmethod
    def update_sponsor(sponsor_id: str, data: SponsorUpdate) -> Optional[Sponsor]:
        update_data = data.model_dump(exclude_unset=True)
        response = supabase.table("sponsors").update(update_data).eq("id", sponsor_id).execute()
        if response.data:
            return Sponsor(**response.data[0])
        return None

    @staticmethod
    def delete_sponsor(sponsor_id: str) -> bool:
        response = supabase.table("sponsors").delete().eq("id", sponsor_id).execute()
        return len(response.data) > 0
