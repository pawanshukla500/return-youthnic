import { EmptyState } from '../components/ui/EmptyState'

export default function FollowUpsPage() {
  return (
    <section aria-labelledby="page-title">
      <h1 id="page-title" className="font-display text-xl font-bold text-ink">Follow-ups</h1>
      <div className="mt-4">
        <EmptyState title="Under construction" message="The ticket follow-up view is being rebuilt as a native desktop screen." />
      </div>
    </section>
  )
}
