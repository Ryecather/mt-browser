var chrome = chrome || browser

let notificationShown = false;
function showErrorNotification(type, message) {
    if(!notificationShown){
        notificationShown = true;
        chrome.notifications.create({
            type: "basic",
            iconUrl: "icons/icon-48.png",
            title: type,
            message: message
        }, function () {
            setTimeout(function () {
                notificationShown = false;
            }, 2000);
        });
    }
}

var menuItem = {
    "id": "translate",
    "title": "翻译",
    "contexts": ["selection"]
}
chrome.contextMenus.create(menuItem);

chrome.runtime.onInstalled.addListener(async function () {
    let resp = await APIQuery('GET', 'languages', null)
    console.log(resp)
    console.log(typeof (resp))
    for (lang of resp) {
        var menuItem = {
            "id": lang.code,
            "title": lang.cname,
            "contexts": ["selection"],
            "parentId": "translate"
        }
        chrome.contextMenus.create(menuItem);
    }
})

chrome.contextMenus.onClicked.addListener(async function (clickData) {
    if (clickData.selectionText) {
        // clickData.menuItemId : 被点击的菜单选项卡id
        // clickData.selectionText: 选中的内容
        var transword = clickData.selectionText
        var source_lang = 'auto'
        var target_lang = clickData.menuItemId
        chrome.storage.local.get('settings', async function (data) {
            if (!data.settings) {
                var defaultsettings = {
                    'api-endpoint': 'http://127.0.0.1:5555/',
                    'api-key': ""
                }
                data.settings = defaultsettings;
            }
            var ak = data.settings['api-key'];
            if(typeof ak === 'undefined'){
                ak = "";
            }
            var endpoint = data.settings['api-endpoint'];
            if (endpoint.charAt(endpoint.length - 1) !== '/') {
                endpoint += '/';
            }
            console.log(ak);
            const res = await fetch(endpoint+"translate", {
                method: "POST",
                body: JSON.stringify({ q: transword, source: source_lang, target: target_lang, format: "text", api_key: ak }),
                headers: { "Content-Type": "application/json" }
            }).catch(function (err) {
                console.log(err)
                // chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
                //     chrome.tabs.sendMessage(tabs[0].id, { todo: "failed" ,message: err.message})
                // })
                showErrorNotification("connect failed", "Translation error: " + err);
            });
            console.log(res);
            trans_json = await res.json();
            if (trans_json.error) {
                showErrorNotification("translate error","Translation failed: " + trans_json.error);
            } else {
                console.log(trans_json.translatedText)
                chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
                    chrome.tabs.sendMessage(tabs[0].id, { todo: "translate", result: trans_json.translatedText })
                })
            }
        })
    }
})

browser.runtime.onMessage.addListener(

    function (request, sender, sendResponse) {
        console.log('request service')
        if (request.action === "translate") {
            if (request.sl === "ar") {
                chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
                    chrome.tabs.sendMessage(tabs[0].id, { todo: "change" })
                })
            }
            let jsn = APIQuery('POST', 'translate',
                JSON.stringify({
                    q: request.text,
                    source: request.sl,
                    target: request.tl,
                    format: request.type,
                    api_key: request.ak
                })).then(function (jsn) {
                    // sendResponse({ type: request.type, text: jsn.translatedText });
                    if(jsn.error){
                        showErrorNotification("translate fail", "Translation failed: " + jsn.error);
                    }else{
                        sendResponse({ type: request.type, text: jsn.translatedText });
                    }
                })    
            return true;
        }
        if (request.action === "inject") {

            browser.tabs.query({ active: true }).then(function (tabId) {
                console.log(tabId)
                browser.scripting.executeScript(
                    {
                        target: { tabId: tabId[0].id },
                        func: doTranslate,
                        args: [request.sl, request.tl, request.api_key],
                    },
                );
                sendResponse(null)
            })

        }
        if (request.action === "detect-lang") {
            browser.i18n.detectLanguage(request.text).then(function (info) {
                sendResponse(info)
            });
        }
        return true
    }

);


function APIQuery(method, route, body) {

    return new Promise(function (resolve, reject) {
        getSettings(function (data) {
            fetch(data.settings['api-endpoint'] + route, {
                method: method,
                body: body,
                headers: { "Content-Type": "application/json" }
            }).then(function (res) {
                res.json().then(function (jsn) {
                    resolve(jsn)
                }).catch(function (err) {
                    reject(err)
                })
            }).catch(function (err) {
                reject(err)
                showErrorNotification("request failed", "Translation failed: " + err);
            });
        })
    })
}


function getSettings(cb) {
    chrome.storage.local.get('settings', function (data) {
        if (!data.settings) {
            let defaultsettings = {
                'api-endpoint': 'http://127.0.0.1:5555/',
                'api-key': ""
            }
            cb({ settings: defaultsettings })
            return
        }
        let settings = data.settings;
        if (!settings['api-endpoint'].endsWith('/')) {
            settings['api-endpoint'] += '/';
        }
        // cb(data)
        cb({ settings: settings });
    })
}


async function doTranslate(sl, tl, ak) {

    if (window.__ltActive) {
        return
    }
    window.__ltActive = true

    let __nodesToTranslate = ['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'span', 'div', 'li', 'b', 'i', 'a', 'label', 'figcaption', 'em'];
    let __translationCache = {};

    let resp = await translate(document.title, 'text', sl, tl)
    document.title = resp.text

    /* we only translate elements visible in the viewport for performance reasons
    rescan the dom for elements to translate if the viewport changes */
    let scrollTimer;
    let resizeTimer;
    
    document.addEventListener('scroll', () => {
        clearTimeout(scrollTimer);
        scrollTimer = setTimeout(translateDom, 200);
    });
    
    window.addEventListener('resize', () => {
        clearTimeout(resizeTimer);
        resizeTimer = setTimeout(translateDom, 200);
    });
    
    translateDom();

    async function translateDom() {
        nodes = findtranslatableElements();
        /* the api server understand "auto" and can guess the source language too
        but we send small fragments and so sometimes it lacks info.
        we have the info in the browser where we can look at more text and then
        just set the language so small fragments are properly translated too. */
        if (sl == 'auto') {
            sl = await detectLanguage(nodes);
        }
        translateNodes(nodes, sl, tl);
    }

    async function detectLanguage(nodes) {
        let langfreqmap = {};
        for (let node of nodes) {
            let resp = await chrome.runtime.sendMessage({ action: "detect-lang", text: node.innerText });
            console.log(resp)
            if (resp.languages.length >= 1) {
                let lang = resp.languages[0].language
                if (!langfreqmap[lang]) {
                    langfreqmap[lang] = 0
                }
                //weight each guess by length of text and certainty
                langfreqmap[lang] += (node.innerText.length * (resp.languages[0].percentage / 100))
            }
        }
        let detectedlang = '';
        let detectscore = 0;
        for (var key of Object.keys(langfreqmap)) {
            if (langfreqmap[key] > detectscore) {
                detectedlang = key
                detectscore = langfreqmap[key]
            }
        }
        if (detectedlang == '') {
            detectLanguage = 'auto'
        }

        return detectedlang
    }

    // the docs *say* runtime.sendMessage does promises,
    // but it doesnt?! so we just wrap it so we can await it.
    /*
    function sendMessage(message) {
        return new Promise(function (resolve, reject) {
            chrome.runtime.sendMessage(message, function (resp) {
                resolve(resp)
            })
        })
    }
    */

    async function translateBatch(texts, type, sl, tl) {
        let responses = await chrome.runtime.sendMessage({
            action: "translate",
            type: type,
            text: texts,
            sl: sl,
            tl: tl,
            ak: ak
        });
        console.log(responses)
        return responses;
    }
    async function translateNodes(allNodes, sl, tl) {
        let textRequests = [];
        let htmlRequests = [];
    
        for (let i = 0; i < allNodes.length; i++) {
            let node = allNodes[i];
    
            if (node.innerHTML == node.innerText) {
                if (node.innerText.length <= 100 && __translationCache[node.innerText]) {
                    node.innerText = __translationCache[node.innerText];
                    setNodeTranslated(node);
                    continue;
                }
    
                textRequests.push({
                    text: node.innerText,
                    node: node
                });
            } else {
                if (node.innerHTML.length <= 200 && __translationCache[node.innerHTML]) {
                    node.innerHTML = __translationCache[node.innerHTML];
                    setNodeTranslated(node);
                    continue;
                }
    
                htmlRequests.push({
                    text: node.innerHTML,
                    node: node
                });
            }
        }
    
        if (textRequests.length > 0) {
            let textResponses = await translateBatch(textRequests.map(req => req.text), 'text', sl, tl);
            let texttranslations = textResponses.text;
            for (let i = 0; i < texttranslations.length; i++) {
                let resp = texttranslations[i];
                let req = textRequests[i];
    
                if (req.text.length <= 100) {
                    __translationCache[req.text] = resp;
                }
    
                req.node.innerText = resp;
                setNodeTranslated(req.node);
            }
        }
    
        if (htmlRequests.length > 0) {
            let htmlResponses = await translateBatch(htmlRequests.map(req => req.text), 'html', sl, tl);
            let htmltranslations = htmlResponses.text;
            for (let i = 0; i < htmltranslations.length; i++) {
                let resp = htmltranslations[i];
                let req = htmlRequests[i];
    
                if (req.text.length <= 200) {
                    __translationCache[req.text] = resp;
                }
    
                req.node.innerHTML = resp;
                setNodeTranslated(req.node);
                if (req.node.childNodes) {
                    [...req.node.childNodes].forEach(n => {
                        let tagName = n.tagName ? n.tagName.toLowerCase() : ''
                        if (n && __nodesToTranslate.includes(tagName)) {
                            setNodeTranslated(n)
                        }
                    })
                }
            }
        }
    }
    //表示节点已翻译
    function setNodeTranslated(node) {
        node.dataset.__ltTranslated = 'true'
    }
    //判断节点是否已翻译
    function getNodeTranslated(node) {
        return node.dataset.__ltTranslated === 'true'
    }
    //将节点加入队列中
    function setNodeQueued(node) {
        node.dataset.__ltQueued = 'true'
    }
    //检测节点是否在队列中
    function getNodeQueued(node) {
        return node.dataset.__ltQueued === 'true'
    }

    function findtranslatableElements() {
        let allNodes = [];

        for (tagName of __nodesToTranslate) {
            let nodeList = document.getElementsByTagName(tagName);
            let nodes = Array.prototype.slice.call(nodeList);
            nodes = filterTranslatable(nodes)
            nodes = filterHidden(nodes)
            nodes = filterInViewport(nodes)
            nodes = filterTranslated(nodes)
            nodes = filterQueued(nodes)

            for (n of nodes) {
                setNodeQueued(n)
            }

            allNodes = allNodes.concat(nodes)
        }

        allNodes = filterChilds(allNodes)

        allNodes.sort(function (a, b) {
            let ab = a.getBoundingClientRect();
            let bb = b.getBoundingClientRect();

            return ab.top - bb.top
        });

        return allNodes
    }

    function filterQueued(nodes) {
        unqueuedNodes = [];

        for (let i = 0; i < nodes.length; i++) {
            let node = nodes[i]
            if (!getNodeQueued(node)) {
                unqueuedNodes.push(node)
            }
        }
        return unqueuedNodes
    }

    function filterTranslated(nodes) {
        translatedNodes = [];

        for (let i = 0; i < nodes.length; i++) {
            let node = nodes[i]
            if (!getNodeTranslated(node)) {
                translatedNodes.push(node)
            }
        }
        return translatedNodes
    }

    function filterInViewport(nodes) {
        viewportNodes = [];

        for (let i = 0; i < nodes.length; i++) {
            let node = nodes[i]
            if (isInViewport(node)) {
                viewportNodes.push(node)
            }
        }
        return viewportNodes
    }

    function isInViewport(node) {
        let bounding = node.getBoundingClientRect();
        return (
            bounding.top >= 0 &&
            bounding.left >= 0 &&
            /* multiply viewport height by 1.5 so when scrolling down, the just-in-time translation isn't as noticable.
            as we will have half a viewport already translated. this is kinda bad if there a large image you scroll past fast.
            but it's better than nothing, for now. */
            bounding.top <= (window.innerHeight || document.documentElement.clientHeight) * 1.5 &&
            bounding.left <= (window.innerWidth || document.documentElement.clientWidth)
        );
    }

    function filterTranslatable(nodes) {
        var translateableNodes = [];

        for (let i = 0; i < nodes.length; i++) {
            let node = nodes[i]
            if (hasTranslateableText(node)) {
                translateableNodes.push(node)
            }
        }
        return translateableNodes
    }

    function hasTranslateableText(node) {
        if (node.nodeType === Node.TEXT_NODE && node.nodeValue.trim() != "") {
            return true
        }
        node = node.firstChild
        while (node) {
            if (node.nodeType === Node.TEXT_NODE && node.nodeValue.trim() != "") {
                return true
            }
            node = node.nextSibling
        }
        return false
    }

    function filterHidden(nodes) {
        visibleNodes = [];
        function isHidden(el) {
            return (el.offsetParent === null)
        }

        for (let i = 0; i < nodes.length; i++) {
            let node = nodes[i]
            if (!isHidden(node)) {
                visibleNodes.push(node)
            }
        }
        return visibleNodes
    }

    function filterChilds(nodes) {
        topLevelNodes = [];

        for (let i = 0; i < nodes.length; i++) {
            let child = nodes[i]
            var node = child
            var found = false
            while (node.parentNode) {
                node = node.parentNode

                //we're a child of another node in the list
                if (includesNode(nodes, node)) {
                    found = true
                    break;
                }
            }
            if (!found) {
                topLevelNodes.push(child);
            }
        }
        return topLevelNodes
    }

    function includesNode(haystack, needle) {
        for (n of haystack) {
            if (needle.isSameNode(n)) {
                return true
            }
        }
        return false
    }

    async function translate(txt, type, sl, tl) {
        let resp = await browser.runtime.sendMessage({ action: "translate", type: type, text: txt, sl: sl, tl: tl, ak: ak })
        return resp
    }
}