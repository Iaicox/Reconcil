import { CONTACT_MAILTO } from '../_lib/site';
import { ButtonLink, Container, DoubleRule, RuledLink } from './ui';

// Validation-honest closing CTA. The point of the page is to recruit interview subjects,
// so the ask is a conversation, not a signup.
export function CtaBand() {
  return (
    <section className="py-20 sm:py-28">
      <Container>
        <div className="border border-rule bg-surface px-6 py-14 text-center sm:px-16 sm:py-16">
          <h2 className="text-3xl font-semibold tracking-[-0.02em] text-balance sm:text-4xl">
            Want to shape it?
          </h2>
          <DoubleRule className="mx-auto mt-6 w-24" />
          <p className="mx-auto mt-6 max-w-xl text-lg leading-relaxed text-ink-2 text-pretty">
            We&rsquo;re talking to a handful of teams that invoice in stablecoins and the
            accountants who serve them. If that&rsquo;s you, a 20-minute conversation would help a
            lot.
          </p>
          <div className="mt-8 flex flex-col items-center justify-center gap-4 sm:flex-row sm:gap-5">
            <ButtonLink href={CONTACT_MAILTO} className="h-[46px] px-[22px] text-sm">
              Book 20 minutes
            </ButtonLink>
            <RuledLink href={CONTACT_MAILTO} className="text-[13.5px]">
              or email instead
            </RuledLink>
          </div>
        </div>
      </Container>
    </section>
  );
}
