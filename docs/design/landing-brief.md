# Reconcil — Project & Landing Design Brief

> For a designer working on the landing page. Written 2026-07-28.
> Product source of truth: [`../brief.md`](../brief.md). Current page: [`../../site/`](../../site/).

---

## Резюме на русском (для быстрого обсуждения)

**Что это.** Reconcil — self-hosted инструмент для бухгалтерии по криптоплатежам. Главный
сценарий: компании выставляют счета и получают оплату стейблкоинами (USDC/EURC) в сети
Ethereum или Base, а бухгалтерия ведётся в EUR/USD. Reconcil сам сопоставляет входящие
он-чейн платежи со счетами (включая частичные оплаты, переплаты и комиссии сети),
фиксирует курс на дату платежа, размечает НДС и выгружает черновики проводок для
QuickBooks/Xero. Каждая цифра прослеживается до хеша транзакции.

**Чем отличается.** Три вещи, которые не делают конкуренты (Cryptio, Bitwave, Cryptoworth,
TRES) одновременно:

1. **Self-host.** `docker compose up` — данные не покидают инфраструктуру клиента (аргумент
   про GDPR, который бухгалтер может показать своему клиенту).
2. **MCP-native.** Интерфейс — не дашборд, а 19 MCP-инструментов, которыми управляют из
   Claude обычным текстом. Учить нечего.
3. **Детерминизм и аудируемость.** Модель никогда не считает сама. Все числа —
   детерминированные функции, каждая цифра сводится к хешам транзакций и ID вызовов
   инструментов. Это буквально контракт, а не обещание.

Плюс: read-only by design (нет ключей, нет кастодиала, нет торговли — соответствие MiCA),
Apache-2.0.

**Стадия и цель лендинга.** Продукт написан и работает, но это **фаза валидации**: нужны
8–10 проблемных интервью с бухгалтерами и SMB, тест цены и ≥3 LOI. Конверсия лендинга —
**разговор на 20 минут**, а не регистрация. Отсюда главное ограничение дизайна: страница
должна выглядеть честно-ранней. Нельзя логотипы «нам доверяют», нельзя выдуманные метрики
(«экономит 10 часов в месяц»), нельзя фейковый дашборд. Всё, что показываем, должно быть
правдой — это тот же принцип, что внутри продукта.

**Главная сложность для дизайна.** У продукта **нет GUI**. Веб-дашборд сознательно вынесен
за MVP. «Экран продукта» — это диалог в Claude, терминал, CSV-файл проводок и JSON
цитирования. Значит нельзя нарисовать привычный hero-скриншот приложения. Нужно придумать,
как показать невидимый продукт: реальный диалог, реальный артефакт выгрузки, реальный след
аудита. Сейчас на странице нет **ни одного** визуала продукта — это дыра №1.

**Что уже есть.** Живая страница: `https://iaicox.github.io/Reconcil/`. Next.js 15 + React 19
+ Tailwind v4, статический экспорт на GitHub Pages. Секции: Nav → Hero → Problem →
How it works (4 шага) → Why it's different (5 карточек) → Who it's for (2 карточки) →
CTA → Footer. Цвета: emerald/teal акцент на нейтральном zinc, шрифт Inter, тёмная тема по
системной настройке, без иллюстраций и без картинок вообще. Текст сильный, структура
разумная, но выглядит как «ещё один темплейт дев-тула»: нет доказательств, нет продукта в
кадре, нет секции доверия.

**Что нужно от дизайнера** (подробно в разделе 10 ниже): концепция подачи продукта без
скриншотов, секция доверия/красных линий, переработанный hero, единый визуальный язык для
«артефактов» (диалог / терминал / CSV / хеш), light + dark токены, OG-картинка и лого.

---

## 1. The product in one paragraph

Reconcil is a self-hostable, MCP-native on-chain accounting ledger. It ingests EVM wallet
activity (Ethereum and Base; native transfers and ERC-20 transfers), normalizes it into an
append-only event ledger, and computes everything deterministically. On top of that ledger
sit two capabilities: **on-chain analytics and reporting** (balances, flows, gas,
counterparties, stablecoin movements, monthly close pack, PDF summary) and **stablecoin
payment ↔ invoice reconciliation** (import invoices, match settlements, confirm, export
QuickBooks/Xero journal drafts). All of it is exposed to an LLM through 19 MCP tools, so
the user interface is a conversation in Claude rather than a dashboard.

Three depths, for whatever the design needs:

- **Six words:** Crypto invoices, reconciled on your infrastructure.
- **One line:** Reconcil matches on-chain stablecoin payments to your invoices and hands
  your accountant review-ready journal drafts — self-hosted, deterministic, traceable to
  the transaction hash.
- **Full:** the paragraph above.

## 2. The problem, concretely

A European agency invoices a client €12,000. The client pays in USDC on Base on the 17th, in
two transfers, one of which is short because of a fee on their side. The agency's books are
in EUR.

To close the month, someone must: find those two transfers among everything else the wallet
did; decide they belong to invoice INV-2026-0043 and not to another one; total them; notice
the invoice is only partially settled; convert to EUR at the rate on the settlement date
(not today's rate, not the invoice date's rate); split out VAT; and write journal lines a
reviewer will accept. Then do it forty more times. Then, six months later, answer an auditor
asking *how exactly* that figure was derived.

Today that is a spreadsheet, a block explorer in another tab, and trust. It is slow, it is
error-prone in a way that compounds silently, and it is very hard to defend after the fact.

**The pain in one sentence, for the page:** money arrives on-chain, the books are in fiat,
and everything between those two facts is manual.

## 3. Who it is for

Two audiences, both real, with different anxieties. The page must speak to both without
splitting in half.

| | **Teams paid in stablecoins** | **The accountants who close them** |
|---|---|---|
| Who | EU SMBs, freelancers, agencies invoicing in USDC/EURC | Solo accountants and small firms with crypto-paid clients; DAO and crypto-company finance teams |
| Job to be done | "Tell me which invoices are actually paid, and don't make me chase transfers" | "Give me numbers I can put my name on and defend to a tax authority" |
| Wins with | Speed, less manual chasing, a month-end that ends | Determinism, citation trail, human-in-the-loop confirmation, drafts rather than auto-postings |
| Fears | Another crypto tool that breaks; handing over wallet data | Being wrong; an AI silently inventing a number; client data leaving their control |
| Buys because | It removes a recurring chore | It removes professional risk |

Note the asymmetry: the SMB feels the pain, the accountant carries the risk. **The
accountant is the harder and more valuable one to convince, and their objections are all
about trust.** Design should weight trust over excitement.

## 4. What it actually does

### Face A — analytics and reporting

Natural-language questions answered from the deterministic ledger. These are verbatim from
the eval suite that gates every release, so they are safe to use as real copy:

- "What was the USDC balance of the ops wallet on 2026-06-30?"
- "How much did I actually send to outside parties? Don't count moves between my own wallets."
- "Break down my gas costs by month."
- "Who are my top counterparties by total turnover?"
- "Explain how you arrived at the gas figure from my previous question — show the underlying events."

Plus two exports: a **monthly close pack** (7 files, each name carrying the period —
`transactions_2026-06.csv`, `balances_opening_2026-06.csv`, `balances_closing_2026-06.csv`,
`gas_2026-06.csv`, `counterparty_summary_2026-06.csv`, `journal_draft_2026-06.csv`,
`manifest.json`) and a **PDF summary**.

### Face B — reconciliation (the headline story)

Four steps, currently the spine of the page and worth keeping:

1. **Import invoices** — CSV in, receivables and payables, any currency, deduplicated on
   re-import.
2. **Match payments** — a deterministic engine proposes many-to-many matches across partial
   payments, overpayments and network fees. Confidence is a sum of weighted rules, not a
   model's opinion.
3. **Confirm** — a human approves each match. Record status moves through open → partial →
   paid → overpaid.
4. **Export** — EUR/USD fixed at payment date, VAT split out, emitted as QuickBooks or Xero
   manual-journal drafts for review.

### The surface

19 MCP tools, grouped by namespace: `analytics_*` (6), `recon_*` (5), `export_*` (3),
`ledger_*` (3), `directory_*` (2). Ten are read-only; the rest write or produce files.
Nothing in the system deletes or mutates ledger data.

## 5. Positioning and differentiation

Incumbents: **Cryptio, Bitwave, Cryptoworth, TRES.** Hosted SaaS, closed, priced for larger
customers, and — TRES aside — not agent-native. None of them let you run the whole thing on
your own box.

Reconcil's five claims, ordered by how much they matter to the accountant:

1. **Deterministic and auditable.** The model never does the math. Every figure in an answer
   reduces to transaction hashes and tool-call IDs. Citation is part of the tool contract —
   a number without provenance is treated as a bug, and the release gate blocks on it.
2. **Read-only by design.** No private keys, no custody, no trade execution, and the agent is
   guardrailed against investment advice. Journal entries are drafts for professional review.
   A deliberate MiCA posture, enforced down to a CI rule that bans signing libraries from the
   dependency tree.
3. **Self-hostable.** `docker compose up` brings up the whole stack. Client data never leaves
   the client's infrastructure — the GDPR argument an accountant can forward to their own
   customer.
4. **MCP-native.** Nineteen tools driven from Claude or any compatible client in plain
   language. No dashboard to learn, no seat to onboard.
5. **Open source.** Apache-2.0 for everything needed to self-host. Inspect it, run it,
   extend it.

**The line that ties it together:** *not another hosted dashboard that holds your data —
infrastructure you own, that can show its work.*

## 6. Honesty constraints (non-negotiable, and they shape the design)

The product's core principle is that nothing is asserted without provenance. The page must
not violate that principle in its own marketing, because the target audience is
professionally trained to notice.

**Not allowed on the page:**

- Customer logos, "trusted by", testimonials — there are no customers yet.
- Invented metrics: hours saved, % faster, accuracy figures, user counts, funding.
- A fabricated product screenshot, or a dashboard mockup for a dashboard that does not exist.
- Anything that reads as financial or investment advice.
- Language implying auto-posting into accounting systems. Output is **drafts for review**.
- Signup, pricing or trial flows. There is no billing pre-gate, and a fake one would poison
  the interviews.

**Available and true:** 19 MCP tools · Apache-2.0 · `docker compose up` · Ethereum + Base ·
QuickBooks and Xero journal drafts · read-only, no keys · every figure traceable to a tx hash ·
a 30-case agent eval suite gating each release · full architecture and 13 decision records
public in the repo.

**Tone:** plain, precise, slightly understated. Confident about the engineering, honest about
the stage. The line currently on the page — "early, and validating with a handful of teams" —
is exactly the right register; the design should make that read as integrity, not apology.

## 7. The hard design problem: there is no GUI

The web dashboard is explicitly out of MVP scope. The product runs headless: a server and a
set of tools that Claude calls. There is no screen to photograph, and inventing one is
off-limits (§6).

So the central creative question is: **how do you make an invisible product feel real and
trustworthy in a hero section?**

Raw materials that genuinely exist and can be shown. **All of these are quoted verbatim, with
sources, in [`real-materials.md`](real-materials.md)** — use that file rather than
reconstructing anything from the summaries below:

- **A real conversation.** A question in plain language; an answer with a figure and a
  citation. The closest thing to "the product in use."
- **The citation envelope.** Every response carries a `tool_call_id`, coverage, event refs
  (chain id, tx hash, log index), pinned price and FX snapshot IDs, and machine-readable
  warnings. Rendering that trail — a number that unfolds into its evidence — is the single
  most differentiating visual available.
- **The output artifact.** A journal-draft CSV with real column headers, balanced debits and
  credits, a VAT split. Accountants trust file formats they recognize.
- **The terminal.** `docker compose up`, one command, stack running.
- **The architecture.** C4 diagrams exist in the repo; the self-host boundary — what stays on
  your infrastructure versus what leaves — is a genuinely clarifying picture for the GDPR
  argument.
- **The tool surface.** Nineteen named tools grouped by namespace: concrete, countable, and it
  communicates scope better than any adjective.

Directions worth exploring together: an interactive "figure → evidence" unfold; a paired
before/after (spreadsheet chaos versus a clean matched record); a three-panel "invoice +
on-chain transfer + resulting journal line" triptych; a stylized conversation that is honest
about being an illustration.

## 8. Current state of the page

**Live:** `https://iaicox.github.io/Reconcil/` · **Repo:** [`../../site/`](../../site/)
(a standalone Next.js app, deliberately outside the pnpm workspace — see
[`../../site/README.md`](../../site/README.md)).

**Stack constraints the design must live within:**

- Next.js 15 App Router · React 19 · TypeScript · Tailwind CSS v4 (CSS-first `@theme`).
- **Static export** (`output: 'export'`) deployed to GitHub Pages. No server, no API routes,
  no server-side form handling, no image optimizer.
- Font: Inter, self-hosted via `next/font` — deliberately no runtime call to Google, which is
  on-message for a self-hostable product. Any new font must be self-hostable the same way.
- Dark mode via `prefers-color-scheme` only, no toggle. **Both themes must be designed.**
- `basePath` is `/Reconcil` in production, so asset paths must stay relative-safe.
- No analytics, no cookies, no consent banner today. Keeping it that way is on-message.
- `site/public/` is empty — there is not a single image on the site. Assets are welcome, but
  inline SVG is preferred over raster.

**Current sections and how they read:**

| Section | Content | Assessment |
|---|---|---|
| Nav | Wordmark + GitHub link, sticky, translucent | Fine. No CTA in the bar — probably a miss. |
| Hero | Eyebrow pill "Open-source · Self-hosted · MCP-native", headline with an emerald→teal gradient on "on your own infrastructure", three-line subhead, two buttons, honesty line | Copy is strong but dense. Purely typographic, no visual, indistinguishable from a template. |
| Problem | "Stablecoin invoicing breaks your books" plus two paragraphs, centered | Good writing, but a wall of prose where a diagram would land harder. |
| How it works | Four numbered cards: import → match → confirm → export | The strongest section structurally. Zero visual support. |
| Why it's different | Five icon cards (self-host, MCP-native, deterministic, read-only, open source) | Correct content, flat hierarchy — all five weighted equally when the first two should dominate. |
| Who it's for | Two cards | Thin. Doesn't help either audience self-identify quickly. |
| CTA band | Emerald→teal gradient panel, "Want to shape it?", 20-minute interview ask | Right ask, right register. |
| Footer | Wordmark, disclaimer, GitHub / Contact / Apache-2.0 | Fine. |

**Palette today:** zinc neutrals (white and `zinc-950` backgrounds), emerald-600→teal-500
accent on the eyebrow pill, step numbers, icon chips, headline gradient and CTA band. Radii
`2xl` on cards, `3xl` on the CTA panel. Generous vertical rhythm (80–112px section padding).

**Honest summary of the gap:** the positioning is right and the copy is above average, but the
page has no evidence layer, no product in frame, no trust section, and no visual identity
beyond "Tailwind emerald". It converts on words alone. For an audience whose entire concern is
*can I trust this*, that is not enough.

## 9. Conversion goal and success metric

**The only conversion is a booked conversation.** Today that is a `mailto:` with the subject
"Reconcil — interview" (single source: `site/app/_lib/site.ts`).

The interview ask deserves to be designed as its own moment, not a generic contact form. It
works better when it states what the visitor gets and what it costs them: twenty minutes, no
pitch, a look at how they close crypto-paid invoices today, and early access shaped by what
they say. Also worth designing: a secondary, lower-commitment path for people who are not
ready to talk (star the repo, read the architecture), so the page does not fail closed for the
95% who will not email.

**Success:** 8–10 qualified problem interviews and ≥3 letters of intent or paid pilots. That
gate decides whether this becomes a product or stays a portfolio piece — so the page has
exactly one job, and it is not looking impressive.

Secondary audiences the page will also receive: developers evaluating an OSS self-host, and
technical hiring managers. Both are served well by a credible, restrained, engineering-honest
page — the same design that convinces an accountant. Neither should get its own section above
the fold.

## 10. What we need from the designer

**Primary deliverables**

1. **Hero concept** — the answer to §7. Desktop and mobile. This is the piece the whole
   project turns on. The lead story is settled (§11 Q1): **headline carries the outcome, the
   visual carries the proof.** Concretely:
   - **H1 — the outcome**, phrased so both audiences read it. Today's headline leads with
     *"on your own infrastructure"*, which is claim #3 of 5 in accountant priority (§5) and,
     per Q3 below, may read as risk to a non-technical accountant. Self-host moves down into
     the proof strip; it is a reason to believe, not the promise.
   - **Subhead — one clause, not three.** The bridge sentence already exists at the end of
     today's subhead: *"Every figure traces back to a transaction hash."* Promote it to its own
     line and move the feature enumeration (partial payments, FX at payment date, VAT, journal
     drafts) down into "How it works".
   - **Visual — one figure that unfolds into its evidence.** A single matched settlement:
     amount, the invoice it settles, then the citation row beneath it (chain · tx hash · pinned
     price/FX snapshot ID · `tool_call_id`). Static-first, so it survives static export and
     mobile; any unfold is progressive enhancement (see Q5). The figure must come from the real
     eval/seed fixture — an invented number here would break §6 in the one place the page is
     claiming it never happens.
   - **Below the fold, rank unchanged:** the trust / red-lines section keeps the §5 claim order.
2. **A visual language for "artifacts"** — one reusable treatment for the conversation,
   terminal, CSV and hash-trail objects, so they read as one system rather than four widgets.
   Both themes.
3. **Revised section architecture.** Decided 2026-07-28 — four additions, two rejections:
   - **Product in action** (new) — the artifacts from [`real-materials.md`](real-materials.md).
     The close pack's seven files live here as one of those artifacts, not as their own section.
   - **Trust / red lines** (new) — read-only, no keys, drafts for review, data stays on your
     infrastructure. Keeps the §5 claim order.
   - **Face A — analytics**, using the verbatim eval questions (§4). Cheap, true, and it shows
     the product is more than the reconciliation spine.
   - **FAQ for the accountant** — MiCA, GDPR, drafts-not-postings. These are the objections
     that stop someone from booking the call; answering them in the open is on-message.
   - **No competitor comparison table.** Pre-gate we cannot substantiate claims about Cryptio,
     Bitwave, Cryptoworth or TRES, the table ages badly, and it invites "why not just use
     Cryptio" from a visitor who was not otherwise asking. The positioning line in §5 carries
     the same weight in one sentence. Revisit post-gate.
   - **No standalone "project stage" section.** The honesty line belongs in the hero and in the
     CTA band, where it explains why the ask is a conversation. Given a section of its own it
     reads as apology rather than integrity.

   Target order: Nav → Hero → Problem → How it works → **Product in action** →
   **Trust / red lines** → **Face A** → Who it's for → **FAQ** → CTA (stage line here) → Footer.
4. **Color and type tokens**, light and dark, mappable to Tailwind v4 `@theme` variables.
   Numbers, amounts and hashes need a monospace with tabular figures — this product is about
   figures and they should look like figures. **Accent decided 2026-07-28: a muted ink base
   plus a single warm mark (ochre / cinnabar), and that same warm mark is the only accent on
   the CTA.** The colour must be *semantic, not decorative* — it marks "needs attention":
   an unmatched settlement, the `DRAFT — REVIEW REQUIRED` banner, a warning code. That is how
   audit markup actually behaves, it gives the artifact visuals a working colour language
   instead of leaving the page grey, and it is maximally far from the crypto-green template.
   Emerald/teal is retired (it was a Tailwind default, and there is no recognition to protect);
   indigo was considered and rejected as generic fintech blue. Check the warm mark in both
   themes — it must not read as "error".
5. **Iconography direction** — the current icons are hand-rolled inline SVG; a coherent set,
   or a decision to standardize on one open icon library, would help.
6. **Brand basics** — wordmark and logo mark refinement, favicon, OG image (there is none
   today, so every shared link renders as a bare card).

**Round one, decided 2026-07-28:** two hero directions, then the full page on the chosen one.
What varies between them is **which artifact leads** — a document-first hero (the journal draft
/ ledger register) versus an evidence-first hero (one figure unfolding into its citation) — not
colour or mood. The story is fixed by Q1 and the aesthetic register is specified above, so a
third comp would be paid iteration on a settled question; a single comp would gamble the most
important screen on one reading of the one genuinely open problem (§7).

**Explicitly out of scope:** a dashboard UI, a pricing page, a signup flow, a blog.

**Aesthetic direction to discuss:** the target is *audit-grade instrument*, not *crypto
product* — closer to a precision tool or a well-set financial document than to web3. Avoid:
neon gradients, glassmorphism, floating 3D coins, animated blockchain networks, purple on
black. Fits: restraint, real data, monospace where numbers live, generous whitespace, one
confident accent, a diagram that actually explains something. The accent itself is no longer
open — emerald/teal was a default, not a decision, and it has been replaced by the ink + single
warm mark settled in deliverable 4 above.

## 11. Open questions to settle together

1. ~~**Which story leads the hero**~~ — **decided 2026-07-28: both, split by role. The headline
   states the outcome ("know which invoices are actually paid"); the hero visual carries the
   proof (the citation trail).** Not a compromise — the standard division of labour: a headline
   states the job to be done, the evidence layer earns belief. Trust is a qualifier, not a hook;
   nobody books a twenty-minute call because of a hash, but an accountant will refuse one
   without it. This also keeps the two strongest assets in play at once — the outcome is the
   only thing an SMB can act on, and the citation envelope is the most differentiating visual
   available (§7). The failure mode is a hybrid that stays abstract, so the split is pinned down
   in §10 deliverable 1 rather than left to interpretation.
2. **How to show the agent** without implying the AI does the arithmetic. The product's whole
   claim is the opposite, so a conversation visual needs careful framing. Constraint, not an
   answer: the REPL frame and the eval questions are real and quotable, but **no assistant prose
   exists in captured form** — see [`real-materials.md`](real-materials.md) §7 for what may and
   may not be written into a conversation visual.
3. **How prominent is "open source / self-host"?** The strongest differentiator against
   incumbents, but it means nothing to a non-technical accountant and may even read as risk.
4. **Do we keep the two-audience split**, or pick the accountant as the primary voice and let
   the SMB read along? Q1 largely answers this above the fold — the SMB gets the headline, the
   accountant gets the visual — so the open part is only how far down the page the split still
   needs to be made explicit (today: the thin "Who it's for" section).
5. **Is any interactivity worth it** on a static export — an unfoldable citation trail, a
   stepped walkthrough — or does motion undercut the sober register?
6. **Naming and mark.** "Reconcil" is the product name; is the current bare wordmark enough, or
   does the page need a mark with more character?
7. ~~**Interview CTA mechanics**~~ — **decided 2026-07-28: a scheduling link is primary, the
   `mailto:` stays as the secondary path.** Composing an email is the largest drop-off in the
   only funnel this page has, and the gate needs 8–10 conversations; some accountants will
   nonetheless never use a scheduler, so both paths ship. **Link-out only — never an embedded
   widget:** an outbound link adds no script, no cookie, no consent banner and nothing for the
   static export to break on, which keeps the "no analytics, no cookies" posture literally
   true. Keep the third, lowest-commitment path (repo, architecture docs) so the page does not
   fail closed for the 95% who will not book.

---

## Further reading

- [`real-materials.md`](real-materials.md) — **start here for anything you need to render**:
  the journal-draft CSV, the citation envelope, the trace call, the matching rationale, the
  REPL frame and the eval questions, all quoted verbatim with sources.
- [`../brief.md`](../brief.md) — canonical product brief: scope, principles P1–P12, kill list,
  validation gate.
- [`../README.md`](../README.md) — reading order and ADR index for the whole design pack.
- [`../architecture/00-overview.md`](../architecture/00-overview.md) — C4 diagrams; the LLM
  boundary and the self-host boundary, both useful as landing visuals.
- [`../architecture/02-mcp-contracts.md`](../architecture/02-mcp-contracts.md) — the citation
  envelope in full, if the design leans on the evidence trail.
- [`../../site/README.md`](../../site/README.md) — how the current page is built and deployed.
