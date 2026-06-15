# Frontend Quick Reference - Torneios App

## Project Structure

```
frontend/src/
├── components/          (6 reusable UI components + CSS)
│   ├── Button.*
│   ├── Card.*
│   ├── Sidebar.*
│   ├── SelectedStageBar.*
│   ├── PlayerSelect.*
│   └── SeatTicket.*
│
├── pages/               (16 feature pages + CSS)
│   ├── Dashboard.*
│   ├── Etapas.* (Stages)
│   ├── Torneios.* (Tournaments)
│   ├── Players.*
│   ├── TournamentDetail.*
│   ├── TournamentDashboard.*
│   ├── TournamentRankings.*
│   ├── BlindManagement.*
│   ├── Caixa.* (Stage Cash)
│   ├── CaixaGeral.* (General Cash)
│   ├── ManualAllocation.*
│   ├── EliminacaoJogadores.* (Elimination)
│   ├── Relatorios.* (Reports)
│   ├── TournamentBroadcast.*
│   └── Login.*
│
├── styles/
│   └── App.css          (Global container & responsive)
│
├── config/
│   ├── api.js           (API client)
│   └── supabase.js      (Supabase client)
│
├── contexts/
│   ├── AuthContext.js   (Authentication)
│   └── StageContext.js  (Stage selection)
│
└── App.js              (Router configuration)
```

## Styling System

### CSS Architecture
- **Type:** Plain CSS (no preprocessor)
- **Organization:** Component CSS + Page CSS + Global CSS
- **Variables:** CSS Custom Properties for theming
- **Total:** ~5000+ lines across 23 CSS files

### Color Palette

```
DARK THEME:
Primary BG:     #0a0e13 (Very Dark Blue)
Secondary BG:   #1a2332 (Dark Blue) 
Card BG:        #141922 (Darkest Blue)

ACCENTS:
Poker Green:    #0f7a4e (Primary)
Poker Green Lt: #139b5f (Highlight)
Gold:           #d4af37 (Secondary)

TEXT:
Primary:        #ffffff (White)
Secondary:      #a0aec0 (Light Gray)
Gold:           #daa520 (Gold)

STATUS:
Danger:         #a90707 (Red)
Warning:        #ff6900 (Orange)
Info:           #0693e3 (Blue)
Success:        #2ecc71 (Green)
```

### Common CSS Patterns

**Buttons:**
```css
.btn { /* Base styles */ }
.btn-[variant]:  primary, secondary, danger, warning, info, success, gold
.btn-[size]:     small, medium, large
```

**Tables:**
```css
.table-name-table thead {
  background: linear-gradient(135deg, green-dark, blue-secondary);
}
.table-name-table tbody tr:hover {
  background: rgba(46, 204, 113, 0.05);  /* Green tint */
}
```

**Modals:**
```css
.modal-overlay      /* Fixed full-screen with backdrop blur */
.modal              /* Centered card with shadow */
.modal-header       /* Gradient header */
.modal-actions      /* Footer button group */
```

**Forms:**
```css
.form-group         /* Label + input wrapper */
.form-row           /* Multi-column grid */
.form-group input:focus {
  border-color: var(--poker-green);
  box-shadow: 0 0 0 3px rgba(15, 122, 78, 0.1);
}
```

## Component API Quick Guide

### Button Component
```jsx
<Button 
  variant="primary|secondary|danger|warning|info|success|gold"
  size="small|medium|large"
  onClick={handler}
  disabled={false}
  type="button|submit|reset"
>
  Label
</Button>
```

### Card Component
```jsx
<Card 
  title="Optional Header"
  className="additional-classes"
>
  Content goes here
</Card>
```

### PlayerSelect Component
```jsx
<PlayerSelect 
  value={selectedId}
  onChange={handler}
  required={true}
  name="player_id"
/>
```

### SeatTicket Component
```jsx
<SeatTicket 
  allocation={{
    id, player_name, tournament_name, 
    table_number, seat_number, created_at
  }}
  onPrint={handler}
/>
```

## Responsive Breakpoints

| Screen | Width | Layout |
|--------|-------|--------|
| Mobile | <768px | Single column, stacked |
| Tablet | 768-1024px | 2-column layout |
| Desktop | >1024px | Full multi-column |

## Emoji Usage (To Be Replaced)

| Emoji | File | Purpose | Line(s) |
|-------|------|---------|---------|
| 🎰 | SeatTicket.js, Login.js | Branding | Print header, page title |
| 🍀 | SeatTicket.js | Luck message | "Boa sorte! 🍀" |
| 📍 | SelectedStageBar.js | Location icon | Stage indicator |
| 📅 | TournamentDetail.js | Calendar icon | Empty state |
| ✓ | Etapas.js | Checkmark | Active status |
| ✕ | Multiple files | Close button | Modal close (10+ instances) |

**Action Items:**
- [ ] Replace 🎰 with proper poker icon
- [ ] Replace 🍀 with luck/star icon
- [ ] Replace 📍 with map pin SVG
- [ ] Replace 📅 with calendar SVG
- [ ] Replace ✓ with checkmark SVG
- [ ] Replace ✕ with X SVG or icon font

## Key CSS Files by Complexity

### Large (400+ lines)
- TournamentDetail.css - Complex form sections & tabs
- Torneios.css - Multiple layouts, modals, tables
- ManualAllocation.css - Drag-drop, visualization
- BlindManagement.css - Modal styling, animations

### Medium (200-400 lines)
- Dashboard.css, Etapas.css, Caixa.css
- CaixaGeral.css, EliminacaoJogadores.css
- Relatorios.css, TournamentDashboard.css

### Small (<200 lines)
- Button.css, Card.css, Sidebar.css
- Players.css, Login.css, TournamentBroadcast.css
- SeatTicket.css, TournamentRankings.css

## Styling Patterns to Standardize

### Hover Effects (Repeated across files)
```css
/* Current pattern */
.element:hover {
  transform: translateY(-2px);
  box-shadow: var(--shadow-lg);
  border-color: var(--border-light);
}
```

### Active/Selected States
```css
/* Current pattern */
.element.active {
  background: var(--card-bg);
  color: var(--text-gold);
  border-left-color: var(--gold-accent);
}
```

### Animations (Repeated)
```css
/* Fade-in */
animation: fadeIn 0.2s ease;

/* Slide-up */
animation: slideUp 0.3s ease;

/* Pulse */
animation: pulse 1.5s ease-in-out infinite;
```

## Common Fixes Needed

1. **Consolidate button styles** - `.btn*`, `.action-btn*`, `.btn-small` exist separately
2. **Consolidate table styles** - Similar table patterns across 8+ pages
3. **Consolidate form styles** - Form markup varies across pages
4. **Consolidate modal styles** - Modal structure repeated 6+ times
5. **Centralize badge styles** - Badge variants scattered
6. **Move sidebar nav icons** - Currently using data URIs, should be SVG component

## Performance Notes

- No CSS minification/optimization pipeline
- No unused CSS removal
- Potential CSS duplication: ~15-20% of CSS could be extracted to shared utilities
- Media query organization could be improved

## Accessibility Issues

1. Emoji usage in UI (no semantic meaning for screen readers)
2. Icon-only buttons missing aria-labels
3. No focus management in modals
4. Some color contrast could be improved
5. No keyboard navigation hints

## Recommendations Priority

| Priority | Task | Effort |
|----------|------|--------|
| High | Replace emojis with icon system | 8h |
| High | Consolidate CSS variables | 4h |
| High | Create CSS utility classes | 12h |
| Medium | Refactor to SASS/Tailwind | 30-40h |
| Medium | Create icon component | 6h |
| Low | Add CSS documentation | 4h |
| Low | Improve accessibility | 8h |

---

**Last Updated:** 2026-01-13  
**Total CSS:** ~5000 lines across 23 files  
**Total Components:** 6 reusable + 16 pages  
**Maintenance Score:** 6/10 (needs consolidation)
