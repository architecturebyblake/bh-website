// Builds the website into ./dist from content/*.json, templates/ and static/.
// No dependencies. Netlify runs this automatically (see netlify.toml).
const fs = require('fs');
const path = require('path');

const root = __dirname;
const dist = path.join(root, 'dist');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const slugify = (t) => String(t).toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
// Image paths: accept "images/uploads/x.jpg" or "/images/uploads/x.jpg"
const img = (p) => String(p || '').replace(/^\/+/, '');

fs.rmSync(dist, { recursive: true, force: true });
fs.mkdirSync(dist, { recursive: true });

const CATS = {
  'new-homes':   { page: 'NewHomes.html',    label: 'New Homes' },
  'additions':   { page: 'Additions.html',   label: 'Additions' },
  'renovations': { page: 'Renovations.html', label: 'Interior Renovations' },
};
const cats = JSON.parse(read('content/categories.json'));

// ---- load projects
const projects = fs.readdirSync(path.join(root, 'content/projects'))
  .filter((f) => f.endsWith('.json'))
  .map((f) => {
    const p = JSON.parse(read('content/projects/' + f));
    p.slug = path.basename(f, '.json');
    p.file = p.slug + '.html';
    return p;
  })
  .filter((p) => CATS[p.category])
  .sort((a, b) => (a.order || 999) - (b.order || 999) || a.title.localeCompare(b.title));

// ---- project page
const LINK = "display: inline-flex; align-items: center; min-height: 2.75rem; font-family: 'Poppins', sans-serif; font-size: 0.75rem; letter-spacing: 0.14em; text-transform: uppercase; color: #4A5650";
function projectMain(p) {
  const cat = CATS[p.category];
  const paras = (p.paragraphs || []).filter((x) => String(x).trim());
  const paraHtml = paras.map((t, i) =>
    `<p style="margin: 0${i < paras.length - 1 ? ' 0 1.0625rem' : ''}; color: #3F4A45">${esc(t)}</p>`).join('');
  const facts = (p.facts || []).filter((f) => f && String(f.value || '').trim())
    .map((f) => `<div style="padding: 0.75rem 0; border-bottom: 1px solid #D3D7D1"><div style="font-family: 'Poppins', sans-serif; font-size: 0.6875rem; letter-spacing: 0.12em; text-transform: uppercase; color: #4A5650">${esc(f.label)}</div><div>${esc(f.value)}</div></div>`).join('');
  const IMG = 'cursor: zoom-in; width: 100%; aspect-ratio: 4 / 3; object-fit: cover; display: block';
  const gallery = (p.gallery || []).filter((g) => g && g.image)
    .map((g) => `<img data-lb="1" src="${esc(img(g.image))}" alt="${esc(g.alt)}" style="${IMG}">`).join('');
  return `<main style="max-width: 1280px; margin: 0 auto; padding: 3rem 1.5rem 5rem"><a href="${cat.page}" style="${LINK}">← ${esc(cat.label)}</a>` +
    `<div style="font-family: 'Poppins', sans-serif; font-size: 0.75rem; font-weight: 500; letter-spacing: 0.14em; text-transform: uppercase; color: #4F6659; margin-top: 1rem">${esc(cat.label)}</div>` +
    `<h1 style="font-family: 'Newsreader', serif; font-weight: 400; font-size: clamp(2.5rem, 5vw, 4rem); line-height: 1.05; letter-spacing: -0.02em; margin: 0.75rem 0 2.5rem">${esc(p.title)}</h1>` +
    `<div><img data-lb="1" src="${esc(img(p.heroImage))}" alt="${esc(p.heroAlt)}" style="${IMG}"></div>` +
    `<div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(20rem, 1fr)); gap: 3rem 4rem; padding: 3rem 0; align-items: start"><div>` +
    `<h2 style="font-family: 'Newsreader', serif; font-weight: 400; font-size: 1.75rem; margin: 0 0 1.0625rem">About the project</h2>${paraHtml}</div>` +
    `<div style="border-top: 1px solid #D3D7D1">${facts}</div></div>` +
    (gallery ? `<div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(18rem, 1fr)); gap: 2rem; padding-top: 3rem; border-top: 1px solid #D3D7D1">${gallery}</div>` : '') +
    `<div style="margin-top: 4rem; padding-top: 3rem; border-top: 1px solid #D3D7D1"><h2 style="font-family: 'Newsreader', serif; font-weight: 400; font-size: 1.75rem; margin: 0 0 0.75rem">Planning a project?</h2>` +
    `<p style="max-width: 40rem; margin: 0 0 1.5rem; color: #3F4A45">Tell us about your ideas and we will be in touch shortly.</p>` +
    `<a href="Inquiries.html" style="display: inline-flex; align-items: center; min-height: 3rem; padding: 0 1.75rem; background: #1C2421; color: #F3F4F1; font-weight: 500">Start an inquiry</a></div></main>`;
}
const projectTpl = read('templates/project.html');
for (const p of projects) {
  const html = projectTpl.replace(/\{\{TITLE\}\}/g, esc(p.title)).replace('{{MAIN}}', () => projectMain(p));
  fs.writeFileSync(path.join(dist, p.file), html);
}

// ---- listing pages
function cardHtml(p) {
  const pos = p.cardImagePosition ? ` style="object-position: ${esc(p.cardImagePosition)}"` : '';
  const title = `<div style="margin-top: 0.75rem"><span style="font-family: 'Newsreader', serif; font-size: 1.375rem">${esc(p.title)}</span> <span style="font-size: 0.9375rem; color: #4A5650">· ${esc(p.cardCity)}</span></div>`;
  const tag = `<p style="margin: 0.25rem 0 0; color: #3F4A45">${esc(p.tagline)}</p>`;
  let visual;
  if (p.category === 'additions' && p.cardBeforeImage) {
    visual = `<div class="ba"><img src="${esc(img(p.cardImage))}" alt="${esc(p.cardAlt)}"${pos}><img class="bef" src="${esc(img(p.cardBeforeImage))}" alt="${esc(p.cardBeforeAlt)}"${pos}><span class="tg tg-a">After</span><span class="tg tg-b" style="position: absolute">Before</span></div>`;
  } else {
    visual = `<img src="${esc(img(p.cardImage))}" alt="${esc(p.cardAlt)}" style="width: 100%; aspect-ratio: 4 / 3; object-fit: cover; display: block${p.cardImagePosition ? '; object-position: ' + esc(p.cardImagePosition) : ''}">`;
  }
  return `<a href="${p.file}" style="display: block">${visual}${title}${tag}</a>`;
}
for (const [key, cat] of Object.entries(CATS)) {
  const tpl = read(`templates/list-${key}.html`);
  const cards = projects.filter((p) => p.category === key).map(cardHtml).join('\n');
  const html = tpl.replace('{{H1}}', esc(cats[key].title)).replace('{{INTRO}}', () => esc(cats[key].intro)).replace('{{CARDS}}', () => cards);
  fs.writeFileSync(path.join(dist, cat.page), html);
}

// ---- static pages, images, admin
for (const f of fs.readdirSync(path.join(root, 'static'))) fs.copyFileSync(path.join(root, 'static', f), path.join(dist, f));
function copyDir(src, dst) {
  if (!fs.existsSync(src)) return;
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    if (e.isDirectory()) copyDir(path.join(src, e.name), path.join(dst, e.name));
    else fs.copyFileSync(path.join(src, e.name), path.join(dst, e.name));
  }
}
copyDir(path.join(root, 'images'), path.join(dist, 'images'));
copyDir(path.join(root, 'admin'), path.join(dist, 'admin'));
if (fs.existsSync(path.join(root, 'favicon.png'))) fs.copyFileSync(path.join(root, 'favicon.png'), path.join(dist, 'favicon.png'));
console.log(`Built ${projects.length} projects into dist/`);
