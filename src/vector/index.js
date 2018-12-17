/*
Copyright 2015, 2016 OpenMarket Ltd
Copyright 2017 Vector Creations Ltd
Copyright 2018 New Vector Ltd

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

// Require common CSS here; this will make webpack process it into bundle.css.
// Our own CSS (which is themed) is imported via separate webpack entry points
// in webpack.config.js
require('gemini-scrollbar/gemini-scrollbar.css');
require('gfm.css/gfm.css');
require('highlight.js/styles/github.css');
require('draft-js/dist/Draft.css');

import React from 'react';
// add React and ReactPerf to the global namespace, to make them easier to
// access via the console
global.React = React;
if (process.env.NODE_ENV !== 'production') {
    global.Perf = require('react-addons-perf');
}

import RunModernizrTests from './modernizr'; // this side-effects a global
import ReactDOM from 'react-dom';
import sdk from 'matrix-react-sdk';
import PlatformPeg from 'matrix-react-sdk/lib/PlatformPeg';
sdk.loadSkin(require('../component-index'));
import VectorConferenceHandler from 'matrix-react-sdk/lib/VectorConferenceHandler';
import Promise from 'bluebird';
import request from 'browser-request';
import * as languageHandler from 'matrix-react-sdk/lib/languageHandler';
// Also import _t directly so we can call it just `_t` as this is what gen-i18n.js expects
import { _t } from 'matrix-react-sdk/lib/languageHandler';

import url from 'url';

import {parseQs, parseQsFromFragment} from './url_utils';
import Platform from './platform';

import MatrixClientPeg from 'matrix-react-sdk/lib/MatrixClientPeg';
import SettingsStore, {SettingLevel} from "matrix-react-sdk/lib/settings/SettingsStore";
import Tinter from 'matrix-react-sdk/lib/Tinter';
import SdkConfig from "matrix-react-sdk/lib/SdkConfig";

import rageshake from "matrix-react-sdk/lib/rageshake/rageshake";

import CallHandler from 'matrix-react-sdk/lib/CallHandler';

import {getVectorConfig} from './getconfig';

let lastLocationHashSet = null;

function initRageshake() {
    rageshake.init().then(() => {
        console.log("Initialised rageshake: See https://bugs.chromium.org/p/chromium/issues/detail?id=583193 to fix line numbers on Chrome.");

        window.addEventListener('beforeunload', (e) => {
            console.log('riot-web closing');
            // try to flush the logs to indexeddb
            rageshake.flush();
        });

        rageshake.cleanup();
    }, (err) => {
        console.error("Failed to initialise rageshake: " + err);
    });
}

function checkBrowserFeatures(featureList) {
    if (!window.Modernizr) {
        console.error("Cannot check features - Modernizr global is missing.");
        return false;
    }
    var featureComplete = true;
    for (var i = 0; i < featureList.length; i++) {
        if (window.Modernizr[featureList[i]] === undefined) {
            console.error(
                "Looked for feature '%s' but Modernizr has no results for this. " +
                "Has it been configured correctly?", featureList[i]
            );
            return false;
        }
        if (window.Modernizr[featureList[i]] === false) {
            console.error("Browser missing feature: '%s'", featureList[i]);
            // toggle flag rather than return early so we log all missing features
            // rather than just the first.
            featureComplete = false;
        }
    }
    return featureComplete;
}

// Parse the given window.location and return parameters that can be used when calling
// MatrixChat.showScreen(screen, params)
function getScreenFromLocation(location) {
    const fragparts = parseQsFromFragment(location);
    return {
        screen: fragparts.location.substring(1),
        params: fragparts.params,
    }
}

// Here, we do some crude URL analysis to allow
// deep-linking.
function routeUrl(location) {
    if (!window.matrixChat) return;

    console.log("Routing URL ", location.href);
    const s = getScreenFromLocation(location);
    window.matrixChat.showScreen(s.screen, s.params);
}

function onHashChange(ev) {
    if (decodeURIComponent(window.location.hash) == lastLocationHashSet) {
        // we just set this: no need to route it!
        return;
    }
    routeUrl(window.location);
}

// This will be called whenever the SDK changes screens,
// so a web page can update the URL bar appropriately.
function onNewScreen(screen) {
    console.log("newscreen "+screen);
    var hash = '#/' + screen;
    lastLocationHashSet = hash;
    window.location.hash = hash;
};

// We use this to work out what URL the SDK should
// pass through when registering to allow the user to
// click back to the client having registered.
// It's up to us to recognise if we're loaded with
// this URL and tell MatrixClient to resume registration.
//
// If we're in electron, we should never pass through a file:// URL otherwise
// the identity server will try to 302 the browser to it, which breaks horribly.
// so in that instance, hardcode to use riot.im/app for now instead.
function makeRegistrationUrl(params) {
    let url;
    if (window.location.protocol === "file:") {
        url = 'https://chat.fabric.pub/#/register';
    } else {
        url = (
            window.location.protocol + '//' +
            window.location.host +
            window.location.pathname +
            '#/register'
        );
    }

    const keys = Object.keys(params);
    for (let i = 0; i < keys.length; ++i) {
        if (i == 0) {
            url += '?';
        } else {
            url += '&';
        }
        const k = keys[i];
        url += k + '=' + encodeURIComponent(params[k]);
    }
    return url;
}

function getConfig(configJsonFilename) {
    let deferred = Promise.defer();

    request(
        { method: "GET", url: configJsonFilename },
        (err, response, body) => {
            if (err || response.status < 200 || response.status >= 300) {
                // Lack of a config isn't an error, we should
                // just use the defaults.
                // Also treat a blank config as no config, assuming
                // the status code is 0, because we don't get 404s
                // from file: URIs so this is the only way we can
                // not fail if the file doesn't exist when loading
                // from a file:// URI.
                if (response) {
                    if (response.status == 404 || (response.status == 0 && body == '')) {
                        deferred.resolve({});
                    }
                }
                deferred.reject({err: err, response: response});
                return;
            }

            // We parse the JSON ourselves rather than use the JSON
            // parameter, since this throws a parse error on empty
            // which breaks if there's no config.json and we're
            // loading from the filesystem (see above).
            deferred.resolve(JSON.parse(body));
        }
    );

    return deferred.promise;
}

function onTokenLoginCompleted() {
    // if we did a token login, we're now left with the token, hs and is
    // url as query params in the url; a little nasty but let's redirect to
    // clear them.
    var parsedUrl = url.parse(window.location.href);
    parsedUrl.search = "";
    var formatted = url.format(parsedUrl);
    console.log("Redirecting to " + formatted + " to drop loginToken " +
                "from queryparams");
    window.location.href = formatted;
}

async function loadApp() {
    initRageshake();
    MatrixClientPeg.setIndexedDbWorkerScript(window.vector_indexeddb_worker_script);
    CallHandler.setConferenceHandler(VectorConferenceHandler);

    window.addEventListener('hashchange', onHashChange);

    await loadLanguage();

    const fragparts = parseQsFromFragment(window.location);
    const params = parseQs(window.location);

    // set the platform for react sdk (our Platform object automatically picks the right one)
    PlatformPeg.set(new Platform());

    // Load the config file. First try to load up a domain-specific config of the
    // form "config.$domain.json" and if that fails, fall back to config.json.
    let configJson;
    let configError;
    try {
        configJson = await getVectorConfig();
    } catch (e) {
        configError = e;
    }

    // XXX: We call this twice, once here and once in MatrixChat as a prop. We call it here to ensure
    // granular settings are loaded correctly and to avoid duplicating the override logic for the theme.
    SdkConfig.put(configJson);

    // don't try to redirect to the native apps if we're
    // verifying a 3pid (but after we've loaded the config)
    const preventRedirect = Boolean(fragparts.params.client_secret);

    if (!preventRedirect) {
        const isIos = /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
        const isAndroid = /Android/.test(navigator.userAgent);
        if (isIos || isAndroid) {
            if (!document.cookie.split(';').some((c) => c.startsWith('mobile_redirect_to_guide'))) {
                window.location = "releases/";
                return;
            }
        }
    }

    // as quickly as we possibly can, set a default theme...
    const styleElements = Object.create(null);
    let a;
    const theme = SettingsStore.getValue("theme");
    for (let i = 0; (a = document.getElementsByTagName("link")[i]); i++) {
        const href = a.getAttribute("href");
        if (!href) continue;
        // shouldn't we be using the 'title' tag rather than the href?
        const match = href.match(/^bundles\/.*\/theme-(.*)\.css$/);
        if (match) {
            if (match[1] === theme) {
                // remove the disabled flag off the stylesheet

                // Firefox requires setting the attribute to false, so do
                // that instead of removing it. Related:
                // https://bugzilla.mozilla.org/show_bug.cgi?id=1281135
                a.disabled = false;

                // in case the Tinter.tint() in MatrixChat fires before the
                // CSS has actually loaded (which in practice happens)...

                // FIXME: we should probably block loading the app or even
                // showing a spinner until the theme is loaded, to avoid
                // flashes of unstyled content.
                a.onload = () => {
                    Tinter.setTheme(theme);
                };
            } else {
                // Firefox requires this to not be done via `setAttribute`
                // or via HTML.
                // https://bugzilla.mozilla.org/show_bug.cgi?id=1281135
                a.disabled = true;
            }
        }
    }

    const validBrowser = checkBrowserFeatures([
        "displaytable", "flexbox", "es5object", "es5function", "localstorage",
        "objectfit", "indexeddb", "webworkers",
    ]);

    const acceptInvalidBrowser = window.localStorage && window.localStorage.getItem('mx_accepts_unsupported_browser');

    console.log("Vector starting at "+window.location);
    if (configError) {
        window.matrixChat = ReactDOM.render(<div className="error">
            Unable to load config file: please refresh the page to try again.
        </div>, document.getElementById('matrixchat'));
    } else if (validBrowser || acceptInvalidBrowser) {
        const platform = PlatformPeg.get();
        platform.startUpdater();

        const MatrixChat = sdk.getComponent('structures.MatrixChat');
        window.matrixChat = ReactDOM.render(
            <MatrixChat
                onNewScreen={onNewScreen}
                makeRegistrationUrl={makeRegistrationUrl}
                ConferenceHandler={VectorConferenceHandler}
                config={configJson}
                realQueryParams={params}
                startingFragmentQueryParams={fragparts.params}
                enableGuest={!configJson.disable_guests}
                onTokenLoginCompleted={onTokenLoginCompleted}
                initialScreenAfterLogin={getScreenFromLocation(window.location)}
                defaultDeviceDisplayName={platform.getDefaultDeviceDisplayName()}
            />,
            document.getElementById('matrixchat')
        );
    } else {
        console.error("Browser is missing required features.");
        // take to a different landing page to AWOOOOOGA at the user
        var CompatibilityPage = sdk.getComponent("structures.CompatibilityPage");
        window.matrixChat = ReactDOM.render(
            <CompatibilityPage onAccept={function() {
                if (window.localStorage) window.localStorage.setItem('mx_accepts_unsupported_browser', true);
                console.log("User accepts the compatibility risks.");
                loadApp();
            }} />,
            document.getElementById('matrixchat')
        );
    }
}

async function loadLanguage() {
    const prefLang = SettingsStore.getValue("language", null, /*excludeDefault=*/true);
    let langs = [];

    if (!prefLang) {
        languageHandler.getLanguagesFromBrowser().forEach((l) => {
            langs.push(...languageHandler.getNormalizedLanguageKeys(l));
        });
    } else {
        langs = [prefLang];
    }
    try {
        await languageHandler.setLanguage(langs);
        document.documentElement.setAttribute("lang", languageHandler.getCurrentLanguage());
    } catch (e) {
        console.error("Unable to set language", e);
    }
}

loadApp();
