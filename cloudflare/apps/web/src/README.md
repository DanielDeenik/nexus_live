# Nexus Financial Platform - React 19 Frontend

A premium, sleek financial dashboard with dark theme, real-time data, and AI-powered insights for freelancers and solopreneurs.

## Architecture

### Entry Points
- **main.tsx** - React 19 entry with BrowserRouter
- **App.tsx** - Root component with layout and routing
- **index.css** - TailwindCSS 4 + custom dark theme styles

### Directory Structure

```
src/
├── components/
│   ├── Layout.tsx           # Main layout wrapper
│   ├── Sidebar.tsx          # Collapsible navigation sidebar
│   ├── Header.tsx           # Top header with search, notifications, user menu
│   └── ui/
│       ├── Card.tsx         # Glass-morphism card components
│       ├── KPICard.tsx      # Metric cards with trends & sparklines
│       ├── Button.tsx       # Button variants (primary, secondary, danger, ghost)
│       ├── Modal.tsx        # Dialog with animations
│       ├── DataTable.tsx    # Sortable, filterable table with pagination
│       ├── StatusBadge.tsx  # Status indicators (paid, pending, overdue, etc.)
│       ├── EmptyState.tsx   # Placeholder for empty states
│       └── LoadingSpinner.tsx # Animated loading indicator
├── pages/
│   ├── Dashboard.tsx        # Main dashboard with KPIs, burn chart, recent invoices
│   ├── Forecast.tsx         # Cashflow forecast with confidence bands & anomalies
│   ├── Budget.tsx           # Budget tracking with variance alerts
│   ├── Scenarios.tsx        # What-if scenario planner
│   ├── Treasury.tsx         # Multi-currency accounts & FX hedging
│   ├── Invoices.tsx         # Invoice management & tracking
│   ├── Market.tsx           # Market signals & seasonality charts
│   ├── Insights.tsx         # Chat-like interface with AI agents
│   └── Settings.tsx         # Profile, data sources, API tokens, stakeholders, agents
├── hooks/
│   ├── useApi.ts            # Generic data fetching (useQuery, useMutation, useInfiniteQuery)
│   └── useAuth.ts           # Authentication state & methods
├── lib/
│   ├── api.ts               # API client with auth headers & base URL
│   └── format.ts            # Formatting utilities (currency, dates, numbers, percent)
├── stores/
│   └── auth.ts              # Auth context & types (no external state library)
└── README.md                # This file
```

## Design System

### Color Palette
- **Backgrounds**: slate-950, slate-900, slate-800
- **Accents**: cyan-500, cyan-600 (primary), teal-500, teal-600
- **Positive**: emerald-400, emerald-500 (green for gains)
- **Negative**: red-400, red-500 (red for losses)
- **Neutral**: slate-400, slate-500 (text), slate-700 (borders)

### Fonts
- **Body**: Inter (weights: 300–700)
- **Numbers**: JetBrains Mono (tabular-nums for financial data)

### Components
All UI components use:
- Glass-morphism effect (semi-transparent dark backgrounds with blur)
- Subtle borders (slate-700/50 opacity)
- Smooth transitions (300ms duration)
- Focus states (cyan-500/50 borders)
- Hover effects (brightness, shadow, background shifts)

## Key Features

### Real-Time Data
- All components use `useQuery` with configurable refresh intervals
- No hardcoded values — all configuration from API
- Automatic error handling with EmptyState fallbacks

### Navigation
- React Router v7 for client-side navigation
- Active route highlighting in sidebar
- Breadcrumb in header

### Charts
- Recharts for all visualizations (Bar, Line, Area, Pie, Composed)
- Custom dark theme tooltips
- Smooth animations disabled for performance

### Forms
- Modal dialogs for data entry
- Form validation in mutation handlers
- Loading states on submit buttons

### Responsive Design
- Mobile-first Tailwind classes
- Grid systems that collapse on smaller screens
- Collapsible sidebar for mobile

## API Integration

### Environment Variables
```
VITE_API_URL=http://localhost:3000/api
```

### API Endpoints Used
```
GET  /v1/finance/summary          # Dashboard KPIs
GET  /v1/finance/burn-history     # Burn chart
GET  /v1/finance/forecast         # Forecast with anomalies
GET  /v1/finance/budget           # Budget categories
POST /v1/finance/budget/categories # Add budget
GET  /v1/finance/scenarios        # Scenarios
POST /v1/finance/scenarios        # Create scenario
GET  /v1/finance/treasury         # Multi-currency accounts
GET  /v1/finance/invoices         # All invoices
POST /v1/finance/invoices         # Create invoice
GET  /v1/market/signals           # Market signals
GET  /v1/insights/summary         # AI agents & insights
POST /v1/insights/query           # Query agent swarm
GET  /v1/settings                 # User settings
POST /v1/settings/api-tokens      # Create API token
POST /v1/settings/stakeholders    # Invite stakeholder
```

## Customization

### Adding a New Page
1. Create page component in `src/pages/YourPage.tsx`
2. Add route in `App.tsx`
3. Add sidebar item in `Sidebar.tsx`

### Styling
- Edit `index.css` for global styles
- Use Tailwind @apply for custom components
- Custom animations in CSS (no heavy animation libraries)

### Data Fetching
```tsx
const { data, isLoading, error, refetch } = useQuery('/v1/path');
const { mutate, isLoading: isMutating } = useMutation('/v1/path', 'POST');
```

## Performance Optimizations
- CSS-only animations (no JavaScript-driven animations)
- Lazy loading with React.lazy (where applicable)
- Memoization of expensive components
- Pagination for large datasets
- Image optimization with modern formats

## Browser Support
- Chrome 90+
- Firefox 88+
- Safari 14+
- Edge 90+

## Dependencies
- react 19
- react-router-dom 7
- recharts (charting)
- lucide-react (icons)
- tailwindcss 4

