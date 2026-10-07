// Isolated test harness for gxb-helper.user.js — jsdom + mocked GM_*/network, no real site/account.
// All account, course, quiz, chapter, unit, topic, and submission IDs are synthetic fixtures.
const { JSDOM } = require('jsdom');
const vm = require('vm');
const fs = require('fs');
const path = require('path');

const SCRIPT = fs.readFileSync(path.join(__dirname, '..', 'gxb-helper.user.js'), 'utf8');
const HEADER = /\/\/ ==UserScript==[\s\S]*?\/\/ ==\/UserScript==\n/;
const flush = (ms = 30) => new Promise(r => setTimeout(r, ms)); // real timer, lets stubbed-immediate timers + microtasks settle
const scopedKey = (base, classId = 10001, userId = 'anonymous', host = 'xmut.class.gaoxiaobang.com') =>
    `${base}:${host}:${classId}:${userId}`;
const stateOf = (store, classId = 10001, userId = 'anonymous', host) => store[scopedKey('gb_auto_step', classId, userId, host)];
const processedOf = (store, classId = 10001, userId = 'anonymous') => {
    try { return JSON.parse(store[scopedKey('gb_processed_topics', classId, userId)] || '[]'); }
    catch { return []; }
};

let pass = 0, fail = 0;
const failures = [];
const assert = (cond, msg) => {
    if (cond) { pass++; console.log(`  ✅ ${msg}`); }
    else { fail++; failures.push(msg); console.log(`  ❌ ${msg}`); }
};

function boot({ html = '', pageGlobals = {}, gmStore = {}, deepseekReply = 'B', apiResponder = null,
    ajaxResponder = null, url = 'https://xmut.class.gaoxiaobang.com/class/10001/unit', referrer = '', onReady = null } = {}) {
    const dom = new JSDOM(`<html><body>${html}</body></html>`, {
        url,
        ...(referrer ? { referrer } : {}),
    });
    const { window } = dom;
    const store = { ...gmStore };
    const fx = { ajaxCalls: [], alerts: [], deepseekReqs: [], intervals: [], timeouts: [], submits: 0, confirms: 0, deleted: {}, menus: [], navigations: [], reloads: 0 };

    window.setTimeout = (fn, ms = 0) => {
        if (ms >= 10000) { fx.timeouts.push({ fn, ms }); return fx.timeouts.length + 1; }
        Promise.resolve().then(fn);
        return 1;
    }; // short waits settle instantly; request/observer deadlines never expire spuriously
    window.setInterval = (fn) => { fx.intervals.push(fn); return 1; };       // captured, never run

    window.GM_setValue = (k, v) => { store[k] = v; };
    window.GM_getValue = (k, d) => (k in store ? store[k] : d);
    window.GM_deleteValue = (k) => { fx.deleted[k] = store[k]; delete store[k]; };
    window.GM_registerMenuCommand = (name, callback) => fx.menus.push({ name, callback });
    window.GM_xmlhttpRequest = (opts) => {
        fx.deepseekReqs.push(opts);
        if (apiResponder) return apiResponder(opts, fx.deepseekReqs.length);
        if (opts.onload) opts.onload({ status: 200, responseText: JSON.stringify({ choices: [{ message: { content: deepseekReply } }] }) });
    };
    window.alert = (m) => fx.alerts.push(m);
    window.prompt = () => 'sk-test';
    window.Element.prototype.scrollIntoView = function () {};
    // jsdom has no layout engine: offsetParent is always null, so "is visible" checks fail.
    // Simulate: elements are "visible" (real offsetParent) unless display:none.
    Object.defineProperty(window.HTMLElement.prototype, 'offsetParent', {
        configurable: true,
        get() { return this.style.display === 'none' ? null : window.document.body; },
    });

    const jqueryStub = (opts) => {
        fx.ajaxCalls.push(opts);
        if (ajaxResponder) return ajaxResponder(opts);
        if (opts.type === 'GET' && /\/chapter\/\d+\/api/.test(opts.url)) {
            opts.success(JSON.stringify({ chapter: { video: { seconds: 600 } } }));
        } else if (opts.type === 'POST') {
            opts.success('ok');
        }
    };
    jqueryStub.ajax = jqueryStub;
    window.$ = jqueryStub;
    // No request is permitted to escape the fixture. Discussion tests replace this
    // with endpoint-specific mocks; an unexpected fetch rejects locally.
    window.fetch = async url => { throw new Error('Unexpected mocked fetch: ' + url); };

    if (onReady) onReady(window);
    const mockedFetch = window.fetch;
    window.fetch = async (...args) => {
        const response = await mockedFetch(...args);
        // Browser Response supports both readers. Existing fixtures use json
        // shorthand; supply text without calling any real networking API.
        if (!response.text && response.json) return { ...response, text: async () => JSON.stringify(await response.json()) };
        return response;
    };
    const sandboxWindow = Object.assign(window, pageGlobals);
    const unsafeWindow = Object.create(window);
    Object.assign(unsafeWindow, pageGlobals);
    sandboxWindow.unsafeWindow = unsafeWindow;

    // Capture navigation without jsdom's unimplemented navigation or any real
    // browser/site action. Script globals otherwise use the jsdom document.
    const pageUrl = new URL(url);
    const navigate = value => {
        const nextUrl = new URL(value, pageUrl), oldUrl = pageUrl.href;
        fx.navigations.push(nextUrl.href);
        if (nextUrl.origin === pageUrl.origin && nextUrl.pathname === pageUrl.pathname
            && nextUrl.search === pageUrl.search && nextUrl.hash !== pageUrl.hash) {
            pageUrl.hash = nextUrl.hash;
            Promise.resolve().then(() => window.dispatchEvent(new window.HashChangeEvent('hashchange', { oldURL: oldUrl, newURL: pageUrl.href })));
        }
    };
    const navigationLocation = {
        get protocol() { return pageUrl.protocol; },
        get host() { return pageUrl.host; },
        get hostname() { return pageUrl.hostname; },
        get pathname() { return pageUrl.pathname; },
        get origin() { return pageUrl.origin; },
        get href() { return pageUrl.href; },
        set href(value) { navigate(value); },
        get hash() { return pageUrl.hash; },
        set hash(value) { navigate(value.startsWith('#') ? value : '#' + value); },
        assign(value) { navigate(value); },
        replace(value) { navigate(value); },
        reload() { fx.reloads++; fx.navigations.push(pageUrl.href); },
    };
    const sandbox = new Proxy({ window: sandboxWindow, location: navigationLocation }, {
        has: () => true,
        get: (t, p) => (p in t ? t[p] : sandboxWindow[p]),
    });
    vm.runInNewContext(SCRIPT.replace(HEADER, ''), sandbox, { filename: 'gxb-helper.user.js' });
    return { window, fx, store, location: navigationLocation,
        changeUrl(value, eventType = 'popstate') {
            pageUrl.href = new URL(value, pageUrl).href;
            if (eventType) window.dispatchEvent(new window.Event(eventType));
        },
    };
}

function quizFixture(options = {}) {
    const questions = options.questions || [{ title: 'Fixture question', questionType: 'single_choice', answerList: [
        { answerId: 'a1', text: 'one' }, { answerId: 'a2', text: 'two' }, { answerId: 'a3', text: 'three' },
    ] }];
    return boot({
        ...options,
        pageGlobals: { ...options.pageGlobals, questionList: questions },
        gmStore: { gb_deepseek_key: 'sk-fixture', gb_quiz_confirm: 'off', ...options.gmStore },
        html: options.html || `<div class="question-item"><i class="gxb-icon-radio" answer_id="a1"></i><i class="gxb-icon-radio" answer_id="a2"></i><i class="gxb-icon-radio" answer_id="a3"></i></div><button id="quizSubmit">Submit</button><button class="btn btn-default gxb-sure">Confirm</button>`,
        onReady(window) {
            // Reproduce the site's normal single/multiple-choice click behavior.
            window.document.querySelectorAll('i[answer_id]').forEach(icon => icon.addEventListener('click', () => {
                if (icon.classList.contains('gxb-icon-radio')) {
                    icon.parentElement.querySelectorAll('i[answer_id]').forEach(other => other.classList.remove('checked'));
                    icon.classList.add('checked');
                } else icon.classList.toggle('checked');
            }));
            window.document.querySelector('#quizSubmit')?.addEventListener('click', event => { event.currentTarget.dataset.autoClicked = 'true'; });
            window.document.querySelector('.gxb-sure')?.addEventListener('click', event => { event.currentTarget.dataset.autoClicked = 'true'; });
            options.onReady?.(window);
        },
    });
}

const submitted = ({ window }) => !!window.document.querySelector('#quizSubmit')?.dataset.autoClicked;
const selectedIds = ({ window }) => [...window.document.querySelectorAll('i[answer_id].checked')].map(icon => icon.getAttribute('answer_id')).sort();

(async () => {
    // ================= Module 1: progress forging =================
    console.log('\n── Module 1: 视频/页面进度 API 直报 ──');
    {
        const { fx, store } = boot({
            pageGlobals: {
                classinfo: { classId: 10001 },
                unitList: [
                    { contentType: 'Video', chapterId: 101 },
                    { contentType: 'Page', chapterId: 102 },
                    { contentType: 'Courseware', chapterId: 105 },
                    { itemList: [{ contentType: 'Video', chapterId: 103 }] },
                    { contentType: 'Quiz', chapterId: 104 },
                ],
            },
        });
        await flush();
        const videoPosts = fx.ajaxCalls.filter(c => c.type === 'POST' && /\/log\/video\//.test(c.url));
        const pageGets = fx.ajaxCalls.filter(c => c.type === 'GET' && /\/chapter\/(102|105)\/api/.test(c.url));
        const quizGets = fx.ajaxCalls.filter(c => /\/chapter\/104\/api/.test(c.url));
        assert(videoPosts.length === 2, 'forges one log POST per video (incl. nested itemList), got ' + videoPosts.length);
        assert(pageGets.length === 2, 'fires completion GET for page + courseware chapters');
        assert(quizGets.length === 0, 'quiz chapters are not touched by the progress module');
        const payload = JSON.parse(videoPosts[0].data.data);
        assert(payload[0].state === 'listening' && payload[0].level === 2 && payload[0].ch === 600,
            'payload claims full duration: {state:listening, level:2, ch:600}');
        assert(videoPosts.every(c => /\/log\/video\/(101|103)\/10001\/api/.test(c.url)), 'posts hit /log/video/{chapterId}/{classId}/api');
        assert(stateOf(store) === 'completed', 'finishes the course when the chapter list contains no discussion topics');
        assert(fx.alerts.length === 0, 'no-topic course completes without requiring discussion user data');
    }

    // ================= Module 3: quiz, confirm mode (default) =================
    console.log('\n── Module 3: 测验 DeepSeek 答题 — 提交前确认模式（默认）──');
    {
        const { window, fx, store } = boot({
            pageGlobals: {
                questionList: [
                    {
                        title: '以下哪项属于用户思维?',
                        answerList: [
                            { answerId: 'a1', content: '以自我为中心', correct: '0' },
                            { answerId: 'a2', content: '站在用户角度', correct: '0' },
                            { answerId: 'a3', content: '忽略用户', correct: '0' },
                        ],
                    },
                    {
                        title: '第二题：粉丝思维的例子?',
                        answerList: [
                            { answerId: 'b1', content: '小米社群', correct: '0' },
                            { answerId: 'b2', content: '传统批发', correct: '0' },
                        ],
                    },
                ],
            },
            html: `
                <i answer_id="a1"></i><i answer_id="a2"></i><i answer_id="a3"></i>
                <i answer_id="b1"></i><i answer_id="b2"></i>
                <button id="quizSubmit">提交</button>
                <button class="btn btn-default gxb-sure">确定</button>
            `,
            deepseekReply: 'B.',
            gmStore: { gb_deepseek_key: 'sk-test-123' },
        });
        // simulate the site's own toggle handler: clicking an option marks it selected
        window.document.querySelectorAll('i[answer_id]').forEach(i =>
            i.addEventListener('click', () => i.classList.toggle('checked')));
        await flush(60);

        assert(fx.deepseekReqs.length === 2, 'asks DeepSeek once per question (2 questions)');
        const req = fx.deepseekReqs[0];
        assert(req.url === 'https://api.deepseek.com/chat/completions', 'posts to api.deepseek.com/chat/completions');
        assert(req.headers.Authorization === 'Bearer sk-test-123', 'sends configured key as Bearer token');
        const body = JSON.parse(req.data);
        assert(body.model === 'deepseek-chat' && body.temperature === 0, 'uses deepseek-chat, temperature 0');
        assert(body.messages[1].content.includes('以下哪项属于用户思维'), 'prompt embeds question title');
        assert(body.messages[1].content.includes('B. 站在用户角度'), 'prompt embeds lettered options');
        assert(window.document.querySelector('i[answer_id="a2"]').className.includes('checked'), 'selects option matching AI letter (B → a2)');
        assert(!window.document.querySelector('i[answer_id="a1"]').className.includes('checked'), 'does not select other options');
        assert(!window.document.getElementById('quizSubmit').dataset.autoClicked, 'does NOT auto-submit in confirm mode');
        assert(fx.alerts.some(a => a.includes('请检查答案后自行点击')), 'prompts user to review and submit manually');
        assert(fx.confirms === 0, 'confirm dialog (.gxb-sure) never clicked in confirm mode');
    }

    // ================= Module 3b: quiz, auto-submit mode =================
    console.log('\n── Module 3b: 测验 — 全自动提交模式（菜单切换后）──');
    {
        const { window, fx } = boot({
            pageGlobals: { questionList: [{ questionName: '<p>T</p>', questionType: 'multiple_choice', answerList: [{ answerId: 'a1', text: 'x' }] }] },
            html: `<i answer_id="a1"></i><button id="quizSubmit">提交</button><button class="btn btn-default gxb-sure">确定</button>`,
            deepseekReply: 'A',
            gmStore: { gb_deepseek_key: 'sk-test', gb_quiz_confirm: 'off' },
        });
        window.document.querySelectorAll('i[answer_id]').forEach(i =>
            i.addEventListener('click', () => i.classList.toggle('checked')));
        let clicked = false;
        window.document.getElementById('quizSubmit').addEventListener('click', () => { clicked = true; });
        let confirmed = false;
        window.document.querySelector('.gxb-sure').addEventListener('click', () => { confirmed = true; });
        await flush(60);
        assert(clicked, 'auto mode clicks #quizSubmit');
        assert(confirmed, 'auto mode clicks the .gxb-sure confirmation');
        assert(fx.deepseekReqs.length === 1, 'AI called for the single question');
        assert(window.document.querySelector('i[answer_id="a1"]').className.includes('checked'), 'option A selected before submit');
    }

    // ================= Module 2: discussion via API =================
    console.log('\n── Module 2: 讨论区 API 直发（复制最长评论 + 5s 防频控 + 提交验证）──');
    {
        // 3 topics: 60001 有评论(发帖), 60002 无评论(跳过), 60003 已含我的回复(跳过)
        const replies = {
            60001: [{ userId: '1', message: '<p>别人的</p>' }, { userId: '2', message: '<p>别人的长评论内容，应该被复制的那条。</p>' }],
            60002: [],  // 无任何回复 → 无可复制，跳过
            60003: [{ userId: '1', message: '<p>已含我的回复</p>' }, { userId: '70001', message: '<p>我的旧回复</p>' }],
        };
        const submits = [];
        const { store, fx } = boot({
            pageGlobals: {
                classinfo: { classId: 10001 },
                unitList: [
                    { contentType: 'Topic', chapterId: 201, topic: { topicId: 60001 } },
                    { contentType: 'Topic', chapterId: 202, topic: { topicId: 60002 } },
                    { contentType: 'Topic', chapterId: 203, topic: { topicId: 60003 } },
                    { contentType: 'Video', chapterId: 204 },
                ],
                gxb: { user: { _: { currentUser: { userId: '70001' } } } },
            },
            onReady: (win) => {
                win.fetch = async (url, init) => {
                    url = String(url);
                    const m = url.match(/\/topic\/(\d+)\/submit\/api/);
                    if (m && init && init.method === 'POST') {
                        submits.push({ tid: m[1], body: init.body.toString() });
                        replies[m[1]] = (replies[m[1]] || []).concat([{ userId: '70001', message: '<p>新帖</p>' }]);
                        return { ok: true, text: async () => '' };
                    }
                    const d = url.match(/\/class\/10001\/topic\/(\d+)\/detail\/api/);
                    if (d) return { ok: true, json: async () => ({ replyList: { dataList: replies[d[1]] || [] } }) };
                    if (/\/chapter\/\d+\/api/.test(url)) return { ok: true, json: async () => ({ chapter: { video: { seconds: 600 } } }) };
                    return { ok: true, json: async () => ({}) };
                };
            },
        });
        await flush(300);

        assert(submits.length === 1, 'submits exactly one reply (others skipped: mine already / no replies to copy), got ' + submits.length);
        assert(/topicId=60001/.test(submits[0] ? submits[0].body : ''), 'submit targets the right topicId');
        assert(decodeURIComponent(submits[0] ? submits[0].body : '').includes('别人的长评论内容'), 'copies the longest existing reply as message');
        const processed = processedOf(store, 10001, '70001');
        assert(processed.includes('201') && processed.includes('203') && !processed.includes('202'), 'marks verified replies processed while an empty topic stays retryable');
        assert(!processed.includes('204'), 'non-Topic chapters are not marked');
        assert(stateOf(store, 10001, '70001') === 'discuss', 'keeps discussion retryable when a topic has no available reply');
        assert(!(scopedKey('gb_processed_topics', 10001, '70001') in fx.deleted), 'keeps the scoped processed list');
    }

    // ================= Module 2c: submit failure → retryable =================
    console.log('\n── Module 2c: 提交未生效 → 不标记、状态留待重试 ──');
    {
        const replies = { 60001: [{ userId: '1', message: '<p>可复制的评论</p>' }] };
        const { store } = boot({
            pageGlobals: {
                classinfo: { classId: 10001 },
                unitList: [{ contentType: 'Topic', chapterId: 301, topic: { topicId: 60001 } }],
                gxb: { user: { _: { currentUser: { userId: '70001' } } } },
            },
            onReady: (win) => {
                win.fetch = async (url, init) => {
                    url = String(url);
                    if (/\/topic\/60001\/submit\/api/.test(url) && init && init.method === 'POST') {
                        return { ok: false, status: 404, text: async () => '' };  // 频控/失败
                    }
                    const d = url.match(/\/class\/10001\/topic\/(\d+)\/detail\/api/);
                    if (d) return { ok: true, json: async () => ({ replyList: { dataList: replies[d[1]] || [] } }) };
                    if (/\/chapter\/\d+\/api/.test(url)) return { ok: true, json: async () => ({ chapter: { video: { seconds: 600 } } }) };
                    return { ok: true, json: async () => ({}) };
                };
            },
        });
        await flush(300);
        const processed = processedOf(store, 10001, '70001');
        assert(!processed.includes('301'), 'does NOT mark the topic processed when the submit failed');
        assert(stateOf(store, 10001, '70001') === 'discuss', 'stays in "discuss" for retry on next reload');
    }

    // ================= Module 0: no-key guard =================
    console.log('\n── Module 0: 未配置 Key 守卫 ──');
    {
        const { fx } = boot({
            pageGlobals: { questionList: [{ questionName: '<p>T</p>', questionType: 'multiple_choice', answerList: [{ answerId: 'a1', text: 'x' }] }] },
            html: `<i answer_id="a1"></i><button id="quizSubmit">提交</button>`,
            gmStore: {}, // no key
        });
        await flush();
        assert(fx.deepseekReqs.length === 0, 'makes no API calls without a configured key');
        assert(fx.ajaxCalls.length === 0, 'makes no ajax calls on a quiz page');
    }

    console.log('\n── Regressions: quiz routing and course/account state ──');
    {
        const fixture = quizFixture({
            pageGlobals: { classinfo: { classId: 10001 }, unitList: [{ contentType: 'Video', chapterId: 101 }] },
            gmStore: { [scopedKey('gb_auto_step')]: 'completed' },
        });
        await flush();
        assert(fixture.fx.deepseekReqs.length === 1 && submitted(fixture), 'a completed course still permits a new quiz');
        assert(fixture.fx.ajaxCalls.length === 0, 'quiz takes priority over course globals even with stored completed state');
        assert(stateOf(fixture.store) === 'completed', 'quiz leaves course completion state intact');
    }
    {
        const fixture = quizFixture({ pageGlobals: { classinfo: { classId: 10001 }, unitList: [{ contentType: 'Video', chapterId: 101 }] } });
        await flush();
        assert(fixture.fx.deepseekReqs.length === 1 && fixture.fx.ajaxCalls.length === 0, 'quiz takes priority over progress on a mixed-data page');
    }

    console.log('\n── Regressions: unsafe AI replies never submit ──');
    for (const reply of ['A or B', 'A because it is correct', 'D', 'AB', '', 'A/Z', '答案是 A']) {
        const fixture = quizFixture({ deepseekReply: reply });
        await flush();
        assert(!submitted(fixture), `rejects invalid/ambiguous single-choice reply ${JSON.stringify(reply)}`);
        assert(selectedIds(fixture).length === 0, 'invalid reply leaves options untouched');
        assert(fixture.fx.alerts.length > 0, 'failed question produces a visible review warning');
    }
    for (const [name, apiResponder] of [
        ['HTTP failure despite a plausible body', opts => opts.onload({ status: 401, responseText: '{"choices":[{"message":{"content":"A"}}]}' })],
        ['invalid JSON', opts => opts.onload({ status: 200, responseText: '{' })],
        ['network error', opts => opts.onerror({})],
        ['request timeout', opts => opts.ontimeout({})],
    ]) {
        const fixture = quizFixture({ apiResponder });
        await flush();
        assert(!submitted(fixture) && fixture.fx.alerts.length > 0, `${name} prevents automatic submission and warns the user`);
    }
    {
        const fixture = quizFixture({ html: '<i class="gxb-icon-radio" answer_id="a1"></i><button id="quizSubmit">Submit</button>', deepseekReply: 'B' });
        await flush();
        assert(!submitted(fixture), 'missing target option prevents submission');
    }
    {
        const questions = [
            { title: 'First', answerList: [{ answerId: 'a1', text: 'one' }] },
            { title: 'Second', answerList: [{ answerId: 'b1', text: 'two' }] },
        ];
        const fixture = quizFixture({ questions,
            html: '<i class="gxb-icon-radio" answer_id="a1"></i><i class="gxb-icon-radio" answer_id="b1"></i><button id="quizSubmit">Submit</button>',
            apiResponder: (opts, n) => opts.onload({ status: 200, responseText: JSON.stringify({ choices: [{ message: { content: n === 1 ? 'A' : 'Z' } }] }) }),
        });
        await flush();
        assert(fixture.fx.deepseekReqs.length === 2 && !submitted(fixture), 'one failed question blocks submission after another question succeeds');
        assert(fixture.fx.alerts.some(message => /1/.test(message) && /失败|未完成|错误/.test(message)), 'partial-result warning reports incomplete work');
    }

    console.log('\n── Regressions: exact selection and idempotence ──');
    {
        const fixture = quizFixture({
            html: '<div><i class="gxb-icon-radio checked" answer_id="a1"></i><i class="gxb-icon-radio" answer_id="a2"></i><i class="gxb-icon-radio" answer_id="a3"></i></div><button id="quizSubmit">Submit</button>',
        });
        await flush();
        assert(JSON.stringify(selectedIds(fixture)) === '["a2"]' && submitted(fixture), 'single choice replaces an incorrect preselected answer exactly');
    }
    {
        const fixture = quizFixture({
            questions: [{ title: 'Multi', questionType: 'multi_select', answerList: [{ answerId: 'a1', text: 'one' }, { answerId: 'a2', text: 'two' }, { answerId: 'a3', text: 'three' }] }],
            html: '<div><i class="gxb-icon-checkbox checked" answer_id="a1"></i><i class="gxb-icon-checkbox checked" answer_id="a2"></i><i class="gxb-icon-checkbox" answer_id="a3"></i></div><button id="quizSubmit">Submit</button>',
            deepseekReply: 'AC',
        });
        await flush();
        assert(JSON.stringify(selectedIds(fixture)) === '["a1","a3"]' && submitted(fixture), 'multiple choice retains desired selections, removes extras, and selects missing answers');
    }
    {
        const fixture = quizFixture({ html: '<div><i class="gxb-icon-radio" answer_id="a1"></i><i class="gxb-icon-radio checked" answer_id="a2"></i><i class="gxb-icon-radio" answer_id="a3"></i></div><button id="quizSubmit">Submit</button>' });
        await flush();
        assert(JSON.stringify(selectedIds(fixture)) === '["a2"]' && submitted(fixture), 'an already-correct answer stays selected');
    }
    {
        const fixture = quizFixture({ onReady(window) {
            window.document.querySelectorAll('i[answer_id]').forEach(icon => icon.addEventListener('click', () => icon.classList.remove('checked')));
        } });
        await flush();
        assert(!submitted(fixture), 'a site click handler that fails to apply selection blocks submission');
    }

    console.log('\n── Regressions: progress requests, failures, and retry ──');
    {
        let pending;
        const fixture = boot({ pageGlobals: { classinfo: { classId: 10001 }, unitList: [{ contentType: 'Page', chapterId: 101 }] },
            ajaxResponder: opts => { pending = opts; },
        });
        await flush();
        assert(pending && stateOf(fixture.store) !== 'completed', 'course does not complete while its page request is pending');
        pending.success('{}');
        await flush();
        assert(stateOf(fixture.store) === 'completed', 'course completes after the pending page request succeeds');
    }
    for (const failure of ['page', 'video detail', 'video report', 'invalid duration']) {
        const fixture = boot({ pageGlobals: { classinfo: { classId: 10001 }, unitList: [{ contentType: failure === 'page' ? 'Page' : 'Video', chapterId: 101 }] },
            ajaxResponder: opts => {
                if (failure === 'page' || (failure === 'video detail' && opts.type === 'GET') || (failure === 'video report' && opts.type === 'POST')) opts.error({ status: 503 });
                else opts.success(JSON.stringify({ chapter: { video: { seconds: failure === 'invalid duration' ? 0 : 600 } } }));
            },
        });
        await flush();
        assert(stateOf(fixture.store) === 'progress', `${failure} failure leaves progress retryable`);
        if (failure === 'invalid duration') assert(!fixture.fx.ajaxCalls.some(call => call.type === 'POST'), 'invalid video duration is never reported as a completion');
    }
    {
        const pageGlobals = { classinfo: { classId: 10001 }, unitList: [{ contentType: 'Page', chapterId: 101 }, { contentType: 'Page', chapterId: 102 }] };
        const first = boot({ pageGlobals, ajaxResponder: opts => /\/102\//.test(opts.url) ? opts.error({ status: 503 }) : opts.success('{}') });
        await flush();
        const retry = boot({ pageGlobals, gmStore: first.store });
        await flush();
        assert(retry.fx.ajaxCalls.length === 1 && /\/102\//.test(retry.fx.ajaxCalls[0].url), 'retry requests only the failed chapter');
        assert(stateOf(retry.store) === 'completed', 'successful retry completes the course');
    }

    console.log('\n── Regressions: scoped and corrupted persistence ──');
    {
        const seeded = { [scopedKey('gb_auto_step', 10001, 'u1')]: 'completed', gb_auto_step: 'completed', gb_processed_topics: '["101"]' };
        const course = classId => ({ classinfo: { classId }, unitList: [{ contentType: 'Page', chapterId: 101 }], gxb: { user: { _: { currentUser: { userId: 'u1' } } } } });
        const anotherCourse = boot({ url: 'https://xmut.class.gaoxiaobang.com/class/10002/unit', pageGlobals: course(10002), gmStore: seeded });
        await flush();
        assert(anotherCourse.fx.ajaxCalls.length === 1, 'completion from one course does not suppress another course with the same chapter ID');
        assert(stateOf(anotherCourse.store, 10002, 'u1') === 'completed', 'new course writes its own scoped completion');
        const anotherUser = boot({ pageGlobals: { ...course(10001), gxb: { user: { _: { currentUser: { userId: 'u2' } } } } }, gmStore: anotherCourse.store });
        await flush();
        assert(anotherUser.fx.ajaxCalls.length === 1 && stateOf(anotherUser.store, 10001, 'u2') === 'completed', 'a second user receives independent progress state');
        const original = boot({ pageGlobals: course(10001), gmStore: anotherUser.store });
        await flush();
        assert(original.fx.ajaxCalls.length === 0, 'completed state still suppresses work for the matching course and user');
        const anotherHost = boot({ url: 'https://other.class.gaoxiaobang.com/class/10001/unit', pageGlobals: course(10001), gmStore: seeded });
        await flush();
        assert(anotherHost.fx.ajaxCalls.length === 1 && stateOf(anotherHost.store, 10001, 'u1', 'other.class.gaoxiaobang.com') === 'completed', 'state is isolated across school hosts');
        assert(anotherCourse.store.gb_auto_step === 'completed' && anotherCourse.store.gb_processed_topics === '["101"]', 'legacy unscoped values are ignored and preserved');
    }
    for (const corrupt of ['{', '{}', 'null', '"not an array"']) {
        const fixture = boot({
            gmStore: { [scopedKey('gb_auto_step', 10001, 'u1')]: 'discuss', [scopedKey('gb_processed_topics', 10001, 'u1')]: corrupt },
            pageGlobals: { classinfo: { classId: 10001 }, unitList: [{ contentType: 'Topic', chapterId: 101, topic: { topicId: 60001 } }], gxb: { user: { _: { currentUser: { userId: 'u1' } } } } },
            onReady: window => { window.fetch = async () => ({ ok: true, json: async () => ({ replyList: { dataList: [{ userId: 'u1', message: 'Existing verified reply' }] } }) }); },
        });
        await flush();
        assert(stateOf(fixture.store, 10001, 'u1') === 'completed' && processedOf(fixture.store, 10001, 'u1').includes('101'), `corrupt processed state ${corrupt} recovers safely`);
    }
    {
        const fixture = boot({ pageGlobals: { classinfo: { classId: 10001 }, unitList: [] } });
        await flush();
        assert(stateOf(fixture.store) !== 'completed', 'an empty chapter list remains retryable while course data may still be loading');
    }

    console.log('\n── Regressions: move to the next task only after confirmed completion ──');
    {
        const fixture = boot({
            pageGlobals: { classinfo: { classId: 10001 }, unitList: [
                { contentType: 'Page', chapterId: 101 }, { contentType: 'Quiz', chapterId: 104 }, { contentType: 'Quiz', chapterId: 105 },
            ] },
            html: '<a content_type="Quiz" chapter_id="104" href="/class/10001/chapter/104/quiz">First quiz</a><a content_type="Quiz" chapter_id="105" href="/class/10001/chapter/105/quiz">Second quiz</a>',
        });
        await flush();
        assert(JSON.stringify(fixture.fx.navigations) === '["https://xmut.class.gaoxiaobang.com/class/10001/chapter/104/quiz"]', 'successful course work opens the first unfinished quiz using its real task link');
    }
    {
        const fixture = boot({
            gmStore: { [scopedKey('gb_processed_quizzes')]: '["104"]' },
            pageGlobals: { classinfo: { classId: 10001 }, unitList: [{ contentType: 'Page', chapterId: 101 },
                { contentType: 'Quiz', chapterId: 104 }, { contentType: 'Quiz', chapterId: 105, href: '/class/10001/chapter/105/quiz' }] },
            html: '<a content_type="Quiz" chapter_id="104" href="/class/10001/chapter/104/quiz">Already done</a>',
        });
        await flush();
        assert(fixture.fx.navigations[0] === 'https://xmut.class.gaoxiaobang.com/class/10001/chapter/105/quiz', 'next task skips previously completed quizzes and uses a chapter-provided href');
    }
    {
        const fixture = boot({
            pageGlobals: { classinfo: { classId: 10001 }, unitList: [{ contentType: 'Page', chapterId: 101 }, { contentType: 'Quiz', chapterId: 104 }] },
            html: '<a content_type="Quiz" chapter_id="104" href="/class/10001/chapter/104/quiz">Quiz</a>',
            ajaxResponder: opts => opts.error({ status: 503 }),
        });
        await flush();
        assert(fixture.fx.navigations.length === 0, 'a progress failure keeps the current task open for retry');
    }
    const quizCourse = {
        classinfo: { classId: 10001 }, chapterinfo: { chapterId: 100 },
        unitList: [{ contentType: 'Quiz', chapterId: 100, href: '/class/10001/chapter/100/quiz' },
            { contentType: 'Quiz', chapterId: 101, href: '/class/10001/chapter/101/quiz' }],
    };
    {
        const fixture = quizFixture({ pageGlobals: quizCourse, gmStore: { gb_quiz_confirm: 'on' } });
        await flush();
        assert(!submitted(fixture) && fixture.fx.navigations.length === 0, 'manual confirmation waits on the current quiz after filling answers');
    }
    {
        const fixture = quizFixture({ pageGlobals: quizCourse });
        await flush();
        assert(submitted(fixture) && fixture.fx.navigations.length === 0, 'clicking submit alone is insufficient to navigate');
    }
    {
        const fixture = quizFixture({ pageGlobals: quizCourse, onReady(window) {
            window.document.getElementById('quizSubmit').addEventListener('click', () => {
                const result = window.document.createElement('div');
                result.className = 'quiz-result';
                result.textContent = '测验已完成';
                window.document.body.append(result);
            });
        } });
        await flush();
        assert(fixture.fx.navigations[0] === 'https://xmut.class.gaoxiaobang.com/class/10001/chapter/101/quiz', 'a visible quiz result opens the next unfinished task');
        assert(JSON.parse(fixture.store[scopedKey('gb_processed_quizzes')] || '[]').includes('100'), 'verified quiz completion persists the current chapter ID');
    }
    {
        const fixture = quizFixture({ pageGlobals: quizCourse, deepseekReply: 'Z' });
        await flush();
        assert(!submitted(fixture) && fixture.fx.navigations.length === 0, 'failed AI answers neither submit nor leave the current quiz');
    }
    {
        let nextClicks = 0;
        boot({ pageGlobals: { classinfo: { classId: 10001 }, unitList: [{ contentType: 'Page', chapterId: 101 }] },
            html: '<button class="gxb-next-blue">下一任务</button>',
            onReady(window) { window.document.querySelector('.gxb-next-blue').addEventListener('click', () => nextClicks++); },
        });
        await flush();
        assert(nextClicks === 1, 'visible site next-task control is clicked after successful course work');
    }
    {
        const fixture = boot({ pageGlobals: { classinfo: { classId: 10001 }, unitList: [{ contentType: 'Page', chapterId: 101 }, { contentType: 'Quiz', chapterId: 104 }] } });
        await flush();
        assert(fixture.fx.navigations.length === 0, 'no known task href leaves the page in place without inventing a URL');
    }
    {
        const fixture = boot({
            pageGlobals: { classinfo: { classId: 10001 }, unitList: [{ contentType: 'Page', chapterId: 101 }, { contentType: 'Quiz', chapterId: 104 }] },
            html: '<a content_type="Quiz" chapter_id="104" href="https://other.class.gaoxiaobang.com/class/10001/chapter/104/quiz">Foreign task</a>',
        });
        await flush();
        assert(fixture.fx.navigations.length === 0, 'a task link on another school host is never followed');
    }

    console.log('\n── Regressions: result evidence, curriculum ordering, and retry controls ──');
    for (const [name, evidence] of [
        ['bare score', '<div class="quiz-score">95 分</div>'],
        ['hidden parent', '<section style="display:none"><div class="quiz-result">测验已完成</div></section>'],
        ['sidebar completion text', '<aside><div class="quiz-result">测验已完成</div></aside>'],
        ['unrelated submit toast', '<div role="status">提交成功</div>'],
        ['another chapter result', '<div class="quiz-result" chapter_id="999">测验已完成</div>'],
    ]) {
        const fixture = quizFixture({ pageGlobals: quizCourse, onReady(window) { window.document.body.insertAdjacentHTML('beforeend', evidence); } });
        await flush();
        assert(fixture.fx.navigations.length === 0 && !fixture.store[scopedKey('gb_processed_quizzes')], `${name} is not treated as current quiz completion`);
    }
    {
        const fixture = quizFixture({ pageGlobals: quizCourse, gmStore: { gb_quiz_confirm: 'on' } });
        await flush();
        fixture.window.document.getElementById('quizSubmit').click();
        fixture.window.document.body.setAttribute('data-quiz-submitted', 'true');
        await flush();
        assert(fixture.fx.navigations[0] === 'https://xmut.class.gaoxiaobang.com/class/10001/chapter/101/quiz', 'the watcher advances when the user later submits and completion appears');
    }
    {
        const fixture = boot({
            pageGlobals: { classinfo: { classId: 10001 }, unitList: [{ contentType: 'Page', chapterId: 101 }, { contentType: 'Quiz', chapterId: 104 }, { contentType: 'Quiz', chapterId: 105 }] },
            html: '<a content_type="Quiz" chapter_id="105" href="/class/10001/chapter/105/quiz">Later task first in DOM</a><a content_type="Quiz" chapter_id="104" href="/class/10001/chapter/104/quiz">Earlier curriculum task</a>',
        });
        await flush();
        assert(fixture.fx.navigations[0] === 'https://xmut.class.gaoxiaobang.com/class/10001/chapter/104/quiz', 'curriculum order wins over reversed DOM task ordering');
    }
    {
        let nextClicks = 0;
        const fixture = boot({
            pageGlobals: { classinfo: { classId: 10001 }, unitList: [{ contentType: 'Page', chapterId: 101 }, { contentType: 'Quiz', chapterId: 104 }, { contentType: 'Quiz', chapterId: 105, href: '/class/10001/chapter/105/quiz' }] },
            html: '<button class="gxb-next-blue">Next</button>',
            onReady(window) { window.document.querySelector('.gxb-next-blue').addEventListener('click', () => nextClicks++); },
        });
        await flush();
        assert(fixture.fx.navigations.length === 0 && nextClicks === 0, 'an earlier unfinished quiz without a usable link blocks skipping ahead and next-button fallback');
    }
    for (const [name, href] of [
        ['mismatched chapter', '/class/10001/chapter/999/quiz'],
        ['another course', '/class/99999/chapter/104/quiz'],
        ['javascript link', 'javascript:alert(1)'],
    ]) {
        const fixture = boot({
            pageGlobals: { classinfo: { classId: 10001 }, unitList: [{ contentType: 'Page', chapterId: 101 }, { contentType: 'Quiz', chapterId: 104, href }] },
        });
        await flush();
        assert(fixture.fx.navigations.length === 0, `${name} is rejected as a next-task destination`);
    }
    {
        let pending;
        const fixture = boot({
            pageGlobals: { classinfo: { classId: 10001 }, unitList: [{ contentType: 'Page', chapterId: 101 }], gxb: { user: { _: { currentUser: { userId: 'u1' } } } } },
            ajaxResponder: opts => { pending = opts; },
        });
        await flush();
        fixture.window.gxb.user._.currentUser.userId = 'u2';
        pending.success('{}');
        await flush();
        assert(!fixture.store[scopedKey('gb_auto_step', 10001, 'u2')] && !fixture.store[scopedKey('gb_processed_chapters', 10001, 'u2')], 'a response started under one account cannot write progress into a newly switched account');
    }
    {
        const fixture = boot();
        await flush();
        assert(fixture.fx.ajaxCalls.length === 0, 'missing initial course globals trigger no progress requests');
        fixture.window.classinfo = { classId: 10001 };
        fixture.window.unitList = [{ contentType: 'Page', chapterId: 101 }];
        const retryMenu = fixture.fx.menus.find(menu => /重试当前页面/.test(menu.name));
        retryMenu.callback();
        await flush();
        assert(fixture.fx.ajaxCalls.length === 1 && stateOf(fixture.store) === 'completed', 'retry menu discovers course globals that arrived after the initial wait');
    }
    {
        const pageGlobals = { classinfo: { classId: 10001 }, unitList: [{ contentType: 'Topic', chapterId: 101, topic: { topicId: 60001 } }], gxb: { user: { _: { currentUser: { userId: 'u1' } } } } };
        let replies = [];
        const onReady = window => { window.fetch = async () => ({ ok: true, json: async () => ({ replyList: { dataList: replies } }) }); };
        const empty = boot({ pageGlobals, onReady });
        await flush();
        assert(stateOf(empty.store, 10001, 'u1') === 'discuss' && !processedOf(empty.store, 10001, 'u1').includes('101'), 'an empty topic remains pending without a false completion record');
        replies = [{ userId: 'u1', message: 'My later manually submitted reply' }];
        const retry = boot({ pageGlobals, gmStore: empty.store, onReady });
        await flush();
        assert(stateOf(retry.store, 10001, 'u1') === 'completed' && processedOf(retry.store, 10001, 'u1').includes('101'), 'an empty topic finishes on retry after a verified reply exists');
    }

    console.log('\n── Regressions: late current quiz, exhausted tasks, and quiz entry ──');
    {
        let injected = false;
        const fixture = boot({
            url: 'https://xmut.class.gaoxiaobang.com/class/10001/chapter/100/quiz',
            pageGlobals: { classinfo: { classId: 10001 }, unitList: [{ contentType: 'Video', chapterId: 99 }, { contentType: 'Quiz', chapterId: 100 }, { contentType: 'Quiz', chapterId: 101, href: '/class/10001/chapter/101/quiz' }] },
            gmStore: { gb_deepseek_key: 'sk-fixture', gb_quiz_confirm: 'on' }, deepseekReply: 'A',
            onReady(window) {
                const shortTimer = window.setTimeout;
                window.setTimeout = (callback, ms) => {
                    if (ms === 500 && !injected) {
                        injected = true;
                        Promise.resolve().then(() => {
                            window.questionList = [{ title: 'Late question', answerList: [{ answerId: 'a1', text: 'one' }] }];
                            window.document.body.insertAdjacentHTML('beforeend', '<i class="gxb-icon-radio" answer_id="a1"></i><button id="quizSubmit">Submit</button>');
                            window.document.querySelector('i[answer_id]').addEventListener('click', event => event.currentTarget.classList.add('checked'));
                        });
                    }
                    return shortTimer(callback, ms);
                };
            },
        });
        await flush();
        assert(injected && fixture.fx.deepseekReqs.length === 1 && selectedIds(fixture).includes('a1'), 'current quiz waits for late-loaded question globals and form');
        assert(fixture.fx.ajaxCalls.length === 0 && fixture.fx.navigations.length === 0, 'waiting for the current quiz never runs course progress or skips to another quiz');
    }
    {
        const fixture = quizFixture({ pageGlobals: quizCourse, questions: [{ title: 'Essay unsupported by options', questionType: 'essay', answerList: [] }] });
        await flush();
        assert(!submitted(fixture) && fixture.fx.navigations.length === 0 && fixture.fx.deepseekReqs.length === 0, 'unsupported quiz form stays open without submitting or skipping');
    }
    {
        let nextClicks = 0;
        const fixture = boot({
            pageGlobals: { classinfo: { classId: 10001 }, unitList: [{ contentType: 'Page', chapterId: 99 }, { contentType: 'Quiz', chapterId: 100, href: '/class/10001/chapter/100/quiz' }] },
            gmStore: { [scopedKey('gb_auto_step')]: 'completed', [scopedKey('gb_processed_quizzes')]: '["100"]' },
            html: '<button class="gxb-next-blue">Next</button>',
            onReady(window) { window.document.querySelector('.gxb-next-blue').addEventListener('click', () => nextClicks++); },
        });
        await flush();
        assert(fixture.fx.navigations.length === 0 && nextClicks === 0, 'exhausted known quizzes do not fall back to a next control that could reopen a completed quiz');
    }
    {
        const fixture = boot({
            url: 'https://xmut.class.gaoxiaobang.com/class/10001/chapter/100/quiz',
            pageGlobals: quizCourse,
            html: '<button class="quiz-join" chapter_id="100">进入测验</button>',
            onReady(window) {
                window.document.querySelector('.quiz-join').addEventListener('click', () => {
                    window.document.body.insertAdjacentHTML('beforeend', '<div class="quiz-result">测验已完成</div>');
                });
            },
        });
        await flush();
        assert(fixture.fx.navigations.length === 1 && fixture.fx.navigations[0] === 'https://xmut.class.gaoxiaobang.com/class/10001/chapter/101/quiz', 'quiz entry that opens a completed result advances exactly once');
        assert(fixture.fx.deepseekReqs.length === 0, 'an existing completed result after quiz entry makes no AI requests');
    }

    console.log('\n── Regressions: same-document chapterId hash routing ──');
    {
        const fixture = boot({
            url: 'https://xmut.class.gaoxiaobang.com/class/10001/chapter/100/quiz',
            pageGlobals: { classinfo: { classId: 10001 }, unitList: [{ contentType: 'Quiz', chapterId: 100 }, { contentType: 'Quiz', chapterId: 101 }] },
            gmStore: { [scopedKey('gb_auto_step')]: 'completed', [scopedKey('gb_processed_quizzes')]: '["100"]' },
        });
        await flush();
        assert(fixture.fx.navigations.length === 0 && fixture.fx.deepseekReqs.length === 0, 'completed current quiz remains ready to retry when the next-task link is missing');
        fixture.window.document.body.insertAdjacentHTML('beforeend', '<a content_type="Quiz" chapter_id="101" href="/class/10001/chapter/101/quiz">Now loaded next quiz</a>');
        fixture.fx.menus.find(menu => /重试当前页面/.test(menu.name)).callback();
        await flush();
        assert(fixture.fx.navigations.length === 1 && fixture.fx.navigations[0] === 'https://xmut.class.gaoxiaobang.com/class/10001/chapter/101/quiz', 'retry menu resumes completed quiz navigation after its next-task link loads');
    }
    {
        const fixture = boot({
            url: 'https://xmut.class.gaoxiaobang.com/class/10001/unit#/learn?chapterId=100&unitId=1',
            pageGlobals: { classinfo: { classId: 10001 }, unitList: [{ contentType: 'Quiz', chapterId: 100 }, { contentType: 'Quiz', chapterId: 101 }] },
            gmStore: { [scopedKey('gb_auto_step')]: 'completed', [scopedKey('gb_processed_quizzes')]: '["100"]' },
        });
        await flush();
        assert(fixture.fx.navigations[0] === 'https://xmut.class.gaoxiaobang.com/class/10001/unit#/learn?chapterId=101&unitId=1', 'completed current quiz resumes via the existing chapterId hash route and preserves other route parameters');
        assert(fixture.fx.deepseekReqs.length === 0, 'persisted current quiz completion is resumed without answering again');
    }
    {
        const fixture = quizFixture({
            url: 'https://xmut.class.gaoxiaobang.com/class/10001/unit#chapterId=100',
            pageGlobals: { classinfo: { classId: 10001 }, unitList: [{ contentType: 'Quiz', chapterId: 100 }, { contentType: 'Quiz', chapterId: 101 }] },
            deepseekReply: 'A',
            onReady(window) {
                const button = window.document.getElementById('quizSubmit');
                button.setAttribute('data-chapter-id', '100');
                button.addEventListener('click', () => {
                    if (button.getAttribute('data-chapter-id') === '100') window.document.body.insertAdjacentHTML('beforeend', '<div class="quiz-result">测验已完成</div>');
                });
                window.addEventListener('hashchange', () => {
                    window.document.querySelector('.quiz-result')?.remove();
                    window.unsafeWindow.questionList = [{ title: 'Next hash-routed quiz', answerList: [{ answerId: 'b1', text: 'new option' }] }];
                    const icon = window.document.querySelector('i[answer_id="a1"]');
                    icon.setAttribute('answer_id', 'b1'); icon.classList.remove('checked');
                    button.setAttribute('data-chapter-id', '101');
                });
            },
        });
        await flush();
        assert(fixture.fx.navigations.length === 1 && fixture.location.hash === '#chapterId=101', 'verified quiz completion changes the SPA hash exactly once');
        assert(fixture.fx.deepseekReqs.length === 2 && selectedIds(fixture).includes('b1'), 'hashchange reruns the assistant on the next quiz without a full reload');
    }
    {
        let pendingReply;
        const clicks = [];
        const fixture = quizFixture({
            url: 'https://xmut.class.gaoxiaobang.com/class/10001/unit#chapterId=100',
            pageGlobals: { classinfo: { classId: 10001 }, unitList: [{ contentType: 'Quiz', chapterId: 100 }, { contentType: 'Quiz', chapterId: 101 }] },
            apiResponder: (opts, n) => {
                if (n === 1) pendingReply = opts;
                else opts.onload({ status: 200, responseText: '{"choices":[{"message":{"content":"A"}}]}' });
            },
            onReady(window) {
                const button = window.document.getElementById('quizSubmit');
                button.setAttribute('data-chapter-id', '100');
                window.document.querySelectorAll('i[answer_id]').forEach(icon => icon.addEventListener('click', () => clicks.push(icon.getAttribute('answer_id'))));
                window.addEventListener('hashchange', () => {
                    window.unsafeWindow.questionList = [{ title: 'New route with reused answer IDs', answerList: [{ answerId: 'a1', text: 'new one' }, { answerId: 'a2', text: 'new two' }] }];
                    button.setAttribute('data-chapter-id', '101');
                    window.document.querySelectorAll('i.checked').forEach(icon => icon.classList.remove('checked'));
                });
            },
        });
        await flush();
        fixture.location.hash = '#chapterId=101';
        pendingReply.onload({ status: 200, responseText: '{"choices":[{"message":{"content":"B"}}]}' });
        await flush();
        assert(!clicks.includes('a2'), 'a delayed AI reply from the old route cannot select reused answer IDs in the new quiz');
        assert(fixture.fx.deepseekReqs.length === 2 && selectedIds(fixture).includes('a1'), 'the new route runs after the stale request releases its guard');
    }

    console.log('\n── Regressions: fresh SPA quiz entry and old result isolation ──');
    {
        let entered = 0;
        const fixture = boot({
            url: 'https://xmut.class.gaoxiaobang.com/class/10001/unit#chapterId=100',
            pageGlobals: { classinfo: { classId: 10001 }, unitList: [{ contentType: 'Quiz', chapterId: 100 }, { contentType: 'Quiz', chapterId: 101 }] },
            gmStore: { [scopedKey('gb_auto_step')]: 'completed', [scopedKey('gb_processed_quizzes')]: '["100"]', gb_deepseek_key: 'sk-fixture', gb_quiz_confirm: 'on' },
            deepseekReply: 'A',
            onReady(window) {
                window.addEventListener('hashchange', () => {
                    window.document.body.insertAdjacentHTML('beforeend', '<button class="quiz-join" chapter_id="101">Enter next quiz</button>');
                    window.document.querySelector('.quiz-join').addEventListener('click', () => {
                        entered++;
                        window.unsafeWindow.questionList = [{ title: 'Newly entered quiz', answerList: [{ answerId: 'b1', text: 'new option' }] }];
                        window.document.body.insertAdjacentHTML('beforeend', '<i class="gxb-icon-radio" answer_id="b1"></i><button id="quizSubmit" data-chapter-id="101">Submit</button>');
                        window.document.querySelector('i[answer_id]').addEventListener('click', event => event.currentTarget.classList.add('checked'));
                    });
                });
            },
        });
        await flush();
        assert(entered === 1 && fixture.fx.deepseekReqs.length === 1 && selectedIds(fixture).includes('b1'), 'a fresh next-quiz entry button is clicked and its newly loaded form is answered');
        assert(fixture.fx.navigations.length === 1 && !JSON.parse(fixture.store[scopedKey('gb_processed_quizzes')] || '[]').includes('101'), 'entering and filling the next quiz does not falsely complete it');
    }
    {
        const fixture = quizFixture({
            url: 'https://xmut.class.gaoxiaobang.com/class/10001/unit#chapterId=100',
            pageGlobals: { classinfo: { classId: 10001 }, unitList: [{ contentType: 'Quiz', chapterId: 100 }, { contentType: 'Quiz', chapterId: 101 }, { contentType: 'Quiz', chapterId: 102 }] },
            deepseekReply: 'A',
            onReady(window) {
                window.document.getElementById('quizSubmit').setAttribute('data-chapter-id', '100');
                window.document.getElementById('quizSubmit').addEventListener('click', () => {
                    window.document.body.insertAdjacentHTML('beforeend', '<div class="quiz-result">测验已完成</div>');
                });
                window.addEventListener('hashchange', event => {
                    if (!new URL(event.newURL).hash.includes('chapterId=101')) return;
                    // Keep the previous unlabelled result visible as some SPA
                    // layouts do; replace only the active question form.
                    window.document.getElementById('quizSubmit').remove();
                    window.document.querySelectorAll('i[answer_id]').forEach(icon => icon.remove());
                    window.unsafeWindow.questionList = [{ title: 'Fresh next form', answerList: [{ answerId: 'b1', text: 'new option' }] }];
                    window.document.body.insertAdjacentHTML('beforeend', '<i class="gxb-icon-radio" answer_id="b1"></i><button id="quizSubmit" data-chapter-id="101">Submit</button>');
                    window.document.querySelector('i[answer_id]').addEventListener('click', event => event.currentTarget.classList.add('checked'));
                });
            },
        });
        await flush();
        assert(fixture.fx.navigations.length === 1 && fixture.location.hash === '#chapterId=101', 'a visible old result beside a fresh next form does not skip the new quiz');
        assert(fixture.fx.deepseekReqs.length === 2 && !JSON.parse(fixture.store[scopedKey('gb_processed_quizzes')] || '[]').includes('101'), 'the new form is answered without inheriting previous result completion');
        fixture.window.document.body.insertAdjacentHTML('beforeend', '<div class="quiz-result" data-chapter-id="101">测验已完成</div>');
        await flush();
        assert(fixture.fx.navigations.length === 2 && fixture.location.hash === '#chapterId=102', 'new current-quiz result evidence advances after the old result was ignored');
    }
    {
        const fixture = quizFixture({
            url: 'https://xmut.class.gaoxiaobang.com/class/10001/unit#chapterId=100',
            pageGlobals: { classinfo: { classId: 10001 }, unitList: [{ contentType: 'Quiz', chapterId: 100 }, { contentType: 'Page', chapterId: 101 }] },
            deepseekReply: 'A', gmStore: { gb_quiz_confirm: 'on' },
        });
        await flush();
        const oldCalls = fixture.fx.deepseekReqs.length;
        fixture.location.hash = '#chapterId=101';
        await flush();
        assert(fixture.fx.deepseekReqs.length === oldCalls, 'a nonquiz hash task ignores stale quiz globals and form from the previous task');
    }

    console.log('\n── Regressions: question data arriving before its option icons ──');
    {
        let injected = false;
        const fixture = boot({
            pageGlobals: { questionList: [
                { title: 'First question rendered late', answerList: [{ answerId: 'a1', text: 'one' }] },
                { title: 'Second question already rendered', answerList: [{ answerId: 'b1', text: 'two' }] },
            ] },
            gmStore: { gb_deepseek_key: 'sk-fixture', gb_quiz_confirm: 'on' }, deepseekReply: 'A',
            html: '<div class="question-item"><i class="gxb-icon-radio" answer_id="b1"></i></div><button id="quizSubmit">Submit</button>',
            onReady(window) {
                window.document.querySelector('i[answer_id="b1"]').addEventListener('click', event => event.currentTarget.classList.add('checked'));
                const shortTimer = window.setTimeout;
                window.setTimeout = (callback, ms) => {
                    if (ms > 0 && ms < 1000 && !injected) {
                        injected = true;
                        Promise.resolve().then(() => {
                            window.document.body.insertAdjacentHTML('afterbegin', '<div class="question-item"><i class="gxb-icon-radio" answer_id="a1"></i></div>');
                            window.document.querySelector('i[answer_id="a1"]').addEventListener('click', event => event.currentTarget.classList.add('checked'));
                        });
                    }
                    return shortTimer(callback, ms);
                };
            },
        });
        await flush();
        assert(injected && fixture.fx.deepseekReqs.length === 2, 'AI waits for all option icons when question globals arrive before the first question DOM');
        assert(JSON.stringify(selectedIds(fixture)) === '["a1","b1"]', 'both early and late rendered questions are answered on the initial run');
        assert(!fixture.fx.alerts.some(message => /失败|未读取/.test(message)), 'normal option rendering delay is not reported as a failed question');
    }

    console.log('\n── Regressions: actual standalone quiz routes and option schema ──');
    const courseReferrer = 'https://xmut.class.gaoxiaobang.com/class/10001/unit/40001/chapter/30003';
    const quizUrl = 'https://xmut.class.gaoxiaobang.com/class/10001/quiz/20003';
    const quizRouteKey = scopedKey('gb_quiz_return_route');
    const storedReturnRoute = store => {
        const value = store[quizRouteKey];
        try { return typeof value === 'string' ? JSON.parse(value) : value; } catch { return null; }
    };
    const completedQuizIds = store => JSON.parse(store[scopedKey('gb_processed_quiz_ids')] || '[]');
    {
        const fixture = quizFixture({ url: quizUrl, referrer: courseReferrer,
            pageGlobals: { quizInfo: { quizId: '20003', contextId: '10001', status: '30' } },
            gmStore: { gb_quiz_confirm: 'on' },
        });
        await flush();
        const saved = storedReturnRoute(fixture.store);
        assert(saved?.quizId === '20003' && saved?.url === courseReferrer, 'standalone quiz saves its validated same-course chapter return route');
        assert(fixture.fx.navigations.length === 0 && completedQuizIds(fixture.store).length === 0, 'filling standalone quiz answers does not return or mark quiz completion');
        assert(!fixture.store[scopedKey('gb_processed_quizzes')], 'quizInfo.contextId is not recorded as a completed chapter ID');
        fixture.window.document.body.insertAdjacentHTML('beforeend', '<div class="quiz-result">测验已完成</div>');
        await flush();
        assert(completedQuizIds(fixture.store).length === 0, 'standalone result text alone does not substitute for an authoritative server submission');
        assert(fixture.fx.navigations.length === 0, 'normal standalone quiz waits for its server submission page before returning');
        assert(!fixture.store[scopedKey('gb_processed_quizzes')], 'returning to a referrer does not falsely complete the referrer chapter');
    }
    for (const [name, referrer] of [
        ['different course', 'https://xmut.class.gaoxiaobang.com/class/99999/unit/40001/chapter/30003'],
        ['different school host', 'https://other.class.gaoxiaobang.com/class/10001/unit/40001/chapter/30003'],
    ]) {
        const fixture = quizFixture({ url: quizUrl, referrer, pageGlobals: { quizInfo: { quizId: '20003', contextId: '10001', status: '30' } }, gmStore: { gb_quiz_confirm: 'on' } });
        await flush();
        fixture.window.document.body.insertAdjacentHTML('beforeend', '<div class="quiz-result">测验已完成</div>');
        await flush();
        assert(!storedReturnRoute(fixture.store) && fixture.fx.navigations.length === 0, `${name} referrer is neither saved nor followed after quiz completion`);
    }
    {
        const fixture = boot({
            url: quizUrl + '/submission/50004',
            pageGlobals: { quizInfo: { quizId: '20003', contextId: '10001' }, submission: { submissionId: '50004', quizId: '20003' } },
            gmStore: { [quizRouteKey]: JSON.stringify({ quizId: '20003', url: courseReferrer }) },
        });
        await flush();
        assert(completedQuizIds(fixture.store).includes('20003') && fixture.fx.navigations[0] === courseReferrer, 'matching server submission on the real quiz submission route records completion and returns to the course');
        assert(fixture.fx.deepseekReqs.length === 0, 'server submission result page is resumed without asking AI again');
    }
    {
        const fixture = boot({
            url: quizUrl + '/submission/50004',
            pageGlobals: { quizInfo: { quizId: '20003', contextId: '10001' }, submission: { submissionId: '50005', quizId: '20003' } },
            gmStore: { [quizRouteKey]: JSON.stringify({ quizId: '20003', url: courseReferrer }) },
        });
        await flush();
        assert(completedQuizIds(fixture.store).length === 0 && fixture.fx.navigations.length === 0, 'a mismatched server submission does not confirm the current quiz');
    }
    {
        const fixture = boot({
            pageGlobals: { classinfo: { classId: 10001 }, unitList: [
                { contentType: 'Quiz', chapterId: 100, quiz: { quizId: '20003' }, href: '/class/10001/quiz/20003' },
                { contentType: 'Quiz', chapterId: 101, quiz: { quizId: '20004' }, href: '/class/10001/quiz/20004' },
            ] },
            gmStore: { [scopedKey('gb_auto_step')]: 'completed', [scopedKey('gb_processed_quiz_ids')]: '["20003"]' },
        });
        await flush();
        assert(fixture.fx.navigations[0] === 'https://xmut.class.gaoxiaobang.com/class/10001/quiz/20004', 'course navigation maps completed standalone quiz IDs to chapter.quiz.quizId and skips the finished quiz');
    }
    {
        const fixture = quizFixture({
            questions: [{ title: 'Actual site multiple answer schema', questionType: 'multiple_answers', answerList: [{ answerId: 'a1', text: 'one' }, { answerId: 'a2', text: 'two' }, { answerId: 'a3', text: 'three' }] }],
            html: '<div><i class="gxb-icon-check" answer_id="a1"></i><i class="gxb-icon-check checked" answer_id="a2"></i><i class="gxb-icon-check" answer_id="a3"></i></div><button id="quizSubmit">Submit</button>',
            deepseekReply: 'AC',
        });
        await flush();
        assert(JSON.stringify(selectedIds(fixture)) === '["a1","a3"]' && submitted(fixture), 'actual multiple_answers/gxb-icon-check question accepts multiple letters and applies exact selections');
    }

    console.log('\n── Regressions: observed course unit/chapter routes ──');
    {
        const fixture = boot({ url: courseReferrer,
            pageGlobals: { classinfo: { classId: 10001 }, unitList: [
                { unitId: 40001, itemList: [{ contentType: 'Page', chapterId: 30003 }] },
                { unitId: 40002, itemList: [{ contentType: 'Quiz', chapterId: 30004, quiz: { quizId: '20004' } }] },
            ] },
        });
        await flush();
        assert(fixture.fx.navigations[0] === 'https://xmut.class.gaoxiaobang.com/class/10001/unit/40002/chapter/30004', 'nested quiz inherits its actual unit ID when reusing the observed course unit/chapter route');
    }
    {
        const fixture = boot({ url: courseReferrer,
            pageGlobals: { classinfo: { classId: 10001 }, unitList: [
                { unitId: 40001, itemList: [{ contentType: 'Page', chapterId: 30003 }] },
                { contentType: 'Quiz', chapterId: 30004, quiz: { quizId: '20004' } },
            ] },
        });
        await flush();
        assert(fixture.fx.navigations.length === 0, 'an unknown quiz unit ID cannot reuse the current chapter unit by guesswork');
    }

    console.log('\n── Regressions: returning to a completed quiz course chapter ──');
    for (const source of ['nested quiz metadata', 'quiz-join DOM fallback', 'quiz-view DOM fallback']) {
        let entryClicks = 0;
        const current = { contentType: 'Quiz', chapterId: 30003 };
        if (source === 'nested quiz metadata') current.quiz = { quizId: '20003' };
        const control = source === 'quiz-view DOM fallback'
            ? '<a class="quiz-view" chapterid="30003" quiz_id="20003" context_id="10001">View quiz</a>'
            : '<button class="quiz-join" chapter_id="30003" quiz_id="20003" context_id="10001">Enter quiz</button>';
        const fixture = boot({
            url: courseReferrer,
            pageGlobals: { classinfo: { classId: 10001 }, unitList: [
                { unitId: 40001, itemList: [current] },
                { unitId: 40002, itemList: [{ contentType: 'Quiz', chapterId: 30004, quiz: { quizId: '20004' } }] },
            ] },
            gmStore: { gb_deepseek_key: 'sk-fixture', [scopedKey('gb_processed_quiz_ids')]: '["20003"]' },
            html: '<div class="chapter-content">' + control + '</div>',
            onReady(window) { window.document.querySelector('.quiz-join, .quiz-view').addEventListener('click', () => entryClicks++); },
        });
        await flush();
        assert(entryClicks === 0 && fixture.fx.deepseekReqs.length === 0, `${source}: a returned completed quiz never opens entry or asks AI again`);
        assert(JSON.parse(fixture.store[scopedKey('gb_processed_quizzes')] || '[]').includes('30003'), `${source}: completion reconciles to the actual current chapter ID`);
        assert(fixture.fx.navigations[0] === 'https://xmut.class.gaoxiaobang.com/class/10001/unit/40002/chapter/30004', `${source}: course continuation opens the next unfinished quiz`);
    }
    for (const [name, attributes] of [
        ['different context', 'chapter_id="30003" context_id="99999"'],
        ['different chapter', 'chapter_id="30009" context_id="10001"'],
    ]) {
        const fixture = boot({
            url: courseReferrer,
            pageGlobals: { classinfo: { classId: 10001 }, unitList: [
                { unitId: 40001, itemList: [{ contentType: 'Quiz', chapterId: 30003 }] },
                { unitId: 40002, itemList: [{ contentType: 'Quiz', chapterId: 30004 }] },
            ] },
            gmStore: { [scopedKey('gb_processed_quiz_ids')]: '["20003"]' },
            html: `<div class="chapter-content"><a class="quiz-view" quiz_id="20003" ${attributes}>View other quiz</a></div>`,
        });
        await flush();
        assert(!JSON.parse(fixture.store[scopedKey('gb_processed_quizzes')] || '[]').includes('30003') && fixture.fx.navigations.length === 0, `${name} quiz control cannot reconcile completion to the current chapter`);
    }

    console.log('\n── Regressions: actual quizSubmission record alongside generic submission ──');
    const submissionResultUrl = quizUrl + '/submission/50002';
    const savedQuizReturn = { [quizRouteKey]: JSON.stringify({ quizId: '20003', url: courseReferrer }) };
    for (const [name, records] of [
        ['production record shape with synthetic IDs', {
            submission: { submissionId: '50003', submittedId: '20003' },
            quizSubmission: { quizId: '20003', quizSubmissionId: '50002', submissionId: '' },
        }],
        ['nonempty quiz submissionId fallback', {
            submission: { submissionId: '50003', submittedId: '20003' },
            quizSubmission: { quizId: '20003', quizSubmissionId: '', submissionId: '50002' },
        }],
    ]) {
        const fixture = boot({
            url: submissionResultUrl,
            pageGlobals: { quizInfo: { quizId: '20003', contextId: '10001' }, ...records },
            gmStore: savedQuizReturn,
        });
        await flush();
        assert(completedQuizIds(fixture.store).includes('20003') && fixture.fx.navigations[0] === courseReferrer, `${name}: a matching nonempty submission record confirms the quiz and returns`);
        assert(fixture.fx.deepseekReqs.length === 0, `${name}: the confirmed server result requires no new AI call`);
    }
    for (const [name, records] of [
        ['matching generic ID cannot override mismatched specific quiz record', {
            submission: { submissionId: '50002', quizId: '20003' },
            quizSubmission: { quizId: '20003', quizSubmissionId: '50009', submissionId: '' },
        }],
        ['unrelated generic and mismatched actual quiz submission IDs', {
            submission: { submissionId: '50003', submittedId: '20003' },
            quizSubmission: { quizId: '20003', quizSubmissionId: '50009', submissionId: '' },
        }],
        ['matching submission ID belongs to another quiz', {
            submission: { submissionId: '50003', submittedId: '20003' },
            quizSubmission: { quizId: '999999', quizSubmissionId: '50002', submissionId: '' },
        }],
        ['blank quiz IDs cannot be substituted by submittedId', {
            submission: { submissionId: '', submittedId: '50002' },
            quizSubmission: { quizId: '20003', quizSubmissionId: '', submissionId: '' },
        }],
    ]) {
        const fixture = boot({
            url: submissionResultUrl,
            pageGlobals: { quizInfo: { quizId: '20003', contextId: '10001' }, ...records },
            gmStore: savedQuizReturn,
        });
        await flush();
        assert(completedQuizIds(fixture.store).length === 0 && fixture.fx.navigations.length === 0, `${name}: result does not falsely confirm or leave the quiz`);
    }

    console.log('\n── Regressions: server history link for quizzes completed before local records ──');
    const historyCourseUrl = 'https://xmut.class.gaoxiaobang.com/class/10001/unit/40001/chapter/30001';
    const historyGlobals = (contentType = 'Quiz', quizId = '20001') => ({ classinfo: { classId: 10001 }, unitList: [
        { unitId: 40001, itemList: [{ contentType, chapterId: 30001, quiz: { quizId } }] },
        { unitId: 40002, itemList: [{ contentType: 'Quiz', chapterId: 30002, quiz: { quizId: '20002' } }] },
    ] });
    {
        let historyClicks = 0, entryClicks = 0;
        const fixture = boot({
            url: historyCourseUrl, pageGlobals: historyGlobals(), gmStore: { gb_deepseek_key: 'sk-fixture' },
            html: '<div class="chapter-content"><button class="quiz-join" chapter_id="30001" context_id="10001" quiz_id="20001">Enter</button><a class="quiz-view" href="javascript:void(0)" quiz_submission_id="50001" context_id="10001" quiz_id="20001">View existing submission</a></div>',
            onReady(window) {
                window.document.querySelector('.quiz-view').addEventListener('click', () => historyClicks++);
                window.document.querySelector('.quiz-join').addEventListener('click', () => entryClicks++);
            },
        });
        await flush();
        assert(completedQuizIds(fixture.store).includes('20001') && JSON.parse(fixture.store[scopedKey('gb_processed_quizzes')] || '[]').includes('30001'), 'the exact server history link records its real quiz ID and current chapter without prior local completion');
        assert(entryClicks === 0 && historyClicks === 0 && fixture.fx.deepseekReqs.length === 0, 'server history after a visible entry button takes precedence without reopening entry/history or asking AI');
        assert(fixture.fx.navigations[0] === 'https://xmut.class.gaoxiaobang.com/class/10001/unit/40002/chapter/30002', 'a historically completed quiz advances to the next unfinished course quiz');
    }
    for (const [name, config] of [
        ['blank history ID', { submissionId: '' }],
        ['whitespace history ID', { submissionId: '   ' }],
        ['history quiz ID differs from chapter metadata', { controlQuizId: '999999' }],
        ['history belongs to another class', { contextId: '99999' }],
        ['current task is not a quiz', { contentType: 'Page' }],
    ]) {
        const fixture = boot({
            url: historyCourseUrl, pageGlobals: historyGlobals(config.contentType),
            html: `<div class="chapter-content"><a class="quiz-view" href="javascript:void(0)" quiz_submission_id="${config.submissionId ?? '50001'}" context_id="${config.contextId || '10001'}" quiz_id="${config.controlQuizId || '20001'}">View submission</a></div>`,
        });
        await flush();
        assert(completedQuizIds(fixture.store).length === 0 && !JSON.parse(fixture.store[scopedKey('gb_processed_quizzes')] || '[]').includes('30001'), `${name}: history control does not falsely mark the current quiz/chapter completed`);
        if (config.contentType !== 'Page') assert(fixture.fx.navigations.length === 0, `${name}: unverified history does not skip the current quiz`);
    }

    console.log('\n── Regressions: old server history survives SPA task changes ──');
    const staleHistoryGlobals = { classinfo: { classId: 10001 }, unitList: [
        { contentType: 'Quiz', chapterId: 100, quiz: { quizId: '20003' } },
        { contentType: 'Quiz', chapterId: 101 },
        { contentType: 'Quiz', chapterId: 102, quiz: { quizId: '20005' } },
    ] };
    const staleHistoryHtml = '<div class="chapter-content"><a class="quiz-view" href="javascript:void(0)" quiz_submission_id="50004" context_id="10001" quiz_id="20003">Old completed quiz history without a chapter attribute</a></div>';
    {
        const fixture = boot({
            url: 'https://xmut.class.gaoxiaobang.com/class/10001/unit#chapterId=100',
            pageGlobals: staleHistoryGlobals, html: staleHistoryHtml,
            gmStore: { [scopedKey('gb_auto_step')]: 'completed' },
        });
        await flush();
        const processed = JSON.parse(fixture.store[scopedKey('gb_processed_quizzes')] || '[]');
        assert(processed.includes('100') && !processed.includes('101'), 'old unlabelled server history cannot complete the next hash quiz when its metadata is missing');
        assert(fixture.fx.navigations.length === 1 && fixture.location.hash === '#chapterId=101', 'old retained history leaves the next quiz open instead of skipping to a later task');
        assert(fixture.fx.deepseekReqs.length === 0, 'a next quiz with no fresh form stays pending without AI requests');
    }
    {
        const fixture = boot({
            url: 'https://xmut.class.gaoxiaobang.com/class/10001/unit#chapterId=100',
            pageGlobals: staleHistoryGlobals, html: staleHistoryHtml, deepseekReply: 'A',
            gmStore: { [scopedKey('gb_auto_step')]: 'completed', gb_deepseek_key: 'sk-fixture', gb_quiz_confirm: 'on' },
            onReady(window) {
                window.addEventListener('hashchange', event => {
                    if (!new URL(event.newURL).hash.includes('chapterId=101')) return;
                    window.unsafeWindow.questionList = [{ title: 'Next quiz with fresh form but no catalog quiz ID', answerList: [{ answerId: 'b1', text: 'new option' }] }];
                    window.document.body.insertAdjacentHTML('beforeend', '<i class="gxb-icon-radio" answer_id="b1"></i><button id="quizSubmit" data-chapter-id="101">Submit</button>');
                    window.document.querySelector('i[answer_id="b1"]').addEventListener('click', event => event.currentTarget.classList.add('checked'));
                });
            },
        });
        await flush();
        assert(fixture.fx.deepseekReqs.length === 1 && selectedIds(fixture).includes('b1'), 'the next fresh form is answered while old server history remains visible');
        fixture.fx.menus.find(menu => /重试当前页面/.test(menu.name)).callback();
        await flush();
        assert(!JSON.parse(fixture.store[scopedKey('gb_processed_quizzes')] || '[]').includes('101'), 'retry after fresh form readiness cannot resurrect old history as next quiz completion');
        assert(fixture.fx.navigations.length === 1 && fixture.location.hash === '#chapterId=101' && fixture.fx.deepseekReqs.length === 2, 'retry stays on the new quiz and reruns its answers after transition readiness was cleared');
    }

    console.log('\n── Regressions: URL course identity and SPA course reload ──');
    {
        const fixture = boot({
            url: 'https://xmut.class.gaoxiaobang.com/class/10003/unit/40003/chapter/30011',
            pageGlobals: { classinfo: { classId: 10001 }, unitList: [{ contentType: 'Video', chapterId: 101 }] },
            gmStore: { [scopedKey('gb_auto_step', 10001)]: 'progress' },
        });
        await flush();
        assert(fixture.fx.ajaxCalls.length === 0 && fixture.fx.deepseekReqs.length === 0, 'new course URL with previous course globals makes no old-course requests');
        assert(!fixture.store[scopedKey('gb_auto_step', 10003)] && !fixture.store[scopedKey('gb_processed_chapters', 10003)], 'mismatched catalog cannot write its chapter progress under the new URL course scope');
        assert(stateOf(fixture.store, 10001) === 'progress', 'waiting for matching new course metadata preserves the previous course state');
    }
    for (const eventType of ['popstate', null]) {
        let pending;
        const fixture = boot({
            pageGlobals: { classinfo: { classId: 10001 }, unitList: [{ contentType: 'Page', chapterId: 101 }] },
            ajaxResponder: opts => { pending = opts; },
        });
        await flush();
        fixture.changeUrl('https://xmut.class.gaoxiaobang.com/class/10003/unit/40003/chapter/30011', eventType);
        fixture.fx.intervals.forEach(callback => callback());
        fixture.window.dispatchEvent(new fixture.window.Event('popstate'));
        fixture.fx.intervals.forEach(callback => callback());
        pending.success('{}');
        await flush();
        assert(fixture.fx.reloads === 1, `${eventType || 'interval watcher'}: changed URL course reloads once across repeated route checks`);
        assert(!fixture.store[scopedKey('gb_processed_chapters', 10001)] && !fixture.store[scopedKey('gb_processed_chapters', 10003)], `${eventType || 'interval watcher'}: delayed previous-course response writes no chapter completion after the course changes`);
        assert(!fixture.store[scopedKey('gb_auto_step', 10003)] && fixture.fx.ajaxCalls.length === 1, `${eventType || 'interval watcher'}: reload preparation issues no new request using the previous catalog`);
    }

    console.log('\n── Regressions: written assignment handoff ──');
    const assignmentCourseUrl = 'https://xmut.class.gaoxiaobang.com/class/10003/unit/40003/chapter/30011';
    const assignmentGlobals = { classinfo: { classId: 10003 }, unitList: [
        { contentType: 'Video', chapterId: 30011 }, { contentType: 'Assignment', chapterId: 30012 },
    ] };
    {
        let assignmentClicks = 0;
        const fixture = boot({
            url: assignmentCourseUrl, pageGlobals: assignmentGlobals,
            gmStore: { [scopedKey('gb_auto_step', 10003)]: 'completed' },
            html: '<a content_type="Assignment" chapter_id="30012" href="javascript:void(0)">Written assignment</a>',
            onReady(window) { window.document.querySelector('a').addEventListener('click', event => { event.preventDefault(); assignmentClicks++; }); },
        });
        await flush();
        assert(assignmentClicks === 1 && fixture.fx.deepseekReqs.length === 0 && fixture.fx.ajaxCalls.length === 0, 'completed video/discussion course opens its actual assignment catalog entry without AI or extra progress requests');
    }
    {
        const fixture = boot({
            url: assignmentCourseUrl,
            pageGlobals: { classinfo: { classId: 10003 }, unitList: [{ contentType: 'Quiz', chapterId: 30010, quiz: { quizId: '20006' } }, { contentType: 'Assignment', chapterId: 30012 }] },
            gmStore: { [scopedKey('gb_auto_step', 10003)]: 'completed', [scopedKey('gb_processed_quiz_ids', 10003)]: '["20006"]' },
            html: '<a content_type="Assignment" chapter_id="30012" href="/class/10003/unit/40003/chapter/30012">Written assignment</a>',
        });
        await flush();
        assert(fixture.fx.navigations[0] === 'https://xmut.class.gaoxiaobang.com/class/10003/unit/40003/chapter/30012', 'completed known quizzes hand off to the valid assignment task link');
    }
    for (const [name, linkHtml] of [
        ['locked flag', '<a content_type="Assignment" chapter_id="30012" href="javascript:void(0)" isunlock="false">Locked assignment</a>'],
        ['disabled accessibility state', '<a content_type="Assignment" chapter_id="30012" href="javascript:void(0)" aria-disabled="true">Disabled assignment</a>'],
        ['disabled class', '<a class="disabled" content_type="Assignment" chapter_id="30012" href="javascript:void(0)">Disabled assignment</a>'],
        ['preceding lock icon', '<i class="gxb-icon-lock"></i><a content_type="Assignment" chapter_id="30012" href="javascript:void(0)">Locked assignment</a>'],
        ['foreign host', '<a content_type="Assignment" chapter_id="30012" href="https://other.class.gaoxiaobang.com/class/10003/unit/40003/chapter/30012">Foreign assignment</a>'],
        ['different course', '<a content_type="Assignment" chapter_id="30012" href="/class/10001/unit/40003/chapter/30012">Other course assignment</a>'],
        ['mismatched chapter route', '<a content_type="Assignment" chapter_id="30012" href="/class/10003/unit/40003/chapter/999999">Mismatched assignment</a>'],
        ['mismatched hash chapter route', '<a content_type="Assignment" chapter_id="30012" href="/class/10003/unit/40003/chapter/30012#chapterId=999999">Mismatched hash assignment</a>'],
    ]) {
        let clicks = 0;
        const fixture = boot({
            url: assignmentCourseUrl, pageGlobals: assignmentGlobals,
            gmStore: { [scopedKey('gb_auto_step', 10003)]: 'completed' }, html: linkHtml,
            onReady(window) { window.document.querySelector('a').addEventListener('click', event => { event.preventDefault(); clicks++; }); },
        });
        await flush();
        assert(clicks === 0 && fixture.fx.navigations.length === 0, `${name} assignment catalog link is skipped`);
    }
    {
        let submissions = 0, catalogClicks = 0;
        const fixture = boot({
            url: 'https://xmut.class.gaoxiaobang.com/class/10003/unit/40003/chapter/30012',
            pageGlobals: { ...assignmentGlobals, questionList: [{ title: 'Stale quiz globals', answerList: [{ answerId: 'a1', text: 'old answer' }] }] },
            gmStore: { gb_deepseek_key: 'sk-fixture', gb_quiz_confirm: 'off', [scopedKey('gb_auto_step', 10003)]: 'completed' },
            html: '<textarea id="assignmentDraft">My unfinished written assignment</textarea><button id="assignmentSubmit">Submit assignment</button><button id="quizSubmit">Stale quiz submit</button><a content_type="Assignment" chapter_id="30012" href="javascript:void(0)">Current assignment</a>',
            onReady(window) {
                window.document.querySelectorAll('button').forEach(button => button.addEventListener('click', () => submissions++));
                window.document.querySelector('a').addEventListener('click', event => { event.preventDefault(); catalogClicks++; });
            },
        });
        await flush();
        assert(fixture.fx.deepseekReqs.length === 0 && submissions === 0 && catalogClicks === 0 && fixture.fx.navigations.length === 0, 'the current assignment stays open without AI, submit clicks, or repeated task entry');
        assert(fixture.window.document.getElementById('assignmentDraft').value === 'My unfinished written assignment', 'assignment handoff preserves the user written draft');
    }

    {
        let assignmentClicks = 0, nextClicks = 0;
        const fixture = boot({
            url: assignmentCourseUrl, pageGlobals: assignmentGlobals,
            gmStore: { [scopedKey('gb_auto_step', 10003)]: 'completed' },
            html: '<a content_type="Assignment" chapter_id="30012" href="javascript:void(0)" isunlock="false">Locked assignment</a><button class="gxb-next-blue">Next task</button>',
            onReady(window) {
                window.document.querySelector('a').addEventListener('click', event => { event.preventDefault(); assignmentClicks++; });
                window.document.querySelector('.gxb-next-blue').addEventListener('click', () => nextClicks++);
            },
        });
        await flush();
        assert(assignmentClicks === 0 && nextClicks === 0 && fixture.fx.navigations.length === 0, 'a locked known assignment cannot be bypassed through an enabled generic next-task button');
    }

    console.log('\n── Regressions: assignment catalog rendering after completed course globals ──');
    {
        let injected = false, clicks = 0;
        const fixture = boot({
            url: assignmentCourseUrl, pageGlobals: assignmentGlobals,
            gmStore: { [scopedKey('gb_auto_step', 10003)]: 'completed' },
            html: '<div id="lateCatalog"></div>',
            onReady(window) {
                const shortTimer = window.setTimeout;
                window.setTimeout = (callback, ms) => {
                    if (ms === 500 && !injected) {
                        injected = true;
                        Promise.resolve().then(() => {
                            window.document.getElementById('lateCatalog').insertAdjacentHTML('beforeend', '<a content_type="Assignment" chapter_id="30012" href="javascript:void(0)">Late-rendered assignment</a>');
                            window.document.querySelector('a').addEventListener('click', event => { event.preventDefault(); clicks++; });
                        });
                    }
                    return shortTimer(callback, ms);
                };
            },
        });
        await flush();
        assert(injected && clicks === 1, 'a precompleted course waits for its delayed assignment catalog link and hands off when rendered');
        assert(fixture.fx.ajaxCalls.length === 0 && fixture.fx.deepseekReqs.length === 0, 'delayed assignment readiness reruns no video/discussion requests or AI');
    }
    {
        let polls = 0;
        const fixture = boot({
            url: assignmentCourseUrl, pageGlobals: assignmentGlobals,
            gmStore: { [scopedKey('gb_auto_step', 10003)]: 'completed' },
            onReady(window) {
                const shortTimer = window.setTimeout;
                window.setTimeout = (callback, ms) => { if (ms === 500) polls++; return shortTimer(callback, ms); };
            },
        });
        await flush();
        assert(polls > 0 && polls <= 30, 'missing assignment catalog link is awaited for a bounded number of readiness polls');
        assert(fixture.fx.navigations.length === 0 && fixture.fx.ajaxCalls.length === 0 && fixture.fx.deepseekReqs.length === 0, 'a catalog link that never renders causes no false assignment handoff or unrelated requests');
        assert(Object.keys(fixture.store).length === 1 && stateOf(fixture.store, 10003) === 'completed', 'missing assignment link preserves existing course completion without recording the assignment as completed');
    }

    console.log(`\n═══ Results: ${pass} passed, ${fail} failed ═══`);
    failures.forEach(f => console.log('  FAILED: ' + f));
    process.exit(fail > 0 ? 1 : 0);
})().catch(e => { console.error('HARNESS ERROR:', e); process.exit(2); });
