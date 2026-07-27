import { Audience } from './_components/Audience';
import { CtaBand } from './_components/CtaBand';
import { Differentiators } from './_components/Differentiators';
import { Footer } from './_components/Footer';
import { Hero } from './_components/Hero';
import { HowItWorks } from './_components/HowItWorks';
import { Nav } from './_components/Nav';
import { Problem } from './_components/Problem';

export default function Home() {
  return (
    <>
      <Nav />
      <main>
        <Hero />
        <Problem />
        <HowItWorks />
        <Differentiators />
        <Audience />
        <CtaBand />
      </main>
      <Footer />
    </>
  );
}
