
interface LoadingSpinnerProps {
  size?: 'sm' | 'md' | 'lg'
  text?: string
  className?: string
}

const sizes = {
  sm: 'w-4 h-4 border-2',
  md: 'w-8 h-8 border-3',
  lg: 'w-12 h-12 border-4',
}

export function LoadingSpinner({
  size = 'md',
  text,
  className = '',
}: LoadingSpinnerProps) {
  return (
    <div className={`flex flex-col items-center justify-center gap-4 ${className}`}>
      <div className="animate-spin-slow">
        <div
          className={`${sizes[size]} border-cyan-500 border-r-transparent rounded-full`}
        />
      </div>
      {text && <p className="text-sm text-slate-400">{text}</p>}
    </div>
  )
}
