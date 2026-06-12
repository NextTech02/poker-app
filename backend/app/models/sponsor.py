from pydantic import BaseModel, Field
from typing import Optional
from datetime import datetime


class SponsorBase(BaseModel):
    name: str = Field(..., min_length=1, max_length=255)
    email: Optional[str] = Field(None, max_length=255)
    phone: Optional[str] = Field(None, max_length=50)
    contact_person: Optional[str] = Field(None, max_length=255)
    notes: Optional[str] = None


class SponsorCreate(SponsorBase):
    pass


class SponsorUpdate(BaseModel):
    name: Optional[str] = Field(None, min_length=1, max_length=255)
    email: Optional[str] = Field(None, max_length=255)
    phone: Optional[str] = Field(None, max_length=50)
    contact_person: Optional[str] = Field(None, max_length=255)
    notes: Optional[str] = None
    status: Optional[str] = None


class Sponsor(SponsorBase):
    id: str
    status: str = "active"
    created_at: datetime
    updated_at: Optional[datetime] = None

    class Config:
        from_attributes = True
