import { business } from '@shared/business'
import { cn } from '@/lib/utils'
import { INPUT, LBL } from './form'

/** The size grid: one number box per size (the standard sizes plus any extra in `cells`). Cells stay text while typing. */
export function SizeGrid({ cells, onChange, label, invalid }: { cells: Record<string, string>; onChange: (c: Record<string, string>) => void; label: (size: string) => string; invalid?: true }) {
  const columns = [...business.sizes, ...Object.keys(cells).filter((k) => !(business.sizes as readonly string[]).includes(k))]
  return (
    <div className="flex flex-wrap gap-1" aria-invalid={invalid}>
      {columns.map((size) => (
        <label key={size} className="flex w-14 flex-col gap-1">
          <span className={cn(LBL, 'text-center')} aria-hidden>{size}</span>
          <input className={cn(INPUT, 'num px-1 text-center')} type="number" inputMode="numeric" min={0} aria-label={label(size)} value={cells[size] ?? ''} onChange={(e) => onChange({ ...cells, [size]: e.target.value })} />
        </label>
      ))}
    </div>
  )
}
