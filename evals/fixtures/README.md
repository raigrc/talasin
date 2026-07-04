# Voice eval fixtures — recording protocol

These 8 scripted passages are the ground truth for `npm run eval:voice`
(AI_DESIGN.md §1.9). Each has a **known word count** and a **known planted
filler pattern**, so the only unknowns after you record are the clip duration
(you measure it) and what Gemini does with the audio (the eval measures that).

The transcripts, word counts, and filler counts are **already filled in** in
`manifest.json`. You only need to: record, drop the files in `audio/`, and
fill in `duration_seconds`.

---

## How to record

1. **Device:** your phone's voice recorder is fine (it produces `.m4a` =
   `audio/mp4`, which is accepted). Windows Sound Recorder or Audacity
   (export WAV) also work.
   Accepted formats (same allowlist the app's upload route enforces):
   `webm`, `ogg`, `m4a`/`mp4`, `mp3`, `wav`, `aac`, `flac`, `aiff`.
2. **Room:** quiet room, no fan/aircon hum if possible, phone ~20 cm from
   your mouth. Background noise inflates WER for reasons that aren't the
   model's fault.
3. **Read the script EXACTLY as printed — including every bolded filler.**
   The planted "um"s and "like"s ARE the test. Don't ad-lib, don't skip,
   don't add your own fillers. If you fumble a line, stop and re-record the
   whole clip. Ground truth only works if the recording matches the script.
4. **Pace:** each script has a pace note. For the slow/fast ones, keep a
   stopwatch visible and aim to finish near the target time (±5 s is fine —
   the WPM ground truth comes from the *measured* duration, not from hitting
   the target; the target just creates the slow/normal/fast spread the eval
   wants).
5. **Save as** the exact filename listed per script, into
   `evals/fixtures/audio/`. If your recorder produced a different extension
   (e.g. `.wav` instead of `.m4a`), update the `audio` field in
   `manifest.json` to match.
6. **Measure the exact duration** and put it in `duration_seconds` in
   `manifest.json` (decimals allowed, e.g. `57.4`). Best tool:

   ```
   ffprobe -v error -show_entries format=duration -of default=nw=1:nk=1 "evals/fixtures/audio/s1-baseline.m4a"
   ```

   No ffprobe? Open the file in VLC → Tools → Media Information → duration,
   or check the file's Properties → Details in Explorer (seconds precision is
   acceptable, sub-second is better). Do NOT eyeball it from memory — WPM
   truth is `word_count / duration`, so a sloppy duration poisons the gate.
7. Keep every clip between ~15 s and 120 s (the app rejects >130 s).

Then run:

```
npm run eval:voice
```

~16 requests (8 fixtures x 2 runs) paced 7 s apart ≈ 2–3 minutes. Use
`--runs 3` for the full §1.9 stability check when you have quota headroom.

---

## The scripts

Planted fillers are **bolded**. Read them as naturally as you can — they're
supposed to sound like real hesitation, not like you're reading a list.

### s1 — Baseline (`audio/s1-baseline.m4a`)
**Pace:** natural, ~57 s. **132 words, 0 fillers.** Clear beginning/middle/end.
**Prompt context:** "Tell me about a project you are proud of."

> Last year I led the migration of our reporting pipeline from nightly batch
> jobs to a streaming setup. The old system took nine hours to refresh, and
> the sales team kept making decisions on stale numbers. I proposed the
> change, mapped every downstream dependency, and wrote the plan the team
> executed over six weeks. My main contribution was the cutover strategy. We
> ran both systems in parallel for two weeks and compared outputs row by row
> until the differences dropped to zero. When we flipped the switch, nothing
> broke, and refresh time went from nine hours to under five minutes. The
> result changed how the company works. Sales now trusts the dashboard enough
> to check it during client calls, and two other teams copied our parallel
> cutover playbook for their own migrations.

### s2 — Slow pace (`audio/s2-slow-pace.m4a`)
**Pace:** deliberately slow — finish in ~60 s (~110 WPM). **113 words, 0 fillers.**
**Prompt context:** "How do you mentor junior developers?"

> When I mentor junior developers, I focus on one habit above everything
> else. I teach them to read the error message twice before touching the
> keyboard. Most beginners panic and start changing code at random. That
> wastes hours and hides the real cause. Instead, I ask them to explain the
> failure to me in one plain sentence. If they can describe what broke, they
> can usually find where it broke. Over six months, my last mentee went from
> asking for help every day to shipping features on her own. Slowing down at
> the start is what made her faster in the end, and it is the first thing I
> teach every new hire.

### s3 — Fast pace (`audio/s3-fast-pace.m4a`)
**Pace:** brisk — finish in ~60 s (~185 WPM). Stay articulate, don't slur.
**183 words, 0 fillers.**
**Prompt context:** "Tell me about the hardest bug you ever fixed."

> The hardest bug I ever chased was a payment failure that only happened on
> the last day of the month. Customers reported charges that vanished,
> support tickets piled up, and nobody could reproduce it in staging. I
> started by pulling every failed transaction from the previous quarter and
> lining them up by timestamp. The pattern jumped out immediately. Every
> failure landed within two minutes of midnight on the thirty first. Our
> invoice generator locked the same database table the payment service
> needed, and on long months the batch ran heavy enough to hold that lock
> past the timeout. The fix took one afternoon once we understood it. We
> moved invoice generation to a read replica and added an alert on lock wait
> time. The lesson stayed with me longer than the fix. When a bug seems
> random, the randomness is almost always a calendar, a timezone, or a queue
> you have not looked at yet. Since then I always graph failures against time
> before I read a single line of code, because the shape of when tells you
> more than the stack trace.

### s4 — Light filler (`audio/s4-light-filler.m4a`)
**Pace:** natural. **126 words, 7 planted fillers: um ×4, like ×2, you know ×1.**
**Prompt context:** "What is your biggest weakness?"

> **Um,** my biggest weakness is probably delegation. When a deadline gets
> close, **um,** I tend to pull work back onto my own plate instead of
> trusting the team to finish it. Last quarter that habit, **like,** burned
> me badly. I took over three tasks in the final week and, **um,** ended up
> as the bottleneck for the whole release. My manager pointed it out in the
> retro, and, **you know,** she was right. Since then I set a rule for
> myself. Before I take work back, I have to, **um,** write down what I am
> afraid will go wrong and share it with the owner instead. It felt,
> **like,** awkward at first, but the last two releases shipped on time
> without me touching anyone else's tasks.

### s5 — Heavy filler (`audio/s5-heavy-filler.m4a`) — the headline test
**Pace:** natural. **142 words, 16 planted fillers: um ×6, uh ×4, like ×3, you know ×2, basically ×1.**
**Prompt context:** "Walk me through a project you would highlight."

> **Um,** the project I would highlight is, **uh,** the customer onboarding
> flow we rebuilt last spring. The old flow had, **um,** eleven steps and,
> **like,** most people quit before finishing. **Basically,** we started by
> watching, **uh,** ten real users try to sign up, and, **um,** the
> recordings were painful to sit through. People got stuck on, **like,** the
> second screen, **you know,** the one asking for tax details nobody keeps
> handy. **Um,** we cut the form to four steps and moved the, **uh,** tax
> part to after the first login. Completion went from, **um,** forty percent
> to seventy eight percent in, **like,** six weeks. The part I am proudest of
> is, **uh,** the follow up, **you know,** we kept watching sessions every
> month after launch, and, **um,** that habit caught two more drop off points
> before they showed up in the numbers.

### s6 — Short and crisp (`audio/s6-short-crisp.m4a`)
**Pace:** natural, ~25–30 s. **64 words, 0 fillers.** Tests short-clip behavior.
**Prompt context:** "Why do you want this role?"

> I want this role for two reasons. First, the product solves a problem I
> have personally dealt with for years, and I know the frustration your
> customers feel. Second, the team ships weekly, and I do my best work in
> fast feedback loops. My track record shows both. I shipped forty releases
> last year and wrote the onboarding guide my replacement still uses today.

### s7 — Taglish (`audio/s7-taglish.m4a`)
**Pace:** natural conversational Taglish. **116 words, 5 planted ENGLISH
fillers: um ×3, like ×1, you know ×1.** Checks transcription + filler counting
on code-switched speech. The WER gate for this one is relaxed to 15% in the
manifest (Filipino spelling variance like *yung/'yung* is transcription noise,
not comprehension failure) — the signal that matters here is the filler count.
**Prompt context:** "Kwento mo yung isang challenging project na hinawakan mo."

> **Um,** noong nakaraang taon, na-assign ako sa isang project na medyo
> magulo ang simula. Walang documentation, tapos yung original developer,
> umalis na sa company. Ang ginawa ko, **um,** in-inventory ko muna lahat ng
> endpoints bago ako gumalaw ng kahit ano. Inabot ako ng, **like,** dalawang
> linggo sa pag-mapa ng buong system, pero sulit naman. Nakita ko na may
> tatlong duplicate na cron jobs na nagbabangga, **you know,** yun pala yung
> dahilan ng mga random na failure tuwing gabi. **Um,** pinakita ko yung
> findings ko sa team lead, gumawa kami ng plano, at inayos namin isa isa.
> Pagkatapos ng isang buwan, naging stable na yung system, at ako na yung
> nag-onboard sa dalawang bagong developer na pumalit.

### s8 — Ramble, no close (`audio/s8-ramble-no-close.m4a`)
**Pace:** natural; let the ending genuinely trail off — do NOT add a
concluding sentence. **138 words, 3 planted fillers: um ×2, actually ×1.**
Structure variant: the eval checks (informationally) that the model reports
beginning=yes, middle=yes, **end=no**.
**Prompt context:** "What do you think about code review culture?"

> The topic I care most about in engineering culture is code review, and I
> have strong opinions about how teams get it wrong. Most reviews focus on
> style when they should focus on risk. **Um,** there was a team I worked
> with that argued about naming for days while an unguarded database
> migration sailed through with one approval. And that reminds me of the time
> our staging environment diverged from production for a whole month, which,
> **actually,** was also sort of a review problem, or maybe more of a process
> problem, depending on how you look at it. There were dashboards nobody
> checked, and, **um,** alerts that went to a channel everyone had muted, and
> the runbook still mentioned a server we had decommissioned, and the person
> who knew the history had moved to another department by then.

---

## If you change a script

Recompute its ground truth and update `manifest.json`: `word_count` uses the
app's method (`text.trim().split(/\s+/).filter(Boolean).length` — whitespace
tokens, punctuation attached), and `filler_count` / `filler_words` must match
what you actually planted. The harness cross-checks both at startup and
refuses to run on an inconsistent manifest.

## What's in `mock/`

Synthetic fixtures + canned Gemini responses for `--mock` runs (harness
self-test, no API key, no audio needed). Don't edit these casually — the
numbers are engineered so each gate demonstrably trips; the `expected` blocks
are asserted by the self-test.
