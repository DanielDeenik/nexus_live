# Nexus Financial Platform - Frontend Quick Start

## Build Complete ✓

All 28 TypeScript/React files have been created with a premium financial dashboard UI.

## File Structure

```
src/
├── main.tsx                  # React 19 entry point
├── App.tsx                   # Root with routing
├── index.css                 # TailwindCSS 4 + dark theme
│
├── components/               # Reusable UI components
│   ├── Layout.tsx           # Main layout wrapper
│   ├── Sidebar.tsx          # Navigation sidebar (collapsible)
│   ├── Header.tsx           # Top bar with search & notifications
│   └── ui/                  # Base components
│       ├── Card.tsx         # Glass-morphism containers
│       ├── KPICard.tsx      # Metric cards with trends
│       ├── Button.tsx       # 4 variants
│       ├── Modal.tsx        # Dialogs
│       ├── DataTable.tsx    # Sortable tables
│       ├── StatusBadge.tsx  # Status indicators
│       ├── EmptyState.tsx   # Empty placeholders
│       └── LoadingSpinner.tsx
│
├── pages/                    # Full-page components (9 total)
│   ├── Dashboard.tsx        # Main dashboard
│   ├── Forecast.tsx         # Cashflow forecast
│   ├── Budget.tsx           # Budget tracking
│   ├── Scenarios.tsx        # Scenario planner
│   ├── Treasury.tsx         # Multi-currency
│   ├── Invoices.tsx         # Invoice management
│   ├── Market.tsx           # Market intelligence
│   ├── Insights.tsx         # AI agent chat
│   └── Settings.tsx         # User settings
│
├── hooks/                    # Custom React hooks
│   ├── useApi.ts            # Data fetching (query, mutation, infinite)
│   └── useAuth.ts           # Authentication
│
├── lib/                      # Utilities
│   ├── api.ts               # API client
│   └── format.ts            # Formatting helpers
│
├── stores/                   # State management
│   └── auth.ts              # Auth context
│
└── README.md                # Documentation
```

## Key Design Decisions

### No Hardcoded Values
- All UI configuration comes from the API
- Environment variable: `VITE_API_URL` (defaults to `http://localhost:3000/api`)
- Graceful error handling with EmptyState fallbacks

### Modern Dark UI
- Slate-900/950 backgrounds with cyan-500 accents
- Green for positive metrics, red for negative
- JetBrains Mono for financial numbers (tabular alignment)
- Glass-morphism effects with subtle borders

### Performance First
- CSS-only animations (no JavaScript animation libraries)
- Recharts for efficient charting
- Lazy component loading ready
- Pagination for large datasets
- Configurable data refresh intervals

### Type Safety
- Full TypeScript strict mode
- Interface types for all API responses
- Generic hooks (useQuery<T>, useMutation<T, V>)
- No `any` types

## Development Setup

### Prerequisites
```bash
node 18+
npm or yarn or pnpm
```

### Install & Run
```bash
cd apps/web
npm install
npm run dev
```

This starts Vite dev server on http://localhost:5173

### Environment Variables
Create `.env` or `.env.local`:
```
VITE_API_URL=http://localhost:3000/api
VITE_APP_NAME=Nexus
```

## Component Usage Examples

### Using useQuery for data fetching
```tsx
const { data, isLoading, error, refetch } = useQuery<DashboardData>(
  '/v1/finance/summary',
  { 
    refetchInterval: 30000,    // Auto-refresh every 30s
    staleTime: 5000            // Cache for 5s
  }
)
```

### Using useMutation for creating/updating data
```tsx
const { mutate, isLoading, error } = useMutation<Invoice, InvoiceInput>(
  '/v1/finance/invoices',
  'POST',
  {
    onSuccess: () => refetch(),
    onError: (err) => console.error(err)
  }
)

// Call it
await mutate({ client: 'Acme', amount: 5000 })
```

### Creating a form with Modal
```tsx
<Modal
  isOpen={isOpen}
  onClose={onClose}
  title="Add Invoice"
  footer={
    <>
      <Button variant="secondary" onClick={onClose}>Cancel</Button>
      <Button variant="primary" onClick={handleSubmit} isLoading={isLoading}>
        Create
      </Button>
    </>
  }
>
  <input type="text" placeholder="Client name" />
  <input type="number" placeholder="Amount" />
</Modal>
```

### Using DataTable with filtering
```tsx
<DataTable
  columns={[
    { key: 'client', label: 'Client', sortable: true },
    { 
      key: 'amount', 
      label: 'Amount',
      render: (value) => formatCurrency(value)
    }
  ]}
  data={invoices}
  searchable
  searchFields={['client', 'invoiceNumber']}
  pagination={{ pageSize: 10 }}
/>
```

## Customization Guide

### Adding a New Page
1. Create `src/pages/YourPage.tsx`
2. Add route in `App.tsx`:
```tsx
<Route path="/your-path" element={<YourPage />} />
```
3. Add sidebar item in `Sidebar.tsx`:
```tsx
{ label: 'Your Page', path: '/your-path', icon: <SomeIcon size={20} /> }
```

### Changing Colors
Edit `index.css` color variables or modify Tailwind classes directly.

Primary accent (cyan) is used in:
- Sidebar active state
- Button primary variant
- Input focus states
- KPI trend indicators

### Adding Custom Fonts
In `index.css`, modify the @import at the top.

## API Endpoints Reference

### Finance
- `GET /v1/finance/summary` - Dashboard KPIs
- `GET /v1/finance/burn-history` - Historical burn data
- `GET /v1/finance/forecast?horizon=12` - Forecast with anomalies
- `GET /v1/finance/budget` - Budget categories
- `POST /v1/finance/budget/categories` - Add budget
- `GET /v1/finance/scenarios` - All scenarios
- `POST /v1/finance/scenarios` - Create scenario
- `GET /v1/finance/treasury` - Accounts & hedges
- `GET /v1/finance/invoices` - All invoices
- `POST /v1/finance/invoices` - Create invoice

### Market
- `GET /v1/market/signals` - Market signals with tiers

### Insights
- `GET /v1/insights/summary` - Agent status & insights
- `POST /v1/insights/query` - Query agent swarm

### Settings
- `GET /v1/settings` - User settings & config
- `POST /v1/settings/api-tokens` - Create API token
- `POST /v1/settings/stakeholders` - Invite user

## Building for Production

```bash
npm run build
```

Output: `dist/` directory ready for deployment.

Supports:
- Docker (Cloudflare workers or Container)
- Railway
- Render
- Vercel
- AWS S3 + CloudFront
- GitHub Pages

## Performance Checklist

- [x] No external animation libraries (CSS only)
- [x] Recharts for efficient charting
- [x] Lazy loading hooks ready
- [x] Pagination on data tables
- [x] Configurable refresh intervals
- [x] Error boundaries in place
- [x] Loading states on all async operations

## Testing (Ready to Add)

Jest + React Testing Library setup can be added:

```bash
npm install --save-dev jest @testing-library/react
```

Example test:
```tsx
import { render, screen } from '@testing-library/react'
import { Dashboard } from './pages/Dashboard'

test('renders dashboard KPI cards', () => {
  render(<Dashboard />)
  expect(screen.getByText(/Cash Paid/i)).toBeInTheDocument()
})
```

## Troubleshooting

### CORS issues
If API calls fail with CORS errors, ensure the backend includes proper headers:
```
Access-Control-Allow-Origin: *
Access-Control-Allow-Methods: GET, POST, PUT, PATCH, DELETE
```

Or configure a proxy in `vite.config.ts`.

### Dark mode not working
Ensure `dark` class is on root element. In TailwindCSS 4, it's class-based:
```tsx
// In Layout.tsx or main wrapper
<div className="dark">...content...</div>
```

Actually, this theme uses hardcoded dark colors, so it's always dark!

### Charts not rendering
Ensure `ResponsiveContainer` parent has a defined height:
```tsx
<div style={{ height: '300px' }}>
  <ResponsiveContainer width="100%" height="100%">
    <BarChart data={data}>...</BarChart>
  </ResponsiveContainer>
</div>
```

## Support & Next Steps

1. **Connect to Backend**: Update API endpoints to match your backend
2. **Authentication**: Implement login flow using `useAuth` hook
3. **Testing**: Add Jest + React Testing Library
4. **E2E Tests**: Add Cypress or Playwright
5. **Deployment**: Push to Railway, Render, or Vercel
6. **Monitoring**: Add Sentry for error tracking

---

Built with React 19 + TypeScript + TailwindCSS 4 + Recharts
