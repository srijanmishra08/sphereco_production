/* =============================================================================
   Spherecho Portal — automatic document verification
   -----------------------------------------------------------------------------
   Runs entirely in the browser, on the file the partner just picked, before it
   is stored. The pipeline is:

       file → format check (magic bytes, not the extension)
            → SHA-256 (integrity + duplicate detection)
            → text extraction (PDF content streams / DOCX word/document.xml)
            → checks from the document's `expect` block in checklist.js
            → verdict: verified | review | failed

   The checks below are the generic layer — the things worth asserting about any
   document of a given kind. The per-document checks we will define from the
   templates later slot in through `SPX.checklist.applyTemplate()`; this engine
   reads whatever is in `expect` and needs no changes to honour stricter rules.

   Where the engine cannot read a document — a scanned agreement with no text
   layer is the common case — it says so and returns `review` rather than
   guessing. Nothing here replaces a lawyer reading the paper.
   ========================================================================== */
(function (global) {
    'use strict';

    var SPX = global.SPX = global.SPX || {};

    var MAX_BYTES = 25 * 1024 * 1024;
    var MIN_BYTES = 512;

    /* -------------------------------------------------------------------------
       Format detection from magic bytes — a .pdf that is really a .exe does not
       get to claim otherwise.
       ---------------------------------------------------------------------- */
    var SIGNATURES = [
        { type: 'pdf',  test: function (b) { return b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46; } },
        { type: 'jpg',  test: function (b) { return b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF; } },
        { type: 'png',  test: function (b) { return b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47; } },
        { type: 'zip',  test: function (b) { return b[0] === 0x50 && b[1] === 0x4B && (b[2] === 0x03 || b[2] === 0x05 || b[2] === 0x07); } },
        { type: 'doc',  test: function (b) { return b[0] === 0xD0 && b[1] === 0xCF && b[2] === 0x11 && b[3] === 0xE0; } }
    ];

    function detectFormat(bytes, filename) {
        var ext = (filename.split('.').pop() || '').toLowerCase();
        for (var i = 0; i < SIGNATURES.length; i++) {
            if (SIGNATURES[i].test(bytes)) {
                var t = SIGNATURES[i].type;
                /* A zip container is .docx / .xlsx / .pptx depending on what is
                   inside; the extension is the only hint we need here. */
                if (t === 'zip') {
                    if (ext === 'docx' || ext === 'xlsx' || ext === 'pptx') return ext;
                    return 'zip';
                }
                if (t === 'jpg' && ext === 'jpeg') return 'jpg';
                return t;
            }
        }
        /* Plain text formats have no signature. */
        if (ext === 'csv' || ext === 'txt') return ext;
        return 'unknown';
    }

    /* -------------------------------------------------------------------------
       Inflate — used for both PDF FlateDecode streams and DOCX zip entries.
       DecompressionStream is available in every browser that also gives us
       WebCrypto, so there is no library to ship.
       ---------------------------------------------------------------------- */
    async function inflate(bytes, format) {
        if (!global.DecompressionStream) return null;
        try {
            var ds = new global.DecompressionStream(format);
            var stream = new Blob([bytes]).stream().pipeThrough(ds);
            return new Uint8Array(await new Response(stream).arrayBuffer());
        } catch (e) {
            return null;
        }
    }

    /* Try zlib first (what PDFs and zips normally use), then raw deflate.
       DecompressionStream rejects any trailing junk, and the PDF spec puts an
       EOL between the stream data and `endstream` — so a byte or two of tail has
       to come off before the data will inflate at all. */
    async function inflateEither(bytes) {
        var candidates = [bytes];
        var trimmed = trimTrailingWhitespace(bytes);
        if (trimmed.length !== bytes.length) candidates.push(trimmed);

        for (var i = 0; i < candidates.length; i++) {
            var out = (await inflate(candidates[i], 'deflate')) || (await inflate(candidates[i], 'deflate-raw'));
            if (out) return out;
        }
        return null;
    }

    function trimTrailingWhitespace(bytes) {
        var end = bytes.length;
        while (end > 0) {
            var b = bytes[end - 1];
            if (b === 0x0A || b === 0x0D || b === 0x20 || b === 0x09 || b === 0x00) end--;
            else break;
        }
        return end === bytes.length ? bytes : bytes.subarray(0, end);
    }

    /* -------------------------------------------------------------------------
       PDF text extraction
       -----------------------------------------------------------------------
       Walks the raw file for `stream … endstream` blocks, inflates the ones that
       are Flate-compressed, and pulls the strings out of the text-showing
       operators. Digitally produced PDFs (the overwhelming majority of executed
       agreements today) come out readable. Scanned paper produces nothing, which
       is exactly the signal we want: it tells the partner the document needs OCR
       or a manual read rather than pretending it passed.
       ---------------------------------------------------------------------- */
    function latin1(bytes) {
        var out = '';
        var CHUNK = 0x8000;
        for (var i = 0; i < bytes.length; i += CHUNK) {
            out += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
        }
        return out;
    }

    function decodePdfString(raw) {
        var out = '';
        for (var i = 0; i < raw.length; i++) {
            var c = raw[i];
            if (c !== '\\') { out += c; continue; }
            var next = raw[++i];
            if (next === 'n') out += '\n';
            else if (next === 'r') out += '\n';
            else if (next === 't') out += ' ';
            else if (next === 'b' || next === 'f') out += ' ';
            else if (next >= '0' && next <= '7') {
                var oct = next;
                while (oct.length < 3 && raw[i + 1] >= '0' && raw[i + 1] <= '7') oct += raw[++i];
                out += String.fromCharCode(parseInt(oct, 8));
            } else out += next;
        }
        return out;
    }

    function decodeHexString(hex) {
        var clean = hex.replace(/[^0-9A-Fa-f]/g, '');
        var out = '';
        /* UTF-16BE is common for CID fonts; 2-byte pairs with a zero high byte
           are really Latin-1, so treat those as single characters. */
        for (var i = 0; i + 1 < clean.length; i += 2) {
            var code = parseInt(clean.substr(i, 2), 16);
            out += code >= 32 ? String.fromCharCode(code) : ' ';
        }
        return out;
    }

    function textFromContentStream(content) {
        var out = [];
        /* (literal) Tj  |  [(a) -1 (b)] TJ  |  <hex> Tj */
        var re = /\((?:\\.|[^\\()])*\)|<[0-9A-Fa-f\s]+>/g;
        var m;
        while ((m = re.exec(content)) !== null) {
            var token = m[0];
            if (token[0] === '(') out.push(decodePdfString(token.slice(1, -1)));
            else out.push(decodeHexString(token.slice(1, -1)));
        }
        return out.join(' ');
    }

    async function extractPdfText(bytes) {
        var raw = latin1(bytes);
        var chunks = [];
        var searchFrom = 0;
        var guard = 0;

        while (guard++ < 4000) {
            var start = raw.indexOf('stream', searchFrom);
            if (start === -1) break;
            var end = raw.indexOf('endstream', start);
            if (end === -1) break;

            /* Skip the EOL that must follow the `stream` keyword. */
            var dataStart = start + 6;
            if (raw[dataStart] === '\r') dataStart++;
            if (raw[dataStart] === '\n') dataStart++;

            var dictStart = Math.max(0, start - 700);
            var dict = raw.slice(dictStart, start);

            /* /Length is authoritative when it is a literal (it can also be an
               indirect reference, which we cannot resolve without the xref). */
            var declared = /\/Length\s+(\d+)\s*(?:\/|>)/.exec(dict);
            var dataEnd = end;
            if (declared) {
                var n = parseInt(declared[1], 10);
                if (n > 0 && dataStart + n <= end) dataEnd = dataStart + n;
            }

            var slice = bytes.subarray(dataStart, dataEnd);
            searchFrom = end + 9;

            if (slice.length === 0) continue;
            /* Images and fonts have nothing for us; skip them rather than
               spending time inflating megabytes of pixels. */
            if (/\/Subtype\s*\/Image|\/FontFile|\/DCTDecode|\/JPXDecode/.test(dict)) continue;

            var text;
            if (/\/FlateDecode/.test(dict)) {
                var inflated = await inflateEither(slice);
                if (!inflated) continue;
                text = latin1(inflated);
            } else if (/\/Filter/.test(dict)) {
                continue;                       /* LZW, RunLength, etc. — rare */
            } else {
                text = latin1(slice);
            }

            if (/\bTj\b|\bTJ\b|\bTd\b|\bTf\b/.test(text)) chunks.push(textFromContentStream(text));
            if (chunks.length > 400) break;
        }

        /* Some PDFs also carry a plain-text /Contents outside compressed streams. */
        if (!chunks.length && /\bTj\b/.test(raw)) chunks.push(textFromContentStream(raw));

        return chunks.join('\n');
    }

    function countPdfPages(bytes) {
        var raw = latin1(bytes);
        var matches = raw.match(/\/Type\s*\/Page[^s]/g);
        if (matches && matches.length) return matches.length;
        var count = raw.match(/\/Count\s+(\d+)/);
        return count ? parseInt(count[1], 10) : 0;
    }

    /* -------------------------------------------------------------------------
       DOCX text extraction — read word/document.xml straight out of the zip.
       ---------------------------------------------------------------------- */
    async function extractDocxText(bytes) {
        var raw = latin1(bytes);
        var results = [];
        var offset = 0;
        var guard = 0;

        while (guard++ < 500) {
            var sigAt = raw.indexOf('PK\x03\x04', offset);
            if (sigAt === -1) break;

            var view = new DataView(bytes.buffer, bytes.byteOffset);
            var method = view.getUint16(sigAt + 8, true);
            var compressedSize = view.getUint32(sigAt + 18, true);
            var nameLen = view.getUint16(sigAt + 26, true);
            var extraLen = view.getUint16(sigAt + 28, true);
            var name = raw.substr(sigAt + 30, nameLen);
            var dataAt = sigAt + 30 + nameLen + extraLen;

            offset = dataAt + (compressedSize || 1);

            if (!/^word\/(document|header\d*|footer\d*)\.xml$/.test(name)) continue;
            if (!compressedSize) continue;      /* streamed entry — size lives in the trailer */

            var slice = bytes.subarray(dataAt, dataAt + compressedSize);
            var xmlBytes = method === 0 ? slice : await inflate(slice, 'deflate-raw');
            if (!xmlBytes) continue;

            var xml = new TextDecoder('utf-8').decode(xmlBytes);
            results.push(xml
                .replace(/<w:p[ >][^]*?<\/w:p>|<w:p\/>/g, function (p) { return p + '\n'; })
                .replace(/<[^>]+>/g, ' ')
                .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
                .replace(/&quot;/g, '"').replace(/&#39;/g, "'"));
        }
        return results.join('\n');
    }

    async function extractText(bytes, format) {
        try {
            if (format === 'pdf') return await extractPdfText(bytes);
            if (format === 'docx') return await extractDocxText(bytes);
            if (format === 'csv' || format === 'txt') return new TextDecoder('utf-8').decode(bytes);
        } catch (e) {
            console.warn('[portal] text extraction failed', e);
        }
        return '';
    }

    /* Extraction can produce mojibake when a PDF subsets its fonts with a custom
       encoding. Judge readability by how much of the text looks like words. */
    function readability(text) {
        if (!text) return 0;
        var letters = (text.match(/[A-Za-z]/g) || []).length;
        var words = (text.match(/\b[A-Za-z]{3,}\b/g) || []).length;
        if (text.length < 40) return 0;
        var letterRatio = letters / text.length;
        var wordDensity = words / Math.max(1, text.length / 100);
        return Math.min(1, letterRatio * 1.2) * Math.min(1, wordDensity / 6);
    }

    /* -------------------------------------------------------------------------
       Indian identifier patterns, with the checks that make them meaningful
       ---------------------------------------------------------------------- */
    var PATTERNS = {
        pan:   /\b[A-Z]{5}[0-9]{4}[A-Z]\b/g,
        gstin: /\b[0-3][0-9][A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]\b/g,
        cin:   /\b[LU][0-9]{5}[A-Z]{2}[0-9]{4}[A-Z]{3}[0-9]{6}\b/g,
        llpin: /\b[A-Z]{3}-?[0-9]{4}\b/g,
        cbfc:  /\b(?:DIL|CFL|VFL|[A-Z]{2,4})[\/-][0-9]{1,6}[\/-][0-9]{2,4}\b/g
    };

    var GSTIN_ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';

    /* GSTIN carries a mod-36 check digit; a typo in a hand-copied GSTIN fails it. */
    function gstinCheckDigit(gstin) {
        if (!gstin || gstin.length !== 15) return false;
        var sum = 0;
        for (var i = 0; i < 14; i++) {
            var value = GSTIN_ALPHABET.indexOf(gstin[i]);
            if (value < 0) return false;
            var factor = (i % 2 === 0) ? 1 : 2;
            var product = value * factor;
            sum += Math.floor(product / 36) + (product % 36);
        }
        var check = (36 - (sum % 36)) % 36;
        return GSTIN_ALPHABET[check] === gstin[14];
    }

    /* PAN's 4th character encodes holder type — C company, F firm, P individual. */
    function panHolderType(pan) {
        return ({ C: 'company', P: 'individual', H: 'HUF', F: 'firm', A: 'AOP', T: 'trust', B: 'BOI', L: 'local authority', J: 'artificial juridical person', G: 'government' })[pan[3]] || null;
    }

    function findAll(text, key) {
        var re = new RegExp(PATTERNS[key].source, 'g');
        var found = {};
        var m;
        var upper = text.toUpperCase();
        while ((m = re.exec(upper)) !== null) found[m[0]] = true;
        return Object.keys(found);
    }

    /* -------------------------------------------------------------------------
       Heuristics over extracted text
       ---------------------------------------------------------------------- */
    var SIGNATURE_HINTS = [
        'signature', 'signed by', 'for and on behalf', 'authorised signatory', 'authorized signatory',
        'in witness whereof', 'sd/-', 'digitally signed', 'witness', '/s/'
    ];
    var DATE_RE = /\b(?:[0-3]?\d[\/\-.\s](?:[01]?\d|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*[\/\-.\s](?:19|20)?\d{2}|(?:19|20)\d{2}[\/\-][01]\d[\/\-][0-3]\d|(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+[0-3]?\d,?\s+(?:19|20)\d{2})\b/i;
    var TERM_HINTS = ['term of', 'perpetuity', 'perpetual', 'territory', 'worldwide', 'in all media', 'for a period of'];

    function normalise(s) {
        return String(s || '').toLowerCase().replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, ' ');
    }

    /* Compare a name from the profile against the document text, tolerating the
       usual suffix noise ("Pvt. Ltd." vs "Private Limited"). */
    function nameAppears(needle, haystack) {
        var clean = normalise(needle)
            .replace(/\b(pvt|private|ltd|limited|llp|inc|co|company|productions?|films?|studios?)\b/g, ' ')
            .replace(/[^a-z0-9 ]/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
        if (clean.length < 3) return normalise(needle).length > 2 && haystack.indexOf(normalise(needle)) !== -1;
        var tokens = clean.split(' ').filter(function (t) { return t.length > 2; });
        if (!tokens.length) return false;
        var hits = tokens.filter(function (t) { return haystack.indexOf(t) !== -1; });
        return hits.length / tokens.length >= 0.6;
    }

    /* -------------------------------------------------------------------------
       The check runner
       ---------------------------------------------------------------------- */
    function check(id, label, status, detail) {
        return { id: id, label: label, status: status, detail: detail || '' };
    }

    var ORDER = { fail: 3, warn: 2, skip: 1, pass: 0 };

    function verdictFrom(checks) {
        var worst = checks.reduce(function (acc, c) { return Math.max(acc, ORDER[c.status] || 0); }, 0);
        if (worst >= 3) return 'failed';
        if (worst === 2) return 'review';
        return 'verified';
    }

    /**
     * Verify one file against one checklist document.
     *
     * @param {File}   file      the file the partner picked
     * @param {Object} doc       entry from SPX.checklist
     * @param {Object} context   { profile, knownHashes }
     * @returns {Promise<Object>} verification record
     */
    async function verifyFile(file, doc, context) {
        context = context || {};
        var profile = context.profile || {};
        var expect = (doc && doc.expect) || {};
        var checks = [];
        var evidence = {};

        var buffer = await file.arrayBuffer();
        var bytes = new Uint8Array(buffer);

        /* 1 — the file arrived intact and is a plausible size ---------------- */
        if (!bytes.length) {
            checks.push(check('presence', 'File is readable', 'fail', 'The file is empty.'));
            return finish(checks, evidence, doc, null);
        }
        if (bytes.length < MIN_BYTES) {
            checks.push(check('presence', 'File is readable', 'warn', 'Only ' + bytes.length + ' bytes — this looks truncated.'));
        } else if (bytes.length > MAX_BYTES) {
            checks.push(check('presence', 'File is readable', 'fail', 'Larger than the 25 MB limit. Split or compress it.'));
            return finish(checks, evidence, doc, null);
        } else {
            checks.push(check('presence', 'File is readable', 'pass', formatBytes(bytes.length)));
        }

        /* 2 — real format, read from the bytes ------------------------------ */
        var format = detectFormat(bytes, file.name);
        evidence.format = format;
        var accepted = doc && doc.accept ? doc.accept : ['pdf', 'docx', 'jpg', 'png'];
        var ext = (file.name.split('.').pop() || '').toLowerCase();

        if (format === 'unknown') {
            checks.push(check('format', 'File type', 'fail', 'The contents do not match any accepted document format.'));
            return finish(checks, evidence, doc, null);
        }
        if (accepted.indexOf(format) === -1) {
            checks.push(check('format', 'File type', 'fail',
                'This slot accepts ' + accepted.join(', ').toUpperCase() + '. The file is a ' + format.toUpperCase() + '.'));
        } else if (ext !== format && !(format === 'jpg' && ext === 'jpeg')) {
            checks.push(check('format', 'File type', 'warn',
                'Named .' + ext + ' but the contents are ' + format.toUpperCase() + '. Accepted, but worth re-checking.'));
        } else {
            checks.push(check('format', 'File type', 'pass', format.toUpperCase()));
        }

        /* 3 — hash, then look for the same bytes already uploaded elsewhere -- */
        var sha256 = await SPX.store.sha256Hex(buffer);
        evidence.sha256 = sha256;
        var duplicate = (context.knownHashes || []).filter(function (k) { return k.sha256 === sha256; })[0];
        if (duplicate) {
            var sameSlot = duplicate.docId === doc.id;
            checks.push(check('duplicate', 'Not a duplicate', sameSlot ? 'fail' : 'warn',
                sameSlot
                    ? 'This exact file is already uploaded against this requirement.'
                    : 'Byte-identical to “' + duplicate.name + '” filed under ' + labelFor(duplicate.docId) + '.'));
        } else {
            checks.push(check('duplicate', 'Not a duplicate', 'pass', 'SHA-256 ' + sha256.slice(0, 12) + '…'));
        }

        /* 4 — pull the text out ---------------------------------------------- */
        var text = await extractText(bytes, format);
        var normalised = normalise(text);
        var score = readability(text);
        evidence.characters = text.length;
        evidence.readability = Math.round(score * 100) / 100;
        if (format === 'pdf') evidence.pages = countPdfPages(bytes);

        /* 80 characters is low, deliberately: a PAN card or a one-line NOC
           carries very little text and is still perfectly checkable. */
        var readable = score >= 0.25 && text.length >= 80;

        if (readable) {
            checks.push(check('text', 'Machine-readable text', 'pass',
                (evidence.pages ? evidence.pages + ' page(s), ' : '') + text.replace(/\s+/g, ' ').trim().length + ' characters extracted'));
        } else if (format === 'jpg' || format === 'png') {
            checks.push(check('text', 'Machine-readable text', 'warn',
                'Image upload — the content checks below cannot run. A searchable PDF would be verified automatically.'));
        } else if (format === 'pdf' && text.length < 80) {
            checks.push(check('text', 'Machine-readable text', 'warn',
                'No text layer — this looks like a scan. Content checks need OCR or a manual read.'));
        } else {
            checks.push(check('text', 'Machine-readable text', 'warn',
                'Text came out garbled (embedded font encoding). Content checks below are unreliable for this file.'));
        }

        /* 5 — content checks, only where the text supports them --------------- */
        if (!readable) {
            var pending = [];
            if (expect.keywordsAll || expect.keywordsAny) pending.push('expected wording');
            if (expect.identifiers) pending.push('identifier check');
            if (expect.wantsSignature) pending.push('signature block');
            if (expect.wantsDate) pending.push('execution date');
            if (expect.matchEntityName || expect.matchFilmTitle) pending.push('party/title match');
            if (pending.length) {
                checks.push(check('content', 'Content checks', 'skip', 'Deferred to manual review: ' + pending.join(', ') + '.'));
            }
            return finish(checks, evidence, doc, text);
        }

        /* 5a — the wording we expect to see */
        if (expect.keywordsAll && expect.keywordsAll.length) {
            var missingAll = expect.keywordsAll.filter(function (k) { return normalised.indexOf(normalise(k)) === -1; });
            checks.push(missingAll.length
                ? check('keywords.all', 'Required wording', 'fail', 'Not found: “' + missingAll.join('”, “') + '”.')
                : check('keywords.all', 'Required wording', 'pass', 'All required phrases present.'));
        }
        if (expect.keywordsAny && expect.keywordsAny.length) {
            var hitsAny = expect.keywordsAny.filter(function (k) { return normalised.indexOf(normalise(k)) !== -1; });
            checks.push(hitsAny.length
                ? check('keywords.any', 'Document type', 'pass', 'Reads as expected (“' + hitsAny.slice(0, 3).join('”, “') + '”).')
                : check('keywords.any', 'Document type', 'warn',
                    'None of the wording expected for this requirement appears. Check the file went into the right slot.'));
        }

        /* 5b — identifiers, extracted and validated */
        if (expect.identifiers && expect.identifiers.length) {
            var found = {};
            expect.identifiers.forEach(function (key) { found[key] = findAll(text, key); });
            evidence.identifiers = found;

            var anyFound = expect.identifiers.filter(function (k) { return found[k].length; });
            var mode = expect.identifiersMode === 'all' ? 'all' : 'any';
            var satisfied = mode === 'all' ? anyFound.length === expect.identifiers.length : anyFound.length > 0;

            if (!satisfied) {
                checks.push(check('identifiers', 'Identifier present', 'warn',
                    'No valid ' + expect.identifiers.join(' or ').toUpperCase() + ' found in the document text.'));
            } else {
                var notes = [];
                anyFound.forEach(function (key) {
                    found[key].forEach(function (value) {
                        if (key === 'gstin') {
                            notes.push('GSTIN ' + value + (gstinCheckDigit(value) ? ' (check digit valid)' : ' (CHECK DIGIT INVALID)'));
                        } else if (key === 'pan') {
                            var t = panHolderType(value);
                            notes.push('PAN ' + value + (t ? ' (' + t + ')' : ''));
                        } else {
                            notes.push(key.toUpperCase() + ' ' + value);
                        }
                    });
                });
                var badGstin = (found.gstin || []).filter(function (g) { return !gstinCheckDigit(g); });
                checks.push(badGstin.length
                    ? check('identifiers', 'Identifier present', 'fail', notes.join('; ') + ' — the check digit does not validate.')
                    : check('identifiers', 'Identifier present', 'pass', notes.slice(0, 3).join('; ')));
            }

            /* 5c — does it match what the partner typed on the profile? */
            if (expect.crossCheck) {
                var field = expect.crossCheck.replace(/^profile\./, '');
                var stated = String(profile[field] || '').toUpperCase().replace(/\s/g, '');
                var key2 = field === 'pan' ? 'pan' : (field === 'gstin' ? 'gstin' : null);
                if (!stated) {
                    checks.push(check('crosscheck', 'Matches entity profile', 'warn', 'Nothing entered for ' + field + ' on the profile to compare against.'));
                } else if (key2 && found[key2]) {
                    checks.push(found[key2].indexOf(stated) !== -1
                        ? check('crosscheck', 'Matches entity profile', 'pass', stated + ' matches the profile.')
                        : check('crosscheck', 'Matches entity profile', 'fail',
                            'The document shows ' + (found[key2][0] || 'nothing') + ' but the profile says ' + stated + '.'));
                } else if (expect.crossCheck === 'profile.signatoryName') {
                    checks.push(nameAppears(stated, normalised)
                        ? check('crosscheck', 'Matches entity profile', 'pass', 'Named signatory appears in the document.')
                        : check('crosscheck', 'Matches entity profile', 'warn', 'The signatory named on the profile does not appear here.'));
                }
            }
        } else if (expect.crossCheck === 'profile.signatoryName' && profile.signatoryName) {
            checks.push(nameAppears(profile.signatoryName, normalised)
                ? check('crosscheck', 'Signatory named', 'pass', profile.signatoryName + ' appears in the document.')
                : check('crosscheck', 'Signatory named', 'warn', profile.signatoryName + ' does not appear in the document.'));
        }

        /* 5d — the parties and the film */
        if (expect.matchEntityName && profile.entityName) {
            checks.push(nameAppears(profile.entityName, normalised)
                ? check('party', 'Seller named', 'pass', profile.entityName + ' appears in the document.')
                : check('party', 'Seller named', 'warn', profile.entityName + ' does not appear — confirm this document belongs to the selling entity.'));
        }
        if (expect.matchFilmTitle && profile.filmTitle) {
            checks.push(nameAppears(profile.filmTitle, normalised)
                ? check('film', 'Film identified', 'pass', '“' + profile.filmTitle + '” appears in the document.')
                : check('film', 'Film identified', 'warn', '“' + profile.filmTitle + '” does not appear in the document text.'));
        }

        /* 5e — executed, dated, and (for licences) scoped */
        if (expect.wantsSignature) {
            var sigHit = SIGNATURE_HINTS.filter(function (h) { return normalised.indexOf(h) !== -1; });
            checks.push(sigHit.length
                ? check('signature', 'Execution block', 'pass', 'Signature block found (“' + sigHit[0] + '”).')
                : check('signature', 'Execution block', 'warn', 'No signature block found — an unexecuted draft will not do.'));
        }
        if (expect.wantsDate) {
            var dateMatch = text.match(DATE_RE);
            checks.push(dateMatch
                ? check('date', 'Dated', 'pass', 'Date found: ' + dateMatch[0].trim())
                : check('date', 'Dated', 'warn', 'No date found in the document.'));
        }
        if (expect.wantsTerm) {
            var termHit = TERM_HINTS.filter(function (h) { return normalised.indexOf(h) !== -1; });
            checks.push(termHit.length
                ? check('term', 'Term and territory', 'pass', 'Scope wording present (“' + termHit[0] + '”).')
                : check('term', 'Term and territory', 'warn', 'No term/territory wording found — confirm the grant covers what is being sold.'));
        }
        if (expect.noDues) {
            var duesHit = ['no dues', 'fully paid', 'no outstanding', 'nothing is due', 'consideration has been paid', 'received the full']
                .filter(function (h) { return normalised.indexOf(h) !== -1; });
            checks.push(duesHit.length
                ? check('dues', 'Payment position', 'pass', 'Confirms payment (“' + duesHit[0] + '”).')
                : check('dues', 'Payment position', 'warn', 'No confirmation that consideration has been paid in full.'));
        }
        if (expect.declaration) {
            var carveOut = ['except', 'save as', 'other than', 'disclosed'].some(function (h) { return normalised.indexOf(h) !== -1; });
            evidence.hasCarveOut = carveOut;
            if (carveOut) {
                checks.push(check('declaration', 'Declaration scope', 'warn',
                    'The declaration carries an exception ("except"/"save as"/"disclosed"). Read the carve-out before relying on it.'));
            } else {
                checks.push(check('declaration', 'Declaration scope', 'pass', 'Unqualified declaration.'));
            }
        }

        return finish(checks, evidence, doc, text);
    }

    function finish(checks, evidence, doc, text) {
        var verdict = verdictFrom(checks);
        return {
            verdict: verdict,
            checks: checks,
            evidence: evidence,
            docId: doc ? doc.id : null,
            engine: 'generic-v1',
            /* Kept for the reviewer's excerpt panel; capped so the store stays small. */
            excerpt: text ? text.replace(/\s+/g, ' ').trim().slice(0, 600) : '',
            verifiedAt: Date.now()
        };
    }

    function labelFor(docId) {
        var d = SPX.checklist && SPX.checklist.get(docId);
        return d ? d.ref + ' ' + d.label : docId;
    }

    function formatBytes(n) {
        if (n < 1024) return n + ' B';
        if (n < 1024 * 1024) return (n / 1024).toFixed(0) + ' KB';
        return (n / 1024 / 1024).toFixed(1) + ' MB';
    }

    SPX.verify = {
        file: verifyFile,
        detectFormat: detectFormat,
        extractText: extractText,
        gstinCheckDigit: gstinCheckDigit,
        readability: readability,
        formatBytes: formatBytes,
        MAX_BYTES: MAX_BYTES
    };
})(window);
