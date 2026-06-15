# The interactive replay engine

The centerpiece of every deck. A **scene** is an array of typed **steps**; a single
`proceed()` loop walks the steps, scheduling each with `later()` (a timer that respects
a per-scene speed factor), and paints one or more **render regions** (e.g. a plan/todo
rail, the desktop thread, a secondary surface like a phone). Approvals **pause** the
loop and wait for a click, then resume. It is plain vanilla JS in one inline `<script>`.

## Core principles
- **One source of truth array** of timeline items (`items`); render functions are pure
  (state → HTML). Re-render on every state change.
- **Settle on advance**: when a new step starts, stop the previous row's spinner/shimmer.
- **The running row shimmers**; on completion it flips to past-tense + check + duration.
- **Approvals are real**: render a clickable card, `scrollIntoView` + pulse it, and only
  `proceed()` after Approve/Decline. Decline branches to an adaptive reply.
- **Fold on finish**: when the run ends, collapse the whole work log into a single
  clickable **"Worked for Ns"** with the final answer below (mirror the real app).
- **Verify**: `new Function(scriptSrc)` to syntax-check headlessly; then click every path.

## Pitfall #1 (this WILL bite you)
The `t` you push must equal the `t` your renderer checks. Push `{t:'approval'}` →
render `if(it.t==='approval')`. A mismatch makes the approval card silently never
render → nothing to click → the demo hangs at that step.

## Minimal working template

```html
<div class="divo"> ... <div class="divo-thread" id="thread"></div> ... </div>
<button id="play">▶ Replay</button>

<script>
(function () {
  const CHK = '<svg ...check.../>';            // icons as string constants
  const SHIELD = '<svg ...shield.../>';

  // ── scenes: each is an array of typed steps ───────────────────────────────
  const SCENES = {
    demo: {
      sec: 6.2,            // "Worked for Ns" label
      speed: 0.5,          // 0.5 = 2x faster; 1 = normal
      plan: [
        { t:'ask',  text:'One hard, cross-domain ask.' },     // user bubble
        { t:'think', text:'Reading the request…' },           // "Thinking …" (shimmers)
        { t:'tool', verb:'Checking rankings', arg:'ahrefs', dur:'1.4s' }, // running→done
        { t:'rbac', kind:'gate', html:'<b>Finance</b> — manager-gated · Owner ✓' },
        { t:'data', title:'This month', rows:[['Avg pos','+4']], total:['Mover','#18→#6'] },
        { t:'say',  html:'Let me route the parts on Lark.' },  // inline streamed text
        { t:'approval', title:'Send 3 DMs', tag:'Sends to people',
          detail:[['Shivam','finance'],['Priya','SEO']],
          okResult:'3 DMs sent.', declineSay:'Held off — want to edit them first?' },
        { t:'reply', html:'<b>Done.</b> Brief routed; 3 DMs sent.' },  // final answer
      ],
    },
  };

  const thread = document.getElementById('thread');
  let scene='demo', items=[], idx=0, isRunning=false, collapsed=false, foldOpen=false,
      pendingAp=null, header='Working', timers=[], speed=1, startMs=0;

  const esc = s => String(s).replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
  const later = (fn,ms)=>{ const id=setTimeout(fn, ms*speed); timers.push(id); return id; };
  const clearT = ()=> timers.splice(0).forEach(clearTimeout);
  const settle = ()=> items.forEach(it=>{ it.running=false; it.cursor=false; });
  const PAST = { Checking:'Checked', Reading:'Read', Pulling:'Pulled', Creating:'Created' };
  const past = v => v.replace(/^(\S+)/, w => PAST[w] || w);

  // ── render one item (used live AND inside the folded "Worked for Ns") ─────
  function itemHTML(it){
    if (it.t==='ask')  return `<div class="d-user">${esc(it.text)}</div>`;
    if (it.t==='think'){ const s=it.running?' shimmer-text':''; return `<div class="tl-row think"><span class="tl-verb${s}">Thinking</span><span class="tl-arg${s}">${esc(it.text)}</span></div>`; }
    if (it.t==='tool'){
      const box = it.running ? `<span class="tl-box"><span class="tl-spin"></span></span>` : `<span class="tl-box done">${CHK}</span>`;
      const s = it.running ? ' shimmer-text' : '';
      const verb = it.running ? esc(it.verb) : esc(past(it.verb));
      const dur = (!it.running && it.dur) ? `<span class="tl-dur">${esc(it.dur)}</span>` : '';
      return `<div class="tl-row">${box}<span class="tl-verb${s}">${verb}</span><span class="tl-arg${s}">${esc(it.arg)}</span>${dur}</div>`;
    }
    if (it.t==='rbac') return `<div class="d-rbac ${it.kind}">${SHIELD}<span>${it.html}</span></div>`;
    if (it.t==='data'){ const r=it.rows.map(x=>`<tr><td>${x[0]}</td><td>${x[1]}</td></tr>`).join('')+`<tr class="total"><td>${esc(it.total[0])}</td><td>${esc(it.total[1])}</td></tr>`; return `<div class="d-data"><div class="dh">${esc(it.title)}</div><table>${r}</table></div>`; }
    if (it.t==='say')  return `<div class="tl-say">${it.html}${it.cursor?'<span class="cur"></span>':''}</div>`;
    if (it.t==='approval'){
      if (it.verdict){ const c=it.verdict==='ok'?'ok':'no'; return `<div class="d-pending ${c}">${it.verdict==='ok'?'✓ Approved':'⊘ Declined'} — ${esc(it.title)}</div>`; }
      const d = it.detail.map(x=>`<div class="r"><span class="k">${esc(x[0])}</span><span class="v">${esc(x[1])}</span></div>`).join('');
      return `<div class="d-approve"><div class="ah"><span class="ai">${SHIELD}</span> <span>Permission gate — approve to <b>${esc(it.title.toLowerCase())}</b></span><span class="tg">${esc(it.tag)}</span></div><div class="ad">${d}</div><div class="aa"><button class="abtn ok" data-act="ok">Approve &amp; continue</button><button class="abtn no" data-act="no">Decline</button><span class="ahint">your call →</span></div></div>`;
    }
    if (it.t==='reply') return `<div class="d-amsg"><div class="head">Divo</div>${it.html}</div>`;
    return '';
  }

  function render(){
    if (collapsed){                                   // finished → fold the work
      let last=-1; items.forEach((it,i)=>{ if(it.t==='reply') last=i; });
      const work = items.filter((_,i)=>i!==last);
      let h = `<button class="tl-worked" id="wf"><span style="display:inline-flex${foldOpen?';transform:rotate(90deg)':''}">▸</span> Worked for <b>${(SCENES[scene].sec||9).toFixed(1)}s</b></button>`;
      h += `<div style="${foldOpen?'':'display:none'}">${work.map(itemHTML).join('')}</div>`;
      if (last>=0) h += itemHTML(items[last]);
      thread.innerHTML = h;
      thread.querySelector('#wf').onclick = ()=>{ foldOpen=!foldOpen; render(); };
      return;
    }
    let h = isRunning ? `<div class="tl-head"><span class="hx shimmer-text">${esc(header)}</span></div>` : '';
    h += items.map(itemHTML).join('');
    if (isRunning && !pendingAp) h += `<div class="tl-ribbon"><span class="rs"></span> Synthesizing reply…</div>`;
    thread.innerHTML = h;
    thread.scrollTop = thread.scrollHeight;
    thread.querySelectorAll('[data-act]').forEach(b => b.onclick = ()=>{
      if (!pendingAp || pendingAp.verdict) return;
      pendingAp.verdict = b.dataset.act==='ok' ? 'ok' : 'no';
      b.dataset.act==='ok' ? approve() : decline();
    });
    if (pendingAp && !pendingAp.verdict){           // never let the gate hide below the fold
      const c = thread.querySelector('.d-approve');
      if (c) requestAnimationFrame(()=> c.scrollIntoView({ block:'center', behavior:'smooth' }));
    }
  }

  function approve(){ const ap=pendingAp; render(); later(()=>{ items.push({t:'reply',html:`<div style="color:var(--green)">✓ ${esc(ap.okResult)}</div>`}); pendingAp=null; idx++; render(); later(proceed,500); }, 800); }
  function decline(){ const ap=pendingAp; render(); later(()=>{ pendingAp=null; items.push({t:'reply',html:esc(ap.declineSay)}); isRunning=false; render(); }, 700); }

  function proceed(){
    const plan = SCENES[scene].plan;
    if (idx >= plan.length){ settle(); isRunning=false; collapsed=true; render(); return; }
    const s = plan[idx];
    if (s.t==='ask'){ settle(); items.push({t:'ask',text:s.text}); render(); idx++; later(proceed,500); return; }
    if (s.t==='think'){ settle(); header='Thinking'; items.push({...s,running:true}); render(); idx++; later(proceed,900); return; }
    if (s.t==='tool'){ settle(); header=s.verb; const it={...s,running:true}; items.push(it); render(); later(()=>{ it.running=false; render(); idx++; later(proceed,340); }, 720); return; }
    if (s.t==='rbac'){ settle(); items.push({...s}); render(); idx++; later(proceed,720); return; }
    if (s.t==='data'){ settle(); items.push({...s}); render(); idx++; later(proceed,1000); return; }
    if (s.t==='say'){ settle(); items.push({...s,cursor:true}); render(); idx++; later(proceed,900); return; }
    if (s.t==='reply'){ settle(); isRunning=true; header='Writing the answer'; items.push({...s}); render(); idx++; later(proceed,1600); return; }
    if (s.t==='approval'){ pendingAp={...s,verdict:null}; items.push(pendingAp); header='Waiting for your approval'; isRunning=true; render(); return; } // PAUSE — wait for click
  }

  function play(){ clearT(); items=[]; idx=0; isRunning=true; collapsed=false; foldOpen=false; pendingAp=null; speed=SCENES[scene].speed||1; startMs=Date.now(); render(); later(proceed,500); }
  document.getElementById('play').addEventListener('click', play);
  render();
})();
</script>
```

## Extending it
- **Secondary surface (phone) that reacts in sync**: add a `lark[]` array + `renderLark()`,
  and steps like `{t:'larkdm', to:'Shivam', note:'…'}` / `{t:'larktask', action:'done'}`
  that push to it. Approvals can also mirror to the phone.
- **A live plan / todo rail**: keep a `todos[]` with `state: pending|running|done`;
  step types `{t:'todo', id}` (→ running) and `{t:'done', id}` (→ done, ticks off).
- **Scene tabs**: a `<button data-scene>` per scene; on click set `scene` and re-`render()`.
- **A live elapsed counter** in the ribbon: `setInterval` updating a `#elapsed` span from
  `(Date.now()-startMs)/1000`; clear it on finish/decline.
- **Multiple scenes**: keep each a focused story; one rich cross-domain scene beats five
  shallow ones.
