// Preview script — generates a Trusted Rituals creator brief and writes preview HTML
import Anthropic from '@anthropic-ai/sdk';
import { writeFileSync } from 'fs';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const brandCtx = {
  brandName: 'Trusted Rituals',
  brandMission: 'Make holistic health products accessible and easy to adopt — integrating traditional and modern nutritional ideas into user-friendly formats. Tagline: "Elevate Your Every Day with Trusted Rituals"',
  products: [
    { name: 'ACV Matcha Gummies', description: '60 sugar-free blackberry-flavored gummies combining Apple Cider Vinegar, Matcha, and Ashwagandha. Supports gut health, natural cleansing, and sustained energy. Non-GMO, gluten-free. $29.99.' },
    { name: 'GLP-1 Patch', description: "World's first affirmation-based patch. Berberine to balance blood sugar and curb cravings, ACV to promote fullness, B vitamins, green tea, ashwagandha, magnesium glycinate, L-glutamine. 60-patch 2-month supply. $29.99." },
    { name: 'Mullein Honey Sticks', description: '30 individually-packed honey sticks with real honey and mullein extract. Supports lung health, clears airways, soothes throat. One stick daily. $31.99.' },
  ],
  targetAudience: 'Women 25–45 interested in gut health, metabolic wellness, weight management, and daily wellness rituals. Health-conscious, looking for natural alternatives to harsh diet products.',
};

const prompt = `You are building a TikTok creator content brief for a brand. Generate a structured brief that gives creators everything they need to make high-converting TikTok Shop videos.

BRAND:
Name: ${brandCtx.brandName}
Mission: ${brandCtx.brandMission}
Products:
${brandCtx.products.map(p => `${p.name}: ${p.description}`).join('\n')}
Target audience: ${brandCtx.targetAudience}

HOOK TEMPLATES (fill in blanks with this brand's specific details — every hook must be complete and ready to use):
- _____ don't want you to know this, but [brand secret/benefit]
- [Product] is the only thing I use for [problem this solves] anymore and here's why
- [Target audience], this is your answer to [main problem]
- [Target audience], DON'T make the same mistake as me with [category]
- Everything you know about [product category] is WRONG
- After [time struggling with problem] I finally [desired outcome] with this
- Don't waste your money on [old solution] — do this instead
- [Timeframe] ago I discovered something that changed my [relevant life area] forever
- Biggest myths about [problem this product solves]
- My honest review of [product name] — is it worth it?
- 3 reasons you need [product name] in your life
- I'm never going back to [old solution] again
- Best way to [desired outcome] in 2026
- Why [target audience] are switching to [product name]
- Five signs you should stop using [alternative product]
- Did you know that [surprising fact about the problem/product]?

UGC FRAMEWORKS TO CHOOSE FROM:
- Problem → Solution: Hook with pain point, agitate it, introduce product as the fix, CTA
- Before / After: Show transformation — life before product vs. after, visual or verbal
- Why I Switched: Personal story of moving from old solution to this product, with reason
- My Honest Review: Authentic pros/cons walkthrough with personal experience and verdict
- 3 Reasons Why: Three tight, benefit-focused arguments for the product
- POV You're Obsessed: First-person immersive experience of discovering and loving the product
- Industry Secret: Position product as insider knowledge most people don't know about
- Stop Wasting Your [X]: Call out wrong/old solution, introduce better one
- Reply to Comment: TikTok comment overlay format — address an objection or common question
- Features Focused: Walk through 3-5 key features with quick demonstrations

COPYWRITING FRAMEWORKS:
- PAS (Problem-Agitate-Solution): Name the problem, make it feel urgent, present the product as relief
- BAB (Before-After-Bridge): Where viewer is now → where they could be → how the product bridges the gap
- AIDA (Attention-Interest-Desire-Action): Stop scroll, build curiosity, create desire, direct to buy
- FAB (Features-Advantages-Benefits): What it does → why that matters → how it improves their life

Generate this EXACT JSON (no markdown, no explanation):
{
  "niche": "single word (Beauty/Fashion/Health/Food/Home/Pet/Accessories/etc)",
  "targetAudience": "2-sentence description of the exact viewer this content is for",
  "mainProblem": "the single core problem this product solves, in 1 sentence",
  "hooks": [
    { "text": "completely filled-in hook, ready to record, specific to this brand/product", "type": "curiosity|pain-point|transformation|social-proof|controversy|myth-bust" },
    { "text": "...", "type": "..." },
    { "text": "...", "type": "..." },
    { "text": "...", "type": "..." },
    { "text": "...", "type": "..." },
    { "text": "...", "type": "..." },
    { "text": "...", "type": "..." },
    { "text": "...", "type": "..." }
  ],
  "frameworks": [
    { "name": "Framework Name", "why": "1 sentence why this format works best for this product", "outline": ["Step 1 specific to this product", "Step 2", "Step 3"] },
    { "name": "...", "why": "...", "outline": ["...", "...", "..."] },
    { "name": "...", "why": "...", "outline": ["...", "...", "..."] }
  ],
  "sampleScripts": [
    {
      "framework": "PAS",
      "title": "Short descriptive title",
      "duration": "~30 seconds",
      "script": "Full word-for-word script. Label sections: [HOOK] [PROBLEM] [SOLUTION] [CTA]. Write it as spoken dialogue, conversational and natural."
    },
    {
      "framework": "BAB",
      "title": "Short descriptive title",
      "duration": "~30 seconds",
      "script": "Full word-for-word script. Label sections: [BEFORE] [AFTER] [BRIDGE] [CTA]."
    }
  ],
  "talkingPoints": {
    "benefits": ["benefit 1", "benefit 2", "benefit 3", "benefit 4", "benefit 5"],
    "objections": ["common objection: how to handle it in the video"],
    "powerPhrases": ["memorable phrase 1", "memorable phrase 2", "memorable phrase 3"]
  },
  "doAndDont": {
    "dos": ["specific do for this product/niche", "do 2", "do 3"],
    "donts": ["specific dont for this product/niche", "dont 2", "dont 3"]
  },
  "benchmarks": {
    "hookRate": ">30%",
    "holdRate": ">10-15%",
    "ctr": ">1-1.5%"
  }
}`;

console.log('Generating brief for Trusted Rituals...');
const msg = await anthropic.messages.create({
  model: 'claude-sonnet-4-6',
  max_tokens: 4000,
  messages: [{ role: 'user', content: prompt }],
});

const brief = JSON.parse(msg.content[0].text.trim().replace(/^```json\n?/, '').replace(/\n?```$/, ''));
console.log('Brief generated. Writing HTML preview...');

const accent = '#00f2ea';
const ar = '0,242,234';
const name = 'Trusted Rituals';

const typeLabel = { curiosity:'Curiosity', 'pain-point':'Pain Point', transformation:'Transformation', 'social-proof':'Social Proof', controversy:'Controversy', 'myth-bust':'Myth Bust' };

const hooksHtml = `
<hr class="page-divider">
<div class="section">
  <div class="section-inner">
    <div class="section-label">Content Brief</div>
    <div class="section-title">Your hook library</div>
    <div class="section-sub">Copy any of these word-for-word as your video's first 3 seconds. The hook makes or breaks your stop-rate.</div>
    <div class="hooks-grid">${brief.hooks.map(h => `
      <div class="hook-card">
        <div class="hook-text">${h.text.replace(/</g,'&lt;').replace(/>/g,'&gt;')}</div>
        <div class="hook-type">${typeLabel[h.type] || h.type}</div>
      </div>`).join('')}
    </div>
  </div>
</div>`;

const frameworksHtml = `
<hr class="page-divider">
<div class="section" style="background:rgba(255,255,255,.015)">
  <div class="section-inner" style="max-width:680px">
    <div class="section-label">Video Formats</div>
    <div class="section-title">Recommended UGC frameworks</div>
    <div class="section-sub">These formats work best for this product. Pick one and follow the structure.</div>
    <div class="frameworks-list">${brief.frameworks.map(f => `
      <div class="fw-card">
        <div class="fw-name">${f.name.replace(/</g,'&lt;')}</div>
        <div class="fw-why">${f.why.replace(/</g,'&lt;')}</div>
        <ol class="fw-steps">${(f.outline||[]).map((s,i) => `<li class="fw-step"><span class="fw-num">${i+1}</span><span>${s.replace(/</g,'&lt;')}</span></li>`).join('')}</ol>
      </div>`).join('')}
    </div>
  </div>
</div>`;

const scriptsHtml = `
<hr class="page-divider">
<div class="section">
  <div class="section-inner" style="max-width:680px">
    <div class="section-label">Sample Scripts</div>
    <div class="section-title">Ready-to-record scripts</div>
    <div class="section-sub">Use these as-is or riff off them. Tap to expand.</div>
    <div class="scripts-list">${brief.sampleScripts.map((s,i) => `
      <div class="script-card open" id="sc${i}">
        <div class="script-header" onclick="toggleScript(${i})">
          <span class="script-fw-badge">${s.framework}</span>
          <span class="script-title">${(s.title||'Script').replace(/</g,'&lt;')}</span>
          <span class="script-duration">${s.duration||'~30s'}</span>
          <span class="script-toggle">&#8964;</span>
        </div>
        <div class="script-body">${(s.script||'').replace(/</g,'&lt;')}</div>
      </div>`).join('')}
    </div>
  </div>
</div>`;

const tpHtml = `
<hr class="page-divider">
<div class="section" style="background:rgba(255,255,255,.015)">
  <div class="section-inner" style="max-width:720px">
    <div class="section-label">Talking Points</div>
    <div class="section-title">What to say</div>
    <div class="section-sub">Key benefits to weave into your video, plus power phrases that drive action.</div>
    <ul class="brief-benefits">${(brief.talkingPoints.benefits||[]).map(b=>`<li class="brief-benefit">${b.replace(/</g,'&lt;')}</li>`).join('')}</ul>
    <div style="margin-top:16px"><div class="sub-label">Power Phrases</div><div class="power-phrases">${(brief.talkingPoints.powerPhrases||[]).map(p=>`<span class="power-phrase">${p.replace(/</g,'&lt;')}</span>`).join('')}</div></div>
  </div>
</div>`;

const ddHtml = `
<hr class="page-divider">
<div class="section">
  <div class="section-inner" style="max-width:720px">
    <div class="section-label">Creator Guidelines</div>
    <div class="section-title">Do's and don'ts</div>
    <div class="section-sub">Follow these to maximise your conversion rate.</div>
    <div class="dd-grid">
      <div class="dd-col dos"><div class="dd-label">Do</div><ul class="dd-list">${(brief.doAndDont.dos||[]).map(d=>`<li class="dd-item">${d.replace(/</g,'&lt;')}</li>`).join('')}</ul></div>
      <div class="dd-col donts"><div class="dd-label">Don't</div><ul class="dd-list">${(brief.doAndDont.donts||[]).map(d=>`<li class="dd-item">${d.replace(/</g,'&lt;')}</li>`).join('')}</ul></div>
    </div>
  </div>
</div>`;

const benchmarksHtml = `
<hr class="page-divider">
<div class="section" style="background:rgba(255,255,255,.015)">
  <div class="section-inner" style="max-width:600px">
    <div class="section-label">Performance Targets</div>
    <div class="section-title">What good looks like</div>
    <div class="section-sub">These are the benchmarks we use to gauge whether a video is performing.</div>
    <div class="benchmarks-row">
      <div class="bm-card"><div class="bm-metric">&gt;30%</div><div class="bm-label">Hook Rate</div></div>
      <div class="bm-card"><div class="bm-metric">&gt;10%</div><div class="bm-label">Hold Rate</div></div>
      <div class="bm-card"><div class="bm-metric">&gt;1%</div><div class="bm-label">Click-Through Rate</div></div>
    </div>
  </div>
</div>`;

const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Welcome — ${name} Creator Program</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#0a0a0f;color:#fff;min-height:100vh;padding:48px 20px}
.top{display:flex;flex-direction:column;align-items:center;text-align:center;max-width:520px;margin:0 auto 48px}
.card{width:100%;max-width:520px;background:rgba(255,255,255,.025);border:1px solid rgba(255,255,255,.08);border-radius:24px;padding:48px 40px;margin:0 auto}
@media(max-width:560px){.card{padding:36px 24px}}
.success-icon{font-size:52px;margin-bottom:22px}
h1{font-size:clamp(22px,4vw,30px);font-weight:900;letter-spacing:-.02em;margin-bottom:10px}
.welcome-sub{font-size:14px;color:rgba(255,255,255,.42);line-height:1.7;margin-bottom:0;max-width:380px}
.section-label{font-size:11px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:${accent};margin-bottom:10px}
.sub-label{font-size:11px;font-weight:700;letter-spacing:.07em;text-transform:uppercase;color:rgba(255,255,255,.3);margin-bottom:10px}
.discord-btn{display:flex;align-items:center;justify-content:center;gap:10px;background:#5865F2;color:#fff;text-decoration:none;border-radius:14px;padding:16px 24px;font-size:14px;font-weight:900;letter-spacing:.03em;margin-top:24px}
.divider{border:none;border-top:1px solid rgba(255,255,255,.06);margin:28px 0}
.page-divider{border:none;border-top:1px solid rgba(255,255,255,.06);margin:0}
.section{padding:48px 20px}
.section-inner{max-width:860px;margin:0 auto}
.section-title{font-size:clamp(18px,3vw,26px);font-weight:900;margin-bottom:8px;letter-spacing:-.01em}
.section-sub{font-size:13px;color:rgba(255,255,255,.4);line-height:1.6;margin-bottom:28px}
/* hooks */
.hooks-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:12px}
.hook-card{background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.07);border-radius:12px;padding:16px 18px;display:flex;flex-direction:column;gap:8px}
.hook-text{font-size:15px;font-weight:600;color:#fff;line-height:1.45}
.hook-type{font-size:10px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:rgba(${ar},.8);background:rgba(${ar},.1);border-radius:100px;padding:3px 10px;align-self:flex-start}
/* frameworks */
.frameworks-list{display:flex;flex-direction:column;gap:14px}
.fw-card{background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.07);border-radius:14px;padding:20px 22px}
.fw-name{font-size:14px;font-weight:900;margin-bottom:4px;color:${accent}}
.fw-why{font-size:13px;color:rgba(255,255,255,.5);margin-bottom:12px;line-height:1.5}
.fw-steps{list-style:none;display:flex;flex-direction:column;gap:6px}
.fw-step{display:flex;gap:10px;font-size:13px;color:rgba(255,255,255,.75);line-height:1.4}
.fw-num{flex-shrink:0;width:20px;height:20px;border-radius:50%;background:rgba(${ar},.15);color:${accent};font-size:11px;font-weight:900;display:flex;align-items:center;justify-content:center;margin-top:1px}
/* scripts */
.scripts-list{display:flex;flex-direction:column;gap:16px}
.script-card{background:rgba(255,255,255,.02);border:1px solid rgba(255,255,255,.07);border-radius:14px;overflow:hidden}
.script-header{display:flex;align-items:center;gap:12px;padding:16px 20px;cursor:pointer;user-select:none;background:rgba(255,255,255,.02)}
.script-header:hover{background:rgba(255,255,255,.04)}
.script-fw-badge{font-size:10px;font-weight:700;letter-spacing:.07em;text-transform:uppercase;background:rgba(${ar},.12);color:${accent};border-radius:100px;padding:4px 12px;flex-shrink:0}
.script-title{font-size:14px;font-weight:700;flex:1}
.script-duration{font-size:11px;color:rgba(255,255,255,.3);flex-shrink:0}
.script-toggle{font-size:16px;color:rgba(255,255,255,.3);flex-shrink:0;transition:transform .2s}
.script-body{display:none;padding:0 20px 20px;font-size:13.5px;color:rgba(255,255,255,.7);line-height:1.75;white-space:pre-wrap}
.script-card.open .script-toggle{transform:rotate(180deg)}
.script-card.open .script-body{display:block}
/* talking points */
.brief-benefits{list-style:none;display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:10px;margin-bottom:20px}
.brief-benefit{background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.06);border-radius:10px;padding:12px 14px 12px 32px;font-size:13px;color:rgba(255,255,255,.75);line-height:1.4;position:relative}
.brief-benefit::before{content:'✓';position:absolute;left:11px;top:12px;font-size:11px;font-weight:900;color:${accent}}
.power-phrases{display:flex;flex-wrap:wrap;gap:8px;margin-top:4px}
.power-phrase{background:rgba(${ar},.08);border:1px solid rgba(${ar},.2);border-radius:100px;padding:6px 14px;font-size:12px;font-weight:600;color:rgba(255,255,255,.8)}
/* do/dont */
.dd-grid{display:grid;grid-template-columns:1fr 1fr;gap:14px}
@media(max-width:560px){.dd-grid{grid-template-columns:1fr}}
.dd-col{background:rgba(255,255,255,.02);border:1px solid rgba(255,255,255,.06);border-radius:12px;padding:18px}
.dd-col.dos{border-color:rgba(0,210,122,.15)}
.dd-col.donts{border-color:rgba(255,60,60,.12)}
.dd-label{font-size:11px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;margin-bottom:12px}
.dd-col.dos .dd-label{color:#00d27a}
.dd-col.donts .dd-label{color:#ff6060}
.dd-list{list-style:none;display:flex;flex-direction:column;gap:8px}
.dd-item{font-size:13px;color:rgba(255,255,255,.7);line-height:1.4;padding-left:18px;position:relative}
.dd-item::before{position:absolute;left:0;font-size:12px;font-weight:900}
.dd-col.dos .dd-item::before{content:'✓';color:#00d27a}
.dd-col.donts .dd-item::before{content:'✕';color:#ff6060}
/* benchmarks */
.benchmarks-row{display:grid;grid-template-columns:repeat(3,1fr);gap:12px}
@media(max-width:520px){.benchmarks-row{grid-template-columns:1fr}}
.bm-card{background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.07);border-radius:12px;padding:16px;text-align:center}
.bm-metric{font-size:22px;font-weight:900;color:${accent};margin-bottom:4px}
.bm-label{font-size:11px;font-weight:700;color:rgba(255,255,255,.4);letter-spacing:.05em;text-transform:uppercase}
footer{border-top:1px solid rgba(255,255,255,.06);padding:24px 20px;text-align:center;font-size:11px;color:rgba(255,255,255,.18)}
footer a{color:${accent};text-decoration:none}
</style>
</head>
<body>

<div class="top">
  <div class="success-icon">🎉</div>
  <h1>You're in the ${name} program!</h1>
  <p class="welcome-sub">Check your texts for your creator hub link. Now sign up for campaigns below and join the community.</p>
</div>

<div class="card">
  <div class="section-label">Join the Community</div>
  <a href="#" class="discord-btn">
    <svg width="20" height="20" viewBox="0 0 127.14 96.36" fill="#fff" xmlns="http://www.w3.org/2000/svg"><path d="M107.7,8.07A105.15,105.15,0,0,0,81.47,0a72.06,72.06,0,0,0-3.36,6.83A97.68,97.68,0,0,0,49,6.83,72.37,72.37,0,0,0,45.64,0,105.89,105.89,0,0,0,19.39,8.09C2.79,32.65-1.71,56.6.54,80.21h0A105.73,105.73,0,0,0,32.71,96.36,77.7,77.7,0,0,0,39.6,85.25a68.42,68.42,0,0,1-10.85-5.18c.91-.66,1.8-1.34,2.66-2a75.57,75.57,0,0,0,64.32,0c.87.71,1.76,1.39,2.66,2a68.68,68.68,0,0,1-10.87,5.19,77,77,0,0,0,6.89,11.1A105.25,105.25,0,0,0,126.6,80.22h0C129.24,52.84,122.09,29.11,107.7,8.07ZM42.45,65.69C36.18,65.69,31,60,31,53s5-12.74,11.43-12.74S54,46,53.89,53,48.84,65.69,42.45,65.69Zm42.24,0C78.41,65.69,73.25,60,73.25,53s5-12.74,11.44-12.74S96.23,46,96.12,53,91.08,65.69,84.69,65.69Z"/></svg>
    Join the Discord
  </a>
</div>

${hooksHtml}
${frameworksHtml}
${scriptsHtml}
${tpHtml}
${ddHtml}
${benchmarksHtml}

<footer>Powered by <a href="https://cultcontent.cc" target="_blank">Cult Content</a></footer>

<script>
function toggleScript(i){
  var c=document.getElementById('sc'+i);
  if(c)c.classList.toggle('open');
}
</script>
</body>
</html>`;

writeFileSync('/tmp/trusted-rituals-brief-preview.html', html);
console.log('✅ Preview saved to /tmp/trusted-rituals-brief-preview.html');
console.log('\n--- Brief JSON ---');
console.log(JSON.stringify(brief, null, 2));
