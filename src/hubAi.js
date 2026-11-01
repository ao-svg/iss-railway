// AI content for schedule sites: the hub writes the text under each sport page's table with
// OpenAI (key, model and brief on the WordPress sites page) and sends it to the site as a
// "content" command. Sites never see the key. Each site and sport gets its own wording, so two
// domains don't carry the same text.

const axios = require('axios');
const hub = require('./hub');

const OPENAI_URL = (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, '');

// Chinese names, as on the sites
const SPORT_CN = {
  Football: '足球', Soccer: '足球', Basketball: '篮球', 'American Football': '美式橄榄球', Tennis: '网球',
  'Table Tennis': '乒乓球', Cricket: '板球', Rugby: '橄榄球', 'Ice Hockey': '冰球', Baseball: '棒球', Golf: '高尔夫',
  Boxing: '拳击', Volleyball: '排球', Cycling: '自行车', Motorsport: '赛车', MotoGP: '摩托车', Darts: '飞镖',
  Snooker: '斯诺克', Billiard: '台球', 'UFC/MMA': '综合格斗', 'Horse Racing': '赛马', Handball: '手球',
  'Australian Rules': '澳式橄榄球', Netball: '无板篮球', 'Water Polo': '水球', Athletics: '田径',
  Gymnastics: '体操', Weightlifting: '举重',
};

// Only simple text markup reaches the site: headings, paragraphs, lists, bold — no attributes
function cleanHtml(html) {
  return String(html || '')
    .replace(/```(?:html)?/gi, '')
    .replace(/<(script|style|iframe)[\s\S]*?<\/\1>/gi, '')
    .replace(/<(\/?)(h2|h3|p|ul|ol|li|strong|em)\b[^>]*>/gi, '<$1$2>')
    .replace(/<(?!\/?(h2|h3|p|ul|ol|li|strong|em)>)[^>]*>/gi, '')
    .trim();
}

async function writePage({ host, brand, sport, ai }) {
  const cn = SPORT_CN[sport] || sport;
  const system =
    '你是体育直播网站的中文编辑，为中国读者写网页正文。只输出 HTML 片段，只用 <h2> <h3> <p> <ul> <li> <strong>，不要 <h1>、不要 markdown、不要外链、不要编造具体比分或赛果。';
  const user = [
    `网站：${brand || host}（${host}）`,
    `页面：${cn}直播（页面顶部已有今日和近期${cn}比赛的直播表，点击比赛即可观看）`,
    '写这个页面表格下方的正文：介绍在本站观看' + cn + '直播（赛程按北京时间、多个直播源、免费观看等），常见赛事，以及 3 个常见问题（<h3> 问题 + <p> 回答）。',
    '400–700 个汉字，自然、具体，用你自己的措辞，避免与其他网站重复的套话。',
    ai.brief ? `额外要求：${ai.brief}` : '',
  ].filter(Boolean).join('\n');

  const res = await axios.post(
    `${OPENAI_URL}/chat/completions`,
    { model: ai.model, temperature: 0.8, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] },
    { headers: { Authorization: `Bearer ${ai.key}` }, timeout: 90000, validateStatus: () => true }
  );
  if (res.status !== 200) {
    const msg = res.data && res.data.error && res.data.error.message;
    throw new Error(`OpenAI ${res.status}${msg ? `: ${msg}` : ''}`);
  }
  const html = cleanHtml(res.data && res.data.choices && res.data.choices[0] && res.data.choices[0].message && res.data.choices[0].message.content);
  if (html.length < 50) throw new Error('OpenAI returned no usable text');
  return html;
}

// Jobs: host → { status: 'writing' | 'sent' | 'failed', done, total, error, at }
const jobs = {};

function jobFor(host) {
  return jobs[host] || null;
}

// Writes every sport page of a site, then queues one content command and pokes the site.
// Returns at once; progress shows on the site's page.
function startSite(host, { pokeSite } = {}) {
  const ai = hub.aiSettings();
  if (!ai.key) throw new Error('Add the OpenAI API key first (AI content, at the bottom of WordPress sites)');
  const site = hub.getState().sites[host];
  if (!site) throw new Error(`Unknown site ${host}`);
  if (site.role === 'player') throw new Error(`${host} is a destination site — content is for schedule sites`);
  const sports = site.sports || Object.keys((site.details && site.details.pages) || {});
  if (!sports.length) throw new Error(`${host} hasn't reported its sport pages yet (needs plugin 2.5.0+, or run Set up first)`);
  if (jobs[host] && jobs[host].status === 'writing') return jobs[host];

  const job = (jobs[host] = { status: 'writing', done: 0, total: sports.length, error: '', at: new Date().toISOString() });
  (async () => {
    const pages = {};
    const failed = [];
    for (const sport of sports) {
      try {
        pages[sport] = await writePage({ host, brand: (site.details && site.details.brand) || '', sport, ai });
      } catch (err) {
        failed.push(`${sport}: ${err.message}`);
        if (/OpenAI 401|OpenAI 429/.test(err.message)) break;   // bad key / out of quota: stop here
      }
      job.done += 1;
    }
    if (!Object.keys(pages).length) {
      Object.assign(job, { status: 'failed', error: failed.join(' · ') || 'nothing written' });
      return;
    }
    hub.queueCommand(host, 'content', { pages });
    Object.assign(job, { status: 'sent', error: failed.join(' · '), at: new Date().toISOString() });
    if (pokeSite) await pokeSite({ ...site, host }).catch(() => {});
  })().catch((err) => Object.assign(job, { status: 'failed', error: err.message }));
  return job;
}

module.exports = { writePage, cleanHtml, startSite, jobFor, SPORT_CN };
