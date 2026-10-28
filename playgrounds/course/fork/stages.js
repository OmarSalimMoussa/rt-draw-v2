/* Forked from the Eval Harness Course (app.js): the 960x600 stage drawing for each chapter, unchanged.
   Every element a caption can point at carries data-k; the player circles and reveals it by that key. */
import "./content.js";

const G = window.GLOSSARY;
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const tm = (k, text) => G[k] ? `<span class="term" data-term="${k}">${text ?? esc(G[k][1])}</span>` : (text ?? k);

const CATS = ["boxy-subject", "low-detail", "split-subject", "shape-shows-through", "squashed-picture", "pen-color", "cut-off", "missing-part", "wrong-target", "empty-page", "ignored"];
const READY = [["R1", "frozen side"], ["R2", "stub integrity"], ["R3", "transport, fake API"], ["R4", "pages"], ["R5", "voice refused"], ["R6", "data dirs"], ["R7", "machine"], ["R8", "timed-replay A/A"], ["R9", "driver parsing"], ["R10", "tokens"], ["R11", "first-message purity"], ["R12", "budget sanity"], ["R13", "bank resolves here"]];

const STAGE = {
  rules() {
    const ops = [300, 380, 470, 560, 640];
    return `<div class="stg"><div class="stg-title">What the loop is for, and your rules</div>
      <div class="rv" data-k="send"><div class="lbl">One send, on the harness clock</div>
        <svg class="ru-tl" viewBox="0 0 892 124" role="img" aria-label="One send: Enter, the first visible stroke (time to first drawing), each op applied and painted (render time), and everything settled (time to done, reported only)">
          <line class="tl-axis ink" x1="20" x2="872" y1="62" y2="62"/>
          <line class="tl-tick ink" x1="30" x2="30" y1="48" y2="76"/><text class="svgt" x="30" y="94" text-anchor="middle">Enter</text>
          <g class="rv" data-k="ttfd"><path class="sig ink" d="M30 46 V36 H232 V46"/><text class="svgt tsig" x="131" y="27" text-anchor="middle">time to first drawing</text><circle class="dot ink" cx="232" cy="62" r="7"/><text class="svgt" x="232" y="94" text-anchor="middle">first visible stroke</text></g>
          <g class="rv" data-k="render">${ops.map(x => `<rect class="op ink" x="${x - 8}" y="55" width="16" height="14" rx="2"/>`).join("")}<path class="acc ink" d="M292 46 V36 H648 V46"/><text class="svgt tacc" x="470" y="27" text-anchor="middle">render: apply and paint, each op</text></g>
          <line class="tl-tick ink" x1="780" x2="780" y1="50" y2="74"/><text class="svgt" x="780" y="94" text-anchor="middle">all settled</text>
          <path class="done ink" d="M30 98 V104 H780 V98"/><text class="svgt" x="405" y="120" text-anchor="middle">time to done: reported only</text>
        </svg></div>
      <div class="ru-cols">
        <div class="bx acc"><div class="lbl">Decides speed</div><b>${tm("ttfd", "Time to first drawing")}</b><b>${tm("render", "Render time")}</b><span class="stamp rv" data-k="never">Never slower · median or tail</span></div>
        <div class="bx rv" data-k="quality"><div class="lbl">Must hold</div><b>Quality</b><span>${tm("fidelity", "Fidelity")} and ${tm("craft", "craft")}, judged blind by a judge checked against your labels</span></div>
        <div class="bx ghost rv" data-k="reported"><div class="lbl">Reported, never decides</div><span>${tm("ttfc", "Time to first change")} (TTFC)</span><span>${tm("ttd", "Time to done")} (TTD)</span><span>Cost, in list $</span></div>
      </div>
      <div class="ru-foot">
        <div class="bx rv" data-k="budget"><div class="lbl">Budget, per token</div>
          <div class="gauge"><span>${tm("weekly-cap", "Week")}</span><i class="ink"><em style="width:50%"></em></i><b>stops at 50%</b></div>
          <div class="gauge"><span>${tm("five-hour", "Five-hour window")}</span><i class="ink"><em style="width:90%"></em></i><b>pauses at 90%</b></div></div>
        <div class="bx rv" data-k="nocaps"><div class="lbl">${tm("no-caps", "No caps")}</div><b>On ops, picture elements or colours</b><span>Prompts ask for the detail the request needs, no more</span></div>
      </div>
    </div>`;
  },
  machines() {
    return `<div class="stg"><div class="stg-title">Two machines, the loop's clone and its branches</div>
      <div class="ma">
        <div class="ma-left">
          <div class="bx rv" data-k="laptop"><div class="lbl">Your laptop</div><b class="mono" style="font-size:13.5px">~/projects/rt-draw-v2</b><span>your checkout, on master</span><span>dev server :5180, with <span class="mono">/evals/label/</span> and <span class="mono">/evals/progress/</span></span></div>
          <div class="ma-down">↑ pull.sh runs here and streams through</div>
          <div class="bx ghost"><div class="lbl">Hosted app</div><b>Testers' sessions</b><span>pulled to the PGX for the real-use pipeline</span></div>
        </div>
        <div class="ma-mid">
          <div class="arr">→<small>git push<br>rte export</small></div>
          <div class="arr rv" data-k="merge">←<small>rte sync, then<br>merge --ff-only</small></div>
          <div class="arr">→<small>pull.sh</small></div>
        </div>
        <div class="bx rv" data-k="pgx"><div class="lbl">${tm("pgx", "The PGX")}</div><b>Latency decisions and nights</b><span>16 case slots at ×1.00 of one · Chrome, arm servers, the gateway</span>
          <div class="ma-home rv" data-k="home"><div class="mono ma-h">~/rt-eval/  ($RT_EVAL_HOME)</div>
            <div class="ma-l rv" data-k="repo"><span class="mono">repo/</span><span>the loop's clone: <b class="mono">loop/champion</b>, <b class="mono">cand/e&lt;E&gt;-h&lt;n&gt;</b> <span class="ma-tag rv" data-k="tag">tag eval-harness-&lt;n&gt;</span></span></div>
            <div class="ma-l rv" data-k="history"><span class="mono">history/</span><span>worktree of ${tm("history", "eval/history")}: the record</span></div>
            <div class="ma-l"><span class="mono">trees/</span><span>what each arm serves</span></div>
            <div class="ma-l"><span class="mono">wt/</span><span>engineers' worktrees</span></div>
            <div class="ma-l"><span class="mono">bank/ cache/ meter/ runs/</span><span>cases, replies, one line per call</span></div>
            <div class="ma-l"><span class="mono">real/</span><span>testers' data, owner-only (700)</span></div>
          </div>
        </div>
      </div>
      <div class="ma-tree rv" data-k="tree"><div class="lbl">A ${tm("tree", "tree")}</div>
        <div class="part"><b>product files</b>at the commit: src, playgrounds, package files</div><div class="eq">+</div>
        <div class="part"><b>evals/</b>from the pinned harness</div><div class="eq">+</div>
        <div class="part"><b>node_modules</b>hard links, about 0.1 s</div><div class="eq">=</div>
        <div class="part res"><b class="mono">trees/&lt;hash&gt;</b>keyed by content</div>
      </div>
    </div>`;
  },
  bank() {
    return `<div class="stg"><div class="stg-title">Recorded once: the bank of fork points</div>
      <div class="bk">
        <div class="bk-col">
          <div class="bx rv" data-k="driver"><div class="lbl">${tm("driver", "Driver")}</div><b>Sonnet plays a user from screenshots</b><div class="mchips"><span>first-timer</span><span>explorer</span><span>breaker</span></div></div>
          <div class="bx rv" data-k="scenario"><div class="lbl">${tm("scenario", "Scenario table")}, frozen</div><b>An ask and a beat for each send</b><span>add, change, remove, move… · an undo, a vague request</span></div>
          <div class="bx rv" data-k="synth"><div class="lbl">${tm("synth", "Synthesizer")}</div><b>Timed words and messy ink</b><span>after the driver writes what it means</span></div>
        </div>
        <div class="arr">→<small>every Enter</small></div>
        <div class="bx acc bk-fork rv" data-k="fork"><div class="lbl">${tm("fork-point", "Fork point")}</div><ul><li>scene before</li><li>words</li><li>ink</li><li>screenshot</li><li>stated intent</li></ul><span>recorded on the champion of the day</span></div>
        <div class="arr">→</div>
        <div class="bk-sets">
          <div class="bk-set rv" data-k="tuning"><b>Tuning</b><i class="bk-bar ink" style="width:100%"></i><span>160 cases · 32 sessions × 5 · the only cases proposers read</span></div>
          <div class="bk-set rv" data-k="hgate"><b>H-gate</b><i class="bk-bar bk-hold ink" style="width:20%"></i><span>32 · 8 × 4 · held out, can only veto</span></div>
          <div class="bk-set rv" data-k="hchart"><b>H-chart</b><i class="bk-bar bk-hold ink" style="width:20%"></i><span>32 · 8 × 4 · held out, half of B1</span></div>
          <div class="bx rv" data-k="refresh"><div class="lbl">${tm("refresh", "Refresh")}</div><span>every 5 keeps or weekly: 40 fresh cases in, none out · past 800, each decision scans its own random sample</span></div>
          <div class="bx sig rv" data-k="b1"><div class="lbl">${tm("b1", "B1")}, the frozen benchmark</div><span>up to 32 H-chart + 32 tuning cases, hashed · 62 in the case-study run</span></div>
        </div>
      </div>
      <div class="stg-sub">Sizes are the config's (LOOP.bank). Refreshes and top-ups grew the case-study bank to 445 cases.</div>
    </div>`;
  },
  replay() {
    return `<div class="stg"><div class="stg-title">Replaying a fork point on both arms</div>
      <div class="rp-lanes">
        <div class="rp-stack rv" data-k="arms"><div class="rp-arm"><b>A</b>champion</div><div class="rp-arm"><b>B</b>candidate</div></div>
        <div class="rp-stack rv" data-k="page"><div class="bx"><b>Fresh bridge page</b><span class="mono">a0.localhost</span></div><div class="bx"><b>Fresh bridge page</b><span class="mono">b0.localhost</span></div></div>
        <div class="rp-stack"><div class="bx"><b>Same fork point</b><span>scene, words, ink</span></div><div class="bx"><b>Same fork point</b><span>scene, words, ink</span></div></div>
        <div class="bx sig rp-enter rv" data-k="moment"><div class="lbl">Enter</div><b>Both at the same moment</b><span>a seeded order alternates which arm goes first</span></div>
      </div>
      <div class="rp-mid">
        <div class="bx rv" data-k="clock"><div class="lbl">${tm("clock", "Harness clock")}</div><b>Reads the stage, not the product</b><span>each shape's SVG hashed every frame; frozen, the same in both arms</span><div class="rp-frames ink"><i></i><i></i><i></i><i class="on"></i><i class="on"></i><i class="on2"></i><i class="on2"></i><i class="on2"></i></div></div>
        <div class="bx sig rv" data-k="ttfd"><div class="lbl">${tm("ttfd", "Time to first drawing")}: visible ink only</div><ul><li>at least 0.2 opacity</li><li>not near-white: every channel at 240 or more is out</li><li>at least 4 screen px, or 4% of its picture</li><li>a placeholder or a bare box never counts</li></ul></div>
      </div>
      <div class="rp-bot">
        <div class="bx rv" data-k="render" style="grid-column: span 2"><div class="lbl">${tm("render", "Render time")}, after both sends</div><span>each engine replays both arms' ops on a copy of the before board and paints the frame they bring</span><span>fastest of up to 15 runs after 5 warm-ups · only content both engines load alike</span></div>
        <div class="bx bad rv" data-k="void"><div class="lbl">${tm("void", "Void")}, never a result</div><span>gateway event-loop delay over 20 ms</span><span>arms' Enters too far apart (25 ms at most)</span><span>a page that fails on both arms</span></div>
      </div>
    </div>`;
  },
  gateway() {
    return `<div class="stg"><div class="stg-title">One gateway for every model call</div>
      <div class="gw-top">
        <div class="gw-in"><div class="bx"><b>Arm pages</b><span><span class="mono">/api/model</span>, labelled run, case, arm, slot</span></div><div class="bx"><b>Eval roles</b><span>judge, failure analyst, driver, triage, gold: <span class="mono">POST /call</span></span></div></div>
        <div class="arr">→</div>
        <div class="bx acc rv" data-k="gw"><div class="lbl">${tm("gateway", "Gateway")} · its own process</div><b>Every model call</b><span>${tm("modes", "modes")}: live · replay · scan</span><span>eval roles: at most 6 at once</span></div>
        <div class="arr">→</div>
        <div class="g" style="gap:9px"><div class="bx rv" data-k="pool"><b>Product calls never queued</b><span>pooled per case slot, like one user's server</span></div><div class="bx ghost"><b>Claude models · ${tm("jev", "Jev")}</b><span>the only way out</span></div></div>
      </div>
      <div class="gw-row2">
        <div class="bx rv" data-k="share"><div class="lbl">${tm("sharing", "Shared call")}</div>
          <svg class="gw-share" viewBox="0 0 360 80" role="img" aria-label="A asks first and one real call is made; B's identical request gets each chunk at its own request time plus the leader's offset">
            <text class="svgt" x="4" y="36" font-weight="700">A</text><line class="ln ink" x1="22" x2="352" y1="32" y2="32"/>
            <text class="svgt" x="4" y="66" font-weight="700">B</text><line class="ln ink" x1="22" x2="352" y1="62" y2="62"/>
            <path class="call ink" d="M40 25 C 90 6, 190 6, 232 25"/><text class="svgt" x="246" y="16" style="fill:var(--signal);font-weight:700">one real call</text>
            <rect class="req ink" x="35" y="27" width="10" height="10"/><rect class="req ink" x="59" y="57" width="10" height="10"/>
            ${[112, 162, 232].map(x => `<circle class="ch ink" cx="${x}" cy="32" r="5"/>`).join("")}
            ${[136, 186, 256].map(x => `<circle class="ch2 ink" cx="${x}" cy="62" r="5"/>`).join("")}
          </svg>
          <span>B gets each chunk at its own request time plus the offset A saw</span></div>
        <div class="bx rv" data-k="cache"><div class="lbl">${tm("cache", "Reply cache")}</div><b>By request hash</b><span>every chunk's time kept, so a reply replays on its own clock</span></div>
        <div class="bx bad rv" data-k="cap"><div class="lbl">${tm("cap", "Hard cap")}</div><div class="gw-cap">--cap n</div><span>call n+1 is refused</span></div>
      </div>
      <div class="gw-row3">
        <div class="bx rv" data-k="meter"><div class="lbl">${tm("meter", "Meter")}</div><span>one line per call, with list $</span><span class="mono" style="font-size:11.5px">meter/calls.jsonl</span></div>
        <div class="bx rv" data-k="tokens"><div class="lbl">${tm("token-slot", "Tokens")}</div><span>1 to 3 slots from tokens.env</span><span>mode 600, outside every repo</span></div>
        <div class="bx sig rv" data-k="budget"><div class="lbl">Before every paying case</div>
          <div class="gauge"><span>Five-hour</span><i class="ink"><em style="width:90%"></em></i><b>wait at 90%</b></div>
          <div class="gauge"><span>Week</span><i class="ink"><em style="width:50%"></em></i><b>stop at 50%</b></div></div>
      </div>
    </div>`;
  },
  judge() {
    return `<div class="stg"><div class="stg-title">The judge, and why it can be trusted</div>
      <div class="jd">
        <div class="g" style="gap:9px">
          <div class="bx acc rv" data-k="judge"><div class="lbl">${tm("judge", "Judge")}</div><b>Sonnet, high effort, frozen prompts</b><span>640 px images · never on a latency path</span></div>
          <div class="bx rv" data-k="expect"><div class="lbl">${tm("expectation", "Expectation")} · once per case</div><span>from the before image and the stated intent</span></div>
          <div class="jd-two">
            <div class="bx rv" data-k="fid"><div class="lbl">${tm("fidelity", "Fidelity")}</div><span>sees before, both results, both change lists</span><b>Which did what was meant?</b></div>
            <div class="bx rv" data-k="craft"><div class="lbl">${tm("craft", "Craft")}</div><span>sees the screens alone</span><b>Which looks better made?</b></div>
          </div>
          <div class="bx rv" data-k="orders"><div class="lbl">${tm("orders", "Both orders")}</div>
            <div class="jd-ord"><div class="jd-scr"><span>A</span><span>B</span></div><span class="arr" style="font-size:16px">⇄</span><div class="jd-scr"><span>B</span><span>A</span></div><span style="font-size:13px;color:var(--ink-2)">positions balanced exactly · confidence-1 verdicts and a seeded 20% audit asked again, swapped</span></div></div>
          <div class="bx rv" data-k="flips"><span><b>Orders disagree:</b> a tie. <b>Over 30% of audits flip</b>, after 16: the rest of the run in both orders.</span></div>
        </div>
        <div class="g" style="gap:9px">
          <div class="bx sig rv" data-k="calib"><div class="lbl">${tm("calibration", "Calibration")}</div><b>Your blind labels at /evals/label/</b><span>real near-ties, clear contrasts, and bias probes: did more, did nothing</span></div>
          <div class="bx rv" data-k="agree"><div class="lbl">Agreement, case-study run</div>
            <div class="jd-bars">
              <div class="jd-bar"><span>Judge and you, 56 decisive pairs</span><div class="jd-track"><i class="ink" style="width:81%"></i></div><b>81%</b></div>
              <div class="jd-bar"><span>Judge and you, clear pairs</span><div class="jd-track"><i class="ink" style="width:82.5%"></i></div><b>33/40</b></div>
              <div class="jd-bar self"><span>You and yourself, repeats</span><div class="jd-track"><i class="ink" style="width:88%"></i></div><b>88%</b></div>
            </div></div>
          <div class="bx rv" data-k="canary"><div class="lbl">Watching for drift</div><span>${tm("canary", "Canary")}: 20 stable packets weekly; 16 or fewer agreeing is an alarm</span><span>one word changed in a judge prompt: a new ${tm("judge-id", "judge version")}</span><span><b>Still owed:</b> ${tm("illustrations", "illustration labels")}, about 25 min</span></div>
        </div>
      </div>
    </div>`;
  },
  cards() {
    return `<div class="stg"><div class="stg-title">Where cards come from</div>
      <div class="cd-flow">
        <div class="bx rv" data-k="digest"><div class="lbl">${tm("digest", "Digests")} · frozen code, 0 calls</div><b>≤ 40k tokens</b><span>champion misses 50% · candidate losses 30% · the rest 20% · tuning cases only</span></div>
        <div class="arr">→</div>
        <div class="bx rv" data-k="analyst"><div class="lbl">${tm("analyst", "Analyst")} · read-only agent</div><b>8–16 hypotheses</b><span>one idea each: knobs, wording, code, ops, ${tm("model-switch", "model routing")}, sweeps, near-win combos · ${tm("research", "the web")} · 30 turns, 12 min, $2.50</span></div>
        <div class="arr">→</div>
        <div class="bx rv" data-k="critic"><div class="lbl">${tm("critic", "Critic")} · read-only agent</div><b>Keeps ≤ 6 cards</b><span>checks the code, the web and the tried index · 30 turns, 12 min, $2.50</span></div>
      </div>
      <div class="cd-mid">
        <div class="bx acc rv" data-k="card"><div class="lbl">A ${tm("card", "card")}</div>
          <div class="kv"><span class="mono">component</span><span>resolve, draw, picture, render…</span><span class="mono">kind</span><span>knob · variant · code · op · newknob · sweep · combo</span><span class="mono">change</span><span>one line</span><span class="mono">goal</span><span>latency (metric ttfd or render) · fidelity · craft</span><span class="mono">classGuess</span><span>S · R · Q · D</span><span class="mono">risk</span><span>what could break</span><span class="mono">overuseDetector</span><span>optional: extra-shapes, camera-move…</span></div></div>
        <div class="g" style="gap:10px;align-content:start">
          <div class="bx sig rv" data-k="seed"><div class="lbl">Your cards go first</div><b>8 ${tm("seed-cards", "seed cards")}</b><span>seed-cards.json · --seed-cards adds more to a running loop</span></div>
          <div class="bx rv" data-k="kinds"><div class="lbl">Search</div><span><b>${tm("sweep", "Sweep")}:</b> one knob at up to 4 values, nearest the champion's first</span><span><b>${tm("combo", "Combo")}:</b> up to 3 tried patches applied together</span></div>
        </div>
      </div>
      <div class="cd-bot">
        <div class="bx ghost"><div class="lbl">Built by script</div><b>knob, sweep, combo</b><span>tuning.ts defaults set, or saved patches applied</span></div>
        <div class="bx rv" data-k="engineer"><div class="lbl">${tm("engineer", "Engineer")} · agent session</div><b>Code cards, in <span class="mono" style="font-size:13.5px">wt/cand/e&lt;E&gt;-h&lt;n&gt;</span></b><span>may change src/core only, may read the web · 60 turns, 25 min, $4 · two build at once</span></div>
      </div>
    </div>`;
  },
  gates() {
    return `<div class="stg"><div class="stg-title">The funnel: free steps first</div>
      <div class="gt-band"><div class="lbl">${tm("g0", "G0")} · free gates · 0 calls</div>
        <div class="gt-two">
          <div class="bx rv" data-k="g0paths"><b>Where a change may land</b><span>only src/core, minus speech · measuring side, dev/, package files → your list · the editor's look → rejected</span></div>
          <div class="bx rv" data-k="g0lint"><b>What it may contain</b><span>every new number a named knob in tuning.ts · no new network or speech · tsc in the candidate's tree · banked scenes still load</span></div>
        </div></div>
      <div class="gt-arrow">↓</div>
      <div class="gt-band gt-g1"><div class="lbl">${tm("diffscan", "G1 · diffscan")} · 0 calls</div>
        <div class="gt-two">
          <div class="bx rv" data-k="scan"><b>Every banked case, both versions</b><span>recorded replies served instantly</span></div>
          <div class="bx rv" data-k="affected"><b>${tm("affected", "Affected")}?</b><span>a request, the scene after, or the rendered stage differs</span></div>
        </div></div>
      <div class="gt-arrow">↓</div>
      <div class="gt-cls">
        <div class="gt-grp rv" data-k="ns"><div class="lbl">Decided at 0 calls</div><div class="gt-row n2">
          <div class="gt-c"><b>N</b><em>no effect</em><span>revert</span></div>
          <div class="gt-c"><b>S</b><em>speed only</em><span>a timed replay decides</span></div></div></div>
        <div class="gt-grp rv" data-k="rqd"><div class="lbl">Measured on affected cases</div><div class="gt-row n3">
          <div class="gt-c"><b>R</b><em>render differs</em><span>bank replies, recorded clock</span></div>
          <div class="gt-c"><b>Q</b><em>a request differs</em><span>live A/B</span></div>
          <div class="gt-c"><b>D</b><em>dialogue</em><span>live, plus continuations</span></div></div></div>
        <div class="bx bad rv" data-k="rare"><div class="lbl">${tm("too-rare", "Too rare")}</div><b>&lt; 32 affected</b><span>even with up to 48 top-up sends · revert, and your list</span></div>
      </div>
    </div>`;
  },
  looks() {
    const x = n => 52 + n / 80 * 370, y = z => 240 - (z + 1) / 4 * 210;
    const keep = [[32, 2.3], [48, 1.8], [80, 1.4]], rev = [[16, -0.2], [32, 0.3], [48, 0.7], [80, 1.4]], ex = [[16, 0.9], [32, 1.6], [48, 2.0]];
    const pts = a => a.map(([n, z]) => `${x(n).toFixed(1)},${y(z).toFixed(1)}`).join(" ");
    const band = `${x(16)},${y(3)} ${pts(keep)} ${pts([...rev].reverse())}`;
    let s = `<svg class="lk-chart" viewBox="0 0 450 290" role="img" aria-label="Rule F: keep when Z reaches 2.3, 1.8 or 1.4 at looks 32, 48 or 80; revert at or under −0.2, 0.3, 0.7 or 1.4 at looks 16 to 80; an example card keeps at look 48">`;
    s += `<polygon class="band" points="${band}"/>`;
    for (const z of [-1, 0, 1, 2, 3]) s += `<line class="svggr" x1="52" x2="430" y1="${y(z)}" y2="${y(z)}"/><text class="svgm" x="44" y="${y(z) + 4}" text-anchor="end">${z}</text>`;
    s += `<line class="svgax" x1="52" x2="430" y1="240" y2="240"/>`;
    s += `<g class="rv" data-k="looks">${[16, 32, 48, 80].map(n => `<line class="svgax ink" x1="${x(n)}" x2="${x(n)}" y1="240" y2="246"/><text class="svgt" x="${x(n)}" y="260" text-anchor="middle" font-weight="700">${n}</text>`).join("")}</g>`;
    s += `<text class="svgm" x="241" y="282" text-anchor="middle">affected cases at each look</text><text class="svgm" x="14" y="135" text-anchor="middle" transform="rotate(-90 14 135)">clustered Z</text>`;
    s += `<text class="svgm" x="238" y="128" text-anchor="middle">go on to the next look</text>`;
    s += `<g class="rv" data-k="keepline"><polyline class="keep ink" points="${pts(keep)}"/>${keep.map(([n, z]) => `<circle class="keepd ink" cx="${x(n)}" cy="${y(z)}" r="4"/>`).join("")}<text class="svgt tkeep" x="${x(32) + 4}" y="${y(2.3) - 10}">keep at or above</text></g>`;
    s += `<g class="rv" data-k="revline"><polyline class="rev ink" points="${pts(rev)}"/>${rev.map(([n, z]) => `<circle class="revd ink" cx="${x(n)}" cy="${y(z)}" r="4"/>`).join("")}<text class="svgt trev" x="${x(16) - 4}" y="${y(-0.2) + 20}">revert at or below</text></g>`;
    s += `<polyline class="ex ink" points="${pts(ex)}"/>${ex.map(([n, z], i) => `<circle class="exd ink" cx="${x(n)}" cy="${y(z)}" r="${i === 2 ? 5 : 3}"/>`).join("")}<text class="svgm" x="${x(48) + 9}" y="${y(2.0) + 4}">example: keeps at look 48</text>`;
    s += `</svg>`;
    return `<div class="stg"><div class="stg-title">G2: looks, Rule F and the latency rule</div>
      <div class="lk">
        <div class="g" style="gap:10px;align-content:start">
          <div class="bx" style="padding:6px 8px"><div class="lbl" style="padding:2px 4px">${tm("rule-f", "Rule F")}, for fidelity and craft cards</div>${s}</div>
          <div class="bx rv" data-k="cluster"><span><b>The unit is the driver session.</b> Sends from one session are alike, so Z uses ${tm("clustered-z", "clustered standard errors")}.</span></div>
        </div>
        <div class="lk-right">
          <div class="bx sig rv" data-k="latkeep"><div class="lbl">A latency card keeps when</div><b>the median ${tm("paired-ratio", "paired ratio")} is surely under 1</b><span>${tm("swap-test", "session-swap test")}: p under 0.10</span></div>
          <div class="bx rv" data-k="tails"><b>or a ${tm("tail", "tail")}, p90 or p95, is surely under 0.95</b><span>p under 0.05 and at least 10% faster · the other latency not surely slower</span></div>
          <div class="bx rv" data-k="floor"><div class="lbl">Fidelity must hold</div><div class="lk-tbl"><span>look</span><b>32</b><b>48</b><b>80</b><span>Z at least</span><b>0</b><b>−0.5</b><b>−1.0</b></div><span>Z at or under −1.25: the speed costs fidelity, and it ends</span></div>
          <div class="bx rv" data-k="sweep"><div class="lbl">${tm("sweep", "Sweeps")} share one card's error</div><span>keep Z raised by +0.32, +0.49, +0.61 for 2, 3, 4 values</span></div>
        </div>
      </div>
    </div>`;
  },
  verdict() {
    return `<div class="stg"><div class="stg-title">Vetoes, G3 and the four outcomes</div>
      <div class="vd">
        <div class="vd-col rv" data-k="vetoes"><div class="lbl">Vetoes, on G2's own rows</div>
          <div class="bx vd-veto rv" data-k="vlat"><b>${tm("latency-veto", "Latency veto")}: one pooled test</b><span>surely slower (p &lt; 0.05) reverts · in place of up to 12 tests: TTFD and render, median, p90, p95, on G2 and G3</span></div>
          <div class="bx vd-veto rv" data-k="vempty"><b>${tm("empty-send", "Empty sends")} or failed pictures</b><span>up by over 2 points · or render() leaving work for after it returns</span></div>
          <div class="bx ghost rv" data-k="voveruse"><b>${tm("overuse", "Over-use")}: reported</b><span>extra shapes, camera moves… shown beside the decision; holds nothing</span></div>
          <div class="bx vd-own"><b>Render not measured whole → your call</b><span>on over a quarter of the cases</span></div>
        </div>
        <div class="vd-col">
          <div class="bx acc rv" data-k="g3"><div class="lbl">${tm("g3", "G3")} · held out, every keep</div><b>Affected H-gate cases</b><span>fidelity Z under −1.0 vetoes</span></div>
          <div class="bx rv" data-k="lean"><b>8 or more cases</b><span>must also lean the card's way</span></div>
          <div class="bx"><div class="lbl">${tm("g4", "G4")} · dialogue cards</div><span>20 continuation cases · fidelity Z at or under −1.0 vetoes</span></div>
          <div class="bx bad rv" data-k="trust"><div class="lbl">${tm("trust", "Trust")}, checked first → void</div><span>over 10% void or lost</span><span>over 30% of audits flip</span><span>A first outside 40–60%</span><span>cold starts differ by over 10 points</span></div>
        </div>
        <div class="vd-col rv" data-k="outcomes"><div class="lbl">Outcomes</div>
          <div class="vd-o"><span class="pill keep">keep</span><span>commit to loop/champion; R1 runs beside it</span></div>
          <div class="vd-o"><span class="pill revert">revert</span><span>patch saved to tried/</span></div>
          <div class="vd-o"><span class="pill owner">owner</span><span>owner-list.md: model switches, the look, frozen areas, too rare</span></div>
          <div class="vd-o"><span class="pill void">void</span><span>your list, never rerun</span></div>
          <span class="stg-sub">Every decision is one commit to eval/history.</span>
        </div>
      </div>
    </div>`;
  },
  checkpoint() {
    const data = [[0, 1.03], [0.9, 0.76], [1.7, 0.71], [4.0, 0.76], [5.4, 0.75], [6.4, 0.49], [7.5, 0.47], [16.6, 0.47], [19.7, 0.48], [21.4, 0.47]];
    const x = h => 40 + h / 22 * 275, y = r => 136 - (r - 0.4) / 0.7 * 116;
    let c = `<svg class="ck-chart" viewBox="0 0 330 168" role="img" aria-label="Case-study run: the champion's first change as a share of the original's, from 1.03 at hour 0 to 0.47 at hour 21.4">`;
    for (const r of [0.4, 0.6, 0.8]) c += `<line class="svggr" x1="40" x2="318" y1="${y(r)}" y2="${y(r)}"/><text class="svgm" x="34" y="${y(r) + 4}" text-anchor="end">${r.toFixed(1)}</text>`;
    c += `<line class="ref" x1="40" x2="318" y1="${y(1)}" y2="${y(1)}"/><text class="svgm" x="34" y="${y(1) + 4}" text-anchor="end">1.0</text><text class="svgm" x="${x(10)}" y="${y(1) - 6}">original</text>`;
    c += `<line class="svgax" x1="40" x2="318" y1="136" y2="136"/>`;
    for (const h of [0, 6, 12, 18]) c += `<text class="svgm" x="${x(h)}" y="152" text-anchor="middle">${h}</text>`;
    c += `<text class="svgm" x="318" y="152" text-anchor="end">hours</text>`;
    c += `<polyline class="ln ink" points="${data.map(([h, r]) => `${x(h).toFixed(1)},${y(r).toFixed(1)}`).join(" ")}"/>`;
    c += data.slice(0, -1).map(([h, r]) => `<circle class="pt ink" cx="${x(h).toFixed(1)}" cy="${y(r).toFixed(1)}" r="2.6"/>`).join("");
    const [eh, er] = data.at(-1);
    c += `<circle class="end ink" cx="${x(eh).toFixed(1)}" cy="${y(er).toFixed(1)}" r="5"/><text class="tend" x="${x(eh) - 4}" y="${y(er) - 10}" text-anchor="end">×0.47</text></svg>`;
    return `<div class="stg"><div class="stg-title">Checkpoints: the yardstick across runs</div>
      <div class="ck-top">
        <div class="bx acc rv" data-k="ck"><div class="lbl">${tm("checkpoint", "Checkpoint")}</div><b>Every 2 keeps</b><span>the champion against ${tm("anchor", "A0")}, the original, on B1 · live, unshared · fidelity and craft on every case</span><span>ck-00 is A0 against itself: the ${tm("aa", "A/A")}</span></div>
        <div class="bx rv" data-k="share"><div class="lbl">${tm("share", "Share")}</div><b>(wins + ½ ties) ÷ n</b><span>0.5 is a tie · 90% band from 2,000 resamples of whole sessions</span></div>
        <div class="bx rv" data-k="chart"><div class="lbl">First change, champion ÷ original</div>${c}<span style="font-size:12px">case-study run, checkpoints ck-01 to ck-10</span></div>
      </div>
      <div class="ck-mid">
        <div class="bx rv" data-k="anchor"><div class="lbl">${tm("anchor", "A0")} stays put</div><b>Every checkpoint: champion vs A0</b><span>A0 never moves, so a series reads on one scale</span></div>
        <div class="bx rv" data-k="judge-ver"><div class="lbl">One series per ${tm("judge-id", "judge version")}</div><b>A new judge starts a new series</b><span>against the same A0, on the same B1</span></div>
        <div class="bx rv" data-k="overfit"><div class="lbl">${tm("overfit", "Overfitting gap")}</div><b>Tuning share − H-chart share</b><span>over 0.15 at two checkpoints in a row → your list</span></div>
      </div>
      <div class="ck-bot">
        <div class="bx ghost rv" data-k="gone"><div class="lbl">Removed in the simplification · none ever changed a decision</div><span>latency and quality debts · anchor moves · era bridges · R1's already-fixed list and rte real baseline · the void rerun · the over-use hold · the night cap and per-class $ budgets · sampled craft on non-craft cards</span></div>
      </div>
    </div>`;
  },
  real() {
    return `<div class="stg"><div class="stg-title">Testers' sends become bench R1</div>
      <div class="rl-1">
        <div class="rl-grp rv" data-k="pull"><div><b>pull.sh</b>the laptop streams the app's data to the PGX</div><div><b>ingest</b>projects become sessions</div><div><b>render</b>before and after images, 0 calls</div></div>
        <div class="arr">→</div>
        <div class="bx rv" data-k="triage"><div class="lbl">${tm("triage", "Triage")} · Opus, high effort</div><b>11 sends a call</b><span>what was meant · landed? · failure kinds · gold?</span></div>
        <div class="arr">→</div>
        <div class="bx sig rv" data-k="gold"><div class="lbl">${tm("gold", "Gold")} · Opus, high effort</div><b>The product's own ops and pictures</b><span>plus a rubric and ${tm("free-checks", "free checks")} · no time or output limit</span></div>
      </div>
      <div class="rl-cats"><span class="lbl">Failure kinds triage can name</span>${CATS.map(c => `<span class="c">${c}</span>`).join("")}</div>
      <div class="rl-2">
        <div class="bx rv" data-k="checks"><div class="lbl">${tm("free-checks", "Free checks")} · 0 calls</div><b>Did it fix what failed?</b><span>picked from a fixed menu: picture-for, single-picture, no-color, removed…</span></div>
        <div class="arr">→</div>
        <div class="bx rv" data-k="review"><div class="lbl">${tm("review", "Your review")} · :5182</div><b>Approve or reject</b><span>the first batch case by case</span></div>
        <div class="arr">→</div>
        <div class="bx acc rv" data-k="freeze"><div class="lbl">${tm("freeze-r1", "Freeze")}</div><b>Bench ${tm("r1", "R1")}</b><span>one case per distinct input · ${tm("r-hold", "split by person")}: you tune, testers fill R-hold toward ⅓</span></div>
        <div class="arr">→</div>
        <div class="bx rv" data-k="shadow"><div class="lbl">${tm("shadow", "Beside every keep")} and checkpoint</div><b>R1 on both arms</b><span>checks, judge share, latency · reported only until illustrations are calibrated</span></div>
      </div>
      <div class="rl-priv rv" data-k="privacy"><b>Private</b><span>Testers' words, drawings and project names live only under $RT_EVAL_HOME/real/ on the PGX, mode 700. History gets R1's hash, counts and case ids; people are pseudonyms; logs carry ids and counts.</span></div>
    </div>`;
  },
  guards() {
    const ts = Array.from({ length: 23 }, (_, i) => `<span>t${i}</span>`).join("");
    return `<div class="stg"><div class="stg-title">Checks, readiness, and when the loop stops</div>
      <div class="gd">
        <div class="gd-col">
          <div class="bx rv" data-k="checks"><div class="lbl">${tm("checks", "Checks")} · evals/checks</div><b>t0–t22, at 0 real calls</b><div class="gd-t ink">${ts}</div><span>fake tokens · a fake API · HTTPS_PROXY at a closed port</span></div>
          <div class="bx rv" data-k="ready"><div class="lbl">${tm("readiness", "Readiness")} · rte ready --stub --mock-api</div><div class="gd-r">${READY.map(([k, v]) => `<span><b>${k}</b>${v}</span>`).join("")}</div><span style="font-size:12px">These R-numbers are not bench R1.</span></div>
          <div class="gd-two">
            <div class="bx sig rv" data-k="day"><b>Within a day</b><span>at this harness tag, or the loop stops</span></div>
            <div class="bx rv" data-k="dry"><b>Rehearsal</b><span>the whole chain, small, on the ${tm("fake-api", "fake API")}: about an hour</span></div>
          </div>
        </div>
        <div class="gd-col">
          <div class="bx bad rv" data-k="stops"><div class="lbl">Stops the loop</div><ul class="two"><li>every token past 50% of its week</li><li>2 void decisions in a row</li><li>a V9 invariant</li><li>readiness failed or stale</li><li>judge not calibrated</li><li>the step's --cap reached</li><li>a sync conflict</li><li>2 epochs deciding nothing</li></ul></div>
          <div class="bx sig rv" data-k="pauses"><div class="lbl">Pauses it</div><ul><li>every token past 90% of its five-hour window</li><li>3 overloaded calls in 10 minutes</li><li>free disk under 10 GB</li><li>a laptop on battery</li></ul></div>
          <div class="bx rv" data-k="overrun"><b>${tm("overrun", "Overrun")} → void</b><span>over 30 min at 8 slots, longer with fewer · to your list like any void</span></div>
          <div class="bx rv" data-k="drywell"><b>${tm("dry-well", "Dry well")}</b><span>12 reverts in a row → your list · 6 on one component → rested to the next checkpoint</span></div>
        </div>
      </div>
    </div>`;
  },
  night() {
    return `<div class="stg"><div class="stg-title">A night of the loop, and your morning</div>
      <div class="nt">
        <div class="g" style="gap:8px;align-content:start">
          <div class="bx acc rv" data-k="script"><div class="lbl">Coordinator</div><b>A script: rte loop</b><span>state.json is its cursor · loop.lock allows one loop · v1's coordinator re-read ~375k tokens a request</span></div>
          <div class="bx rv" data-k="between"><div class="lbl">Before each step, and between epochs</div><span>stop and pause rules · ${tm("sync", "sync")} your master, at most daily · bank refresh when due · weekly canary</span></div>
          <div class="bx rv" data-k="epoch"><div class="lbl">${tm("epoch", "Epoch")}</div><span>up to 6 cards · two build ahead · each decided in turn</span></div>
          <div class="bx rv" data-k="record"><div class="lbl">Record</div><span>a checkpoint every 2 keeps · epochs.jsonl and budget.jsonl, committed</span></div>
          <div class="bx rv" data-k="notify"><div class="lbl">${tm("notices", "Notices")}</div><span>every 2 decisions, 120 min or $20 · rte stop-after stops between steps</span></div>
          <div class="arr" style="text-align:left;font-size:15px">↺ <span style="font-size:13px;color:var(--ink-2)">next epoch, until --epochs runs out or a stop rule fires</span></div>
        </div>
        <div class="nt-right">
          <div class="bx sig rv" data-k="morning"><div class="lbl">Your morning</div><ol><li><span class="mono">/evals/progress/</span>: quality, latency, cost, decisions, health, status</li><li><span class="mono">owner-list.md</span>: what waits for you</li><li><span class="mono">tail -3 budget.jsonl</span>: each token's use</li><li><span class="mono">rte status</span>: cursor, lock, slots</li></ol></div>
          <div class="bx rv" data-k="yours"><div class="lbl">Only you</div><ul><li>label illustrations for the judge, about 25 min</li><li>approve the first gold batch</li><li>decide owner-list items</li><li>rte sync, then merge loop/champion --ff-only</li><li>deploy the champion to prod</li></ul></div>
          <div class="bx rv" data-k="scale"><div class="lbl">The case-study run</div><div class="nt-stats"><div><b>64</b><span>rounds</span></div><div><b>22 h</b><span>of running</span></div><div><b>21,182</b><span>model calls</span></div><div><b>≈ $217</b><span>at list prices</span></div><div><b>≈ $1.70</b><span>per decision</span></div><div><b>≈ 7 min</b><span>per decision</span></div></div></div>
        </div>
      </div>
    </div>`;
  },
};

export { STAGE };
