import { AuthBar } from "./auth-bar";
import { ContactForm } from "./contact-form";
import { Year } from "./year";

const svg = {
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 2,
  strokeLinecap: "round",
  strokeLinejoin: "round",
} as const;

export default function Home() {
  return (
    <>
      <AuthBar />

      <header>
        <div className="container nav">
          <a href="#" className="logo">
            <span className="logo-mark" aria-hidden="true">
              <svg width="18" height="18" viewBox="0 0 24 24" {...svg} stroke="#fff" strokeWidth={2.6}>
                <polyline points="3 17 9 11 13 15 21 7" />
                <polyline points="15 7 21 7 21 13" />
              </svg>
            </span>
            Sales at Scale
          </a>
          <nav className="nav-links">
            <a href="#services">Services</a>
            <a href="#process">How it works</a>
            <a href="#faq">FAQ</a>
          </nav>
          <a href="#contact" className="btn btn-primary">
            Book a call
          </a>
        </div>
      </header>

      <main>
        {/* Hero */}
        <section className="hero">
          <div className="container">
            <span className="eyebrow">B2B sales systems · strategy · execution</span>
            <h1>
              Turn your sales from a hustle into a <span className="gradient-text">repeatable growth engine</span>
            </h1>
            <p>
              We help founders and revenue leaders build the pipeline, process and team needed to grow predictably —
              without burning out the people doing the selling.
            </p>
            <div className="hero-ctas">
              <a href="#contact" className="btn btn-primary">
                Book a free strategy call →
              </a>
              <a href="#services" className="btn btn-ghost">
                See what we do
              </a>
            </div>
          </div>
        </section>

        {/* Problem */}
        <section className="section-alt">
          <div className="container">
            <div className="section-head">
              <div className="kicker">Sound familiar?</div>
              <h2>Growth stalls when sales depends on a few heroes</h2>
              <p>What got you your first customers won&apos;t get you to the next stage.</p>
            </div>
            <div className="problems">
              <div className="problem">
                <h3>Unpredictable pipeline</h3>
                <p>Some months are great, others are empty — and forecasting feels like guesswork.</p>
              </div>
              <div className="problem">
                <h3>Founder-led everything</h3>
                <p>Deals only close when you&apos;re in the room, so you can&apos;t step back and lead.</p>
              </div>
              <div className="problem">
                <h3>New hires ramp slowly</h3>
                <p>There&apos;s no playbook, so every new rep reinvents the wheel and results vary wildly.</p>
              </div>
            </div>
          </div>
        </section>

        {/* Services */}
        <section id="services">
          <div className="container">
            <div className="section-head">
              <div className="kicker">Services</div>
              <h2>Everything you need to scale revenue</h2>
              <p>Pick one area to fix, or let us build the whole system with you.</p>
            </div>
            <div className="grid">
              <div className="card">
                <div className="icon">
                  <svg width="22" height="22" viewBox="0 0 24 24" {...svg}>
                    <circle cx="12" cy="12" r="10" />
                    <circle cx="12" cy="12" r="6" />
                    <circle cx="12" cy="12" r="2" />
                  </svg>
                </div>
                <h3>Go-to-market strategy</h3>
                <p>Get clear on who you sell to, why they buy, and how to reach them.</p>
                <ul>
                  <li>Ideal customer profile &amp; segmentation</li>
                  <li>Positioning and messaging</li>
                  <li>Pricing and packaging review</li>
                </ul>
              </div>
              <div className="card">
                <div className="icon">
                  <svg width="22" height="22" viewBox="0 0 24 24" {...svg}>
                    <path d="M22 12h-4l-3 9L9 3l-3 9H2" />
                  </svg>
                </div>
                <h3>Pipeline generation</h3>
                <p>Build outbound and inbound motions that fill the calendar consistently.</p>
                <ul>
                  <li>Outbound sequences and cadences</li>
                  <li>Lead qualification frameworks</li>
                  <li>Channel testing and optimization</li>
                </ul>
              </div>
              <div className="card">
                <div className="icon">
                  <svg width="22" height="22" viewBox="0 0 24 24" {...svg}>
                    <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
                    <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
                  </svg>
                </div>
                <h3>Sales playbooks &amp; process</h3>
                <p>Document what works so every rep can repeat it.</p>
                <ul>
                  <li>Stage definitions and exit criteria</li>
                  <li>Discovery, demo and objection guides</li>
                  <li>CRM setup and reporting</li>
                </ul>
              </div>
              <div className="card">
                <div className="icon">
                  <svg width="22" height="22" viewBox="0 0 24 24" {...svg}>
                    <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
                    <circle cx="9" cy="7" r="4" />
                    <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
                    <path d="M16 3.13a4 4 0 0 1 0 7.75" />
                  </svg>
                </div>
                <h3>Team building &amp; coaching</h3>
                <p>Hire the right people and help them hit quota faster.</p>
                <ul>
                  <li>Hiring profiles and interview process</li>
                  <li>Onboarding and ramp plans</li>
                  <li>Ongoing deal and call coaching</li>
                </ul>
              </div>
            </div>
          </div>
        </section>

        {/* Process */}
        <section id="process" className="section-alt">
          <div className="container">
            <div className="section-head">
              <div className="kicker">How it works</div>
              <h2>A clear path from where you are to where you want to be</h2>
            </div>
            <div className="steps">
              <div className="step">
                <h3>Diagnose</h3>
                <p>We review your funnel, data, team and deals to find what&apos;s really holding growth back.</p>
              </div>
              <div className="step">
                <h3>Design</h3>
                <p>Together we build a focused plan: targets, motions, process and the metrics that matter.</p>
              </div>
              <div className="step">
                <h3>Deploy</h3>
                <p>We roll it out alongside your team — playbooks, tooling, training and hiring support.</p>
              </div>
              <div className="step">
                <h3>Scale</h3>
                <p>We measure, refine and hand over a system your team can run and grow on its own.</p>
              </div>
            </div>
          </div>
        </section>

        {/* FAQ */}
        <section id="faq">
          <div className="container">
            <div className="section-head">
              <div className="kicker">FAQ</div>
              <h2>Questions, answered</h2>
            </div>
            <div className="faq">
              <details>
                <summary>Who is Sales at Scale for?</summary>
                <p>
                  B2B companies that have found early traction and now need a structured, repeatable way to grow revenue
                  — typically founder-led teams moving to their first sales hires, or teams whose growth has plateaued.
                </p>
              </details>
              <details>
                <summary>Do you do the selling for us?</summary>
                <p>
                  Our focus is building the system and the team so you own your growth long term. Where it helps, we can
                  run parts of the motion with you while your team ramps.
                </p>
              </details>
              <details>
                <summary>How long does an engagement take?</summary>
                <p>
                  It depends on scope. A focused diagnostic can take a few weeks; a full build-out usually runs over a
                  few months. We&apos;ll recommend a scope after the first call.
                </p>
              </details>
              <details>
                <summary>What happens on the strategy call?</summary>
                <p>
                  We&apos;ll talk about your goals, where things are getting stuck and whether we&apos;re a good fit.
                  You&apos;ll leave with at least a few concrete ideas — no obligation.
                </p>
              </details>
            </div>
          </div>
        </section>

        {/* Contact */}
        <section id="contact">
          <div className="container">
            <div className="cta-box">
              <h2>Ready to scale your sales?</h2>
              <p>Tell us a bit about your business and we&apos;ll get back to you to set up a free strategy call.</p>
              <ContactForm />
            </div>
          </div>
        </section>
      </main>

      <footer>
        <div className="container footer-inner">
          <span>
            © <Year /> Sales at Scale. All rights reserved.
          </span>
          <nav className="nav-links" style={{ display: "flex" }}>
            <a href="#services">Services</a>
            <a href="#process">How it works</a>
            <a href="#contact">Contact</a>
          </nav>
        </div>
      </footer>
    </>
  );
}
