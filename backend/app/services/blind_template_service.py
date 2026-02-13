from typing import List, Optional
from uuid import UUID
from datetime import datetime
from app.database import supabase
from app.models.blind_template import (
    BlindTemplateCreate,
    BlindTemplateUpdate,
    BlindTemplateResponse,
    BlindLevel
)


class BlindTemplateService:
    @staticmethod
    def create_template(template_data: BlindTemplateCreate, user_id: Optional[str] = None) -> BlindTemplateResponse:
        """Create a new blind template"""
        data = template_data.model_dump()

        # Convert custom_levels to list of dicts if present
        if data.get('custom_levels'):
            data['custom_levels'] = [level.model_dump() if hasattr(level, 'model_dump') else level for level in data['custom_levels']]

        # Convert UUID to string
        if data.get('stage_id'):
            data['stage_id'] = str(data['stage_id'])

        # Add created_by if user is authenticated
        if user_id:
            data['created_by'] = user_id

        response = supabase.table("blind_templates").insert(data).execute()
        return BlindTemplateResponse(**response.data[0])

    @staticmethod
    def get_template(template_id: str) -> Optional[BlindTemplateResponse]:
        """Get a specific template by ID"""
        response = supabase.table("blind_templates").select("*").eq("id", template_id).execute()
        if response.data:
            return BlindTemplateResponse(**response.data[0])
        return None

    @staticmethod
    def get_templates(stage_id: Optional[str] = None) -> List[BlindTemplateResponse]:
        """Get all templates, optionally filtered by stage"""
        query = supabase.table("blind_templates").select("*")

        if stage_id:
            # Get templates for this stage OR global templates (no stage)
            query = query.or_(f"stage_id.eq.{stage_id},stage_id.is.null")

        response = query.order("name").execute()
        return [BlindTemplateResponse(**item) for item in response.data]

    @staticmethod
    def update_template(template_id: str, template_data: BlindTemplateUpdate) -> Optional[BlindTemplateResponse]:
        """Update a template"""
        data = template_data.model_dump(exclude_unset=True)

        # Convert custom_levels to list of dicts if present
        if 'custom_levels' in data and data['custom_levels']:
            data['custom_levels'] = [level.model_dump() if hasattr(level, 'model_dump') else level for level in data['custom_levels']]

        # Add updated_at timestamp
        data['updated_at'] = datetime.utcnow().isoformat()

        response = supabase.table("blind_templates").update(data).eq("id", template_id).execute()

        if response.data:
            return BlindTemplateResponse(**response.data[0])
        return None

    @staticmethod
    def delete_template(template_id: str) -> bool:
        """Delete a template"""
        response = supabase.table("blind_templates").delete().eq("id", template_id).execute()
        return len(response.data) > 0

    @staticmethod
    def apply_template_to_day(template_id: str, tournament_day_id: str, clear_existing: bool = True) -> List[dict]:
        """
        Apply a blind template to a tournament day.
        This creates all the blind levels defined in the template.
        """
        # Get the template
        template_response = supabase.table("blind_templates").select("*").eq("id", template_id).execute()
        if not template_response.data:
            raise ValueError("Template not found")

        template = template_response.data[0]

        # Get the tournament_id from the day
        day_response = supabase.table("tournament_days").select("id, tournament_id").eq("id", tournament_day_id).execute()
        if not day_response.data:
            raise ValueError("Tournament day not found")

        tournament_id = day_response.data[0]["tournament_id"]

        # Clear existing blinds if requested
        if clear_existing:
            supabase.table("blinds").delete().eq("tournament_day_id", tournament_day_id).execute()

        # Generate blinds based on template
        blinds_to_create = []

        if template.get('custom_levels') and len(template['custom_levels']) > 0:
            # Use custom levels if defined
            for level_data in template['custom_levels']:
                blinds_to_create.append({
                    "tournament_day_id": tournament_day_id,
                    "tournament_id": tournament_id,
                    "level": level_data['level'],
                    "small_blind": level_data['small_blind'],
                    "big_blind": level_data['big_blind'],
                    "ante": level_data.get('ante', 0),
                    "duration": level_data.get('duration', template.get('blind_duration', 15)),
                    "is_break": level_data.get('is_break', False)
                })
        else:
            # Auto-generate blinds based on template configuration
            blinds_to_create = BlindTemplateService._generate_blinds(
                template=template,
                tournament_day_id=tournament_day_id,
                tournament_id=tournament_id
            )

        # Insert all blinds
        if blinds_to_create:
            response = supabase.table("blinds").insert(blinds_to_create).execute()
            return response.data

        return []

    @staticmethod
    def _generate_blinds(template: dict, tournament_day_id: str, tournament_id: str, num_levels: int = 20) -> List[dict]:
        """
        Generate blind levels based on template configuration.
        """
        blinds = []
        small_blind = template.get('initial_small_blind', 25)
        big_blind = template.get('initial_big_blind', 50)
        duration = template.get('blind_duration', 15)
        increase_type = template.get('blind_increase_type', 'double')
        ante_start_level = template.get('bb_ante_start_level', 3)
        break_interval = template.get('break_interval', 60)  # minutes
        break_duration = template.get('break_duration', 10)

        time_elapsed = 0
        next_break_at = break_interval

        for level in range(1, num_levels + 1):
            # Check if we need a break
            if break_interval > 0 and time_elapsed >= next_break_at:
                blinds.append({
                    "tournament_day_id": tournament_day_id,
                    "tournament_id": tournament_id,
                    "level": len(blinds) + 1,
                    "small_blind": 0,
                    "big_blind": 0,
                    "ante": 0,
                    "duration": break_duration,
                    "is_break": True
                })
                next_break_at += break_interval

            # Calculate ante (BB ante starts at specified level)
            ante = big_blind if level >= ante_start_level else 0

            blinds.append({
                "tournament_day_id": tournament_day_id,
                "tournament_id": tournament_id,
                "level": len(blinds) + 1,
                "small_blind": small_blind,
                "big_blind": big_blind,
                "ante": ante,
                "duration": duration,
                "is_break": False
            })

            time_elapsed += duration

            # Increase blinds for next level
            if increase_type == 'double':
                small_blind *= 2
                big_blind *= 2
            elif increase_type == 'gradual':
                # Gradual increase (roughly 50% increase)
                small_blind = int(small_blind * 1.5)
                big_blind = int(big_blind * 1.5)
                # Round to nice numbers
                small_blind = BlindTemplateService._round_to_nice_number(small_blind)
                big_blind = BlindTemplateService._round_to_nice_number(big_blind)

        return blinds

    @staticmethod
    def _round_to_nice_number(value: int) -> int:
        """Round a number to a 'nice' value for blinds"""
        if value < 100:
            return round(value / 5) * 5
        elif value < 1000:
            return round(value / 25) * 25
        elif value < 10000:
            return round(value / 100) * 100
        else:
            return round(value / 500) * 500

    @staticmethod
    def save_blinds_as_template(
        tournament_day_id: str,
        template_name: str,
        description: Optional[str] = None,
        stage_id: Optional[str] = None,
        user_id: Optional[str] = None
    ) -> BlindTemplateResponse:
        """
        Save the current blinds from a tournament day as a new template.
        """
        # Get existing blinds from the tournament day
        blinds_response = supabase.table("blinds")\
            .select("*")\
            .eq("tournament_day_id", tournament_day_id)\
            .order("level")\
            .execute()

        if not blinds_response.data:
            raise ValueError("No blinds found for this tournament day")

        # Convert blinds to custom_levels format
        custom_levels = []
        for blind in blinds_response.data:
            custom_levels.append({
                "level": blind['level'],
                "small_blind": blind['small_blind'],
                "big_blind": blind['big_blind'],
                "ante": blind.get('ante', 0),
                "duration": blind.get('duration', 15),
                "is_break": blind.get('is_break', False)
            })

        # Determine initial values from first non-break level
        first_blind = next((b for b in blinds_response.data if not b.get('is_break', False)), None)
        initial_small = first_blind['small_blind'] if first_blind else 25
        initial_big = first_blind['big_blind'] if first_blind else 50
        default_duration = first_blind.get('duration', 15) if first_blind else 15

        # Create template data
        template_data = {
            "name": template_name,
            "description": description,
            "blind_duration": default_duration,
            "initial_small_blind": initial_small,
            "initial_big_blind": initial_big,
            "blind_increase_type": "custom",
            "custom_levels": custom_levels
        }

        if stage_id:
            template_data["stage_id"] = stage_id

        if user_id:
            template_data["created_by"] = user_id

        response = supabase.table("blind_templates").insert(template_data).execute()
        return BlindTemplateResponse(**response.data[0])
