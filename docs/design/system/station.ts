/**
 * <sf-station>: one stage of the factory line, drawn as a small machine on a length of belt.
 *
 *   <sf-station kind="build" status="working"></sf-station>
 *
 * The tool on top says what the stage does (kind). The face, beacon, hatch and belt say how
 * it is doing (status). Eight stations side by side make one continuous 1344px conveyor.
 *
 * Attributes
 *   kind     sense | triage | plan | build | gates | review | release | verify   (default build)
 *   status   idle | working | returning | passing | blocked | failed            (default idle)
 *   motion   "off" draws the still pose. Motion also stops under prefers-reduced-motion.
 *   label    Accessible name; defaults to "<Stage>: <state>".
 *   decorative  Present when something else (a button, a caption) already names the station.
 *
 * Hover: lift the machine, never the belt, so the line stays continuous:
 *   button:hover sf-station::part(machine) { transform: translateY(-3px); }
 * The legs are tucked 4px under the body, so a lift of up to 4px reads as stretching.
 *
 * Colour comes from the design system's CSS custom properties (tokens.css), which inherit
 * into the shadow tree, so the station follows the Paper or Ink theme of its container.
 *
 * This TypeScript module is the source, and the console imports it as it is. Its styles are one
 * constructed stylesheet shared by every station, and its drawing uses classes and presentation
 * attributes, never a <style> element or a style attribute, so it runs under a content security
 * policy that allows neither. build.ts writes station.js from it: the same element as a classic
 * script, for design pages opened from disk, exposing globalThis.SFStation.
 */

export const KINDS = ['sense', 'triage', 'plan', 'build', 'gates', 'review', 'release', 'verify'] as const;
export type Kind = (typeof KINDS)[number];
export const STATUSES = ['idle', 'working', 'returning', 'passing', 'blocked', 'failed'] as const;
export type Status = (typeof STATUSES)[number];

export const STAGE_NAME: Record<Kind, string> = {
  sense: 'Sense', triage: 'Triage', plan: 'Plan', build: 'Build',
  gates: 'Gates', review: 'Review', release: 'Release', verify: 'Verify',
};

/** Short state words for captions. Tone says which colour role goes with them. */
export const STATE: Record<Status, { label: string; tone: 'faint' | 'signal' | 'ok' | 'attn' }> = {
  idle: { label: 'idle', tone: 'faint' },
  working: { label: 'working', tone: 'signal' },
  returning: { label: 'sending back', tone: 'signal' },
  passing: { label: 'passed', tone: 'ok' },
  blocked: { label: 'needs you', tone: 'attn' },
  failed: { label: 'failed', tone: 'attn' },
};

const CSS = `
:host {
  display: inline-block; position: relative; vertical-align: top;
  width: 168px; aspect-ratio: 168 / 220; height: auto;
  --_ink: var(--text, #202020);
  --_paper: var(--raised, #fbfaf7);
  --_steel: var(--surface, #ebe6dd);
  --_face: var(--station-face, #252321);
  --_faint: var(--text-faint, #a8a095);
  --_canary: var(--station-canary, #e9c46a);
}
svg { display: block; width: 100%; height: 100%; overflow: visible; }
.machine { transition: transform .2s var(--motion-ease, ease); }
.s-idle      { --tone: var(--text-faint, #a8a095); --led: var(--station-led-dim, #77716a); }
.s-working,
.s-returning { --tone: var(--signal, #2a2826); --led: var(--station-led-on, #f4f1ea); }
.s-passing   { --tone: var(--ok, #3b6631); --led: var(--station-led-ok, #a9c79c); }
.s-blocked,
.s-failed    { --tone: var(--attn, #b53c0a); --led: var(--station-led-attn, #f09a64); }

/* Linework */
.part  { fill: var(--_paper); stroke: var(--_ink); stroke-width: 1.75; stroke-linejoin: round; }
.steel { fill: var(--_steel); stroke: var(--_ink); stroke-width: 1.75; }
.body  { fill: var(--_paper); stroke: var(--_ink); stroke-width: 2; }
.ink   { fill: var(--_ink); }
.line  { fill: none; stroke: var(--_ink); stroke-width: 1.75; stroke-linecap: round; stroke-linejoin: round; }
.thin  { fill: none; stroke: var(--_ink); stroke-width: 1.25; stroke-linecap: round; }
.face  { fill: var(--_face); }
.led   { fill: none; stroke: var(--led); stroke-linecap: round; stroke-linejoin: round; }
.led-fill { fill: var(--led); }
.tone  { fill: none; stroke: var(--tone); stroke-linecap: round; stroke-linejoin: round; }
.tone-fill { fill: var(--tone); }
.faint { fill: none; stroke: var(--_faint); stroke-width: 1.5; stroke-linecap: round; stroke-linejoin: round; }
.parcel { fill: var(--_steel); stroke: var(--_ink); stroke-width: 1.5; }
.bird  { fill: var(--_canary); stroke: var(--_ink); stroke-width: 1.5; stroke-linejoin: round; }
.beacon-glow { fill: var(--tone); opacity: 0; }
.s-passing .beacon-glow { opacity: .18; }
.s-blocked .beacon-glow, .s-failed .beacon-glow { opacity: .3; }
.roller { fill: var(--_steel); stroke: var(--_ink); stroke-width: 1.5; }
.chev  { fill: none; stroke: var(--_ink); stroke-width: 1.5; stroke-linecap: round; stroke-linejoin: round; opacity: .55; }
.s-idle .chev { opacity: .22; }
.s-blocked .chev, .s-failed .chev { opacity: .35; }
.hazard-stripe { fill: var(--_face); }
.fault { fill: var(--led); font: 500 12px/1 'Geist Mono', ui-monospace, Menlo, monospace; letter-spacing: 2.5px; }
.zz { fill: none; stroke: var(--_faint); stroke-width: 1.5; stroke-linecap: round; stroke-linejoin: round; }

/* What were inline styles: the console's content security policy refuses style attributes. */
.rim   { stroke: var(--_ink); }
.glare { stroke: var(--_paper); stroke-width: 2; }
.track { fill: var(--_ink); opacity: .14; }
.frame { fill: none; stroke: var(--_ink); stroke-width: 1.75; }
.belt  { fill: var(--_steel); }
.seam  { stroke: var(--_steel); stroke-width: 2.5; stroke-linecap: round; }
.dome  { fill: var(--tone); stroke: var(--_ink); stroke-width: 1.75; stroke-linejoin: round; }
.puff  { fill: var(--_faint); }
.puff-a { transform-origin: 44px 40px; }
.puff-b { transform-origin: 51px 40px; }

/* Pivots, in the SVG's user units */
.pivot, .sense-dish, .plan-arm, .build-arm, .gate-boom, .lens, .bird-ok, .stamp, .belt-run,
.eyes, .bar, .drop, .puff, .note, .wave, .light, .glint, .alarm, .zz path {
  transform-box: view-box;
}
.sense-dish { transform-origin: 74px 31px; }
.plan-arm   { transform-origin: 74px 8px; }
.build-arm  { transform-origin: 74px 38px; transform: rotate(-18deg); }
.gate-boom  { transform-origin: 59px 16.5px; }
.s-passing .gate-boom { transform: rotate(-55deg); }
.bar        { transform-origin: 48px 129px; transform: scaleX(.62); }
.eyes       { transform-origin: 84px 82px; }

@media (prefers-reduced-motion: no-preference) {
  :host(:not([motion="off"])) .belt-run { animation: belt var(--_belt-dur, .7s) linear infinite; }
  :host(:not([motion="off"])) .s-passing  { --_belt-dur: 1.4s; }
  :host(:not([motion="off"])) .s-returning .belt-run { animation-name: belt-back; }
  :host(:not([motion="off"])) .s-idle .belt-run,
  :host(:not([motion="off"])) .s-blocked .belt-run,
  :host(:not([motion="off"])) .s-failed .belt-run { animation: none; }

  :host(:not([motion="off"])) .s-blocked .beacon-glow,
  :host(:not([motion="off"])) .s-failed .beacon-glow { animation: alarm-glow .9s ease-in-out infinite; }
  :host(:not([motion="off"])) .s-blocked .dome,
  :host(:not([motion="off"])) .s-failed .dome,
  :host(:not([motion="off"])) .alarm { animation: flash .9s ease-in-out infinite; }

  :host(:not([motion="off"])) .s-working .eyes,
  :host(:not([motion="off"])) .s-returning .eyes { animation: blink 3.6s linear infinite; }
  :host(:not([motion="off"])) .s-working .bar { animation: fill 2.4s var(--motion-ease, ease-in-out) infinite; }
  :host(:not([motion="off"])) .glint { animation: twinkle 1.8s ease-in-out infinite; }
  :host(:not([motion="off"])) .zz path { animation: drift 2.8s ease-out infinite; }
  :host(:not([motion="off"])) .zz path + path { animation-delay: 1.4s; }
  :host(:not([motion="off"])) .puff { animation: puff 2.4s ease-out infinite; }
  :host(:not([motion="off"])) .puff + .puff { animation-delay: 1.2s; }

  :host(:not([motion="off"])) .s-working .sense-dish,
  :host(:not([motion="off"])) .s-returning .sense-dish { animation: sweep 2.4s ease-in-out infinite; }
  :host(:not([motion="off"])) .s-working .wave,
  :host(:not([motion="off"])) .s-returning .wave { animation: pulse-op 1.6s ease-in-out infinite; }
  :host(:not([motion="off"])) .wave + .wave { animation-delay: .4s; }
  :host(:not([motion="off"])) .s-working .drop,
  :host(:not([motion="off"])) .s-returning .drop { animation: drop 1.5s ease-in infinite; }
  :host(:not([motion="off"])) .s-working .light,
  :host(:not([motion="off"])) .s-returning .light { animation: pulse-op 1.5s ease-in-out infinite; }
  :host(:not([motion="off"])) .light:nth-of-type(2) { animation-delay: .5s; }
  :host(:not([motion="off"])) .light:nth-of-type(3) { animation-delay: 1s; }
  :host(:not([motion="off"])) .s-working .plan-arm,
  :host(:not([motion="off"])) .s-returning .plan-arm { animation: swing 2.2s ease-in-out infinite; }
  :host(:not([motion="off"])) .s-working .arc,
  :host(:not([motion="off"])) .s-returning .arc { animation: draw 2.2s ease-in-out infinite; }
  :host(:not([motion="off"])) .s-working .build-arm,
  :host(:not([motion="off"])) .s-returning .build-arm { animation: hammer .7s ease-in-out infinite; }
  :host(:not([motion="off"])) .s-working .gate-boom,
  :host(:not([motion="off"])) .s-returning .gate-boom { animation: wobble 1.2s ease-in-out infinite; }
  :host(:not([motion="off"])) .s-working .lens,
  :host(:not([motion="off"])) .s-returning .lens { animation: scan 2.6s ease-in-out infinite; }
  :host(:not([motion="off"])) .s-working .bird-ok,
  :host(:not([motion="off"])) .s-returning .bird-ok { animation: bob .6s ease-in-out infinite; }
  :host(:not([motion="off"])) .s-passing .bird-ok { animation: bob 1.2s ease-in-out infinite; }
  :host(:not([motion="off"])) .note { animation: pulse-op 1.6s ease-in-out infinite; }
  :host(:not([motion="off"])) .s-working .stamp,
  :host(:not([motion="off"])) .s-returning .stamp { animation: press .9s ease-in-out infinite; }
}
@keyframes belt      { to { transform: translateX(21px); } }
@keyframes belt-back { to { transform: translateX(-21px); } }
@keyframes alarm-glow{ 0%, 100% { opacity: .45; } 50% { opacity: 0; } }
@keyframes flash     { 0%, 100% { opacity: 1; } 50% { opacity: .35; } }
@keyframes blink     { 0%, 92%, 100% { transform: scaleY(1); } 96% { transform: scaleY(.12); } }
@keyframes fill      { from { transform: scaleX(0); } to { transform: scaleX(1); } }
@keyframes twinkle   { 0%, 100% { opacity: .15; } 50% { opacity: 1; } }
@keyframes drift     { from { transform: translate(0, 0); opacity: 0; } 30% { opacity: 1; } to { transform: translate(6px, -16px); opacity: 0; } }
@keyframes puff      { from { transform: translateY(0) scale(1); opacity: .7; } to { transform: translateY(-36px) scale(2.4); opacity: 0; } }
@keyframes sweep     { 0%, 100% { transform: rotate(-14deg); } 50% { transform: rotate(14deg); } }
@keyframes pulse-op  { 0%, 100% { opacity: .15; } 50% { opacity: 1; } }
@keyframes drop      { from { transform: translateY(-4px); opacity: 1; } 80% { opacity: 1; } to { transform: translateY(20px); opacity: 0; } }
@keyframes swing     { 0%, 100% { transform: rotate(-12deg); } 50% { transform: rotate(12deg); } }
@keyframes draw      { from { stroke-dashoffset: 30; } to { stroke-dashoffset: 0; } }
@keyframes hammer    { 0%, 100% { transform: rotate(-32deg); } 55% { transform: rotate(14deg); } }
@keyframes wobble    { 0%, 100% { transform: rotate(-12deg); } 50% { transform: rotate(-3deg); } }
@keyframes scan      { 0%, 100% { transform: translateX(-12px); } 50% { transform: translateX(12px); } }
@keyframes bob       { 0%, 100% { transform: translateY(0); } 50% { transform: translateY(-3px); } }
@keyframes press     { 0%, 100% { transform: translateY(0); } 45% { transform: translateY(6px); } }
`;

/* ---- Tools: what the stage does ------------------------------------------------------ */

const TOOLS: Record<Kind, (status: Status) => string> = {
  sense: () => `
    <rect class="ink" x="71" y="30" width="6" height="14"/>
    <g class="sense-dish">
      <path class="part" d="M56 18 Q74 44 92 18 Z"/>
      <path class="line" d="M74 30 V13"/>
      <circle class="tone-fill rim" cx="74" cy="10" r="3.5" stroke-width="1.5"/>
    </g>
    <g class="waves-set">
      <path class="tone wave" stroke-width="2" d="M98 12 q6 6 0 12"/>
      <path class="tone wave" stroke-width="2" d="M104 6 q10 12 0 24"/>
    </g>`,

  triage: () => `
    <rect class="parcel drop" x="70" y="-6" width="8" height="8" rx="1"/>
    <path class="part" d="M50 10 H98 L80 30 V44 H68 V30 Z"/>
    <circle class="tone-fill light" cx="62" cy="17" r="2.6"/>
    <circle class="tone-fill light" cx="74" cy="17" r="2.6"/>
    <circle class="tone-fill light" cx="86" cy="17" r="2.6"/>`,

  plan: () => `
    <rect class="steel" x="30" y="32" width="26" height="11" rx="5.5"/>
    <circle class="ink" cx="36" cy="37.5" r="2"/>
    <path class="tone arc" stroke-width="2" stroke-dasharray="30" d="M62 42 Q74 32 86 42"/>
    <g class="plan-arm">
      <path class="line" stroke-width="2" d="M74 8 L61 43 M74 8 L87 43"/>
      <circle class="part" cx="74" cy="8" r="4.5"/>
    </g>`,

  build: () => `
    <rect class="ink" x="64" y="36" width="20" height="8" rx="1.5"/>
    <g class="build-arm">
      <path class="line" stroke-width="3.5" d="M74 38 V14"/>
      <rect class="part" x="60" y="4" width="28" height="12" rx="2.5"/>
      <rect class="tone-fill rim" x="80" y="4" width="8" height="12" rx="2" stroke-width="1.75"/>
    </g>`,

  gates: () => `
    <rect class="part" x="52" y="14" width="14" height="30" rx="1.5"/>
    <g class="gate-boom">
      <rect class="part" x="56" y="12" width="46" height="9" rx="4.5"/>
      <rect class="ink" x="68" y="13.5" width="6" height="6"/>
      <rect class="ink" x="80" y="13.5" width="6" height="6"/>
      <circle class="tone-fill" cx="97" cy="16.5" r="2.4"/>
    </g>
    <circle class="ink" cx="59" cy="16.5" r="3.5"/>`,

  review: () => `
    <g class="lens">
      <path class="line" stroke-width="5" d="M81 23 L92 38"/>
      <circle class="steel" cx="72" cy="14" r="12" stroke-width="2.5"/>
      <path class="thin glare" d="M64 10 q3 -4 8 -4"/>
      <circle class="ink" cx="74" cy="15" r="3.5"/>
    </g>`,

  release: (status) => {
    const cage = `
      <circle class="line" cx="74" cy="6" r="3" stroke-width="1.5"/>
      <path class="line" stroke-width="1.5" d="M60 38 H88"/>`;
    const bars = `
      <path class="line" stroke-width="2" d="M58 44 V24 A16 14 0 0 1 90 24 V44"/>
      <path class="thin" d="M66 44 V12 M74 44 V10 M82 44 V12"/>
      <path class="line" stroke-width="2" d="M56 44 H92"/>`;
    const bird = status === 'failed'
      ? `<path class="thin" d="M71 43 v-4 M76 43 v-4"/>
         <ellipse class="bird" cx="73" cy="38" rx="8" ry="4.5"/>
         <circle class="bird" cx="83" cy="39" r="4.2"/>
         <path class="thin" stroke-width="1.2" d="M81.5 37.5 l3 3 M84.5 37.5 l-3 3"/>`
      : `<g class="bird-ok">
           <path class="bird" d="M67 30 l-6 3 6 2"/>
           <ellipse class="bird" cx="73" cy="30" rx="7" ry="6"/>
           <circle class="bird" cx="79" cy="24" r="4.5"/>
           <path class="ink" d="M83 22.5 l4 1.5 -4 1.5 z"/>
           <circle class="ink" cx="80" cy="23" r="1.1"/>
           <path class="thin" d="M69 29 q4 4 8 0"/>
         </g>`;
    const note = status === 'passing'
      ? `<g class="note"><circle class="tone-fill" cx="97" cy="12" r="2.4"/><path class="tone" stroke-width="1.75" d="M99.2 12 V2 l4.5 2"/></g>`
      : '';
    return cage + bird + bars + note;
  },

  verify: () => `
    <g class="stamp">
      <rect class="ink" x="70" y="10" width="8" height="13"/>
      <circle class="tone-fill rim" cx="74" cy="5" r="6.5" stroke-width="2"/>
      <rect class="part" x="56" y="22" width="36" height="11" rx="2.5"/>
      <rect class="tone-fill rim" x="59" y="33" width="30" height="4" rx="1" stroke-width="1.5"/>
    </g>`,
};

/* ---- Faces, hatches and extras: how it is doing -------------------------------------- */

const STATE_ART: Record<Status, () => { face: string; hatch: string; extra: string }> = {
  idle: () => ({
    face: `<path class="led" stroke-width="3" d="M59 82 q7 6 14 0 M95 82 q7 6 14 0"/>
           <path class="led" stroke-width="2.5" d="M80 97 h8"/>`,
    hatch: '',
    extra: `<g class="zz"><path d="M140 18 h6 l-6 7 h6"/><path d="M147 22 h4 l-4 5 h4"/></g>`,
  }),
  working: () => ({
    face: `<g class="eyes"><rect class="led-fill" x="62" y="72" width="11" height="19" rx="5.5"/><rect class="led-fill" x="95" y="72" width="11" height="19" rx="5.5"/></g>
           <path class="led" stroke-width="2.5" d="M79 98 h10"/>`,
    hatch: `<rect class="track" x="48" y="126" width="72" height="6" rx="3"/>
            <rect class="tone-fill bar" x="48" y="126" width="72" height="6" rx="3"/>`,
    extra: '',
  }),
  returning: () => ({
    face: `<g class="eyes"><rect class="led-fill" x="55" y="72" width="11" height="19" rx="5.5"/><rect class="led-fill" x="88" y="72" width="11" height="19" rx="5.5"/></g>
           <path class="led" stroke-width="2.25" d="M54 67 q6 -4 12 -2 M88 65 q6 -2 12 2"/>
           <path class="led" stroke-width="2.5" d="M77 98 h10"/>`,
    hatch: `<path class="tone" stroke-width="2.5" d="M100 129 H68 M75 122 l-7 7 7 7"/>`,
    extra: '',
  }),
  passing: () => ({
    face: `<path class="led" stroke-width="3.5" d="M59 86 q7 -11 14 0 M95 86 q7 -11 14 0"/>
           <path class="led" stroke-width="2.5" d="M77 94 q7 6 14 0"/>`,
    hatch: `<path class="tone" stroke-width="3" d="M76 129 l6 6 12 -12"/>`,
    extra: `<path class="tone-fill glint" d="M150 52 l2 6 6 2 -6 2 -2 6 -2 -6 -6 -2 6 -2 z"/>`,
  }),
  blocked: () => ({
    face: `<rect class="led-fill" x="59" y="80" width="14" height="6" rx="3"/><rect class="led-fill" x="95" y="80" width="14" height="6" rx="3"/>
           <path class="led" stroke-width="2.5" d="M58 72 l14 -4 M110 72 l-14 -4"/>
           <path class="led" stroke-width="2.5" d="M78 99 q6 -4 12 0"/>`,
    hatch: `<rect class="tone-fill" x="40" y="118" width="88" height="22" rx="4"/>
            <rect x="40" y="118" width="88" height="22" rx="4" fill="url(#hazard)"/>
            <rect class="frame" x="40" y="118" width="88" height="22" rx="4"/>`,
    extra: `<path class="tone alarm" stroke-width="2" d="M125 11 v-7 M110 19 l-6 -4 M140 19 l6 -4"/>`,
  }),
  failed: () => ({
    face: `<path class="led" stroke-width="3.25" d="M60 75 l12 13 M72 75 l-12 13 M96 75 l12 13 M108 75 l-12 13"/>
           <path class="led" stroke-width="2.25" d="M76 99 q3 -3 6 0 t6 0 t6 0"/>`,
    hatch: `<rect class="face rim" x="40" y="118" width="88" height="22" rx="4" stroke-width="1.75"/>
            <text class="fault" x="85" y="133.5" text-anchor="middle">FAULT</text>`,
    extra: `<path class="tone alarm" stroke-width="2" d="M125 11 v-7 M110 19 l-6 -4 M140 19 l6 -4"/>
            <circle class="puff puff-a" cx="44" cy="40" r="3.5"/>
            <circle class="puff puff-b" cx="51" cy="40" r="3.5"/>`,
  }),
};

const CHEV_RIGHT = Array.from({ length: 10 }, (_, i) => `M${-13 + 21 * i} 169l6 5-6 5`).join('');
const CHEV_LEFT = Array.from({ length: 10 }, (_, i) => `M${-7 + 21 * i} 169l-6 5 6 5`).join('');

function render(kind: Kind, status: Status): string {
  const art = STATE_ART[status]();
  return `
<svg viewBox="0 -20 168 220" class="s-${status} k-${kind}" part="svg" aria-hidden="true" focusable="false">
  <defs>
    <clipPath id="belt-clip"><rect x="0" y="166" width="168" height="16"/></clipPath>
    <pattern id="hazard" width="10" height="10" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
      <rect class="hazard-stripe" width="5" height="10"/>
    </pattern>
  </defs>

  <!-- belt -->
  <rect class="belt" x="0" y="166" width="168" height="16"/>
  <g clip-path="url(#belt-clip)"><g class="belt-run"><path class="chev" d="${status === 'returning' ? CHEV_LEFT : CHEV_RIGHT}"/></g></g>
  <path class="line" stroke-width="1.5" d="M0 166 H168 M0 182 H168"/>
  <circle class="roller" cx="0" cy="174" r="5"/><circle class="roller" cx="168" cy="174" r="5"/>

  <!-- legs stay on the belt; everything above them is the machine -->
  <rect class="steel" x="42" y="146" width="10" height="20"/>
  <rect class="steel" x="116" y="146" width="10" height="20"/>

  <g class="machine" part="machine">
  <!-- tool -->
  ${TOOLS[kind](status)}

  <!-- chassis -->
  <rect class="body" x="28" y="44" width="112" height="106" rx="12"/>
  <path class="seam" d="M35 62 V132"/>
  <rect class="face" x="42" y="58" width="84" height="48" rx="8"/>
  <rect class="steel" x="40" y="118" width="88" height="22" rx="4" stroke-width="1.5"/>
  <circle class="ink" cx="36" cy="52" r="1.6"/><circle class="ink" cx="36" cy="142" r="1.6"/><circle class="ink" cx="132" cy="142" r="1.6"/>

  <!-- beacon -->
  <rect class="ink" x="116" y="36" width="18" height="8" rx="1.5"/>
  <circle class="beacon-glow" cx="125" cy="31" r="14"/>
  <path class="dome" d="M117 36 a8 8 0 0 1 16 0 z"/>

  <!-- state -->
  ${art.face}
  ${art.hatch}
  ${art.extra}
  </g>
</svg>`;
}

let sheet: CSSStyleSheet | undefined;

export class Station extends HTMLElement {
  static observedAttributes = ['kind', 'status', 'label', 'decorative'];

  readonly #root: ShadowRoot;

  constructor() {
    super();
    this.#root = this.attachShadow({ mode: 'open' });
    if (!sheet) {
      sheet = new CSSStyleSheet();
      sheet.replaceSync(CSS);
    }
    this.#root.adoptedStyleSheets = [sheet];
  }

  connectedCallback(): void {
    this.#update();
  }

  attributeChangedCallback(): void {
    if (this.isConnected) this.#update();
  }

  // Properties reflect their attributes, so frameworks that set properties (React does) and markup that sets
  // attributes draw the same thing.
  get kind(): Kind {
    const k = this.getAttribute('kind');
    return KINDS.find((kind) => kind === k) ?? 'build';
  }

  set kind(kind: Kind) {
    this.setAttribute('kind', kind);
  }

  get status(): Status {
    const s = this.getAttribute('status');
    return STATUSES.find((status) => status === s) ?? 'idle';
  }

  set status(status: Status) {
    this.setAttribute('status', status);
  }

  #update(): void {
    const { kind, status } = this;
    this.#root.innerHTML = render(kind, status);
    if (this.hasAttribute('decorative')) {
      this.setAttribute('aria-hidden', 'true');
      this.removeAttribute('role');
      this.removeAttribute('aria-label');
    } else {
      this.removeAttribute('aria-hidden');
      this.setAttribute('role', 'img');
      this.setAttribute('aria-label', this.getAttribute('label') || `${STAGE_NAME[kind]}: ${STATE[status].label}`);
    }
  }
}

if (!customElements.get('sf-station')) customElements.define('sf-station', Station);
