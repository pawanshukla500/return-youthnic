import { EmptyState } from '../components/ui/EmptyState'

export default function ClaimsPage() {
  return (
    <section aria-labelledby="page-title">
      <h1 id="page-title" className="font-display text-xl font-bold text-ink">Claims</h1>
      <div className="mt-4">
        <EmptyState title="Under construction" message="The claims view is being rebuilt as a native desktop screen." />
      </div>
    </section>
  )
}
