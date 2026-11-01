/** A slot for a real photo. Clearly labelled until the shop supplies one. */
export function Photo({ label, tone, className = '', bare = false }: { label: string; tone: 'blue' | 'sand' | 'sage' | 'steel' | 'warm' | 'deep'; className?: string; bare?: boolean }) {
  return (
    <figure className={`s-photo s-tone-${tone} ${className}`}>
      {!bare && <span>Placeholder photo: {label}</span>}
    </figure>
  )
}
