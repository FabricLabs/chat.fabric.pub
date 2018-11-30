#!/usr/bin/env node

// copies the resources into the webapp directory.
//

// Languages are listed manually so we can choose when to include
// a translation in the app (because having a translation with only
// 3 strings translated is just frustrating)
// This could readily be automated, but it's nice to explicitly
// control when new languages are available.
const INCLUDE_LANGS = [
    {'value': 'bg', 'label': 'Български'},
    {'value': 'ca', 'label': 'Català'},
    {'value': 'cs', 'label': 'čeština'},
    {'value': 'da', 'label': 'Dansk'},
    {'value': 'de_DE', 'label': 'Deutsch'},
    {'value': 'el', 'label': 'Ελληνικά'},
    {'value': 'en_EN', 'label': 'English'},
    {'value': 'en_US', 'label': 'English (US)'},
    {'value': 'eo', 'label': 'Esperanto'},
    {'value': 'es', 'label': 'Español'},
    {'value': 'eu', 'label': 'Euskara'},
    {'value': 'fi', 'label': 'Suomi'},
    {'value': 'fr', 'label': 'Français'},
    {'value': 'gl', 'label': 'Galego'},
    {'value': 'hu', 'label': 'Magyar'},
    {'value': 'it', 'label': 'Italiano'},
    {'value': 'ja', 'label': '日本語'},
    {'value': 'ko', 'label': '한국어'},
    {'value': 'lv', 'label': 'Latviešu'},
    {'value': 'nb_NO', 'label': 'Norwegian Bokmål'},
    {'value': 'nl', 'label': 'Nederlands'},
    {'value': 'nn', 'label': 'Norsk Nynorsk'},
    {'value': 'pl', 'label': 'Polski'},
    {'value': 'pt', 'label': 'Português'},
    {'value': 'pt_BR', 'label': 'Português do Brasil'},
    {'value': 'ru', 'label': 'Русский'},
    {'value': 'sk', 'label': 'Slovenčina'},
    {'value': 'sr', 'label': 'српски'},
    {'value': 'sv', 'label': 'Svenska'},
    {'value': 'te', 'label': 'తెలుగు'},
    {'value': 'th', 'label': 'ไทย'},
    {'value': 'tr', 'label': 'Türk'},
    {'value': 'zh_Hans', 'label': '简体中文'}, // simplified chinese
    {'value': 'zh_Hant', 'label': '繁體中文'}, // traditional chinese
];

// cpx includes globbed parts of the filename in the destination, but excludes
// common parents. Hence, "res/{a,b}/**": the output will be "dest/a/..." and
// "dest/b/...".
const COPY_LIST = [
    ["res/manifest.json", "webapp"],
    ["res/home.html", "webapp"],
    ["res/home-status.html", "webapp"],
    ["res/home/**", "webapp/home"],
    ["res/themes/rpg/fonts/**", "webapp/fonts"],
    ["res/grove-icons/**", "webapp/grove-icons"],
    ["res/vector-icons/**", "webapp/vector-icons"],
    ["res/verse-icons/**", "webapp/verse-icons"],
    ["res/images/**", "webapp/images"],
    ["res/releases/**", "webapp/releases"],
    ["node_modules/matrix-react-sdk/res/{fonts,img,themes,media}/**", "webapp"],
    ["res/themes/**", "webapp/themes"],
    ["node_modules/emojione/assets/svg/*", "webapp/emojione/svg/"],
    ["node_modules/emojione/assets/png/*", "webapp/emojione/png/"],
    // XXX: This is tied quite heavily to the matching olm.js so it really should be
    // in the bundle dir with the js to avoid caching issues giving us wasm that
    // doesn't match our js, but I cannot find any way to get webpack to do this.
    ["node_modules/olm/olm.wasm", "webapp", { directwatch: 1 }],
    ["node_modules/olm/olm_legacy.js", "webapp", { directwatch: 1 }],
    ["./config.json", "webapp", { directwatch: 1 }],
];

INCLUDE_LANGS.forEach(function(l) {
    COPY_LIST.push([
        l.value, "webapp/i18n/", { lang: 1 },
    ]);
});

const parseArgs = require('minimist');
const Cpx = require('cpx');
const chokidar = require('chokidar');
const fs = require('fs');
const rimraf = require('rimraf');

const argv = parseArgs(
    process.argv.slice(2), {}
);

var watch = argv.w;
var verbose = argv.v;

function errCheck(err) {
    if (err) {
        console.error(err.message);
        process.exit(1);
    }
}

// Check if webapp exists
if (!fs.existsSync('webapp')) {
    fs.mkdirSync('webapp');
}
// Check if i18n exists
if (!fs.existsSync('webapp/i18n/')) {
    fs.mkdirSync('webapp/i18n/');
}

function next(i, err) {
    errCheck(err);

    if (i >= COPY_LIST.length) {
        return;
    }

    const ent = COPY_LIST[i];
    const source = ent[0];
    const dest = ent[1];
    const opts = ent[2] || {};
    let cpx = undefined;

    if (!opts.lang) {
        cpx = new Cpx.Cpx(source, dest);
    }

    if (verbose && cpx) {
        cpx.on("copy", (event) => {
            console.log(`Copied: ${event.srcPath} --> ${event.dstPath}`);
        });
        cpx.on("remove", (event) => {
            console.log(`Removed: ${event.path}`);
        });
    }

    const cb = (err) => { next(i + 1, err) };

    if (watch) {
        if (opts.directwatch) {
            // cpx -w creates a watcher for the parent of any files specified,
            // which in the case of config.json is '.', which inevitably takes
            // ages to crawl. So we create our own watcher on the files
            // instead.
            const copy = () => { cpx.copy(errCheck) };
            chokidar.watch(source)
                .on('add', copy)
                .on('change', copy)
                .on('ready', cb)
                .on('error', errCheck);
        } else if (opts.lang) {
            const reactSdkFile = 'node_modules/matrix-react-sdk/src/i18n/strings/' + source + '.json';
            const riotWebFile = 'src/i18n/strings/' + source + '.json';

            // XXX: Use a debounce because for some reason if we read the language
            // file immediately after the FS event is received, the file contents
            // appears empty. Possibly https://github.com/nodejs/node/issues/6112
            let makeLangDebouncer;
            const makeLang = () => {
                if (makeLangDebouncer) {
                    clearTimeout(makeLangDebouncer);
                }
                makeLangDebouncer = setTimeout(() => {
                    genLangFile(source, dest);
                }, 500);
            };

            [reactSdkFile, riotWebFile].forEach(function(f) {
                chokidar.watch(f)
                    .on('add', makeLang)
                    .on('change', makeLang)
                    //.on('ready', cb)  We'd have to do this when both files are ready
                    .on('error', errCheck);
            });
            next(i + 1, err);
        } else {
            cpx.on('watch-ready', cb);
            cpx.on("watch-error", cb);
            cpx.watch();
        }
    } else if (opts.lang) {
        genLangFile(source, dest);
        next(i + 1, err);
    } else {
        cpx.copy(cb);
    }
}

function genLangFile(lang, dest) {
    const reactSdkFile = 'node_modules/matrix-react-sdk/src/i18n/strings/' + lang + '.json';
    const riotWebFile = 'src/i18n/strings/' + lang + '.json';

    let translations = {};
    [reactSdkFile, riotWebFile].forEach(function(f) {
        if (fs.existsSync(f)) {
            try {
                Object.assign(
                    translations,
                    JSON.parse(fs.readFileSync(f).toString())
                );
            } catch (e) {
                console.error("Failed: " + f, e);
                throw e;
            }
        }
    });

    translations = weblateToCounterpart(translations);

    fs.writeFileSync(dest + lang + '.json', JSON.stringify(translations, null, 4));
    if (verbose) {
        console.log("Generated language file: " + lang);
    }
}

function genLangList() {
    const languages = {};
    INCLUDE_LANGS.forEach(function(lang) {
        const normalizedLanguage = lang.value.toLowerCase().replace("_", "-");
        const languageParts = normalizedLanguage.split('-');
        if (languageParts.length == 2 && languageParts[0] == languageParts[1]) {
            languages[languageParts[0]] = {'fileName': lang.value + '.json', 'label': lang.label};
        } else {
            languages[normalizedLanguage] = {'fileName': lang.value + '.json', 'label': lang.label};
        }
    });
    fs.writeFile('webapp/i18n/languages.json', JSON.stringify(languages, null, 4), function(err) {
        if (err) {
            console.error("Copy Error occured: " + err);
            throw new Error("Failed to generate languages.json");
        }
    });
    if (verbose) {
        console.log("Generated languages.json");
    }
}

/**
 * Convert translation key from weblate format
 * (which only supports a single level) to counterpart
 * which requires object values for 'count' translations.
 *
 * eg.
 *     "there are %(count)s badgers|one": "a badger",
 *     "there are %(count)s badgers|other": "%(count)s badgers"
 *   becomes
 *     "there are %(count)s badgers": {
 *         "one": "a badger",
 *         "other": "%(count)s badgers"
 *     }
 */
function weblateToCounterpart(inTrs) {
    const outTrs = {};

    for (const key of Object.keys(inTrs)) {
        const keyParts = key.split('|', 2);
        if (keyParts.length === 2) {
            let obj = outTrs[keyParts[0]];
            if (obj === undefined) {
                obj = {};
                outTrs[keyParts[0]] = obj;
            }
            obj[keyParts[1]] = inTrs[key];
        } else {
            outTrs[key] = inTrs[key];
        }
    }

    return outTrs;
}

genLangList();
next(0);
