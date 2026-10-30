import { business } from '@shared/business'

// Wordmark block: monogram + name, from shared/business.ts only.
export default function ShopIdentity() {
  const [first, ...rest] = business.name.split(' ')
  return (
    <div className="flex items-center gap-2.5 px-1.5 py-1">
      <div className="flex size-7 items-center justify-center rounded-[7px] bg-primary text-sm font-bold text-primary-foreground">
        {business.shortName[0]}
      </div>
      <div className="flex flex-col">
        <span className="text-sm font-semibold tracking-[-0.01em]">{first}</span>
        {rest.length > 0 && <span className="text-[11.5px] text-muted-foreground">{rest.join(' ')}</span>}
      </div>
    </div>
  )
}
