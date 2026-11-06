# Migration Guide - Version 2 with Player Tracking

## What's New in V2?

### Database Changes
- **New `players` table** - Centralized player management
- **New `tournament_players` junction table** - Tracks player participation per tournament
- **Enhanced `tournaments` table** - Added rebuy_amount, addon_amount, prize_pool, tournament_date
- **Enhanced `transactions` table** - Now links to player_id instead of free text player_name

### Backend API Changes

#### New Endpoints

**Players:**
- `POST /players` - Create new player
- `GET /players?search=name` - List/search players
- `GET /players/{id}` - Get player details
- `GET /players/statistics` - Get player stats
- `PATCH /players/{id}` - Update player
- `DELETE /players/{id}` - Delete player

**Tournament Players:**
- `POST /tournament-players` - Register player to tournament
- `POST /tournament-players/{id}/rebuy` - Add rebuy
- `POST /tournament-players/{id}/addon` - Add addon
- `GET /tournament-players/tournament/{id}` - Get tournament roster
- `PATCH /tournament-players/{id}` - Update player (position, prize, status)

**Updated Endpoints:**
- Transactions now require `player_id` instead of `player_name`
- Reports now aggregate from `tournament_players` table

## Step-by-Step Migration

### 1. Backup Your Data ✅
The migration script automatically backs up your old transactions to `transactions_old_backup`.

### 2. Run Migration Script
```sql
-- Execute in Supabase SQL Editor
database_migration_v2.sql
```

### 3. Verify Migration
Check that these tables exist:
- ✅ players
- ✅ tournament_players
- ✅ tournaments (with new columns)
- ✅ transactions (new structure)
- ✅ transactions_old_backup (backup)

### 4. Update Backend
The backend code has been updated to version 2.0.0 with:
- New Pydantic models for Player and TournamentPlayer
- Updated services for all entities
- New API routers
- Enhanced transaction handling

### 5. Update Frontend
Frontend changes needed:
- Add Player management page
- Update Caixa to select players from dropdown
- Update Tournament pages to show registered players
- Reports now show detailed player statistics

## New Workflow

### Old Workflow (V1):
1. Create tournament
2. Register transaction with free-text player name
3. View reports by player name

### New Workflow (V2):
1. Create players (one-time setup)
2. Create tournament
3. Register player to tournament (creates tournament_player + transaction)
4. Add rebuys/addons via tournament_player
5. View comprehensive player statistics and tournament rosters

## Benefits of V2

✅ **Player Database** - Centralized player information with contact details
✅ **Tournament Roster** - See exactly who's registered for each tournament
✅ **Detailed Tracking** - Track buy-ins, rebuys, addons per player per tournament
✅ **Accurate Reports** - Player statistics across all tournaments
✅ **Prize Tracking** - Record final positions and prizes won
✅ **Chip Management** - Track total chips for each player
✅ **Better Analytics** - View player performance over time

## API Examples

### Register Player to Tournament
```javascript
POST /tournament-players
{
  "tournament_id": "uuid",
  "player_id": "uuid",
  "buy_in_count": 1
}
```

### Add Rebuy
```javascript
POST /tournament-players/{tournament_player_id}/rebuy
// Automatically calculates amount from tournament rebuy_amount
```

### Get Tournament Roster
```javascript
GET /tournament-players/tournament/{tournament_id}
// Returns all players with their stats for this tournament
```

### Player Statistics
```javascript
GET /players/statistics
// Returns aggregate stats for all players
```

## Backwards Compatibility

The migration script ensures:
- ✅ Old transaction data is preserved
- ✅ Players are created from existing transaction names
- ✅ Transaction history is migrated to new structure
- ✅ Tournament counts are updated correctly

## Troubleshooting

### Players not showing in dropdown
- Check that players were created: `SELECT * FROM players`
- Verify frontend is calling `/players` endpoint

### Transactions failing
- Ensure player_id is valid UUID
- Check that player exists in players table
- Verify tournament_id is correct

### Reports showing zero
- Run migration script again if data is missing
- Check tournament_players table has data
- Verify transactions have player_id populated

## Need Help?

Refer to:
- `database_schema_v2.sql` - Complete schema
- `database_migration_v2.sql` - Migration script
- `CLAUDE.md` - Development guidance
- API Docs: `http://localhost:8000/docs`
