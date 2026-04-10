
type StatusType = 'paid' | 'pending' | 'overdue' | 'active' | 'proposed' | 'cold'

interface StatusBadgeProps {
  status: StatusType
  label?: string
  className?: string
}

const statusClasses: Record<StatusType, string> = {
  paid: 'badge-paid',
  pending: 'badge-pending',
  overdue: 'badge-overdue',
  active: 'badge-active',
  proposed: 'badge-proposed',
  cold: 'badge-cold',
}

const statusLabels: Record<StatusType, string> = {
  paid: 'Paid',
  pending: 'Pending',
  overdue: 'Overdue',
  active: 'Active',
  proposed: 'Proposed',
  cold: 'Cold',
}

export function StatusBadge({
  status,
  label,
  className = '',
}: StatusBadgeProps) {
  return (
    <span
      className={`px-2.5 py-1 rounded-full text-xs font-medium inline-flex items-center ${statusClasses[status]} ${className}`}
    >
      {label || statusLabels[status]}
    </span>
  )
}
