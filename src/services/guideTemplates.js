// HTML of the channel guide, one approved look per channel (App Lab board 50,
// approved by the GLC direction 2026-11-11), each a little different per
// bracket: morning = warm sunrise light + sun ("Good morning!"), afternoon =
// high clear light, tonight = violet dusk + moon + the night's film, late night
// = dark with stars, moon and the mascot asleep (Zzz). Elementary also changes
// the paper and tape colour; MoE Central sets its clock to :59 before the
// bracket and its ticker announces the next one.
//
// The stage is 768x432 CSS px (rendered at 2.5x = 1920x1080). Every animation
// is CSS, so guideRender.js can pause and seek them frame by frame. Pure: a
// view in, an HTML string out (see guideView() in guideRender.js).

const AS = '/guide/assets';
const MASCOT = `${AS}/mascot.png`;
const LOGO = {
  discover: `${AS}/logo-discover.png`, jr: `${AS}/logo-jr.png`, teen: `${AS}/logo-teen.png`,
  elevate: `${AS}/logo-elevate.png`, elementary: `${AS}/logo-elementary.png`, moe: `${AS}/logo-moe.png`,
};
export const MUSIC = {
  discover: `${AS}/music-discover.mp3`, jr: `${AS}/music-jr.mp3`, teen: `${AS}/music-teen.mp3`,
  elevate: `${AS}/music-elevate.mp3`, elementary: `${AS}/music-elementary.mp3`, moe: `${AS}/music-moe.mp3`,
};
const POSTER = ['linear-gradient(135deg,#d62828,#f77f00)', 'linear-gradient(135deg,#7209b7,#4cc9f0)', 'linear-gradient(135deg,#55a630,#f4a261)',
  'linear-gradient(135deg,#ef476f,#ffd166)', 'linear-gradient(135deg,#118ab2,#06d6a0)'];

// index = position in the approved board (am, pm, eve, late)
const BK = {
  am: { i: 0, name: 'Morning', word: 'THIS MORNING', range: '6 AM – 12 PM', ruler: ['6 AM', '8 AM', '10 AM', '12 PM'], clock: ['5:59', 'AM'] },
  pm: { i: 1, name: 'Afternoon', word: 'THIS AFTERNOON', range: '12 PM – 6 PM', ruler: ['12 PM', '2 PM', '4 PM', '6 PM'], clock: ['11:59', 'AM'] },
  eve: { i: 2, name: 'Tonight', word: 'TONIGHT', range: '6 PM – 12 AM', ruler: ['6 PM', '8 PM', '10 PM', '12 AM'], clock: ['5:59', 'PM'] },
  late: { i: 3, name: 'Late Night', word: 'LATE NIGHT', range: '12 AM – 6 AM', ruler: ['12 AM', '2 AM', '4 AM', '6 AM'], clock: ['11:59', 'PM'] },
};
const pick = (bk, list) => list[BK[bk].i];

export const E = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const f1 = (n) => (Math.round(n * 10) / 10).toString();
const f0 = (n) => String(Math.round(n));

const ICON = {
  am: '<svg width="{s}" height="{s}" viewBox="0 0 30 30"><circle cx="15" cy="19" r="7" fill="#ffd27a"/><g stroke="#ffd27a" stroke-width="2" stroke-linecap="round"><path d="M15 5v4M5 19h3M22 19h3M8 12l2 2M22 12l-2 2"/></g><path d="M3 26h24" stroke="{c}" stroke-width="2" stroke-linecap="round" opacity=".7"/></svg>',
  pm: '<svg width="{s}" height="{s}" viewBox="0 0 30 30"><circle cx="15" cy="15" r="7" fill="#ffd84a"/><g stroke="#ffd84a" stroke-width="2" stroke-linecap="round"><path d="M15 2v4M15 24v4M2 15h4M24 15h4M6 6l3 3M21 21l3 3M24 6l-3 3M6 24l3-3"/></g></svg>',
  eve: '<svg width="{s}" height="{s}" viewBox="0 0 30 30"><path d="M20 4a11 11 0 1 0 6 18A9 9 0 0 1 20 4z" fill="#ffe2a0"/></svg>',
  late: '<svg width="{s}" height="{s}" viewBox="0 0 30 30"><path d="M18 4a11 11 0 1 0 8 16A9 9 0 0 1 18 4z" fill="#bcd6ff"/><circle cx="25" cy="6" r="1.4" fill="#fff"/><circle cx="6" cy="5" r="1" fill="#fff"/></svg>',
};
const icon = (bk, s = 26, c = '#fff') => ICON[bk].replaceAll('{s}', String(s)).replaceAll('{c}', c);
const GLOW = {
  am: 'radial-gradient(circle at 88% 4%,rgba(255,200,110,.75) 0,rgba(243,140,60,.35) 16%,transparent 40%),linear-gradient(0deg,rgba(255,160,80,.18),transparent 45%)',
  pm: 'radial-gradient(circle at 50% -10%,rgba(255,250,215,.65) 0,rgba(150,220,255,.3) 25%,transparent 55%)',
  eve: 'radial-gradient(circle at 88% 6%,rgba(170,120,255,.55) 0,transparent 38%),linear-gradient(0deg,rgba(255,110,90,.16),transparent 35%)',
  late: 'radial-gradient(circle at 86% 8%,rgba(150,190,255,.45) 0,transparent 30%),linear-gradient(rgba(0,0,20,.35),rgba(0,0,20,.35))',
};
const STARS = [[8, 6, 2, 2.4, 0], [22, 14, 1.5, 3, 0.6], [37, 4, 2, 2, 1.1], [55, 10, 1.5, 2.8, 0.3], [64, 3, 2, 2.2, 1.5], [73, 18, 1.5, 3.2, 0.9],
  [93, 22, 2, 2.6, 0.2], [47, 20, 1.5, 2.9, 1.8], [15, 24, 1.5, 2.1, 1.2], [82, 30, 1.5, 3.4, 0.5]]
  .map(([x, y, w, d, o]) => `<i style="position:absolute;left:${x}%;top:${y}%;width:${w}px;height:${w}px;border-radius:50%;background:#fff;animation:g_tw ${d}s ${o}s infinite"></i>`).join('');
const sky = (bk, op = 1) => `<div style="position:absolute;inset:0;background:${GLOW[bk]};opacity:${op}"></div>`
  + (bk === 'late' ? `<div style="position:absolute;inset:0">${STARS}</div>` : '');
const zzz = (color) => [0, 1, 2].map((i) => `<span style="position:absolute;left:${-4 - i * 8}px;top:${18 + i * 4}px;font:900 ${14 + i * 4}px system-ui;color:${color};animation:g_zz 2.4s ${f1(i * 0.8)}s infinite;opacity:0">z</span>`).join('');
function mascot(bk, style, h = 96) {
  const asleep = bk === 'late';
  const anim = asleep ? 'transform:rotate(-8deg)' : 'transform-origin:50% 90%;animation:g_wave 2.2s ease-in-out infinite';
  const extra = asleep ? zzz('#cfe0ff') : bk === 'am' ? `<span style="position:absolute;left:-14px;top:-6px">${icon('am', 28)}</span>` : '';
  return `<div style="position:absolute;${style};height:${h}px"><img src="${MASCOT}" style="height:${h}px;${anim};filter:drop-shadow(0 6px 10px rgba(0,0,0,.4))">${extra}</div>`;
}
const COMMON = (secs) => `@keyframes g_tw{0%,100%{opacity:.2}50%{opacity:1}}
@keyframes g_wave{0%,100%{transform:rotate(-6deg) translateY(0)}50%{transform:rotate(6deg) translateY(-6px)}}
@keyframes g_zz{0%{opacity:0;transform:translate(0,0) scale(.7)}30%{opacity:1}100%{opacity:0;transform:translate(-16px,-28px) scale(1.15)}}
@keyframes g_bar{from{width:0}to{width:100%}}
@keyframes g_kb{from{transform:scale(1)}to{transform:scale(1.12) translate(-8px,-5px)}}
@keyframes g_sweep{0%{left:-40%}60%,100%{left:125%}}
.g-bar{animation:g_bar ${secs}s linear forwards}`;

const durText = (s) => { const t = Math.round(s / 60); const h = Math.floor(t / 60), m = t % 60; return h ? `${h}h ${String(m).padStart(2, '0')}m` : `${m} min`; };
export function sub(r) {
  if (!r) return '';
  if (r.kind === 'movie') return `Movie · ${durText(r.duration)}`;
  const t = r.tag || '';
  if (t.includes('LESSON')) return t === 'LESSON' ? 'Lesson' : t.replace('LESSONS', 'Lessons');
  if (t.startsWith('EP ')) return `Episode ${t.slice(3)}`;
  if (t.endsWith('EPS')) return t.replace('EPS', 'episodes');
  return t;
}
const bgOf = (r, j = 0) => (r?.img ? `url(${r.img}) center/cover` : POSTER[j % POSTER.length]);
const hasPic = (r) => Boolean(r.img) || r.kind === 'movie';
const short = (t) => String(t).split(' ')[0];
const fit = (n, avail, mx, gap) => Math.max(20, Math.min(mx, (avail - gap * (n - 1)) / Math.max(n, 1)));

// ---------------------------------------------------------------- Discover: glass + featured
function discover(v) {
  const { bk, rows, hero } = v; const b = BK[bk];
  const base = pick(bk, ['#1f7fb8,#0f4f80 45%,#04192a', '#2aa0dc,#136ea8 45%,#052238', '#2a1f6b,#14245c 40%,#04192a', '#0b1a3d,#071230 50%,#020814']);
  const n = rows.length; const h = fit(n, 278, 44, 5); const one = h < 34;
  const list = rows.map((r, j) => {
    const nxt = j === 0 ? '<span class="tag">NEXT</span>' : '';
    const th = r.kind === 'movie' ? `<div style="width:${f0(h * 1.6)}px;height:${f0(h - 8)}px;border-radius:4px;background:${bgOf(r, j)}"></div>` : '';
    const body = one
      ? `<div style="flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis"><b style="font-size:13px">${E(r.title)}</b><span style="font-size:10px;opacity:.7;margin-left:7px">${E(sub(r))}</span></div>`
      : `<div style="flex:1;min-width:0"><div style="font-size:15px;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${E(r.title)}</div><div style="font-size:10px;opacity:.7">${E(sub(r))}</div></div>`;
    const hl = j === 0 ? 'background:linear-gradient(90deg,rgba(54,176,224,.3),rgba(255,255,255,.06));border-color:rgba(54,176,224,.6);' : '';
    return `<div class="row" style="height:${f1(h)}px;animation-delay:${(0.4 + j * 0.12).toFixed(2)}s;${hl}"><span class="t" style="font-size:${one ? 13 : 15}px">${r.time}</span>${body}${th}${nxt}</div>`;
  }).join('');
  let lab = { am: "THIS MORNING'S PICK", pm: "THIS AFTERNOON'S PICK", eve: "TONIGHT'S MOVIE", late: 'LATE-NIGHT PICK' }[bk];
  if (hero && hero.kind !== 'movie') lab = lab.replace('MOVIE', 'PICK');
  const feat = !hero ? '' : `<div style="position:absolute;top:104px;right:56px;width:280px;height:226px;border-radius:14px;overflow:hidden;box-shadow:0 18px 50px rgba(0,0,0,.6);opacity:0;animation:d_inR .8s .5s cubic-bezier(.2,.8,.2,1) forwards">
  <div style="position:absolute;inset:0;background:${bgOf(hero)};animation:g_kb 14s linear forwards"></div>
  <div style="position:absolute;inset:0;background:linear-gradient(180deg,transparent 40%,rgba(0,0,0,.85))"></div>
  <div style="position:absolute;top:0;bottom:0;width:30%;background:linear-gradient(90deg,transparent,rgba(255,255,255,.25),transparent);animation:g_sweep 4s 1.4s infinite"></div>
  <div style="position:absolute;left:16px;bottom:14px;right:16px"><span class="tag">${lab}</span><div style="font-size:${hero.title.length < 22 ? 22 : 18}px;font-weight:900;margin-top:6px;line-height:1.05">${E(hero.title)}</div><div style="font-size:12px;color:#7fd3f5;margin-top:3px;font-weight:700">${hero.time} · ${E(sub(hero))}</div></div></div>`;
  const css = `@keyframes d_inL{from{opacity:0;transform:translateX(-40px)}to{opacity:1;transform:none}}
@keyframes d_inR{from{opacity:0;transform:scale(1.08)}to{opacity:1;transform:none}}
.cd *{box-sizing:border-box}
.cd .row{display:flex;align-items:center;gap:10px;padding:0 10px;border-radius:9px;background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.1);opacity:0;animation:d_inL .6s cubic-bezier(.2,.8,.2,1) forwards}
.cd .t{font-weight:800;color:#7fd3f5;width:70px;flex:none}
.cd .tag{font-size:9px;font-weight:800;letter-spacing:1.5px;padding:2px 6px;border-radius:3px;background:#36b0e0;color:#04192a;white-space:nowrap}`;
  const st = `<div id="stage" class="cd" style="width:768px;height:432px;position:relative;overflow:hidden;color:#fff;background:#04192a;font-family:system-ui,sans-serif">
 <div style="position:absolute;inset:-20px;background:radial-gradient(circle at 15% 20%,${base});filter:blur(14px);animation:g_kb 20s linear forwards"></div>
 ${sky(bk)}
 <div style="position:absolute;inset:0;background:linear-gradient(90deg,rgba(2,14,24,.75) 0,rgba(2,14,24,.25) 60%,rgba(2,14,24,.5))"></div>
 <div style="position:absolute;top:16px;left:28px;animation:d_inL .5s both;display:flex;align-items:center;gap:14px"><img src="${LOGO.discover}" style="height:46px;filter:drop-shadow(0 4px 12px rgba(0,0,0,.4))">
  <div style="display:flex;align-items:center;gap:8px">${icon(bk)}<div><div style="font-size:18px;font-weight:900;letter-spacing:1px">COMING UP ${b.word}</div><div style="font-size:11px;letter-spacing:4px;color:#7fd3f5">${b.range}</div></div></div></div>
 <div style="position:absolute;top:96px;left:28px;width:390px;display:flex;flex-direction:column;gap:5px">${list}</div>
 ${feat}
 ${mascot(bk, 'right:14px;bottom:42px', 84)}
 <div style="position:absolute;left:0;right:0;bottom:0;height:38px;background:rgba(0,0,0,.5);display:flex;align-items:center;padding:0 28px;gap:14px;font-size:11px">
  <span style="font-weight:800;letter-spacing:2px;color:#7fd3f5">GLC DISCOVER</span><span style="opacity:.6">${E(v.dateTitle)}</span><span style="margin-left:auto;opacity:.6">${b.range}</span>
  <div class="g-bar" style="position:absolute;left:0;bottom:0;height:3px;background:#36b0e0"></div></div>
</div>`;
  return { css, st };
}

// ---------------------------------------------------------------- Jr: timeline
function jr(v) {
  const { bk, rows } = v; const b = BK[bk];
  const big = { am: 'GOOD MORNING!', pm: 'THIS AFTERNOON', eve: 'TONIGHT', late: 'LATE NIGHT' }[bk];
  const base = pick(bk, ['#3a73e8,#1d47b0 45%,#0c1f52', '#4b8af0,#2257c4 45%,#0e2560', '#2b3fa8,#172a78 45%,#0a1440', '#16246b,#0d1848 50%,#050a24']);
  const n = rows.length; const two = n > 5; const per = two ? Math.ceil(n / 2) : Math.max(n, 1);
  const W = 708, gap = 10; const cw = (W - gap * (per - 1)) / per;
  const ch = two ? 100 : 150; const ih = two ? 46 : 84;
  const cards = rows.map((r, j) => {
    const row = two ? Math.floor(j / per) : 0; const col = two ? j % per : j;
    const top = two ? 112 + row * (ch + 10) : 150;
    const pic = hasPic(r);
    const ib = pic ? `background:${bgOf(r, j)}` : 'background:linear-gradient(135deg,rgba(255,210,63,.35),rgba(232,52,64,.35));display:flex;align-items:center;justify-content:center;font-size:22px';
    const glyph = pic ? '' : (r.kind === 'lesson' ? '📚' : '★');
    const nx = j === 0 ? '<span style="position:absolute;top:5px;left:5px;font-size:8px;font-weight:900;background:#e83440;color:#fff;padding:2px 5px;border-radius:3px">NEXT</span>' : '';
    return `<div class="card" style="left:${f0(30 + col * (cw + gap))}px;top:${top}px;width:${f0(cw)}px;height:${ch}px;animation-delay:${(0.5 + j * 0.12).toFixed(2)}s;${j === 0 ? 'outline:3px solid #e83440;' : ''}"><div class="img" style="height:${ih}px;${ib}">${glyph}${nx}</div><div class="cap"><div class="tm">${r.time}${r.kind === 'movie' ? ' · MOVIE' : ''}</div><div class="nm">${E(r.title)}</div><div class="sub">${E(r.kind === 'movie' ? durText(r.duration) : sub(r))}</div></div></div>`;
  }).join('');
  const pins = rows.map((r, j) => {
    const x = 30 + 708 * Math.min(Math.max((r.at - v.bracketStart) / 21600, 0), 1);
    return `<div class="pin" style="left:${f0(x)}px;${j === 0 ? 'animation:j_pulse 1.6s infinite;' : ''}"></div>`;
  }).join('');
  const css = `@keyframes j_up{from{opacity:0;transform:translateY(30px)}to{opacity:1;transform:none}}
@keyframes j_grow{from{width:0}to{width:100%}}
@keyframes j_pulse{0%,100%{box-shadow:0 0 0 0 rgba(232,52,64,.7)}50%{box-shadow:0 0 0 10px rgba(232,52,64,0)}}
.cj *{box-sizing:border-box}
.cj .card{position:absolute;border-radius:12px;overflow:hidden;background:rgba(255,255,255,.1);border:1px solid rgba(255,210,63,.35);color:#fff;box-shadow:0 10px 24px rgba(0,0,0,.3);opacity:0;animation:j_up .7s cubic-bezier(.2,.8,.2,1) forwards}
.cj .img{position:relative;background-size:cover!important;background-position:center!important}
.cj .cap{padding:5px 8px}
.cj .tm{font-size:11px;font-weight:900;color:#ffd23f}
.cj .nm{font-size:12px;font-weight:800;line-height:1.1;margin-top:1px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.cj .sub{font-size:9px;opacity:.65;margin-top:1px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.cj .pin{position:absolute;bottom:50px;width:12px;height:12px;border-radius:50%;background:#ffd23f;border:3px solid #e83440;transform:translateX(-50%)}`;
  const st = `<div id="stage" class="cj" style="width:768px;height:432px;position:relative;overflow:hidden;color:#fff;background:radial-gradient(circle at 20% 10%,${base});font-family:system-ui,sans-serif">
 ${sky(bk)}
 <div style="position:absolute;inset:0;opacity:.16;background-image:radial-gradient(circle,#fff 3px,transparent 4px);background-size:34px 34px"></div>
 <div style="position:absolute;top:10px;left:26px;animation:j_up .5s both"><img src="${LOGO.jr}" style="height:${two ? 70 : 88}px;display:block;filter:drop-shadow(0 4px 10px rgba(0,0,0,.4))"></div>
 <div style="position:absolute;top:22px;left:${two ? 170 : 190}px;animation:j_up .5s .15s both"><div style="display:flex;align-items:center;gap:10px"><div style="font-size:34px;font-weight:900;line-height:.9">${big}</div>${icon(bk, 32)}</div><div style="font-size:12px;letter-spacing:4px;margin-top:5px;font-weight:700">${b.range}</div></div>
 ${mascot(bk, 'right:36px;top:6px', two ? 84 : 96)}
 ${cards}
 <div style="position:absolute;left:30px;right:30px;bottom:54px;height:4px;border-radius:2px;background:rgba(255,255,255,.2)"><div style="height:4px;border-radius:2px;background:#e83440;animation:j_grow 2s .3s both"></div></div>
 ${pins}
 <div style="position:absolute;left:30px;right:30px;bottom:22px;display:flex;justify-content:space-between;font-size:11px;font-weight:800;letter-spacing:2px">${b.ruler.map((t) => `<span>${t}</span>`).join('')}</div>
</div>`;
  return { css, st };
}

// ---------------------------------------------------------------- Teen: trailer + tiles
function teen(v) {
  const { bk, rows, hero, seconds } = v; const b = BK[bk];
  const base = pick(bk, ['#7a3e8c,#3a1d63 45%,#120b2e', '#5a4fc8,#2a1f6b 45%,#120b2e', '#3a1360,#1d0b40 45%,#06030f', '#1a0f3d,#0d0726 50%,#030108']);
  const n = rows.length; const per = n <= 4 ? Math.max(n, 1) : Math.ceil(n / 2); const two = n > 4;
  const W = 700, gap = 12; const tw = Math.floor((W - gap * (per - 1)) / per); const ih = two ? 66 : 150;
  const half = seconds / 2;
  const tiles = rows.map((r, j) => {
    const pic = hasPic(r);
    const img = pic ? bgOf(r, j) : 'linear-gradient(135deg,#6a6fc8,#c06fb0)';
    const hl = j === 0 ? 'border-color:#00d0f5;box-shadow:0 0 0 2px #00d0f5;' : '';
    const glyph = pic ? '' : (r.kind === 'lesson' ? '📚' : '▶');
    return `<div class="tile" style="width:${tw}px;animation-delay:${(half + 0.4 + j * 0.15).toFixed(2)}s;${hl}"><div style="height:${ih}px;background:${img};background-size:cover;background-position:center;display:flex;align-items:center;justify-content:center;font-size:${two ? 26 : 40}px;color:rgba(255,255,255,.85)">${glyph}</div><div style="padding:${two ? 5 : 8}px 8px"><div style="color:#00d0f5;font-weight:900;font-size:${two ? 11 : 13}px">${r.time}</div><div style="font-weight:700;font-size:${two ? 12 : 15}px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${E(r.title)}</div><div style="font-size:9.5px;opacity:.6;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${E(sub(r))}</div></div></div>`;
  }).join('');
  const hw = { am: 'THIS MORNING', pm: 'THIS AFTERNOON', eve: 'TONIGHT', late: 'LATE TONIGHT' }[bk];
  const also = { am: 'All morning', pm: 'All afternoon', eve: 'All night long', late: 'After midnight' }[bk];
  const css = `@keyframes t_s1{0%{opacity:0}2%,45%{opacity:1}49%,100%{opacity:0}}
@keyframes t_s2{0%,46%{opacity:0}50%,100%{opacity:1}}
@keyframes t_kb2{from{transform:scale(1.15)}to{transform:scale(1)}}
@keyframes t_ttl{from{opacity:0;letter-spacing:12px}to{opacity:1;letter-spacing:0}}
@keyframes t_up{from{opacity:0;transform:translateY(24px)}to{opacity:1;transform:none}}
.ct .sc{position:absolute;inset:0}
.ct .tile{box-sizing:border-box;border-radius:11px;overflow:hidden;background:rgba(255,255,255,.07);border:1px solid rgba(180,140,255,.35);opacity:0;animation:t_up .6s cubic-bezier(.2,.8,.2,1) forwards}`;
  const st = `<div id="stage" class="ct" style="width:768px;height:432px;position:relative;overflow:hidden;color:#fff;background:#000;font-family:system-ui,sans-serif">
 <div class="sc" style="animation:t_s1 ${seconds}s forwards">
  <div style="position:absolute;inset:0;background:${hero?.img ? `url(${hero.img}) center/cover` : '#222'};animation:t_kb2 ${half}s linear forwards"></div>
  <div style="position:absolute;inset:0;background:linear-gradient(90deg,rgba(0,0,0,.9) 0,rgba(0,0,0,.35) 55%,transparent),linear-gradient(0deg,rgba(0,0,0,.7),transparent 40%)"></div>
  ${sky(bk, 0.7)}
  ${mascot(bk, 'right:30px;bottom:20px', 130)}
  <img src="${LOGO.teen}" style="position:absolute;top:20px;left:28px;height:62px">
  <div style="position:absolute;left:36px;top:140px;max-width:460px">
   <div style="display:flex;align-items:center;gap:8px;font-size:12px;letter-spacing:5px;color:#00d0f5;font-weight:700">${icon(bk, 22)}${hw} AT ${hero ? hero.time : ''}</div>
   <div style="font-size:${hero && hero.title.length < 20 ? 46 : 36}px;font-weight:900;line-height:1;margin-top:8px;animation:t_ttl 1.2s .3s both;text-shadow:0 4px 24px rgba(0,0,0,.6)">${E(hero?.title)}</div>
   <div style="width:70px;height:4px;border-radius:2px;background:linear-gradient(90deg,#6a6fc8,#c06fb0);margin-top:14px"></div>
   <div style="font-size:12px;opacity:.75;margin-top:10px">${E(sub(hero))}</div>
  </div>
 </div>
 <div class="sc" style="animation:t_s2 ${seconds}s forwards;background:radial-gradient(circle at 25% 15%,${base})">
  ${sky(bk)}
  <div style="position:absolute;inset:0;opacity:.25;background:linear-gradient(115deg,transparent 40%,#6a6fc8 41%,transparent 42%),linear-gradient(115deg,transparent 70%,#c06fb0 71%,transparent 72%)"></div>
  <div style="position:absolute;top:20px;left:32px;right:32px;display:flex;justify-content:space-between;align-items:center">
   <div><div style="font-size:28px;font-weight:900;display:flex;align-items:center;gap:10px">${also} ${icon(bk, 28)}</div><div style="font-size:11px;letter-spacing:4px;opacity:.8;font-weight:700">${b.range}</div></div>
   <img src="${LOGO.teen}" style="height:50px">
  </div>
  <div style="position:absolute;left:32px;right:32px;top:${two ? 92 : 110}px;display:flex;flex-wrap:wrap;gap:${gap}px">${tiles}</div>
  <div style="position:absolute;left:32px;bottom:16px;font-size:11px;letter-spacing:3px;opacity:.6">GLC TEEN · ${E(v.dateLong)}</div>
 </div>
</div>`;
  return { css, st };
}

// ---------------------------------------------------------------- Elevate: floors
function elevate(v) {
  const { bk, rows, hero } = v; const b = BK[bk];
  const tint = pick(bk, ['linear-gradient(180deg,rgba(255,170,80,.28),rgba(10,79,146,.1) 55%)', 'linear-gradient(180deg,rgba(255,255,230,.18),transparent 60%)',
    'linear-gradient(180deg,rgba(60,20,120,.5),rgba(6,30,80,.45))', 'linear-gradient(180deg,rgba(2,6,30,.78),rgba(2,10,40,.7))']);
  const n = rows.length; const h = fit(n, 248, 44, 6);
  const lv = rows.map((r, j) => {
    const th = r.kind === 'movie' && r.img ? `<div style="width:50px;height:${f0(h - 14)}px;border-radius:3px;background:${bgOf(r, j)}"></div>` : '';
    const text = h >= 32
      ? `<div class="ti">${E(r.title)}</div><div class="ep">${E(sub(r)).toUpperCase()}</div>`
      : `<div style="display:flex;align-items:baseline;gap:8px;min-width:0"><span class="ti" style="font-size:13px">${E(r.title)}</span><span class="ep" style="flex:none">${E(sub(r)).toUpperCase()}</span></div>`;
    return `<div class="lv" style="height:${f1(h)}px;animation-delay:${(0.3 + j * 0.15).toFixed(2)}s"><div class="n">${short(r.time)}</div><div class="body"><div style="flex:1;min-width:0">${text}</div>${th}${j === 0 ? '<span class="chip">NEXT</span>' : ''}</div></div>`;
  }).join('');
  const disp = b.ruler.slice(0, 3).map((t) => `<div style="height:44px;line-height:44px">▲ ${t.replace(' ', '')}</div>`).join('')
    + `<div style="height:44px;line-height:44px">● ${hero ? hero.time.replace(' ', '').replace(':00', '') : ''}</div>`;
  const lab = hero?.kind === 'movie' ? 'TOP FLOOR · MOVIE' : 'TOP FLOOR · FEATURE';
  const css = `@keyframes e_rise{from{opacity:0;transform:translateY(60px)}to{opacity:1;transform:none}}
@keyframes e_slideR{from{opacity:0;transform:translateX(-30px)}to{opacity:1;transform:none}}
@keyframes e_chev{0%{transform:translateY(20px);opacity:0}40%{opacity:.5}100%{transform:translateY(-60px);opacity:0}}
@keyframes e_floor{0%,18%{transform:translateY(0)}25%,43%{transform:translateY(-44px)}50%,68%{transform:translateY(-88px)}75%,100%{transform:translateY(-132px)}}
.ce *{box-sizing:border-box}
.ce .lv{position:relative;display:flex;align-items:stretch;margin-bottom:6px;opacity:0;animation:e_rise .7s cubic-bezier(.2,.8,.2,1) forwards}
.ce .lv .n{width:60px;flex:none;display:flex;align-items:center;justify-content:center;font-weight:900;font-size:13px;background:rgba(255,255,255,.95);color:#0a5ea8;clip-path:polygon(0 0,82% 0,100% 50%,82% 100%,0 100%)}
.ce .lv .body{flex:1;min-width:0;display:flex;align-items:center;gap:10px;padding:0 12px;margin-left:-6px;background:linear-gradient(90deg,rgba(255,255,255,.16),rgba(255,255,255,.04));border-left:3px solid #7fd6ff}
.ce .lv .ti{font-weight:800;font-size:14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ce .lv .ep{font-size:9.5px;letter-spacing:1px;color:#bfe9ff}
.ce .chip{font-size:8.5px;font-weight:900;letter-spacing:1.5px;padding:2px 6px;border-radius:2px;background:#fff;color:#0a5ea8}`;
  const st = `<div id="stage" class="ce" style="width:768px;height:432px;position:relative;overflow:hidden;color:#fff;background:#0a4f92;font-family:system-ui,sans-serif">
 <div style="position:absolute;inset:0;background:url(${AS}/bg-blue.png) center/cover;animation:g_kb 22s linear forwards"></div>
 <div style="position:absolute;inset:0;background:${tint}"></div>
 ${sky(bk, 0.8)}
 <div style="position:absolute;inset:0;opacity:.13;background:repeating-linear-gradient(115deg,#fff 0 2px,transparent 2px 90px)"></div>
 <div style="position:absolute;right:250px;top:150px;font-size:60px;font-weight:900;animation:e_chev 2.4s infinite">︿</div>
 <div style="position:absolute;right:250px;top:150px;font-size:60px;font-weight:900;animation:e_chev 2.4s 1.2s infinite">︿</div>
 <div style="position:absolute;top:20px;left:30px;display:flex;align-items:center;gap:18px;animation:e_slideR .6s both">
  <img src="${LOGO.elevate}" style="height:54px;filter:drop-shadow(0 3px 10px rgba(0,0,0,.35))"><div style="width:2px;height:40px;background:rgba(255,255,255,.5)"></div>
  <div><div style="font-size:11px;letter-spacing:5px;color:#bfe9ff;font-weight:700;display:flex;align-items:center;gap:6px">${icon(bk, 18)}LEVEL UP ${b.word}</div><div style="font-size:24px;font-weight:900;line-height:1.05">${b.range}</div></div></div>
 <div style="position:absolute;left:30px;top:104px;width:450px">${lv}</div>
 <div style="position:absolute;right:30px;top:24px;width:210px;height:330px;border-radius:6px;overflow:hidden;box-shadow:0 20px 50px rgba(0,20,60,.6);opacity:0;animation:e_rise .9s .5s cubic-bezier(.2,.8,.2,1) forwards;border:2px solid rgba(255,255,255,.7)">
  <div style="position:absolute;inset:0;background:${hero?.img ? `url(${hero.img}) center/cover` : POSTER[1]}"></div>
  <div style="position:absolute;inset:0;background:linear-gradient(180deg,rgba(0,0,0,.2),transparent 30%,rgba(0,0,0,.9))"></div>
  <div style="position:absolute;top:0;bottom:0;width:25%;background:linear-gradient(90deg,transparent,rgba(255,255,255,.3),transparent);animation:g_sweep 4s 1.6s infinite"></div>
  <div style="position:absolute;top:10px;right:10px;height:44px;overflow:hidden;background:#000;border-radius:4px;padding:0 8px;font:900 14px ui-monospace,monospace;color:#ff9b3d;box-shadow:inset 0 0 8px rgba(255,155,61,.4)"><div style="animation:e_floor 8s infinite">${disp}</div></div>
  <div style="position:absolute;left:14px;right:14px;bottom:16px"><span class="chip">${lab}</span>
   <div style="font-size:${hero && hero.title.length < 24 ? 22 : 19}px;font-weight:900;line-height:1.05;margin-top:8px">${E(hero?.title)}</div>
   <div style="font-size:12px;color:#bfe9ff;font-weight:700;margin-top:6px">${hero ? `${hero.time} · ${E(sub(hero))}` : ''}</div></div></div>
 <div style="position:absolute;left:0;right:0;bottom:0;height:40px;background:#fff;color:#0a5ea8;display:flex;align-items:center;padding:0 30px;gap:14px;font-size:11px;font-weight:800;letter-spacing:2px">
  <span>GLC ELEVATE</span><span style="opacity:.5;font-weight:600;letter-spacing:1px">${E(v.dateLong)}</span><span style="margin-left:auto;opacity:.5">${b.range}</span>
  <div class="g-bar" style="position:absolute;left:0;top:0;height:3px;background:#29abe2"></div></div>
</div>`;
  return { css, st };
}

// ---------------------------------------------------------------- Elementary: notebook
function elementary(v) {
  const { bk, rows, hero } = v; const b = BK[bk];
  const paper = pick(bk, ['#fff6e3', '#fffdf6', '#f3efff', '#e9eef8']);
  const line = pick(bk, ['#f2d9b0', '#cfe6f6', '#d9d0f5', '#c7d3ea']);
  const tape = pick(bk, ['#f5a64a', '#4fc3f7', '#9b7ae8', '#5a7bb8']);
  const head = { am: "Good morning! Today's first lessons", pm: 'Still to come this afternoon', eve: 'Tonight on Elementary', late: 'While you sleep (12–6 AM)' }[bk];
  const n = rows.length; const lh = Math.round(fit(n, 236, 38, 0));
  const ln = rows.map((r, j) => `<div class="ln" style="height:${lh}px;animation-delay:${(0.5 + j * 0.3).toFixed(2)}s"><span class="tm" style="font-size:${lh > 30 ? 15 : 13}px">${r.time}</span><span class="nm" style="font-size:${lh > 30 ? 17 : 14}px">${E(r.title)}</span><span class="sb">${E(sub(r))}</span>${j === 0 ? '<span class="nx">NEXT</span>' : ''}</div>`).join('');
  const doodle = {
    am: `<div style="position:absolute;right:250px;top:16px">${icon('am', 44, '#e8892b')}</div>`,
    pm: `<div style="position:absolute;right:250px;top:16px">${icon('pm', 44)}</div>`,
    eve: '<svg style="position:absolute;right:250px;top:18px" width="40" height="40" viewBox="0 0 40 40"><path d="M20 3l5 11 12 1-9 8 3 12-11-6-11 6 3-12-9-8 12-1z" fill="none" stroke="#9b7ae8" stroke-width="2.5" stroke-linejoin="round" style="animation:g_tw 2s infinite"/></svg>',
    late: '<svg style="position:absolute;right:248px;top:14px" width="48" height="48" viewBox="0 0 30 30"><path d="M18 4a11 11 0 1 0 8 16A9 9 0 0 1 18 4z" fill="none" stroke="#5a7bb8" stroke-width="2"/><text x="22" y="9" font-size="7" fill="#5a7bb8" font-weight="900">z</text></svg>',
  }[bk];
  let noteLab = { am: "This morning's star!", pm: "Don't miss!", eve: "Tonight's movie!", late: 'Late-night pick!' }[bk];
  if (hero?.kind === 'movie' && bk !== 'eve') noteLab = 'Movie time!';
  if (hero && hero.kind !== 'movie' && bk === 'eve') noteLab = "Tonight's pick!";
  const holes = [60, 205, 350].map((t) => `<div style="position:absolute;left:22px;top:${t}px;width:18px;height:18px;border-radius:50%;background:#e2d8c6;box-shadow:inset 0 2px 3px rgba(0,0,0,.2)"></div>`).join('');
  const peek = bk === 'late'
    ? `<img src="${MASCOT}" style="height:96px;transform:rotate(-10deg);filter:drop-shadow(0 4px 6px rgba(0,0,0,.25))">${zzz('#5a7bb8')}`
    : `<img src="${MASCOT}" style="height:96px;transform-origin:50% 90%;animation:l_peek 2.4s ease-in-out infinite;filter:drop-shadow(0 4px 6px rgba(0,0,0,.25))">`;
  const css = `@keyframes l_write{from{clip-path:inset(0 100% 0 0)}to{clip-path:inset(0 0 0 0)}}
@keyframes l_pop{0%{opacity:0;transform:scale(.6) rotate(-8deg)}70%{transform:scale(1.05) rotate(3deg)}100%{opacity:1;transform:rotate(3deg)}}
@keyframes l_tick{from{stroke-dashoffset:400}to{stroke-dashoffset:0}}
@keyframes l_peek{0%,100%{transform:translateY(0) rotate(-4deg)}50%{transform:translateY(-8px) rotate(4deg)}}
.cl *{box-sizing:border-box}
.cl .ln{display:flex;align-items:center;gap:12px;clip-path:inset(0 100% 0 0);animation:l_write .9s steps(24) forwards;white-space:nowrap}
.cl .tm{width:70px;flex:none;font-weight:900;color:#e8892b}
.cl .nm{font-weight:800;color:#24476b;overflow:hidden;text-overflow:ellipsis}
.cl .sb{font-size:11px;color:#4a90c2;font-weight:700}
.cl .nx{margin-left:auto;font-size:9px;font-weight:900;color:#fff;background:#e8892b;padding:2px 6px;border-radius:10px}
.cl .hand{font-family:'Comic Neue','Segoe Print','Bradley Hand','Chalkboard SE','Comic Sans MS',system-ui,sans-serif;font-style:italic}`;
  const st = `<div id="stage" class="cl" style="width:768px;height:432px;position:relative;overflow:hidden;background:${paper};font-family:system-ui,sans-serif">
 <div style="position:absolute;inset:0;background:repeating-linear-gradient(180deg,transparent 0 ${lh - 1}px,${line} ${lh - 1}px ${lh}px);background-position:0 ${124 % lh}px"></div>
 <div style="position:absolute;top:0;bottom:0;left:64px;width:2px;background:#f4a0a0"></div>
 ${holes}${doodle}
 <div style="position:absolute;top:14px;left:84px;display:flex;align-items:center;gap:14px"><img src="${LOGO.elementary}" style="height:44px"><span style="font-size:12px;color:#4a90c2;font-weight:800;letter-spacing:3px;margin-top:10px">${b.range}</span></div>
 <div class="hand" style="position:absolute;top:66px;left:84px;font-size:23px;font-weight:700;color:#24476b">${head} <span style="color:#e8892b">✎</span></div>
 <svg style="position:absolute;top:100px;left:84px" width="320" height="10"><path d="M2 6 Q 80 1 160 5 T 318 4" fill="none" stroke="#f5a64a" stroke-width="3" stroke-linecap="round" stroke-dasharray="400" stroke-dashoffset="400" style="animation:l_tick 1.2s .3s forwards"/></svg>
 <div style="position:absolute;left:84px;top:124px;width:440px">${ln}</div>
 <div style="position:absolute;right:40px;top:52px;width:196px;padding:14px 14px 16px;background:#ffe9a8;box-shadow:4px 8px 16px rgba(0,0,0,.18);opacity:0;animation:l_pop .7s ${(0.8 + Math.min(n, 10) * 0.3).toFixed(1)}s forwards">
  <div style="position:absolute;top:-10px;left:64px;width:70px;height:20px;background:rgba(79,195,247,.55);transform:rotate(-4deg)"></div>
  <div class="hand" style="font-size:13px;color:#e8892b;font-weight:700">${noteLab}</div>
  <div style="height:96px;border-radius:4px;margin:8px 0;background:${hero?.img ? `url(${hero.img}) center/cover` : POSTER[3]}"></div>
  <div style="font-size:16px;font-weight:900;color:#24476b;line-height:1.1">${E(hero?.title)}</div>
  <div class="hand" style="font-size:13px;color:#24476b;margin-top:4px">${hero ? `${hero.time} · ${E(sub(hero))}` : ''}</div></div>
 <div style="position:absolute;right:28px;bottom:34px;height:96px">${peek}</div>
 <div style="position:absolute;left:0;right:0;bottom:0;height:30px;background:${tape};display:flex;align-items:center;padding:0 84px;gap:14px;font-size:11px;color:#fff;font-weight:800;letter-spacing:2px">
  <span>GLC ELEMENTARY</span><span style="opacity:.85;font-weight:600;letter-spacing:1px">${E(v.dateLong)}</span>
  <div class="g-bar" style="position:absolute;left:0;top:0;height:3px;background:#e8892b"></div></div>
</div>`;
  return { css, st };
}

// ---------------------------------------------------------------- MoE Central: newscast
function moe(v) {
  const { bk, rows, hero, next } = v; const b = BK[bk];
  const tint = pick(bk, ['linear-gradient(180deg,rgba(255,150,40,.3),transparent 55%)', 'linear-gradient(180deg,rgba(255,230,150,.18),transparent 55%)',
    'linear-gradient(180deg,rgba(70,0,60,.45),rgba(40,0,0,.3))', 'linear-gradient(180deg,rgba(10,0,10,.72),rgba(25,0,0,.6))']);
  const n = rows.length; const h = fit(n, 244, 40, 5);
  const lt = rows.map((r, j) => {
    const inner = h >= 32
      ? `<div class="t">${E(r.title)}</div><div class="s">${E(sub(r))}</div>`
      : `<div style="display:flex;align-items:baseline;gap:8px;min-width:0"><span class="t" style="font-size:13px">${E(r.title)}</span><span class="s" style="flex:none">${E(sub(r))}</span></div>`;
    return `<div class="lt" style="height:${f1(h)}px;animation-delay:${(0.35 + j * 0.15).toFixed(2)}s"><div class="h" style="font-size:${h >= 32 ? 14 : 13}px">${short(r.time)}</div><div class="b"><div style="flex:1;min-width:0">${inner}</div>${j === 0 ? '<span class="nxt">NEXT</span>' : ''}</div></div>`;
  }).join('');
  const nb = BK[next?.bracket] ?? BK.am;
  const items = (next?.rows ?? []).map((r) => `★ ${r.time} · ${E(r.title).toUpperCase()}`).join(' &nbsp; ');
  const tick = `★ ${next?.bracket === 'am' ? 'TOMORROW ' : ''}${nb.word} · ${nb.range} &nbsp; ${items} &nbsp; ★ LEARNING FOR EVERY GUYANESE HOME &nbsp; `;
  const [clk, ap] = v.clock ?? b.clock;
  const css = `@keyframes m_wipe{from{clip-path:inset(0 100% 0 0)}to{clip-path:inset(0 0 0 0)}}
@keyframes m_crawl{from{transform:translateX(0)}to{transform:translateX(-50%)}}
@keyframes m_blink{0%,100%{opacity:1}50%{opacity:.25}}
@keyframes m_up{from{opacity:0;transform:translateY(20px)}to{opacity:1;transform:none}}
.cm *{box-sizing:border-box}
.cm .lt{display:flex;align-items:stretch;margin-bottom:5px;clip-path:inset(0 100% 0 0);animation:m_wipe .55s cubic-bezier(.6,0,.2,1) forwards}
.cm .lt .h{width:78px;flex:none;background:#ffd400;color:#7a0000;font-weight:900;font-size:14px;display:flex;align-items:center;justify-content:center}
.cm .lt .b{flex:1;min-width:0;background:rgba(20,0,0,.55);display:flex;align-items:center;padding:0 12px;gap:10px;border-bottom:2px solid #ff8a00}
.cm .lt .t{font-weight:800;font-size:14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.cm .lt .s{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-size:9.5px;letter-spacing:1.5px;color:#ffd99a;text-transform:uppercase}
.cm .nxt{font-size:9px;font-weight:900;background:#ffd400;color:#7a0000;padding:2px 6px;letter-spacing:1.5px}`;
  const st = `<div id="stage" class="cm" style="width:768px;height:432px;position:relative;overflow:hidden;color:#fff;background:#8f0b0b;font-family:system-ui,sans-serif">
 <div style="position:absolute;inset:0;background:url(${AS}/bg-red.png) center/cover;animation:g_kb 22s linear forwards"></div>
 <div style="position:absolute;inset:0;background:${tint}"></div>
 ${sky(bk, 0.6)}
 <div style="position:absolute;inset:0;background:linear-gradient(90deg,rgba(40,0,0,.55),transparent 60%)"></div>
 <div style="position:absolute;top:16px;left:28px;display:flex;align-items:center;gap:16px;animation:m_up .5s both">
  <img src="${LOGO.moe}" style="height:64px;display:block;filter:drop-shadow(0 0 1px rgba(40,0,0,.9)) drop-shadow(0 3px 8px rgba(0,0,0,.6))">
  <div><div style="display:flex;align-items:center;gap:8px;font-size:11px;font-weight:900;letter-spacing:3px"><span style="width:9px;height:9px;border-radius:50%;background:#ffd400;animation:m_blink 1s infinite"></span>ON AIR ${b.word}</div><div style="font-size:26px;font-weight:900;line-height:1.05;display:flex;align-items:center;gap:8px">${b.range} ${icon(bk, 24)}</div></div></div>
 <div style="position:absolute;top:16px;right:28px;text-align:right;animation:m_up .5s .15s both">
  <div style="font:900 40px ui-monospace,'SF Mono',monospace;color:#ffd400;line-height:1">${clk}<span style="font-size:20px">${ap}</span></div>
  <div style="font-size:10px;letter-spacing:3px;font-weight:700;opacity:.8">${E(v.dateShort)}</div></div>
 <div style="position:absolute;left:28px;top:104px;width:440px">${lt}</div>
 <div style="position:absolute;right:30px;top:108px;width:250px;height:228px;opacity:0;animation:m_up .8s .6s cubic-bezier(.2,.8,.2,1) forwards">
  <div style="position:absolute;inset:0;border-radius:16px;padding:3px;background:linear-gradient(160deg,#2bb673,#ffffff 45%,#3a8fd6);transform:rotate(-2deg);box-shadow:0 18px 40px rgba(0,0,0,.5)">
   <div style="position:relative;width:100%;height:100%;border-radius:13px;overflow:hidden;background:${hero?.img ? `url(${hero.img}) center/cover` : POSTER[0]}">
    <div style="position:absolute;inset:0;background:linear-gradient(180deg,transparent 40%,rgba(0,0,0,.85))"></div>
    <div style="position:absolute;top:0;bottom:0;width:30%;background:linear-gradient(90deg,transparent,rgba(255,255,255,.25),transparent);animation:g_sweep 4s 1.5s infinite"></div>
    <div style="position:absolute;left:14px;bottom:14px;right:14px"><span class="nxt">${hero ? hero.time : ''} · ${hero?.kind === 'movie' ? 'MOVIE' : 'FEATURE'}</span><div style="font-size:${hero && hero.title.length < 20 ? 22 : 18}px;font-weight:900;margin-top:6px;line-height:1.05">${E(hero?.title)}</div><div style="font-size:11px;opacity:.8;margin-top:3px">${E(sub(hero))}</div></div>
   </div></div></div>
 <div style="position:absolute;left:0;right:0;bottom:0;height:34px;background:#ffd400;color:#7a0000;display:flex;align-items:center;overflow:hidden">
  <div style="flex:none;height:100%;background:#7a0000;color:#ffd400;font-weight:900;font-size:11px;letter-spacing:2px;display:flex;align-items:center;padding:0 14px;z-index:1">UP NEXT</div>
  <div style="white-space:nowrap;font-weight:800;font-size:12px;letter-spacing:1px;animation:m_crawl 30s linear infinite">&nbsp; ${tick}${tick}</div></div>
</div>`;
  return { css, st };
}

const BY_STYLE = { discover, jr, teen, elevate, elementary, moe };

/** Full HTML document of one guide. `view` from guideView(). */
export function guideHtml(view) {
  const fn = BY_STYLE[view.style];
  if (!fn) throw new Error(`no guide look "${view.style}"`);
  const { css, st } = fn(view);
  return `<!doctype html><html><head><meta charset="utf-8"><title>${E(view.title || 'Channel guide')}</title>
<style>html,body{margin:0;background:#000}body{display:flex;align-items:flex-start;justify-content:flex-start}
${COMMON(view.seconds)}
${css}</style></head><body>${st}</body></html>`;
}

/**
 * The channel's fallback clip: logo + "Stay with us", for a block whose own
 * guide is not rendered (yet) when its day is pushed. Same length as a guide,
 * so the day's playlist keeps its timing either way.
 */
const IDENT = {
  discover: ['radial-gradient(circle at 20% 15%,#1f8fc4,#0e5f8f 45%,#04192a)', '#7fd3f5', true],
  jr: ['radial-gradient(circle at 20% 10%,#2b5fd9,#173a8c 45%,#0c1f52)', '#ffd23f', true],
  teen: ['radial-gradient(circle at 25% 15%,#2a1f5c,#120b2e 55%,#06030f)', '#00d0f5', true],
  elevate: [`url(${AS}/bg-blue.png) center/cover`, '#bfe9ff', false],
  elementary: ['#fffaf0', '#e8892b', true],
  moe: [`url(${AS}/bg-red.png) center/cover`, '#ffd400', false],
};
export function identHtml(style, seconds) {
  const [bg, acc, withMascot] = IDENT[style] ?? IDENT.discover;
  const dark = style !== 'elementary';
  return `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;background:#000}
${COMMON(seconds)}
@keyframes i_in{from{opacity:0;transform:scale(.92)}to{opacity:1;transform:none}}</style></head><body>
<div id="stage" style="width:768px;height:432px;position:relative;overflow:hidden;background:${bg};font-family:system-ui,sans-serif;color:${dark ? '#fff' : '#24476b'}">
 <div style="position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:18px;animation:i_in .8s both">
  <img src="${LOGO[style] ?? LOGO.discover}" style="height:120px;filter:drop-shadow(0 6px 16px rgba(0,0,0,.35))">
  <div style="font-size:30px;font-weight:900;letter-spacing:2px">STAY WITH US</div>
  <div style="font-size:13px;letter-spacing:5px;color:${acc};font-weight:800">MORE COMING UP NEXT</div>
 </div>
 ${withMascot ? `<div style="position:absolute;right:40px;bottom:30px;height:110px"><img src="${MASCOT}" style="height:110px;transform-origin:50% 90%;animation:g_wave 2.2s ease-in-out infinite"></div>` : ''}
 <div class="g-bar" style="position:absolute;left:0;bottom:0;height:4px;background:${acc}"></div>
</div></body></html>`;
}

export const TEMPLATE_VERSION = 1; // bump when a look changes: every guide re-renders
