# Tournament Broadcast Feature - Setup Instructions

> **Atualização (out/2026):** o telão ganhou layout novo, biblioteca de fundos
> no Storage e uma rota pública de extras (prêmios/moeda/clube). Ordem de
> deploy e detalhes em [BROADCAST_TV_LAYOUT_2026-10.md](BROADCAST_TV_LAYOUT_2026-10.md).

## Overview
I've implemented a tournament broadcast display system with configurable blind structures. This guide will help you complete the setup.

## What Was Implemented

### 1. Broadcast Display Component
- **File**: `frontend/src/pages/TournamentBroadcast.js`
- Fullscreen TV display for tournaments
- Real-time countdown timer
- Live blind levels and player counts
- Configurable blind progression

### 2. Database Schema Updates
- **File**: `database_migration_add_blind_structure.sql`
- Added `start_time` field to track when tournament begins
- Added blind structure configuration fields:
  - `initial_small_blind` - Starting small blind value
  - `initial_big_blind` - Starting big blind value
  - `blind_increase_type` - How blinds increase (double, triple, 1.5x, 2x, 3x)
  - `bb_ante_start_level` - Which level BB ante starts
  - `break_interval` - Minutes between breaks
  - `break_duration` - Duration of breaks in minutes

### 3. Backend Updates
- **File**: `backend/app/models/tournament.py`
  - Added `BlindIncreaseType` enum
  - Added blind structure fields to `TournamentBase` model
  - Added `start_time` to `Tournament` model

- **File**: `backend/app/services/tournament_service.py`
  - Updated `update_tournament` to automatically set `start_time` when tournament status changes to 'active'

### 4. Frontend Tournament Form
- **File**: `frontend/src/pages/Torneios.js`
  - Added blind structure configuration section to tournament creation form
  - Fields for all blind structure parameters

- **File**: `frontend/src/pages/Torneios.css`
  - Added styling for form sections

## Setup Steps

### Step 1: Run Database Migration

1. Open your Supabase dashboard
2. Go to the SQL Editor
3. Copy the contents of `database_migration_add_blind_structure.sql`
4. Run the migration

This will add all the necessary columns to your `tournaments` table.

### Step 2: Restart Backend Server

The backend has been updated with new model fields. Restart your FastAPI server:

```bash
cd backend
# Stop the server (Ctrl+C)
# Start it again
uvicorn main:app --reload
```

### Step 3: Test the Features

1. **Create a new tournament** with custom blind structure:
   - Go to Tournaments page
   - Click "Novo Torneio"
   - Fill in all fields including the new "Estrutura de Blinds" section
   - Create the tournament

2. **Start the tournament**:
   - Click "Iniciar" on your tournament
   - This will automatically set the `start_time` field

3. **Open broadcast display**:
   - Click the "📺 Transmitir" button
   - This opens the fullscreen broadcast view
   - Open in a separate window/tab for TV display

## How It Works

### Blind Progression Logic

The broadcast display calculates blinds based on your configuration:

- **Double (2x)**: Blinds double every 2 levels
  - Level 1: 50/100
  - Level 2: 50/100
  - Level 3: 100/200
  - Level 4: 100/200
  - Level 5: 200/400

- **Triple (3x)**: Blinds triple every level
  - Level 1: 50/100
  - Level 2: 150/300
  - Level 3: 450/900

- **1.5x**: Blinds multiply by 1.5 every level
  - Level 1: 50/100
  - Level 2: 75/150
  - Level 3: 112/225

### BB Ante

- Starts at the level you specify (default: level 3)
- Ante amount = current big blind
- Example: At 100/200 blinds, BB Ante = 200

### Timer

- Counts down from blind duration (e.g., 20:00 for 20 minutes)
- Automatically advances to next level when timer reaches 0:00
- Recalculates blinds based on your increase type

### Break Intervals

- Configured via `break_interval` (default: 60 minutes)
- Break duration via `break_duration` (default: 10 minutes)
- Currently displays time elapsed; break logic can be enhanced

## Troubleshooting

### Issue: NaN values in broadcast display

**Cause**: Tournament doesn't have `start_time` set

**Solution**:
1. Run the database migration
2. Restart the tournament (change status to pending, then back to active)
3. Or manually update `start_time` in database

### Issue: Blinds not calculating correctly

**Cause**: Missing blind configuration fields

**Solution**:
1. Ensure database migration was run
2. Create a new tournament with all fields filled
3. Check console logs for tournament data

### Issue: Player count shows 0

**Cause**: No players registered to tournament

**Solution**:
1. Register players to the tournament via the Players page
2. Player count updates automatically via real-time subscriptions

## Future Enhancements

1. **Break Timer**: Implement automatic break intervals based on `break_interval` and `break_duration`
2. **Blind Structure Preview**: Show full blind structure table in tournament details
3. **Custom Blind Structures**: Allow uploading custom blind schedules
4. **Sound Alerts**: Play sounds when level changes or breaks occur
5. **Multi-Table Display**: Show multiple tournament tables on one screen

## File Reference

### Modified Files
- `frontend/src/pages/TournamentBroadcast.js` - Broadcast display component
- `frontend/src/pages/TournamentBroadcast.css` - Broadcast styling
- `frontend/src/pages/Torneios.js` - Tournament form with blind config
- `frontend/src/pages/Torneios.css` - Form styling
- `frontend/src/App.js` - Added broadcast route
- `backend/app/models/tournament.py` - Added blind structure fields
- `backend/app/services/tournament_service.py` - Auto-set start_time

### New Files
- `database_migration_add_blind_structure.sql` - Database migration
- `BROADCAST_SETUP_INSTRUCTIONS.md` - This file

## Support

If you encounter issues:
1. Check browser console for errors
2. Check backend logs for API errors
3. Verify database migration was successful
4. Ensure all fields have default values in the database
