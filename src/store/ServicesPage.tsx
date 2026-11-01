import { Link } from 'react-router'
import { business } from '@shared/business'
import { Photo } from './Photo'
import { Reveal } from './Reveal'
import { CtaLink, usePageTitle } from './StoreLayout'

type Service = (typeof business.storefront.services)[number] & { product?: string }
const services: readonly Service[] = business.storefront.services
const by = (id: string) => services.find((s) => s.id === id)!
const orderLink = (s: Service) => `/order?${s.product ? `product=${s.product}` : `method=${s.method}`}`

function Details({ s, title }: { s: Service; title?: boolean }) {
  return (
    <div className="s-stack-18">
      {title && <h2 className="s-display s-h-section">{s.name}</h2>}
      <p className="s-body">{s.body}</p>
      <ul className="s-chips">{s.uses.map((u) => <li key={u}>{u}</li>)}</ul>
      <Link to={orderLink(s)} viewTransition className="s-text-link">Start an order for {s.cta}</Link>
    </div>
  )
}

export default function ServicesPage() {
  usePageTitle('Services')
  return (
    <main>
      <section className="s-wrap s-services-head">
        <h1 tabIndex={-1} className="s-display s-h-page">The right method for every project.</h1>
        <p className="s-lead">Not sure which one fits? Choose "Help me choose" when you start an order and we will recommend one.</p>
        <nav aria-label="Services on this page" className="s-pills">
          {services.map((s) => <a key={s.id} href={`#${s.id}`}>{s.name}</a>)}
        </nav>
      </section>

      <section id="screen" className="s-wrap s-anchor s-section-bottom">
        <Photo label={by('screen').photo} tone="blue" className="s-photo-wide" />
        <div className="s-split s-split-top">
          <h2 className="s-display s-h-section">{by('screen').name}</h2>
          <Details s={by('screen')} />
        </div>
      </section>

      <section id="embroidery" className="s-anchor s-band">
        <div className="s-wrap s-split s-section-small">
          <Details s={by('embroidery')} title />
          <Photo label={by('embroidery').photo} tone="sand" className="s-split-photo" />
        </div>
      </section>

      <section className="s-wrap s-section s-two-up">
        {(['dtg', 'laser'] as const).map((id, i) => (
          <Reveal index={i} key={id}>
            <article id={id} className="s-anchor s-article">
              <Photo label={by(id).photo} tone={id === 'dtg' ? 'sage' : 'steel'} className="s-article-photo" />
              <div className="s-article-text"><h2 className="s-display s-h-article">{by(id).name}</h2><Details s={by(id)} /></div>
            </article>
          </Reveal>
        ))}
      </section>

      <section id="awards" className="s-wrap s-anchor s-split s-section-bottom">
        <Photo label={by('awards').photo} tone="warm" className="s-split-photo" />
        <Details s={by('awards')} title />
      </section>

      <section className="s-wrap s-section-bottom">
        <div className="s-banner s-banner-tint">
          <div className="s-stack-8">
            <h2 className="s-display">Something else in mind?</h2>
            <p>Describe it in your request. If we can make it, we will tell you how.</p>
          </div>
          <CtaLink to="/order?product=other" />
        </div>
      </section>
    </main>
  )
}
