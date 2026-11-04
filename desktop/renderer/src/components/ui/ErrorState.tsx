export function ErrorState({
  title,
  message,
  onRetry,
}: {
  title: string
  message?: string
  onRetry?: () => void
}) {
  return (
    <div
      role="alert"
      className="flex flex-col items-center justify-center gap-2 rounded-xl border border-red/30 bg-red-soft px-6 py-10 text-center"
    >
      <p className="font-display text-sm font-semibold text-red">{title}</p>
      {message ? <p className="max-w-md whitespace-pre-wrap text-sm text-ink">{message}</p> : null}
      {onRetry ? (
        <button
          type="button"
          onClick={onRetry}
          className="mt-2 rounded-lg border border-line bg-surface px-3 py-1.5 text-sm font-medium text-ink hover:bg-surface-2"
        >
          Try again
        </button>
      ) : null}
    </div>
  )
}
