import { Link } from 'react-router'
import { ArrowRight } from 'lucide-react'
import { business } from '@shared/business'
import { Photo } from './Photo'
import { Reveal } from './Reveal'
import { CtaLink, usePageTitle } from './StoreLayout'

const { storefront } = business
const service = (id: string) => storefront.services.find((s) => s.id === id)!
const Blurb = ({ id }: { id: string }) => <><p className="s-desktop-only">{service(id).card}</p><p className="s-phone-only">{service(id).short}</p></>
const STEPS = [
  { title: 'Tell us what you need', body: 'Pick a product, add quantities and sizes, and upload your artwork. A rough sketch is fine.' },
  { title: 'Get a quote', body: 'We price your order. If it uses artwork, we show you a proof before anything is made.' },
  { title: 'Approve, then pick up', body: 'Once you approve, we make it and let you know when it is ready.' },
]

export default function HomePage() {
  usePageTitle('Custom printing, embroidery and engraving')
  return (
    <main>
      <section className="s-wrap s-hero">
        <div className="s-hero-copy">
          <h1 tabIndex={-1} className="s-display s-h-hero">{storefront.headline}</h1>
          <p className="s-lead">{storefront.intro}</p>
          <div className="s-hero-actions">
            <CtaLink>Start an order <ArrowRight aria-hidden size={18} /></CtaLink>
            <Link to="/services" viewTransition className="s-btn-ghost">See our services</Link>
          </div>
        </div>
        <div className="s-hero-photos">
          <Photo label="embroidered team polo, close-up" tone="blue" className="s-hero-main" />
          <Photo label="tees on the press" tone="sand" className="s-desktop-only" />
          <Photo label="engraved tumbler" tone="sage" className="s-desktop-only" />
        </div>
      </section>

      <section className="s-wrap s-section-tight">
        <h2 className="s-display s-h-section s-mb">What we make, and how we make it.</h2>
        <div className="s-bento">
          <Reveal className="s-cell-a">
            <Link to="/services#screen" viewTransition className="s-tile s-tile-column">
              <Photo label="screen-printed school shirts" tone="blue" className="s-tile-photo" />
              <div className="s-tile-text"><h3 className="s-display s-h-tile">{service('screen').name}</h3><Blurb id="screen" /></div>
            </Link>
          </Reveal>
          <Reveal className="s-cell-b" index={1}>
            <Link to="/services#embroidery" viewTransition className="s-tile s-tile-split">
              <div className="s-tile-text s-tile-end"><h3 className="s-display s-h-tile">{service('embroidery').name}</h3><Blurb id="embroidery" /></div>
              <Photo label="stitched cap" tone="sand" className="s-tile-photo" />
            </Link>
          </Reveal>
          <Reveal className="s-cell-c" index={2}>
            <Link to="/services#dtg" viewTransition className="s-tile s-tile-accent">
              <Photo label="" bare tone="sage" className="s-tile-photo s-phone-only" />
              <div className="s-tile-text-plain"><h3 className="s-display s-h-tile-small">{service('dtg').name}</h3><Blurb id="dtg" /></div>
            </Link>
          </Reveal>
          <Reveal className="s-cell-d" index={3}>
            <Link to="/services#laser" viewTransition className="s-tile s-tile-steel">
              <Photo label="" bare tone="steel" className="s-tile-photo s-phone-only" />
              <div className="s-tile-text-plain"><h3 className="s-display s-h-tile-small">Laser engraving</h3><Blurb id="laser" /></div>
            </Link>
          </Reveal>
          <Reveal className="s-cell-e" index={1}>
            <Link to="/services#awards" viewTransition className="s-tile s-tile-wide">
              <Photo label="a row of finished team trophies" tone="warm" className="s-tile-photo" />
              <div className="s-tile-text s-tile-center"><h3 className="s-display s-h-tile">{service('awards').name}</h3><Blurb id="awards" /></div>
            </Link>
          </Reveal>
        </div>
      </section>

      <section id="schools" className="s-tint">
        <div className="s-wrap s-split s-section">
          <Photo label="a stack of folded spirit shirts" tone="deep" className="s-split-photo" />
          <div className="s-stack-22">
            <p className="s-eyebrow">For schools and districts</p>
            <h2 className="s-display s-h-section">We know how school ordering works.</h2>
            <p className="s-body">Ordering on a purchase order? Attach it when you send your request. We confirm every PO with you before anything goes into production.</p>
            <div className="s-desktop-only"><CtaLink /></div>
          </div>
        </div>
      </section>

      <section id="how" className="s-wrap s-section">
        <h2 className="s-display s-h-section s-mb-lg">From idea to pickup.</h2>
        <ol className="s-steps">
          {STEPS.map((step, i) => (
            <Reveal as="li" index={i} key={step.title}>
              <span aria-hidden className="s-display s-step-number">{i + 1}</span>
              <div>
                <h3 className="s-display s-h-step">{step.title}</h3>
                <p>{step.body}</p>
              </div>
            </Reveal>
          ))}
        </ol>
      </section>

      <section className="s-wrap s-section-tight s-desktop-only">
        <div className="s-banner">
          <h2 className="s-display">Have an idea? We would love to see it.</h2>
          <CtaLink />
        </div>
      </section>
    </main>
  )
}
