import { CONTACT_MAILTO } from '../_lib/site';
import { ArrowIcon, ButtonLink, Container } from './ui';

// Validation-honest closing CTA. The point of the page is to recruit interview subjects,
// so the ask is a conversation, not a signup.
export function CtaBand() {
  return (
    <section className="py-20 sm:py-28">
      <Container>
        <div className="relative overflow-hidden rounded-3xl bg-gradient-to-br from-emerald-600 to-teal-600 px-8 py-16 text-center sm:px-16">
          <h2 className="text-3xl font-bold tracking-tight text-white text-balance sm:text-4xl">
            Want to shape it?
          </h2>
          <p className="mx-auto mt-4 max-w-xl text-lg text-emerald-50 text-pretty">
            We&rsquo;re talking to a handful of teams that invoice in stablecoins and the
            accountants who serve them. If that&rsquo;s you, a 20-minute conversation would help a
            lot.
          </p>
          <div className="mt-8 flex justify-center">
            <ButtonLink
              href={CONTACT_MAILTO}
              className="bg-white text-emerald-700 hover:bg-emerald-50"
            >
              Get in touch
              <ArrowIcon className="h-4 w-4" />
            </ButtonLink>
          </div>
        </div>
      </Container>
    </section>
  );
}
