# Tournament Break/Interval System - Feature Guide

## Overview
The broadcast display now includes an automatic break/interval system that pauses the tournament at configured intervals and displays a countdown overlay.

## How It Works

### Break Timing
- Breaks occur based on the `break_interval` setting (default: 60 minutes)
- The system tracks **actual play time** (excluding previous breaks)
- When play time reaches the interval threshold, a break automatically starts

### Break Duration
- Duration is controlled by `break_duration` setting (default: 10 minutes)
- During a break, the tournament timer pauses
- Blind levels do not advance during breaks

### Display Features

#### Sidebar - "INTERVALO EM"
Shows countdown to the next break in format: `HH:MM:SS`

Example:
- `00:45:30` - Break in 45 minutes 30 seconds
- `00:05:00` - Break in 5 minutes
- `00:00:30` - Break starting in 30 seconds

#### Break Overlay
When a break starts, a fullscreen overlay appears with:
- Large orange/gold gradient background
- Animated coffee cup icon ☕
- "INTERVALO" title
- Countdown timer showing break time remaining
- "O torneio retornará em breve" message

The overlay automatically disappears when the break ends.

## Configuration

### Tournament Creation Form
When creating a tournament, you can set:

1. **Intervalo (min)** - Minutes between breaks
   - Default: 60 minutes
   - Example: Set to 90 for breaks every 1.5 hours

2. **Duração Intervalo (min)** - Break duration
   - Default: 10 minutes
   - Example: Set to 15 for 15-minute breaks

### Example Break Schedule

**Configuration**:
- Blind Duration: 20 minutes
- Break Interval: 60 minutes
- Break Duration: 10 minutes

**Timeline**:
```
00:00 - Tournament starts (Level 1)
00:20 - Level 2
00:40 - Level 3
01:00 - BREAK (10 minutes) - Tournament paused
01:10 - Resume (Level 4)
01:30 - Level 5
01:50 - Level 6
02:10 - Level 7
02:30 - BREAK (10 minutes) - Tournament paused
02:40 - Resume (Level 8)
```

Notice: Levels continue where they left off after breaks.

## Technical Implementation

### State Management
The broadcast component tracks:
- `totalPlayTime` - Seconds of actual tournament play (excluding breaks)
- `isOnBreak` - Boolean indicating if currently on break
- `breakTimeRemaining` - Countdown of current break
- `timeUntilBreak` - Calculated time until next break

### Timer Logic
```javascript
// During normal play
- Blind level countdown continues
- totalPlayTime increments every second
- Check if totalPlayTime % breakInterval === 0
  - If yes: Start break

// During break
- Blind level countdown pauses
- Break countdown decrements
- When break ends: Resume normal play
```

### Break Detection
Breaks trigger when:
```
totalPlayTime (seconds) % (break_interval * 60) === 0
```

Example with 60-minute interval:
- At 3600 seconds (60 min) → Break
- At 7200 seconds (120 min) → Break
- etc.

## Visual Design

### Break Overlay Styling
- **Background**: Semi-transparent black with blur effect
- **Content Box**: Orange-to-gold gradient (#ff6b35 to #f7931e)
- **Animations**:
  - Pulsing scale effect
  - Rotating coffee cup icon
  - Glowing shadow

### Responsive Design
The break overlay adapts to screen sizes:
- **Large screens (>1920px)**: Largest fonts
- **Desktop (1280px-1920px)**: Standard size
- **Tablets (<1280px)**: Medium size
- **Mobile (<768px)**: Compact layout

## User Experience

### Before Break (Last 5 minutes)
The "INTERVALO EM" countdown becomes more visible:
- Shows exact time remaining
- Allows players to prepare for the break

### During Break
- Fullscreen overlay appears immediately
- Tournament information hidden
- Only break timer visible
- Clear messaging about resumption

### After Break
- Overlay disappears smoothly
- Tournament resumes exactly where it left off
- No manual intervention needed

## Testing the Feature

### Manual Test Steps

1. **Create a test tournament** with short intervals:
   ```
   Blind Duration: 1 minute
   Break Interval: 2 minutes
   Break Duration: 1 minute
   ```

2. **Start the tournament**

3. **Open broadcast display** (📺 Transmitir button)

4. **Watch the countdown**:
   - After 2 minutes of play → Break overlay appears
   - Break counts down from 1:00
   - After break ends → Tournament resumes

5. **Verify**:
   - ✓ Blind timer pauses during break
   - ✓ "INTERVALO EM" shows correct countdown
   - ✓ Break overlay displays properly
   - ✓ Tournament resumes after break

### Expected Behavior

- ✅ Break triggers at exact interval
- ✅ All timers pause during break
- ✅ Break countdown is accurate
- ✅ Overlay is fullscreen and visible
- ✅ Tournament resumes automatically
- ✅ No blind levels are skipped

## Customization Options

### Changing Break Icon
Edit [TournamentBroadcast.js:306](frontend/src/pages/TournamentBroadcast.js#L306):
```javascript
<div className="break-icon">🍕</div>  // Change emoji
```

### Adjusting Colors
Edit [TournamentBroadcast.css:346](frontend/src/pages/TournamentBroadcast.css#L346):
```css
background: linear-gradient(135deg, #your-color 0%, #your-color2 100%);
```

### Custom Break Messages
Edit [TournamentBroadcast.js:311](frontend/src/pages/TournamentBroadcast.js#L311):
```javascript
<p className="break-subtitle">Your custom message</p>
```

## Future Enhancements

### Possible Improvements
1. **Sound Alert**: Play sound when break starts
2. **Late Registration**: Close late registration during first break
3. **Chip Count Update**: Show player chip counts during break
4. **Break Schedule**: Display upcoming break times
5. **Variable Breaks**: Different durations for different breaks
6. **Skip Break**: Manual override to skip a break
7. **Break Activities**: Show sponsor messages or ads during breaks

## Troubleshooting

### Issue: Break doesn't trigger

**Possible Causes**:
1. Tournament not started (status not 'active')
2. Break interval too long for testing
3. Browser tab not active (timer may throttle)

**Solution**:
- Ensure tournament is active
- Use shorter intervals for testing (e.g., 2 minutes)
- Keep browser tab active and focused

### Issue: Break timer shows NaN

**Cause**: Missing `break_duration` in tournament

**Solution**:
- Ensure database migration was run
- Check tournament has `break_duration` value
- Default should be 10 minutes

### Issue: Timer doesn't resume after break

**Cause**: State synchronization issue

**Solution**:
- Refresh the broadcast page
- Check console for errors
- Verify `isOnBreak` state toggles correctly

## Database Fields

The following tournament fields control breaks:

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `break_interval` | INTEGER | 60 | Minutes between breaks |
| `break_duration` | INTEGER | 10 | Duration of breaks in minutes |

Both fields are set when creating a tournament and stored in the database.

## Files Modified

- `frontend/src/pages/TournamentBroadcast.js` - Break logic and overlay
- `frontend/src/pages/TournamentBroadcast.css` - Break overlay styling
- `frontend/src/pages/Torneios.js` - Added interval configuration fields
- `database_migration_add_blind_structure.sql` - Database schema

## Summary

The break system provides:
- ✅ Automatic break triggering based on play time
- ✅ Configurable interval and duration
- ✅ Visual countdown to next break
- ✅ Fullscreen break overlay with timer
- ✅ Automatic tournament pause/resume
- ✅ No manual intervention required
- ✅ Fully responsive design

Perfect for live poker tournaments where regular breaks are essential for player comfort and tournament pacing!
