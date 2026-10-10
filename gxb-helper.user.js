// ==UserScript==
// @name         我不想上高校邦
// @name:en      I Don't Wanna Take Gaoxiaobang
// @namespace    https://github.com/Wu557666/gaoxiaobang
// @version      1.4.1
// @description  视频/页面进度 + 讨论回复 + DeepSeek 测验答题；默认暂停，各模块需启用，支持开始和暂停
// @author       combined from Wu557666/gaoxiaobang + Tyrone2333/Gaoxiaobang-Script
// @homepageURL  https://github.com/xiaoyu884/i-dont-wanna-take-gaoxiaobang
// @supportURL   https://github.com/xiaoyu884/i-dont-wanna-take-gaoxiaobang/issues
// @match        https://*.class.gaoxiaobang.com/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// @grant        GM_xmlhttpRequest
// @grant        GM_registerMenuCommand
// @grant        unsafeWindow
// @connect      api.deepseek.com
// @run-at       document-idle
// ==/UserScript==

(function () {
    'use strict';

    const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
    const STATE_KEY = 'gb_auto_step';
    const PROCESSED_TOPICS_KEY = 'gb_processed_topics';
    const PROCESSED_CHAPTERS_KEY = 'gb_processed_chapters';
    const PROCESSED_QUIZZES_KEY = 'gb_processed_quizzes';
    const PROCESSED_QUIZ_IDS_KEY = 'gb_processed_quiz_ids';
    const QUIZ_RETURN_KEY = 'gb_quiz_return_route';
    const QUIZ_CONFIRM_KEY = 'gb_quiz_confirm';
    const DEEPSEEK_KEY = 'gb_deepseek_key';
    const DEEPSEEK_MODEL = 'gb_deepseek_model';
    const REQUEST_TIMEOUT = 30000;
    const EXECUTION_SESSION_KEY = 'gb_execution_session';
    const MODULE_KEYS = { progress: 'gb_enable_progress', discussion: 'gb_enable_discussion', ai: 'gb_enable_ai' };
    const moduleEnabled = module => GM_getValue(MODULE_KEYS[module], 'off') === 'on';
    const selectedModules = () => Object.keys(MODULE_KEYS).filter(moduleEnabled);
    const sameModules = session => Object.keys(MODULE_KEYS)
        .every(module => session.modules.includes(module) === moduleEnabled(module));
    const pendingRequests = new Set();
    let executionSession = null;
    try {
        const saved = JSON.parse(sessionStorage.getItem(EXECUTION_SESSION_KEY) || 'null');
        if (saved && typeof saved.host === 'string' && typeof saved.course === 'string'
            && (saved.user === null || typeof saved.user === 'string') && Array.isArray(saved.modules)
            && saved.modules.length > 0 && new Set(saved.modules).size === saved.modules.length
            && saved.modules.every(module => Object.hasOwn(MODULE_KEYS, module))) executionSession = saved;
    } catch (_) { /* A missing or malformed session starts paused. */ }

    const routeClassId = () => location.pathname.match(/\/class\/([^/]+)/)?.[1] || null;
    const classId = () => routeClassId() || unsafeWindow.classinfo?.classId;
    const userId = () => {
        const id = unsafeWindow.gxb?.user?._?.currentUser?.userId;
        return id == null || id === '' ? null : String(id);
    };
    // Legacy keys had no account/course identity and cannot safely be migrated.
    const scopedKey = key => `${key}:${location.host}:${classId() || 'unknown'}:${userId() || 'anonymous'}`;
    const state = () => GM_getValue(scopedKey(STATE_KEY), 'progress');
    const setState = value => GM_setValue(scopedKey(STATE_KEY), value);
    const readIds = key => {
        try {
            const ids = JSON.parse(GM_getValue(scopedKey(key), '[]'));
            return Array.isArray(ids) ? [...new Set(ids.filter(id => typeof id === 'string'))] : [];
        } catch (_) { return []; }
    };
    const markProcessed = (key, id) => {
        const ids = readIds(key);
        if (!ids.includes(String(id))) {
            ids.push(String(id));
            GM_setValue(scopedKey(key), JSON.stringify(ids));
        }
    };
    const dataSource = () => extractAllChapters(unsafeWindow.unitList).length ? unsafeWindow.unitList : unsafeWindow.chapterList;
    const isChapterPage = () => !!(classId() && extractAllChapters(dataSource()).length);
    const isQuizPage = () => {
        const current = extractAllChapters(dataSource()).find(chapter => String(chapter.chapterId) === currentChapterId());
        if (current && current.contentType !== 'Quiz') return false;
        return (Array.isArray(unsafeWindow.questionList) && unsafeWindow.questionList.length > 0)
            || !!document.getElementById('quizSubmit');
    };
    let discussRunning = false;
    let quizRunning = false;
    let mainRunning = false;
    let scopeAtStart = null;
    let routeEpoch = 0;
    let chapterAtStart = null;
    let routeRestartRequested = false;
    let epochAtStart = null;
    let pendingQuizContinuation = null;
    let routeTransition = null;
    let staleResultNodes = new Set();
    let staleQuizControls = new Map();
    let lastRouteChapter = null;
    let navigationTimeout = null;
    const executionRequested = () => executionSession?.host === location.host
        && executionSession.course === String(classId())
        && (userId() === null || executionSession.user === userId())
        && sameModules(executionSession);
    const executionAllowed = () => executionRequested() && executionSession.user === userId();
    const assertScope = () => {
        if (!executionAllowed()) throw new Error('脚本已暂停，或当前账号、课程未授权开始');
        if ((scopeAtStart && (scopeAtStart !== scopedKey(STATE_KEY) || chapterAtStart !== currentChapterId()))
            || (epochAtStart !== null && epochAtStart !== routeEpoch)) {
            throw new Error('账号、课程或任务已改变，本轮停止');
        }
    };
    const assertModule = module => {
        assertScope();
        if (!moduleEnabled(module)) throw new Error('当前模块已停用，请重新选择模块后开始');
    };

    // Reject promptly even when an underlying API does not support abort().
    // Late callbacks settle an already rejected promise and cannot resume a run.
    function cancellableRequest(start) {
        return new Promise((resolve, reject) => {
            let handle, settled = false;
            const finish = (callback, value) => {
                if (settled) return;
                settled = true;
                pendingRequests.delete(cancel);
                callback(value);
            };
            const cancel = () => {
                finish(reject, new Error('脚本已暂停'));
                try { handle?.abort?.(); } catch (_) { /* Already finished or not abortable. */ }
            };
            pendingRequests.add(cancel);
            try {
                handle = start(value => finish(resolve, value), error => finish(reject, error));
            } catch (error) { finish(reject, error); }
        });
    }

    function refreshControls() {
        const panel = document.getElementById('gxb-helper-controls');
        if (!panel) return;
        const running = executionAllowed();
        panel.querySelector('#gxb-status').textContent = running ? '已启动：仅运行已启用模块'
            : executionRequested() ? '等待账号信息' : '已暂停';
        panel.querySelector('#gxb-start').disabled = running && (mainRunning || navigating);
        panel.querySelector('#gxb-pause').disabled = !executionSession;
        panel.querySelectorAll('[data-gxb-module]').forEach(input => { input.checked = moduleEnabled(input.dataset.gxbModule); });
    }

    function pauseExecution() {
        executionSession = null;
        try { sessionStorage.removeItem(EXECUTION_SESSION_KEY); } catch (_) { /* Local pause still applies. */ }
        routeEpoch++;
        routeRestartRequested = false;
        pendingQuizContinuation = null;
        navigating = false;
        clearTimeout(navigationTimeout);
        quizObserver?.disconnect(); quizObserver = null;
        clearTimeout(quizObserverTimeout);
        for (const cancel of [...pendingRequests]) cancel();
        refreshControls();
        console.log('⏸ 已暂停；已发送的请求无法撤回，不再执行后续操作');
    }

    function startExecution() {
        if (executionAllowed() && (mainRunning || navigating)) return;
        if (!selectedModules().length) { alert('请先启用至少一个模块，再点击开始。'); return; }
        if (!classId() || (!userId() && (unsafeWindow.gxb?.user || executionSession?.user != null))) { alert('请等待课程及账号信息加载后再开始。'); return; }
        if (executionSession || mainRunning || navigating) pauseExecution();
        executionSession = { host: location.host, course: String(classId()), user: userId(), modules: selectedModules() };
        try { sessionStorage.setItem(EXECUTION_SESSION_KEY, JSON.stringify(executionSession)); }
        catch (_) { console.warn('⚠️ 无法保存本标签页的运行状态；页面切换后请重新开始'); }
        refreshControls();
        if (mainRunning) routeRestartRequested = true;
        else { navigating = false; void main(); }
    }

    function changeModule(module, value) {
        pauseExecution();
        GM_setValue(MODULE_KEYS[module], value ? 'on' : 'off');
        refreshControls();
    }

    function mountControls() {
        const panel = document.createElement('aside');
        panel.id = 'gxb-helper-controls';
        panel.setAttribute('aria-label', '我不想上高校邦运行控制');
        panel.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:2147483647;background:#fff;color:#222;border:1px solid #bbb;border-radius:8px;padding:12px;box-shadow:0 2px 12px #0002;font:14px/1.6 sans-serif;width:240px';
        panel.innerHTML = '<strong>我不想上高校邦</strong><div id="gxb-status" role="status" aria-live="polite"></div>'
            + '<label style="display:block"><input type="checkbox" data-gxb-module="progress"> 视频 / 阅读进度</label>'
            + '<label style="display:block"><input type="checkbox" data-gxb-module="discussion"> 发布讨论回复</label>'
            + '<label style="display:block"><input type="checkbox" data-gxb-module="ai"> AI 测验答案</label>'
            + '<button id="gxb-start" type="button">开始 / 重试</button> <button id="gxb-pause" type="button">暂停</button>'
            + '<div style="font-size:12px;color:#555">更改模块后，请重新开始。</div>';
        panel.querySelector('#gxb-start').addEventListener('click', startExecution);
        panel.querySelector('#gxb-pause').addEventListener('click', pauseExecution);
        panel.querySelectorAll('[data-gxb-module]').forEach(input => {
            input.addEventListener('change', () => changeModule(input.dataset.gxbModule, input.checked));
        });
        document.body.appendChild(panel);
        refreshControls();
    }

    const settings = {
        get apiKey() { return GM_getValue(DEEPSEEK_KEY, ''); },
        set apiKey(v) { GM_setValue(DEEPSEEK_KEY, v); },
        get model() { return GM_getValue(DEEPSEEK_MODEL, 'deepseek-chat'); },
        set model(v) { GM_setValue(DEEPSEEK_MODEL, v); },
        get confirmBeforeSubmit() { return GM_getValue(QUIZ_CONFIRM_KEY, 'on') === 'on'; },
        set confirmBeforeSubmit(v) { GM_setValue(QUIZ_CONFIRM_KEY, v ? 'on' : 'off'); },
    };

    // ========== 菜单命令 ==========
    GM_registerMenuCommand('⚙️ 设置 DeepSeek API Key', () => {
        const key = prompt('DeepSeek API Key (sk-...，留空可清除):', '');
        if (key !== null) settings.apiKey = key.trim();
    });
    GM_registerMenuCommand('⚙️ 设置 DeepSeek 模型', () => {
        const model = prompt('DeepSeek 模型名称:', settings.model);
        if (model !== null && model.trim()) settings.model = model.trim();
    });
    GM_registerMenuCommand('🤖 切换答题模式: ' + (settings.confirmBeforeSubmit ? '提交前确认(当前)' : '自动提交(当前)'), () => {
        pauseExecution();
        settings.confirmBeforeSubmit = !settings.confirmBeforeSubmit;
        alert('答题模式已切换为: ' + (settings.confirmBeforeSubmit ? '提交前人工确认' : '全自动提交'));
        location.reload();
    });
    GM_registerMenuCommand('▶️ 运行 / 重试当前页面', startExecution);
    GM_registerMenuCommand('⏸ 暂停当前标签页', pauseExecution);
    GM_registerMenuCommand('🔁 重置当前课程脚本状态', () => {
        if (mainRunning) { alert('任务正在运行，请等待结束后再重置'); return; }
        if (!classId()) { alert('请在课程页面重置状态'); return; }
        [STATE_KEY, PROCESSED_TOPICS_KEY, PROCESSED_CHAPTERS_KEY, PROCESSED_QUIZZES_KEY, PROCESSED_QUIZ_IDS_KEY, QUIZ_RETURN_KEY].forEach(key => GM_deleteValue(scopedKey(key)));
        alert('当前课程状态已重置，刷新页面生效');
    });

    // ========== DeepSeek 答题 ==========
    async function askDeepSeek(question) {
        assertModule('ai');
        const letterNote = question.multi
            ? '可能有多个正确选项，请返回所有正确选项的字母连在一起（如 ABD）'
            : '请只返回一个正确选项的字母';
        const prompt = `你是答题助手。${letterNote}，不要任何其他文字、解释或标点。\n\n题目：${question.title}\n\n选项：\n${question.options.map((o, i) => `${String.fromCharCode(65 + i)}. ${o}`).join('\n')}`;

        return cancellableRequest((resolve, reject) => {
            return GM_xmlhttpRequest({
                method: 'POST',
                url: 'https://api.deepseek.com/chat/completions',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${settings.apiKey}`,
                },
                data: JSON.stringify({
                    model: settings.model,
                    messages: [
                        { role: 'system', content: question.multi ? '你只输出选项字母的组合，如 ABD。' : '你只输出一个选项字母。' },
                        { role: 'user', content: prompt },
                    ],
                    temperature: 0,
                    max_tokens: question.multi ? 8 : 4,
                }),
                timeout: 60000,
                onload: res => {
                    try {
                        if (typeof res.status === 'number' && (res.status < 200 || res.status >= 300)) throw new Error(`DeepSeek HTTP ${res.status}`);
                        const data = JSON.parse(res.responseText);
                        if (data.error) throw new Error('DeepSeek API 返回错误，请检查密钥、模型和额度');
                        const reply = data.choices?.[0]?.message?.content;
                        if (typeof reply !== 'string') throw new Error('AI 返回内容为空');
                        const answer = reply.trim().toUpperCase();
                        // Parse an answer, not arbitrary letters contained in an explanation.
                        if (!/^[A-Z](?:[\s,，、;；]*[A-Z])*[.!。]?$/.test(answer)) {
                            throw new Error('AI 未返回明确的选项字母');
                        }
                        const letters = [...new Set(answer.match(/[A-Z]/g))];
                        if (letters.some(letter => letter.charCodeAt(0) - 65 >= question.options.length)) {
                            throw new Error('AI 返回越界选项');
                        }
                        if (!question.multi && letters.length !== 1) throw new Error('单选题返回了多个选项');
                        resolve(letters);
                    } catch (error) { reject(error); }
                },
                onerror: () => reject(new Error('DeepSeek 请求失败')),
                ontimeout: () => reject(new Error('DeepSeek 请求超时')),
            });
        });
    }

    const stripTags = value => {
        const container = document.createElement('div');
        container.innerHTML = String(value ?? '');
        return (container.textContent || '').replace(/\s+/g, ' ').trim();
    };
    // Avoid interpolating answer IDs into CSS selectors; IDs may contain quotes.
    const iconsFor = id => Array.from(document.querySelectorAll('i[answer_id]'))
        .filter(element => element.getAttribute('answer_id') === String(id));
    const selected = element => element.classList.contains('checked') || element.getAttribute('aria-checked') === 'true';
    const isMulti = (type, icons) => {
        if (/multiple_answers|multi_select|multi_selection|multiple_select|checkbox|check_box/i.test(type || '')) return true;
        if (icons.some(icon => /radio/.test(icon.className))) return false;
        return icons.some(icon => icon.classList.contains('gxb-icon-check') || /checkbox|check-box|check_box/.test(icon.className));
    };

    function extractQuestions() {
        const list = unsafeWindow.questionList;
        if (Array.isArray(list) && list.length) {
            return list.map((question, index) => {
                const answers = Array.isArray(question.answerList) ? question.answerList : [];
                const answerIds = answers.map(answer => answer.answerId);
                return {
                    index,
                    title: stripTags(question.questionName || question.name || question.title || question.questionTitle),
                    options: answers.map(answer => stripTags(answer.text || answer.content || answer.answerContent)),
                    answerIds,
                    multi: isMulti(question.questionType, answerIds.flatMap(iconsFor)),
                };
            });
        }
        const items = [];
        document.querySelectorAll('[class*="quiz-question"], [class*="question-item"]').forEach(element => {
            const icons = Array.from(element.querySelectorAll('i[answer_id]'));
            // A wrapper may also match the selector; process each actual question only once.
            if (!icons.length || icons.some(icon => items.some(item => item.answerIds.includes(icon.getAttribute('answer_id'))))) return;
            const titleElement = element.querySelector('[class*="title"], p');
            items.push({
                index: items.length,
                title: stripTags(titleElement?.textContent),
                options: icons.map(icon => stripTags(icon.parentElement?.textContent)),
                answerIds: icons.map(icon => icon.getAttribute('answer_id')),
                multi: isMulti('', icons),
            });
        });
        return items;
    }

    function validateQuestion(question) {
        if (!question.title || !question.options.length || question.options.length > 26
            || question.options.some(option => !option)
            || question.answerIds.some(id => id == null || id === '')
            || new Set(question.answerIds.map(String)).size !== question.answerIds.length) {
            throw new Error('题干或选项不完整 / 不支持该题型');
        }
        if (question.answerIds.some(id => !iconsFor(id).length)) throw new Error('未找到题目选项，等待页面加载后重试');
    }

    async function selectAnswers(question, letters) {
        const wanted = new Set(letters.map(letter => String(question.answerIds[letter.charCodeAt(0) - 65])));
        // Clear stale choices first, then select only the requested answers.
        for (const id of question.answerIds) {
            assertModule('ai');
            if (!wanted.has(String(id))) {
                for (const icon of iconsFor(id)) {
                    assertModule('ai');
                    if (selected(icon)) { icon.click(); await wait(0); }
                }
            }
        }
        for (const id of wanted) {
            assertModule('ai');
            for (const icon of iconsFor(id)) {
                assertModule('ai');
                if (!selected(icon)) { icon.click(); await wait(0); }
            }
        }
        assertModule('ai');
        if (question.answerIds.some(id => iconsFor(id).some(icon => selected(icon) !== wanted.has(String(id))))) {
            throw new Error('页面未确认选项选中状态，请手动检查');
        }
    }

    async function waitForQuizQuestions() {
        for (let attempt = 0; attempt < 60; attempt++) {
            assertModule('ai');
            const questions = extractQuestions();
            if (questions.length && questions.every(question => question.answerIds.length > 0
                && question.answerIds.every(id => iconsFor(id).some(visible)))) return questions;
            await wait(250);
        }
        alert('页面加载失败或题目选项不完整，未调用 AI、未自动提交。请等待页面加载后使用菜单重试。');
        return [];
    }

    async function runQuiz() {
        if (!moduleEnabled('ai')) { console.log('⏭ AI 答题未启用，请自行完成当前测验'); return; }
        assertScope();
        if (quizRunning) return;
        quizRunning = true;
        try {
            if (!settings.apiKey) {
                console.error('❌ 未配置 DeepSeek API Key，请通过油猴菜单设置');
                return;
            }
            const questions = await waitForQuizQuestions();
            assertModule('ai');
            if (!questions.length) return;
            const confirmBeforeSubmit = settings.confirmBeforeSubmit;
            let answered = 0;
            for (const question of questions) {
                assertModule('ai');
                try {
                    validateQuestion(question);
                    const letters = await askDeepSeek(question);
                    assertModule('ai');
                    await selectAnswers(question, letters);
                    answered++;
                    console.log(`✅ 第${question.index + 1}题 → ${letters.join(', ')}`);
                } catch (error) {
                    console.error(`❌ 第${question.index + 1}题失败: ${error.message}`);
                }
                await wait(1200);
            }
            assertModule('ai');
            const submitButton = document.getElementById('quizSubmit');
            if (submitButton) {
                submitButton.scrollIntoView({ behavior: 'smooth', block: 'center' });
                submitButton.style.outline = '3px solid red';
            }
            if (answered !== questions.length) {
                alert(`AI 成功作答 ${answered}/${questions.length} 道题，有 ${questions.length - answered} 道题失败。未自动提交，请检查答案后手动作答或使用菜单重试。`);
                return;
            }
            if (confirmBeforeSubmit) {
                alert(`AI 已完成 ${answered} 道题的作答。请检查答案后自行点击「提交」。提交次数和规则以课程页面为准。`);
                return;
            }
            if (!submitButton || submitButton.disabled) throw new Error('提交按钮不可用，未自动提交');
            submitButton.click();
            await wait(800);
            assertModule('ai');
            const confirmation = document.querySelector('.btn.btn-default.gxb-sure');
            if (confirmation && !confirmation.disabled) confirmation.click();
            console.log('🚀 已点击测验提交，请在页面确认提交结果');
        } finally { quizRunning = false; }
    }

    // ========== 进度 ==========
    function extractAllChapters(source) {
        const result = [], seen = new Set();
        const walk = (value, inheritedUnitId) => {
            if (!value || typeof value !== 'object' || seen.has(value)) return;
            seen.add(value);
            if (Array.isArray(value)) { value.forEach(item => walk(item, inheritedUnitId)); return; }
            const unitId = value.unitId ?? inheritedUnitId;
            if (value.contentType && value.chapterId != null) result.push({ ...value, unitId });
            walk(value.itemList, unitId);
            walk(value.chapterList, unitId);
        };
        walk(source);
        const ids = new Set();
        return result.filter(chapter => {
            const id = `${chapter.contentType}:${chapter.chapterId}`;
            if (ids.has(id)) return false;
            ids.add(id);
            return true;
        });
    }

    function ajaxRequest(options) {
        assertModule('progress');
        const jquery = unsafeWindow.$ || window.$;
        if (typeof jquery?.ajax === 'function') {
            return cancellableRequest((resolve, reject) => jquery.ajax({
                ...options, timeout: REQUEST_TIMEOUT,
                success: result => {
                    try { assertModule('progress'); resolve(result); } catch (error) { reject(error); }
                },
                error: (xhr, status) => reject(new Error(`课程请求失败 (${xhr?.status || status || '网络错误'})`)),
            }));
        }
        const init = { method: options.type || 'GET', credentials: 'include' };
        if (options.data) {
            init.headers = { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' };
            init.body = new URLSearchParams(options.data).toString();
        }
        return fetchRequest(options.url, init).then(response => response.text());
    }

    async function fetchRequest(url, init = {}) {
        assertScope();
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);
        try {
            return await cancellableRequest((resolve, reject) => {
                (async () => {
                    const response = await fetch(url, { ...init, signal: controller.signal });
                    assertScope();
                    if (!response.ok) throw new Error(`课程请求 HTTP ${response.status}`);
                    // Read the response body before releasing the timeout.
                    const text = await response.text();
                    assertScope();
                    return { text: async () => text, json: async () => JSON.parse(text) };
                })().then(resolve, reject);
                return controller;
            });
        } finally { clearTimeout(timeout); }
    }

    const progressTasks = () => extractAllChapters(dataSource())
        .filter(chapter => ['Video', 'Page', 'UEditor', 'Html', 'Courseware'].includes(chapter.contentType));
    const progressComplete = () => {
        const ids = new Set(readIds(PROCESSED_CHAPTERS_KEY));
        return progressTasks().every(chapter => ids.has(`${chapter.contentType}:${chapter.chapterId}`));
    };
    const discussionComplete = () => {
        const ids = new Set(readIds(PROCESSED_TOPICS_KEY));
        return extractAllChapters(dataSource()).filter(chapter => chapter.contentType === 'Topic')
            .every(chapter => ids.has(String(chapter.chapterId)));
    };
    function syncPhaseState() {
        assertScope();
        setState(!progressComplete() ? 'progress' : !discussionComplete() ? 'discuss' : 'completed');
    }
    async function runCoursePhases() {
        assertScope();
        // A completed scoped record from previous versions represents both phases.
        if (state() === 'completed') return true;
        if (moduleEnabled('progress') && !progressComplete() && !await runProgress()) return false;
        if (moduleEnabled('discussion') && !discussionComplete() && !await runDiscuss()) return false;
        // Disabled modules never acquire processed IDs or claim completion.
        syncPhaseState();
        return true;
    }

    async function runProgress() {
        if (!moduleEnabled('progress')) return true;
        assertScope();
        const id = classId();
        const chapters = extractAllChapters(dataSource());
        if (!id || !chapters.length) throw new Error('未找到课程章节，请等待目录加载后重试');
        const tasks = progressTasks();
        const processed = new Set(readIds(PROCESSED_CHAPTERS_KEY));
        const pending = tasks.filter(chapter => !processed.has(`${chapter.contentType}:${chapter.chapterId}`));
        console.log(`📚 进度阶段：${pending.length} 个待处理章节`);
        let cursor = 0, failed = 0;
        const worker = async () => {
            while (cursor < pending.length) {
                assertModule('progress');
                const chapter = pending[cursor++];
                try {
                    const result = await ajaxRequest({
                        url: `${location.origin}/class/${encodeURIComponent(id)}/chapter/${encodeURIComponent(chapter.chapterId)}/api`,
                        type: 'GET', dataType: 'text',
                    });
                    if (chapter.contentType === 'Video') {
                        const data = typeof result === 'string' ? JSON.parse(result) : result;
                        const seconds = Number(data?.chapter?.video?.seconds);
                        if (!Number.isFinite(seconds) || seconds <= 0) throw new Error('视频时长无效');
                        await ajaxRequest({
                            url: `${location.origin}/log/video/${encodeURIComponent(chapter.chapterId)}/${encodeURIComponent(id)}/api`,
                            type: 'POST', dataType: 'text',
                            data: { data: JSON.stringify([{ state: 'listening', level: 2, ch: seconds, mh: 0 }]) },
                        });
                    }
                    assertModule('progress');
                    markProcessed(PROCESSED_CHAPTERS_KEY, `${chapter.contentType}:${chapter.chapterId}`);
                    console.log(`✅ 章节 ${chapter.chapterId} 请求成功`);
                } catch (error) {
                    failed++;
                    console.error(`❌ 章节 ${chapter.chapterId}: ${error.message}`);
                }
            }
        };
        // Keep the run guard until every cancelled worker has released its loop.
        const outcomes = await Promise.allSettled(Array.from({ length: Math.min(3, pending.length) }, worker));
        const stopped = outcomes.find(result => result.status === 'rejected');
        if (stopped) throw stopped.reason;
        assertScope();
        if (failed) { setState('progress'); console.warn(`⚠️ ${failed} 个章节失败，使用菜单重试`); return false; }
        syncPhaseState();
        return true;
    }

    // ========== 讨论 ==========
    const DiscussApi = {
        buildTopicMap() {
            return Object.fromEntries(extractAllChapters(dataSource())
                .filter(chapter => chapter.contentType === 'Topic' && chapter.topic?.topicId != null)
                .map(chapter => [String(chapter.chapterId), chapter.topic.topicId]));
        },
        async fetchReplies(id, topicId) {
            assertModule('discussion');
            const response = await fetchRequest(`/class/${encodeURIComponent(id)}/topic/${encodeURIComponent(topicId)}/detail/api?${Date.now()}`, { credentials: 'include' });
            const data = await response.json();
            if (!Array.isArray(data.replyList?.dataList)) throw new Error('讨论回复数据无效');
            return data.replyList.dataList;
        },
        async submitReply(topicId, message) {
            assertModule('discussion');
            const body = new URLSearchParams({ topicId, message });
            await fetchRequest(`/topic/${encodeURIComponent(topicId)}/submit/api?${Date.now()}`, {
                method: 'POST', credentials: 'include',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
                body: body.toString(),
            });
        },
    };

    async function runDiscuss() {
        if (!moduleEnabled('discussion')) return true;
        assertScope();
        if (discussRunning) return false;
        discussRunning = true;
        try {
            const id = classId();
            const chapters = extractAllChapters(dataSource());
            if (!id || !chapters.length) throw new Error('课程目录尚未加载');
            const topicMap = DiscussApi.buildTopicMap();
            const topicChapters = chapters.filter(chapter => chapter.contentType === 'Topic');
            if (topicChapters.length !== Object.keys(topicMap).length) throw new Error('专题 ID 不完整，请等待目录加载后重试');
            if (!topicChapters.length) { syncPhaseState(); return true; }
            const myId = userId();
            if (!myId) throw new Error('未读取到当前用户，无法验证讨论回复');
            const processed = new Set(readIds(PROCESSED_TOPICS_KEY));
            let failed = 0, posted = 0, skipped = 0;
            for (const chapter of topicChapters) {
                assertModule('discussion');
                const cid = String(chapter.chapterId), tid = topicMap[cid];
                if (processed.has(cid)) continue;
                try {
                    assertScope();
                    const replies = await DiscussApi.fetchReplies(id, tid);
                    assertModule('discussion');
                    if (replies.some(reply => String(reply.userId) === myId)) {
                        markProcessed(PROCESSED_TOPICS_KEY, cid);
                        continue;
                    }
                    const candidates = replies.filter(reply => typeof reply.message === 'string' && stripTags(reply.message));
                    if (!candidates.length) {
                        // Keep empty topics retryable: there is no reply to copy yet.
                        skipped++;
                        console.warn(`⚠️ 专题 ${cid} 暂无可用评论，等待手动处理后重试`);
                        continue;
                    }
                    const longest = candidates.reduce((a, b) => stripTags(a.message).length >= stripTags(b.message).length ? a : b).message;
                    await wait(5000);
                    assertModule('discussion');
                    await DiscussApi.submitReply(tid, longest);
                    const after = await DiscussApi.fetchReplies(id, tid);
                    assertModule('discussion');
                    if (!after.some(reply => String(reply.userId) === myId)) throw new Error('提交未确认');
                    markProcessed(PROCESSED_TOPICS_KEY, cid);
                    posted++;
                } catch (error) {
                    failed++;
                    console.error(`❌ 专题 ${cid}: ${error.message}`);
                }
            }
            assertScope();
            const complete = failed === 0 && skipped === 0;
            syncPhaseState();
            console.log(`💬 本轮讨论：提交 ${posted} | 无可用评论 ${skipped} | 失败 ${failed}`);
            return complete;
        } finally { discussRunning = false; }
    }

    const standaloneQuizId = () => location.pathname.match(/\/class\/[^/]+\/quiz\/([^/]+)/)?.[1] || null;
    function courseReturnUrl(value) {
        try {
            const url = new URL(value);
            if (url.origin !== location.origin || url.pathname.match(/\/class\/([^/]+)/)?.[1] !== String(classId())) return null;
            if (!/\/unit\/[^/]+\/chapter\/[^/]+/.test(url.pathname)) return null;
            return url.href;
        } catch (_) { return null; }
    }
    function rememberQuizReturn() {
        const quizId = standaloneQuizId();
        const url = courseReturnUrl(document.referrer);
        if (quizId && url) GM_setValue(scopedKey(QUIZ_RETURN_KEY), JSON.stringify({ quizId, url }));
    }
    function verifiedStandaloneSubmission() {
        const route = location.pathname.match(/\/class\/[^/]+\/quiz\/([^/]+)\/submission\/([^/]+)\/?$/);
        if (!route || String(unsafeWindow.quizInfo?.quizId) !== route[1]) return false;
        const submission = unsafeWindow.quizSubmission || unsafeWindow.submission;
        const id = submission?.quizSubmissionId || submission?.submissionId;
        return id != null && String(id) === route[2]
            && (submission.quizId == null || String(submission.quizId) === route[1]);
    }
    function returnAfterStandaloneQuiz() {
        const quizId = standaloneQuizId();
        if (!quizId || !verifiedStandaloneSubmission()) return false;
        markProcessed(PROCESSED_QUIZ_IDS_KEY, quizId);
        let saved;
        try { saved = JSON.parse(GM_getValue(scopedKey(QUIZ_RETURN_KEY), '{}')); } catch (_) { saved = {}; }
        const url = String(saved.quizId) === quizId && courseReturnUrl(saved.url);
        if (!url) { console.warn('⚠️ 已记录测验提交，未找到原课程入口，请使用页面「返回」'); return true; }
        beginNavigation();
        console.log('➡️ 测验提交已确认，返回课程继续下一任务');
        location.assign(url);
        return true;
    }

    // ========== 任务导航 ==========
    const currentChapterId = () => {
        const id = location.hash.match(/(?:^#|[?&])chapterId=([^&]+)/)?.[1]
            || unsafeWindow.chapterinfo?.chapterId || unsafeWindow.chapterInfo?.chapterId
            || location.pathname.match(/\/chapter\/([^/]+)/)?.[1]
            || document.querySelector('a[chapter_id].active, .active a[chapter_id], a[chapter_id][aria-current="page"]')?.getAttribute('chapter_id');
        return id == null ? null : String(id);
    };
    const visible = element => {
        if (!element || !element.isConnected) return false;
        for (let node = element; node instanceof Element; node = node.parentElement) {
            const style = getComputedStyle(node);
            if (node.hidden || node.getAttribute('aria-hidden') === 'true'
                || style.display === 'none' || style.visibility === 'hidden') return false;
        }
        return true;
    };
    const enabled = element => visible(element) && !element.disabled && element.getAttribute('aria-disabled') !== 'true'
        && !element.classList.contains('disabled') && !element.classList.contains('disable');
    const safeTaskUrl = href => {
        if (!href || /^javascript:/i.test(href.trim()) || href.trim() === '#') return null;
        try {
            const url = new URL(href, location.href);
            if (url.origin !== location.origin || url.href === location.href) return null;
            const targetClass = url.pathname.match(/\/class\/([^/]+)/)?.[1];
            return targetClass && targetClass === String(classId()) ? url.href : null;
        } catch (_) { return null; }
    };
    let navigating = false;
    const quizSignature = () => JSON.stringify(extractQuestions().map(question => [question.title, question.answerIds, question.options]));
    function captureTransition() {
        staleResultNodes = new Set(document.querySelectorAll('.quiz-result, .quiz-score, .quiz-finish, [data-quiz-submitted="true"]'));
        staleQuizControls = new Map(Array.from(document.querySelectorAll('.chapter-content .quiz-join[quiz_id], .chapter-content .quiz-view[quiz_id]'),
            element => [element, `${element.getAttribute('quiz_id')}:${element.getAttribute('quiz_submission_id')}`]));
        routeTransition = {
            form: document.getElementById('quizSubmit'),
            joins: new Map(Array.from(document.querySelectorAll('.quiz-join[chapter_id], .quiz-join.chapter_id'), element => [element, element.getAttribute('chapter_id')])),
            signature: quizSignature(),
            results: new Set(document.querySelectorAll('.quiz-result, .quiz-score, .quiz-finish, [data-quiz-submitted="true"]')),
        };
    }
    function beginNavigation() {
        captureTransition();
        navigating = true;
        clearTimeout(navigationTimeout);
        navigationTimeout = setTimeout(() => {
            navigating = false;
            console.warn('⚠️ 页面未切换，请使用菜单重试');
        }, 15000);
    }
    function quizEntryButton() {
        return Array.from(document.querySelectorAll('.quiz-join[chapter_id], .quiz-join.chapter_id')).find(element => {
            const id = element.getAttribute('chapter_id') || element.getAttribute('chapterid');
            return enabled(element) && !element.closest('aside, nav, .sidebar')
                && (!id || !currentChapterId() || id === currentChapterId());
        });
    }
    function quizUIReady(allowEntry = false) {
        if (!routeTransition || !onQuizTask()) return true;
        const entry = quizEntryButton();
        if (allowEntry && entry && (!routeTransition.joins.has(entry)
            || routeTransition.joins.get(entry) !== entry.getAttribute('chapter_id'))) return true;
        const form = document.getElementById('quizSubmit');
        const explicit = form?.getAttribute('chapter_id') || form?.getAttribute('data-chapter-id');
        const resultChanged = Array.from(document.querySelectorAll('.quiz-result, .quiz-score, .quiz-finish, [data-quiz-submitted="true"]'))
            .some(element => isCompletedResult(element) && (!routeTransition.results.has(element)
                || (element.getAttribute('chapter_id') || element.getAttribute('data-chapter-id')) === currentChapterId()));
        if (resultChanged) return true;
        const questions = extractQuestions();
        const matchesDOM = questions.length > 0 && questions.every(question => question.answerIds.length > 0
            && question.answerIds.every(id => iconsFor(id).some(visible)));
        return matchesDOM && ((form && (form !== routeTransition.form || explicit === currentChapterId()))
            || quizSignature() !== routeTransition.signature);
    }
    function navigateToNextTask() {
        if (navigating) return false;
        assertScope();
        const completedQuizzes = new Set(readIds(PROCESSED_QUIZZES_KEY));
        const completedQuizIds = new Set(readIds(PROCESSED_QUIZ_IDS_KEY));
        const current = currentChapterId();
        const links = Array.from(document.querySelectorAll('a[content_type][chapter_id]'));
        const quizChapters = extractAllChapters(dataSource()).filter(chapter => chapter.contentType === 'Quiz');
        const candidates = !moduleEnabled('ai') ? [] : quizChapters.length ? quizChapters : links.filter(link => link.getAttribute('content_type') === 'Quiz')
            .map(link => ({ chapterId: link.getAttribute('chapter_id'), contentType: 'Quiz' }));
        for (const chapter of candidates) {
            const id = String(chapter.chapterId);
            const quizId = chapter.quiz?.quizId ?? chapter.quizId;
            if (quizId != null && completedQuizIds.has(String(quizId))) { markProcessed(PROCESSED_QUIZZES_KEY, id); continue; }
            if (completedQuizzes.has(id) || chapter.completed === true || chapter.finished === true) continue;
            if (id === current) { console.warn('⚠️ 当前测验尚未确认完成，请完成提交后继续'); return false; }
            const link = links.find(element => element.getAttribute('chapter_id') === id && element.getAttribute('content_type') === 'Quiz');
            if (link && (link.classList.contains('completed') || link.classList.contains('finished'))) continue;
            let url = safeTaskUrl(link?.getAttribute('href') || chapter.href || chapter.url);
            // The upstream course view routes within the page using chapterId.
            // Reuse that observed route instead of constructing a new path.
            if (!url && /(?:^#|[?&])chapterId=[^&]+/.test(location.hash)) {
                const target = new URL(location.href);
                target.hash = target.hash.replace(/((?:^#|[?&])chapterId=)[^&]+/, `$1${encodeURIComponent(id)}`);
                url = safeTaskUrl(target.href);
            }
            if (!url && /\/unit\/[^/]+\/chapter\/[^/]+/.test(location.pathname) && chapter.unitId != null) {
                const target = new URL(location.href);
                target.pathname = target.pathname.replace(/\/unit\/[^/]+\/chapter\/[^/]+/, `/unit/${encodeURIComponent(chapter.unitId)}/chapter/${encodeURIComponent(id)}`);
                url = safeTaskUrl(target.href);
            }
            if (!url || (link && (link.getAttribute('aria-disabled') === 'true' || link.classList.contains('disabled') || link.classList.contains('disable')))) {
                console.warn(`⚠️ 下一项测验 ${id} 没有可用链接，请展开课程目录后使用菜单重试`);
                return false;
            }
            const targetUrl = new URL(url);
            const routeId = targetUrl.hash.match(/(?:^#|[?&])chapterId=([^&]+)/)?.[1] || targetUrl.pathname.match(/\/chapter\/([^/]+)/)?.[1];
            if (routeId && decodeURIComponent(routeId) !== id) {
                console.warn(`⚠️ 测验 ${id} 的链接与章节不匹配`);
                return false;
            }
            beginNavigation();
            console.log(`➡️ 打开下一项测验 ${id}`);
            location.assign(url);
            return true;
        }
        // Written assignments require the user; open their actual catalog entry.
        const assignments = extractAllChapters(dataSource()).filter(chapter => chapter.contentType === 'Assignment');
        if (assignments.some(chapter => String(chapter.chapterId) === current)) {
            console.log('📝 视频、讨论和测验阶段已处理；当前书面作业请按课程要求自行完成');
            return false;
        }
        for (const chapter of assignments) {
            if (chapter.completed === true || chapter.finished === true) continue;
            const link = links.find(element => element.getAttribute('chapter_id') === String(chapter.chapterId)
                && element.getAttribute('content_type') === 'Assignment');
            if (!link || link.getAttribute('isunlock') === 'false' || link.getAttribute('aria-disabled') === 'true'
                || link.classList.contains('disabled') || link.classList.contains('disable')
                || link.previousElementSibling?.classList.contains('gxb-icon-lock')) continue;
            const href = link.getAttribute('href');
            const url = safeTaskUrl(href);
            if (href && !url && !/^(?:javascript:|#)/i.test(href.trim())) continue;
            const assignmentUrl = url && new URL(url);
            const targetChapter = assignmentUrl && (assignmentUrl.hash.match(/(?:^#|[?&])chapterId=([^&]+)/)?.[1]
                || assignmentUrl.pathname.match(/\/chapter\/([^/]+)/)?.[1]);
            if (targetChapter && decodeURIComponent(targetChapter) !== String(chapter.chapterId)) continue;
            beginNavigation();
            console.log(`📝 打开书面作业 ${chapter.chapterId}，请按课程要求自行完成`);
            if (url) location.assign(url);
            else link.click();
            return true;
        }
        if (assignments.length) {
            console.log('📝 课程含书面作业；没有可用的作业入口，请检查目录及解锁条件');
            return false;
        }
        // All known quizzes are already done; a next button could reopen them.
        if (candidates.length) return false;
        if (!moduleEnabled('ai')) return false;
        // The site's next button retains its routing for versions without chapter links.
        const next = Array.from(document.querySelectorAll('.gxb-next-blue, a[rel="next"]')).find(enabled);
        if (next) {
            const href = next.getAttribute('href');
            if (href && !safeTaskUrl(href) && !/^(?:javascript:|#)/i.test(href.trim())) return false;
            const targetId = safeTaskUrl(href) && new URL(safeTaskUrl(href)).pathname.match(/\/chapter\/([^/]+)/)?.[1];
            if (targetId && (completedQuizzes.has(targetId) || readIds(PROCESSED_CHAPTERS_KEY).some(id => id.endsWith(`:${targetId}`)) || readIds(PROCESSED_TOPICS_KEY).includes(targetId))) return false;
            beginNavigation();
            if (safeTaskUrl(href)) location.assign(safeTaskUrl(href));
            else next.click();
            console.log('➡️ 已打开下一项任务');
            return true;
        }
        console.log('✅ 当前阶段已完成；没有找到可用的下一任务链接');
        return false;
    }

    function isCompletedResult(element) {
        if (!visible(element) || element.closest('aside, nav, .sidebar')) return false;
        const chapter = element.getAttribute('chapter_id') || element.getAttribute('data-chapter-id');
        if (chapter && currentChapterId() && chapter !== currentChapterId()) return false;
        if (staleResultNodes.has(element) && chapter !== currentChapterId()) return false;
        return element.getAttribute('data-quiz-submitted') === 'true'
            || /测验已完成|测试已完成|已提交测验|测验提交成功|测试提交成功|已完成测验/.test(element.textContent || '');
    }
    function quizCompletionVisible() {
        // A score label or a generic "submit succeeded" toast is insufficient.
        const current = extractAllChapters(dataSource()).find(chapter => String(chapter.chapterId) === currentChapterId());
        if (current && current.contentType !== 'Quiz') return false;
        return Array.from(document.querySelectorAll('.quiz-result, .quiz-score, .quiz-finish, [data-quiz-submitted="true"]'))
            .some(isCompletedResult);
    }
    let quizObserver = null;
    let quizObserverTimeout = null;
    function watchQuizCompletion() {
        if (!executionAllowed()) return;
        if (quizObserver) return;
        const scope = scopedKey(STATE_KEY), chapter = currentChapterId(), epoch = routeEpoch;
        const stop = () => {
            quizObserver?.disconnect(); quizObserver = null;
            clearTimeout(quizObserverTimeout); quizObserverTimeout = null;
        };
        const check = () => {
            if (!executionAllowed() || scope !== scopedKey(STATE_KEY) || currentChapterId() !== chapter || epoch !== routeEpoch) { stop(); return; }
            if (!quizCompletionVisible()) return;
            if (chapter) markProcessed(PROCESSED_QUIZZES_KEY, chapter);
            stop();
            pendingQuizContinuation = { scope, epoch, chapter };
            if (!mainRunning) void continueAfterQuiz();
        };
        quizObserver = new MutationObserver(check);
        quizObserver.observe(document.body, { childList: true, subtree: true, attributes: true, characterData: true });
        quizObserverTimeout = setTimeout(stop, 30 * 60 * 1000);
        document.getElementById('quizSubmit')?.addEventListener('click', () => {
            if (!quizObserver) watchQuizCompletion();
        }, { once: true });
        check();
    }

    async function continueAfterQuiz() {
        if (!executionAllowed() || !pendingQuizContinuation || mainRunning || navigating) return;
        const { scope, epoch, chapter } = pendingQuizContinuation;
        pendingQuizContinuation = null;
        if (scope !== scopedKey(STATE_KEY) || epoch !== routeEpoch || chapter !== currentChapterId()) return;
        mainRunning = true;
        refreshControls();
        scopeAtStart = scope;
        epochAtStart = epoch;
        chapterAtStart = chapter;
        try {
            // A directly opened quiz can finish before the course phases ran.
            const ready = !isChapterPage() || await runCoursePhases();
            assertScope();
            if (ready) navigateToNextTask();
        } catch (error) { console.error(`❌ 下一任务处理失败: ${error.message}`); }
        finally {
            mainRunning = false; scopeAtStart = null; epochAtStart = null; chapterAtStart = null;
            refreshControls();
            if (routeRestartRequested) { routeRestartRequested = false; void main(); }
        }
    }
    const onQuizTask = () => {
        const current = currentChapterId();
        const chapter = extractAllChapters(dataSource()).find(item => String(item.chapterId) === current);
        return chapter ? chapter.contentType === 'Quiz' : /\/quiz(?:\/|$)/.test(location.pathname);
    };
    function currentQuizProcessed() {
        const current = currentChapterId();
        if (readIds(PROCESSED_QUIZZES_KEY).includes(current)) return true;
        const chapter = extractAllChapters(dataSource()).find(item => String(item.chapterId) === current && item.contentType === 'Quiz');
        const knownQuizId = chapter?.quiz?.quizId ?? chapter?.quizId;
        const controls = Array.from(document.querySelectorAll('.chapter-content .quiz-join[quiz_id], .chapter-content .quiz-view[quiz_id]'))
            .filter(element => {
                const id = element.getAttribute('chapterid') || element.getAttribute('chapter_id');
                const stale = staleQuizControls.get(element) === `${element.getAttribute('quiz_id')}:${element.getAttribute('quiz_submission_id')}`;
                if (stale && id !== current && (knownQuizId == null || String(knownQuizId) !== element.getAttribute('quiz_id'))) return false;
                return visible(element) && (!id || id === current)
                    && element.getAttribute('context_id') === String(classId());
            });
        const control = controls.find(element => element.classList.contains('quiz-view')
            && element.getAttribute('quiz_submission_id')?.trim()) || controls[0];
        const quizId = knownQuizId ?? control?.getAttribute('quiz_id');
        // The chapter's server-rendered history link identifies a real submission.
        // Previously submitted quizzes may predate this script's local records.
        if (current && onQuizTask() && control?.classList.contains('quiz-view')
            && control.getAttribute('quiz_submission_id')?.trim()
            && quizId != null && String(quizId) === control.getAttribute('quiz_id')) {
            markProcessed(PROCESSED_QUIZ_IDS_KEY, quizId);
            markProcessed(PROCESSED_QUIZZES_KEY, current);
            return true;
        }
        if (quizId != null && readIds(PROCESSED_QUIZ_IDS_KEY).includes(String(quizId))) {
            markProcessed(PROCESSED_QUIZZES_KEY, current);
            return true;
        }
        return false;
    }
    function courseNavigationReady() {
        const assignments = extractAllChapters(dataSource()).filter(chapter => chapter.contentType === 'Assignment');
        if (!assignments.length || assignments.some(chapter => String(chapter.chapterId) === currentChapterId())) return true;
        return assignments.some(chapter => Array.from(document.querySelectorAll('a[content_type="Assignment"][chapter_id]'))
            .some(link => link.getAttribute('chapter_id') === String(chapter.chapterId)));
    }

    // ========== 主控 ==========
    async function main() {
        if (!executionRequested() || mainRunning || navigating) return;
        mainRunning = true;
        refreshControls();
        const requestedEpoch = routeEpoch;
        try {
            // Globals and the quiz form often arrive after document-idle.
            for (let attempt = 0; attempt < 30; attempt++) {
                if (!executionRequested() || requestedEpoch !== routeEpoch) return;
                const awaitingResult = /\/quiz\/[^/]+\/submission\/[^/]+\/?$/.test(location.pathname) && !verifiedStandaloneSubmission();
                const awaitingUser = !userId() && (executionSession?.user != null || unsafeWindow.gxb?.user);
                const awaitingCourse = routeClassId() && unsafeWindow.classinfo?.classId != null
                    && String(unsafeWindow.classinfo.classId) !== routeClassId();
                if (awaitingResult || awaitingUser || awaitingCourse) {
                    if (attempt === 29) { console.warn('⚠️ 课程、提交结果或账号信息未就绪，未重新答题，请使用菜单重试'); return; }
                    await wait(500);
                    continue;
                }
                assertScope();
                if (verifiedStandaloneSubmission() || currentQuizProcessed()
                    || (quizUIReady() && (isQuizPage() || quizCompletionVisible()))
                    || (isChapterPage() && !onQuizTask() && courseNavigationReady()) || (quizEntryButton() && quizUIReady(true))) break;
                if (attempt === 29) { console.warn('⚠️ 等待课程数据超时，使用菜单重试'); return; }
                await wait(500);
            }
            scopeAtStart = scopedKey(STATE_KEY);
            epochAtStart = routeEpoch;
            chapterAtStart = currentChapterId();
            refreshControls();
            rememberQuizReturn();
            if (returnAfterStandaloneQuiz()) return;
            if (currentQuizProcessed()) {
                pendingQuizContinuation = { scope: scopeAtStart, epoch: epochAtStart, chapter: chapterAtStart };
                return;
            }
            if (!quizUIReady(true)) { console.warn('⚠️ 新测验尚未加载，使用菜单重试'); return; }
            if (quizUIReady() && (isQuizPage() || quizCompletionVisible())) {
                routeTransition = null;
                watchQuizCompletion();
                if (!navigating && !quizCompletionVisible()) await runQuiz();
                return;
            }
            const quizJoin = quizEntryButton();
            if (enabled(quizJoin)) {
                if (!moduleEnabled('ai')) { console.log('⏭ AI 答题未启用，请自行进入和完成测验'); return; }
                assertScope();
                quizJoin.click();
                console.log('➡️ 已进入测验，等待题目加载');
                for (let attempt = 0; attempt < 30 && !(quizUIReady() && (isQuizPage() || quizCompletionVisible())); attempt++) {
                    assertScope();
                    await wait(500);
                }
                assertScope();
                if (quizUIReady() && (isQuizPage() || quizCompletionVisible())) {
                    routeTransition = null;
                    watchQuizCompletion();
                    if (!quizCompletionVisible()) await runQuiz();
                } else console.warn('⚠️ 测验题目加载超时，使用菜单重试');
                return;
            }
            if (onQuizTask()) { console.warn('⚠️ 当前测验尚未加载 / 未确认完成，使用菜单重试'); return; }
            if (isChapterPage()) {
                const ready = await runCoursePhases();
                if (ready) navigateToNextTask();
            }
        } catch (error) {
            console.error(`❌ 任务停止: ${error.message}`);
        } finally {
            mainRunning = false; scopeAtStart = null; epochAtStart = null; chapterAtStart = null;
            refreshControls();
            if (routeRestartRequested) { routeRestartRequested = false; void main(); }
            else if (pendingQuizContinuation) void continueAfterQuiz();
        }
    }
    lastRouteChapter = currentChapterId();
    // History API navigation does not reinject userscripts or emit hashchange.
    // A fresh document is safer than reusing another course's global catalog.
    let observedCourseRoute = routeClassId();
    let courseReloading = false;
    const checkCourseRoute = () => {
        const next = routeClassId();
        if (executionSession && (!sameModules(executionSession)
            || (userId() !== null && executionSession.user !== userId()))) pauseExecution();
        if (courseReloading || next === observedCourseRoute) return;
        observedCourseRoute = next;
        routeEpoch++;
        if (!executionSession) return;
        pauseExecution();
        if (!next) return;
        courseReloading = true;
        console.log('🔄 课程已切换，已暂停；刷新后请在新课程重新开始');
        location.reload();
    };
    window.addEventListener('popstate', checkCourseRoute);
    setInterval(checkCourseRoute, 500);
    window.addEventListener('hashchange', () => {
        const current = currentChapterId();
        if (current === lastRouteChapter) return;
        routeEpoch++;
        if (!routeTransition) captureTransition();
        lastRouteChapter = current;
        navigating = false;
        clearTimeout(navigationTimeout);
        quizObserver?.disconnect(); quizObserver = null;
        clearTimeout(quizObserverTimeout);
        pendingQuizContinuation = null;
        // The outgoing run must release its guard before the new route starts.
        if (executionAllowed()) {
            if (mainRunning) routeRestartRequested = true;
            else void main();
        }
    });
    if (executionSession && (executionSession.host !== location.host
        || (classId() && executionSession.course !== String(classId()))
        || (userId() !== null && executionSession.user !== userId())
        || !sameModules(executionSession))) pauseExecution();
    mountControls();
    if (executionRequested()) void main();
})();
