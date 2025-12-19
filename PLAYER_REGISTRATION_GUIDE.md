# Player Registration Feature - Complete Guide

## Overview
I've implemented a complete player registration system with tournament capacity validation, real-time updates, and duplicate player checking.

## What Was Implemented

### 1. Backend Validation (tournament_player_service.py)

**Tournament Capacity Check**:
- Validates that `registered_players < max_players` before allowing registration
- Returns error: `"Tournament is full (X/Y players)"` if tournament is at capacity

**Duplicate Player Check**:
- Prevents the same player from being registered multiple times in the same tournament
- Returns error: `"Player is already registered for this tournament"`

**Location**: `backend/app/services/tournament_player_service.py:22-32`

### 2. Tournament Detail Page (NEW)

**File**: `frontend/src/pages/TournamentDetail.js`

**Features**:
- Displays full tournament information
- Shows registered players in a table
- Player registration form with validation
- Real-time updates via Supabase subscriptions
- Rebuy and Add-on buttons for each player
- Capacity indicator showing "X / Y players"
- "LOTADO" (Full) warning when tournament reaches max capacity

**Player Table Columns**:
- Number
- Player Name (with nickname)
- Buy-ins count
- Rebuys count
- Add-ons count
- Total chips
- Total spent
- Actions (Rebuy/Add-on buttons)

### 3. Player Registration Form

**Fields**:
- **Player**: Dropdown using PlayerSelect component (required)
- **Buy-in Count**: Number of initial buy-ins (default: 1, min: 1)
- **Notes**: Optional observations about the player

**Validation**:
- Form is disabled when tournament is full
- Shows error alerts for failed registrations
- Button text changes to "🔒 Torneio Lotado" when full

### 4. Real-time Updates

**Supabase Subscriptions**:
- Tournament updates (status, player count, prize pool)
- Player list changes (new registrations, rebuys, add-ons)
- Automatic refresh when data changes

**Benefits**:
- Multiple users can register players simultaneously
- Capacity updates in real-time
- No page refresh needed

### 5. Updated Routes

**New Routes Added**:
- `/torneios/:id` - Tournament Detail page (protected)
- Already existing: `/broadcast/:id` - Broadcast Display (public)

**Navigation Flow**:
```
Torneios List → Ver Detalhes → Tournament Detail
                             → Register Players
                             → View Players
                             → Add Rebuys/Add-ons
                             → 📺 Transmitir (Broadcast)
```

## How to Use

### Registering a Player

1. **Navigate to Tournament**:
   - Go to "Torneios" page
   - Click "Ver Detalhes" on any tournament

2. **Check Capacity**:
   - Look at player count: "5 / 50" means 5 registered out of 50 max
   - If it shows "LOTADO", tournament is full

3. **Register Player**:
   - Click "➕ Registrar Jogador" button
   - Select player from dropdown
   - Set number of buy-ins (default: 1)
   - Add notes if needed (optional)
   - Click "Registrar"

4. **Success**:
   - Player appears in the table immediately
   - Player count updates: "6 / 50"
   - Prize pool increases automatically

### Handling Full Tournaments

**When Tournament is Full**:
- "Registrar Jogador" button shows "🔒 Torneio Lotado"
- Button is disabled (cannot click)
- Attempting registration via API returns error

**Error Message**:
```
"Tournament is full (50/50 players)"
```

### Handling Duplicate Registrations

**If Same Player Registered Twice**:
- API returns error immediately
- Alert shown: "Player is already registered for this tournament"
- No duplicate entry is created

## API Endpoints Used

### Register Player
```
POST /tournament-players
Body: {
  "tournament_id": "uuid",
  "player_id": "uuid",
  "buy_in_count": 1,
  "notes": "optional"
}
```

**Success Response** (201):
```json
{
  "id": "uuid",
  "player_name": "João Silva",
  "player_nickname": "JoãoAce",
  "tournament_name": "Torneio Sexta",
  "total_chips": 10000,
  "total_spent": 100.00
}
```

**Error Responses** (400):
- `"Tournament is full (50/50 players)"`
- `"Player is already registered for this tournament"`
- `"Tournament not found"`

### Add Rebuy
```
POST /tournament-players/{id}/rebuy
```

### Add Add-on
```
POST /tournament-players/{id}/addon
```

### Get Tournament Players
```
GET /tournament-players/tournament/{tournament_id}
```

## Database Behavior

### Automatic Player Count
The database automatically maintains `registered_players` count via triggers:

```sql
-- When player is registered (INSERT on tournament_players)
tournaments.registered_players = registered_players + 1

-- When player is removed (DELETE on tournament_players)
tournaments.registered_players = registered_players - 1
```

### Automatic Prize Pool
Prize pool updates automatically when transactions are created:
- Buy-in transactions increase prize pool
- Rebuy transactions increase prize pool
- Add-on transactions increase prize pool

## User Experience Flow

### Happy Path
1. User clicks "Ver Detalhes" on tournament
2. Sees tournament info and current players
3. Clicks "Registrar Jogador"
4. Selects player from dropdown
5. Clicks "Registrar"
6. ✅ Player appears in table
7. ✅ Count updates: "6 / 50"
8. ✅ Prize pool increases

### Tournament Full
1. User sees "5 / 5" players (tournament full)
2. "Registrar Jogador" button shows "🔒 Torneio Lotado"
3. Button is disabled (grayed out)
4. Cannot register more players
5. Must wait for someone to remove a player

### Duplicate Player
1. User selects player already registered
2. Clicks "Registrar"
3. ❌ Alert: "Player is already registered for this tournament"
4. Registration fails
5. No duplicate entry created

## Real-time Scenarios

### Scenario 1: Two Users Register Simultaneously
**User A**:
- Sees "48 / 50" players
- Starts registering player X

**User B** (same time):
- Sees "48 / 50" players
- Starts registering player Y

**Result**:
- Both registrations succeed
- Both users see "50 / 50" immediately
- Button changes to "Torneio Lotado" for both

### Scenario 2: Last Spot Race
**Initial**: Tournament has "49 / 50" players

**User A** clicks Register → Success → "50 / 50"
**User B** clicks Register → ❌ Error: "Tournament is full"

User B sees the update immediately via Supabase subscription.

## File References

### Modified Files
- `backend/app/services/tournament_player_service.py:13-33` - Added validation
- `frontend/src/pages/Torneios.js:175-181` - Added navigation
- `frontend/src/App.js:7,44-50` - Added route

### New Files
- `frontend/src/pages/TournamentDetail.js` - Tournament detail page
- `frontend/src/pages/TournamentDetail.css` - Styling
- `PLAYER_REGISTRATION_GUIDE.md` - This file

## Styling

### Color Indicators
- **Green** (accent-color): Chips count
- **Orange** (warning-color): When tournament is full
- **Blue** (info-color): Rebuy button
- **Yellow** (warning-color): Add-on button

### Responsive Design
- Desktop: Full table layout
- Tablet: Condensed font sizes
- Mobile: Scrollable table, stacked buttons

## Testing Checklist

- [ ] Register player to tournament
- [ ] Try to register same player twice (should fail)
- [ ] Fill tournament to capacity
- [ ] Try to register when full (should fail)
- [ ] Add rebuy to player
- [ ] Add add-on to player
- [ ] Verify prize pool updates
- [ ] Verify player count updates in real-time
- [ ] Test with multiple browser tabs (real-time sync)
- [ ] Navigate between pages (Torneios → Detail → Broadcast)

## Future Enhancements

1. **Player Search**: Filter/search in player list
2. **Bulk Registration**: Register multiple players at once
3. **Waiting List**: Queue for full tournaments
4. **Remove Player**: Unregister a player
5. **Edit Registration**: Modify buy-in count or notes
6. **Export Players**: Download player list as CSV
7. **Print List**: Printable player roster
8. **Player Stats**: Show player history in modal

## Summary

The player registration system is now fully functional with:
- ✅ Backend validation for capacity and duplicates
- ✅ User-friendly error messages
- ✅ Real-time updates across users
- ✅ Clean, responsive UI
- ✅ Automatic database triggers for counts
- ✅ Complete navigation flow

Players can be registered safely with proper validation, and the tournament capacity is enforced both at the backend and frontend levels!
